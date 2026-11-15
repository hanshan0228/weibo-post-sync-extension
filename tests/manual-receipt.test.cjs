'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(initial) {
  let data = structuredClone(initial);
  let listener;
  const event = { addListener() {} };
  const chrome = {
    storage: { local: {
      async get(keys) { return Object.fromEntries(keys.filter(k => k in data).map(k => [k, structuredClone(data[k])])); },
      async set(value) { data = { ...data, ...structuredClone(value) }; },
    } },
    runtime: { onInstalled: event, onStartup: event, onMessage: { addListener(fn) { listener = fn; } }, async sendMessage() {} },
    alarms: { onAlarm: event, get(name, callback) { callback({ name }); }, async create() {} },
    declarativeNetRequest: { async updateDynamicRules() {} },
    tabs: {}, windows: {}, scripting: {},
  };
  const context = vm.createContext({ chrome, console, URL, Date, setTimeout, clearTimeout, setInterval, clearInterval, fetch() { throw Error('禁止网络'); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background/service_worker.js'), 'utf8'), context);
  return { context, get data() { return data; }, run(code) { return vm.runInContext(code, context); },
    send(payload) { return new Promise(resolve => listener({ action: 'MANUAL_RECEIPT_WRITE_BACK', payload }, {}, resolve)); } };
}
const entry = { id: 'a', mode: '真实发布', submittedWithoutReceipt: true, account: '虚构账号', fullContent: '虚构正文', docUrl: 'https://docs.qq.com/sheet/MOCK', targetCell: 'E2', targetSheetId: 's' };
const url = 'https://weibo.com/123/Abc';

test('清账后的记录先保存链接，再补写，失败可重试', async () => {
  const h = harness({ publishLedger: [], __unwrittenReceipts__: [entry] });
  h.run(`findOrCreateTab = async () => { throw Error('隔离模拟失败'); }`);
  const response = await h.send({ ledgerId: 'a', postUrl: url });
  assert.equal(response.ok, false);
  assert.match(response.error, /隔离模拟失败/);
  assert.equal(h.data.__unwrittenReceipts__[0].postUrl, url);
  assert.equal(h.data.publishLedger[0].postUrl, url);
  assert.equal(h.data.publishLedger[0].submittedWithoutReceipt, false);
});

test('拒绝无效状态、覆盖和其他记录占用的链接', async () => {
  for (const [stored, payload] of [
    [[entry], { ledgerId: 'a', postUrl: 'https://evil.example/123' }],
    [[{ ...entry, postUrl: url }], { ledgerId: 'a', postUrl: 'https://weibo.com/123/Other' }],
    [[entry, { ...entry, id: 'b', postUrl: url }], { ledgerId: 'a', postUrl: url + '?foo=1' }],
    [[{ ...entry, writeBackOk: true }], { ledgerId: 'a', postUrl: url }],
    [[entry], { ledgerId: 'missing', postUrl: url }],
  ]) {
    const h = harness({ publishLedger: stored, __unwrittenReceipts__: [] });
    const result = await h.send(payload);
    assert.equal(result.ok, false);
    assert.deepEqual(h.data.publishLedger, stored);
  }
});

test('清账记录补写成功后仍保留账本', async () => {
  const h = harness({ publishLedger: [], __unwrittenReceipts__: [entry] });
  h.run(`findOrCreateTab = async () => ({id: 1}); waitForTabLoaded = async () => {}; holdBackgroundTabAwake = async () => false; executeInTabDirect = async () => ({ok: true});`);
  const result = await h.send({ ledgerId: 'a', postUrl: url });
  assert.equal(result.ok, true);
  assert.equal(h.data.publishLedger[0].postUrl, url);
  assert.equal(h.data.publishLedger[0].writeBackOk, true);
  assert.equal(h.data.__unwrittenReceipts__.length, 0);
});
