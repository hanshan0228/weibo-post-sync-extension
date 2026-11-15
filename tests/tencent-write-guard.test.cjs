const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../background/service_worker.js'), 'utf8');
const event = () => ({ addListener() {} });
function setup(rows) {
  let writes = 0;
  const sheet = {
    getSheetId: () => 'mock-sheet', getIsInitialized: () => true,
    getRowCount: () => rows.length, getColCount: () => Math.max(...rows.map(r => r.length)),
    getCellDataAtPosition: (r, c) => rows[r]?.[c] ?? '', getSheetName: () => 'Mock',
  };
  const app = {
    workbook: { worksheetManager: { sheetList: [sheet] } },
    e2eTools: { getCellEditValue: (_wb, _r, _c, _sid, cell) => typeof cell === 'object' ? cell.text : cell },
    behaviorApi: { cellApi: { setSingleValue: async (payload) => { writes++; rows[payload.rowIndex][payload.colIndex] = payload.text; } } },
  };
  const c = { console, URL, Uint8Array, window: { SpreadsheetApp: app }, crypto: { randomUUID: () => 'mock' },
    setTimeout: fn => { fn(); return 0; },
    chrome: { storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
      runtime: { onInstalled: event(), onStartup: event(), onMessage: event(), sendMessage: () => Promise.resolve() },
      alarms: { get: (_name, cb) => cb({}), onAlarm: event(), create: () => Promise.resolve() } } };
  vm.createContext(c); vm.runInContext(source, c);
  return { c, writes: () => writes };
}
const url = 'https://weibo.com/detail/MOCK';
function fixture() { return [['账号', '正文', '微博链接'], ['虚构账号甲', '正文甲', ''], ['', '正文乙', '']]; }
function snap(c, index = 1) { return c.directExtractDocTasks('mock-sheet', 'C', '').tasks[index].writeSnapshot; }

test('扫描快照记录动态列与合并账号，匹配后才写入', async () => {
  const rows = fixture(); const { c, writes } = setup(rows); const snapshot = snap(c);
  assert.equal(snapshot.account, '虚构账号甲'); assert.equal(snapshot.contentCol, 1); assert.equal(snapshot.accountCol, 0);
  const result = await c.directWriteCellToDoc('C3', url, 'mock-sheet', snapshot);
  assert.equal(result.ok, true); assert.equal(writes(), 1); assert.equal(rows[2][2], url);
});

test('正文、继承账号或链接变化时阻断，包含相同链接的正文复核', async () => {
  for (const change of ['content', 'account', 'otherLink', 'sameLinkChangedContent', 'readError']) {
    const rows = fixture(); const { c, writes } = setup(rows); const snapshot = snap(c);
    if (change === 'content') rows[2][1] = '变更正文';
    if (change === 'account') rows[1][0] = '虚构账号乙';
    if (change === 'otherLink') rows[2][2] = 'https://weibo.com/detail/OTHER';
    if (change === 'sameLinkChangedContent') { rows[2][2] = url; rows[2][1] = '变更正文'; }
    if (change === 'readError') c.window.SpreadsheetApp.e2eTools.getCellEditValue = () => { throw new Error('mock read error'); };
    const result = await c.directWriteCellToDoc('C3', url, 'mock-sheet', snapshot);
    assert.equal(result.ok, false, change); assert.equal(writes(), 0, change);
  }
});

test('相同链接幂等，隐藏的不同超链接禁止覆盖', async () => {
  for (const same of [true, false]) {
    const rows = fixture(); const { c, writes } = setup(rows); const snapshot = snap(c);
    rows[2][2] = { text: same ? '链接' : '', getCellHyperlinksInfo: () => ({ hyperlinksInfo: [{ hyperlink: { url: same ? url : 'https://weibo.com/detail/OTHER' } }] }) };
    const result = await c.directWriteCellToDoc('C3', url, 'mock-sheet', snapshot);
    assert.equal(result.ok, same); assert.equal(writes(), 0); if (same) assert.equal(result.idempotent, true);
  }
});

test('已写回的账号行仍可供后续合并单元格继承', () => {
  const rows = fixture(); rows[1][2] = 'https://weibo.com/detail/EXISTING';
  const { c } = setup(rows);
  const result = c.directExtractDocTasks('mock-sheet', 'C', '', true);
  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].account, '虚构账号甲');
});

test('发布前严格扫描遇到链接读取失败时不能当作空链接', () => {
  const rows = fixture(); const { c } = setup(rows);
  const originalRead = c.window.SpreadsheetApp.e2eTools.getCellEditValue;
  c.window.SpreadsheetApp.e2eTools.getCellEditValue = (wb, row, col, sid, cell) => {
    if (row === 2 && col === 2) throw new Error('mock link read failure');
    return originalRead(wb, row, col, sid, cell);
  };
  const result = c.directExtractDocTasks('mock-sheet', 'C', '', true);
  assert.equal(result.ok, false);
});

test('旧任务缺快照及坐标或子表不匹配时阻断', async () => {
  const rows = fixture(); const { c, writes } = setup(rows); const snapshot = snap(c);
  for (const item of [undefined, { ...snapshot, row: 2 }, { ...snapshot, contentCol: 2 }, { ...snapshot, sheetId: 'other' }, { ...snapshot, account: '' }]) {
    const result = await c.directWriteCellToDoc('C3', url, 'mock-sheet', item);
    assert.equal(result.ok, false); assert.match(result.error, /快照/);
  }
  assert.equal(writes(), 0);
});
