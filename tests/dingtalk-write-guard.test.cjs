const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../background/service_worker.js'), 'utf8');
const event = () => ({ addListener() {} });
const context = { console, URL, setTimeout, clearTimeout, structuredClone, chrome: {
  runtime: { onInstalled: event(), onStartup: event(), onMessage: event() },
  alarms: { onAlarm: event(), get: (_name, cb) => cb({}), create: async () => {} }, storage: { local: { get: async () => ({}), set: async () => {} } },
} };
vm.createContext(context);
vm.runInContext(source, context);
const snapshot = { account: '虚构账号甲', content: '虚构正文甲' };
const coords = { rowNum: 2, colNum: 3, normAddr: 'C2' };
const link = 'https://weibo.com/999/MockPost';
function payload(value, account = snapshot.account, content = snapshot.content) {
  const row = [[0, { value: account }], [1, { value: content }]];
  if (value !== undefined) row.push([2, { value }]);
  const workbook = { sheetsMeta: [{ id: 's1', title: '模拟表' }], content: { s1: { rows: [
    [0, 0, [[0, { value: '账号' }], [1, { value: '正文' }], [2, { value: '链接' }]]],
    [1, 0, row],
  ] } } };
  return { data: { documentContent: { checkpoint: { content: JSON.stringify(workbook) } } } };
}
function guard(data, snap = snapshot, title = '模拟表', sheet = 's1') {
  return context.validateDingTalkWriteSnapshot(data, sheet, coords, snap, link, title);
}
test('空链接允许，同一链接仅在账号正文一致时幂等', () => {
  assert.equal(guard(payload()).ok, true);
  assert.equal(guard(payload(link)).idempotent, true);
  assert.equal(guard(payload(link, '虚构账号乙')).ok, false);
});
test('不同值、未知格式、错误账号正文和子表均阻断', () => {
  for (const value of ['普通备注', 'https://example.invalid/other', { type: 'unknown' }]) assert.equal(guard(payload(value)).ok, false);
  assert.equal(guard(payload(undefined, '虚构账号乙')).ok, false);
  assert.equal(guard(payload(undefined, snapshot.account, '变更正文')).ok, false);
  assert.equal(guard(payload(), snapshot, '').ok, false);
  assert.equal(guard(payload(), snapshot, '模拟表', 'missing').ok, false);
  assert.equal(guard(payload(), {}).ok, false);
  assert.equal(guard({}, snapshot).ok, false);
});
test('调试通道写入前核验，已有不同内容不得输入', async () => {
  let documentPayload = payload();
  let formula = '';
  let writes = 0;
  context.inspectDingTalkSheetState = async () => ({ currentAddr: 'C2', activeSheetTitle: '模拟表', formulaReadable: true, formulaValue: formula });
  context.fetchDingTalkDocumentPayloadInTab = async () => documentPayload;
  context.dingTalkPointerAllowed = async () => false;
  context.chrome.scripting = { executeScript: async () => [] };
  context.chrome.debugger = {
    attach: async () => {}, detach: async () => {},
    sendCommand: async (_target, method, params) => {
      if (method === 'Input.insertText' && params.text === link) { writes++; formula = link; documentPayload = payload(link); }
    },
  };
  const realTimeout = context.setTimeout;
  context.setTimeout = (fn) => { fn(); return 0; };
  try {
    let result = await context.writeDingTalkCellInTab(1, 'C2', link, 's1', { snapshot });
    assert.equal(result.ok, true);
    assert.equal(writes, 1);
    result = await context.writeDingTalkCellInTab(1, 'C2', link, 's1', { snapshot });
    assert.equal(result.idempotent, true);
    documentPayload = payload('已有备注');
    formula = '已有备注';
    result = await context.writeDingTalkCellInTab(1, 'C2', link, 's1', { snapshot });
    assert.equal(result.ok, false);
    assert.equal(writes, 1);
  } finally { context.setTimeout = realTimeout; delete context.chrome.debugger; }
});
test('无调试器时安全阻断，不执行注入', async () => {
  let injected = false;
  context.chrome.scripting = { executeScript: async () => { injected = true; } };
  const result = await context.writeDingTalkCellInTab(1, 'C2', link, 's1', { snapshot });
  assert.equal(result.ok, false);
  assert.equal(injected, false);
});
