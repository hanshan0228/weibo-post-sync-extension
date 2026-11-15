const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../background/service_worker.js'), 'utf8');
const event = () => ({ addListener() {} });
function setup(tasks) {
  const c = { console, URL, Uint8Array, setTimeout, clearTimeout, crypto: { randomUUID: () => 'mock' },
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } },
      runtime: { onInstalled: event(), onStartup: event(), onMessage: event(), sendMessage: async () => {} },
      alarms: { get: (_n, cb) => cb({}), onAlarm: event(), create: async () => {} } } };
  vm.createContext(c); vm.runInContext(source, c);
  c.waitForTabLoaded = async () => {};
  c.executeInTabDirect = async () => ({ ok: true, tasks });
  c.scanDingTalkDocTab = async () => ({ ok: true, tasks });
  return c;
}
const original = { row: 3, targetCell: 'C3', content: '旧正文', account: '虚构账号', targetSheetId: 'mock-sheet' };
const item = () => ({ task: { ...original }, taskDocUrl: 'https://docs.qq.com/sheet/mock', taskSheetId: 'mock-sheet', resolvedAccount: '虚构账号' });

test('当前文档匹配时恢复旧任务的安全快照', async () => {
  const snapshot = { sheetId: 'mock-sheet', row: 3, content: '旧正文', account: '虚构账号', accountCol: 0 };
  const c = setup([{ ...original, writeSnapshot: snapshot }]); const b = item();
  await c.verifyCurrentDocumentTasks({ id: 1 }, [b], x => x);
  assert.equal(b.task.writeSnapshot.content, '旧正文');
});

test('正文、账号或目标行改变，以及读取失败时禁止提交', async () => {
  for (const rows of [[{ ...original, content: '新正文' }], [{ ...original, account: '虚构账号乙' }], [], [{ ...original, targetCell: 'C4' }], [{ ...original, imgUrls: ['https://mock.invalid/new.png'] }], [{ ...original, writeSnapshot: { account: '', accountCol: -1 } }]]) {
    const c = setup(rows);
    await assert.rejects(c.verifyCurrentDocumentTasks({ id: 1 }, [item()], x => x));
  }
  const c = setup([]); c.executeInTabDirect = async () => { throw new Error('mock failure'); };
  await assert.rejects(c.verifyCurrentDocumentTasks({ id: 1 }, [item()], x => x));
  await assert.rejects(c.verifyCurrentDocumentTasks(null, [item()], x => x));
});

test('群发逐行检查，纯文本任务不依赖文档', async () => {
  const c = setup([{ ...original, writeSnapshot: { row: 3 } }]);
  const second = item(); second.task = { ...second.task, row: 4, targetCell: 'C4' };
  await assert.rejects(c.verifyCurrentDocumentTasks({ id: 1 }, [item(), second], x => x));
  await c.verifyCurrentDocumentTasks(null, [{ task: { targetCell: '-' } }], x => x);
});
