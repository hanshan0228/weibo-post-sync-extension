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
    alarms: { onAlarm: event, get(name, callback) { callback({ name }); }, async create() {}, async clear() {} },
    declarativeNetRequest: { async updateDynamicRules() {} },
    tabs: {}, windows: {}, scripting: {},
  };
  const context = vm.createContext({ chrome, console, URL, Date, setTimeout, clearTimeout, setInterval, clearInterval, fetch() { throw Error('禁止网络'); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background/service_worker.js'), 'utf8'), context);
  return { context, get data() { return data; }, run(code) { return vm.runInContext(code, context); },
    send(action, payload) { return new Promise(resolve => listener({ action, payload }, {}, resolve)); } };
}

const base = {
  mode: '真实发布', submittedWithoutReceipt: true, account: '虚构账号', fullContent: '虚构正文',
  docUrl: 'https://docs.qq.com/sheet/MOCK', targetCell: 'E2', targetSheetId: 's', row: 2,
  writeBackOk: false, scheduleId: '',
};
const url = 'https://weibo.com/123/Abc';

test('账号主页与非法形态不能作为回执链接', async () => {
  for (const bad of ['https://weibo.com/1234567890', 'https://weibo.com/u/123', 'https://evil.example/123/Abc', 'https://weibo.com/']) {
    const h = harness({ publishLedger: [{ ...base, id: 'a' }], __unwrittenReceipts__: [] });
    const result = await h.send('MANUAL_RECEIPT_WRITE_BACK', { ledgerId: 'a', postUrl: bad });
    assert.equal(result.ok, false);
    assert.equal(h.data.publishLedger[0].postUrl || '', '');
  }
});

test('运行中的待核对记录不能被补录或解除', async () => {
  const h = harness({ publishLedger: [{ ...base, id: 'a' }], __unwrittenReceipts__: [] });
  h.run(`activePendingSubmissionIds.add('a')`);
  const manual = await h.send('MANUAL_RECEIPT_WRITE_BACK', { ledgerId: 'a', postUrl: url });
  assert.equal(manual.ok, false);
  assert.match(manual.error, /正在发布中/);
  const resolve = await h.send('RESOLVE_PENDING_SUBMISSION', { ledgerId: 'a' });
  assert.equal(resolve.ok, false);
  assert.match(resolve.error, /正在发布中/);
  assert.equal(h.data.publishLedger.length, 1);
});

test('人工核实未发布可解除阻断并保留可重试状态', async () => {
  const h = harness({
    publishLedger: [{ ...base, id: 'a', scheduleId: 'sched_a' }],
    __unwrittenReceipts__: [{ ...base, id: 'a', scheduleId: 'sched_a' }],
    scheduledTasks: [{ id: 'sched_a', status: 'done', submittedWithoutReceipt: true, postUrl: '', writeBackOk: false }],
  });
  const result = await h.send('RESOLVE_PENDING_SUBMISSION', { ledgerId: 'a' });
  assert.equal(result.ok, true);
  assert.equal(h.data.publishLedger.length, 0);
  assert.equal(h.data.__unwrittenReceipts__.length, 0);
  assert.equal(h.data.scheduledTasks[0].status, 'error');
  assert.equal(h.data.scheduledTasks[0].submittedWithoutReceipt, false);
  assert.ok(h.data.scheduledTasks[0].resolvedAt, '解除时间必须落盘以便后续清理');
});

test('解除阻断的定时任务到期后可自动清理', async () => {
  const h = harness({
    publishLedger: [],
    __unwrittenReceipts__: [],
    scheduledTasks: [{ id: 'sched_a', status: 'error', submittedWithoutReceipt: false, resolvedAt: Date.now() - 13 * 60 * 60 * 1000 }],
  });
  const removed = await h.run(`cleanupExpiredDoneSchedules(Date.now())`);
  assert.ok(Number(removed) >= 1);
  assert.equal(h.data.scheduledTasks.length, 0);
});

test('人工补录链接同步关联定时任务并完成补写', async () => {
  const h = harness({
    publishLedger: [{ ...base, id: 'a', scheduleId: 'sched_a' }],
    __unwrittenReceipts__: [{ ...base, id: 'a', scheduleId: 'sched_a' }],
    scheduledTasks: [{ id: 'sched_a', status: 'done', submittedWithoutReceipt: true, postUrl: '', writeBackOk: false, docUrl: 'https://docs.qq.com/sheet/MOCK', targetCell: 'E2' }],
  });
  h.run(`findOrCreateTab = async () => ({ id: 1 }); waitForTabLoaded = async () => {}; holdBackgroundTabAwake = async () => false; executeInTabDirect = async () => ({ ok: true });`);
  const result = await h.send('MANUAL_RECEIPT_WRITE_BACK', { ledgerId: 'a', postUrl: url });
  assert.equal(result.ok, true);
  assert.equal(h.data.publishLedger[0].writeBackOk, true);
  assert.equal(h.data.scheduledTasks[0].postUrl, url);
  assert.equal(h.data.scheduledTasks[0].submittedWithoutReceipt, false);
  assert.equal(h.data.scheduledTasks[0].writeBackOk, true);
});

test('改期清理与发布认领共用串行队列，不互相覆盖', async () => {
  const h = harness({
    scheduledTasks: [
      { id: 't1', status: 'pending', fireAtTimestamp: Date.now() + 60000, fireAtTime: 'x' },
      { id: 't2', status: 'pending', fireAtTimestamp: Date.now() + 60000, fireAtTime: 'x' },
    ],
    __publishClaims__: { 'sched::t2': Date.now() },
  });
  await Promise.all([
    h.run(`handleBatchRescheduleTasks(['t1'], { delayMinutes: 5 })`),
    h.run(`claimPublishTaskLock('post::x', 180000)`),
  ]);
  const claims = h.data.__publishClaims__ || {};
  assert.ok(claims['sched::t2'], '未被改期列表包含的认领锁必须保留');
  assert.ok(claims['post::x'], '并发认领锁不能被改期快照覆盖');
});
