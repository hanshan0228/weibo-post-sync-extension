'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../background/service_worker.js'), 'utf8');

function harness(initial = {}) {
  let data = structuredClone(initial);
  const messages = [], alarms = new Map(), listeners = [], calls = [];
  const event = { addListener() {} };
  const chrome = {
    storage: { local: {
      get(keys, callback) {
        const value = Object.fromEntries(keys.filter(k => k in data).map(k => [k, structuredClone(data[k])]));
        if (callback) callback(value);
        return Promise.resolve(value);
      },
      async set(value) { data = { ...data, ...structuredClone(value) }; calls.push(['storage', structuredClone(value)]); }
    } },
    declarativeNetRequest: { async updateDynamicRules() {} },
    runtime: { onInstalled: event, onStartup: event, onMessage: { addListener(fn) { listeners.push(fn); } },
      async sendMessage(message) { messages.push(message); }, async getPlatformInfo() { return {}; } },
    alarms: { get(name, callback) { callback(alarms.get(name)); }, async create(name, value) { alarms.set(name, value); },
      async clear(name) { alarms.delete(name); return true; }, async clearAll() { alarms.clear(); }, onAlarm: event },
    tabs: { async get(id) { return { id, url: 'https://ai-publish-platform.weibo.com/#/post', status: 'complete' }; },
      async update(id, value) { calls.push(['tab.update', id, value]); return { id, ...value }; },
      async reload() {}, async create(value) { calls.push(['tab.create', value]); return { id: 123, ...value }; }, async query() { return []; } },
    windows: { async remove() {}, async update() {} }, scripting: { async executeScript() { throw new Error('Unexpected real injection'); } }
  };
  const context = vm.createContext({ chrome, console, URL, Date, setTimeout: (fn, ms) => ms <= 2000 ? (queueMicrotask(fn), 1) : 1,
    clearTimeout() {}, setInterval() { return 1; }, clearInterval() {}, fetch() { throw new Error('Network disabled in tests'); },
    btoa: s => Buffer.from(s, 'binary').toString('base64'), Uint8Array });
  vm.runInContext(source, context, { filename: path.join(__dirname, '../background/service_worker.js') });
  return { context, chrome, calls, messages, alarms, get data() { return data; },
    run(code) { return vm.runInContext(code, context); },
    async send(request) { return new Promise(resolve => listeners[0](request, {}, resolve)); } };
}
function stubPipeline(h, result = { ok: true, postUrl: 'https://weibo.com/123456/Abc123', dryRun: false }) {
  h.context.testResult = result;
  h.run(`verifyCurrentDocumentTasks = async () => {};
    findOrCreateTab = async () => ({ id: 7 });
    waitForTabLoaded = async () => ({ id: 7, url: 'https://ai-publish-platform.weibo.com/#/post', status: 'complete' });
    createSilentRunnerWindow = async () => ({ window: { id: 8 }, tab: { id: 7 } });
    executeInTabDirect = async (id, func) => {
      if (func === directWriteCellToDoc) { chrome.runtime.sendMessage({ action: 'TEST_WRITE' }); return { ok: true }; }
      if (func === directPostToWeiboPlatform || func === directPostPollToWeiboHome) return testResult;
      if (func === directRecoverPublishedWeiboUrl) { chrome.runtime.sendMessage({ action: 'TEST_RECOVERY' }); return { ok: true, postUrl: 'https://weibo.com/123456/Old123' }; }
      return { ok: true };
    };`);
}
const task = { id: 'parsed_1', account: 'Mock账号', content: 'Mock正文', row: 2, docId: 'slot_1',
  docUrl: 'https://docs.qq.com/sheet/MOCK', targetCell: 'E2', targetSheetId: 'mock_sheet' };

test('清空账本串行保留全部待回写和待核对证据', async () => {
  const retained = Array.from({ length: 650 }, (_, i) => ({ id: `r${i}`, mode: '真实发布', postUrl: `https://weibo.com/detail/${i}`, writeBackOk: false }));
  const h = harness({ publishLedger: [{ id: 'pending', mode: '真实发布', submittedWithoutReceipt: true }, retained[0]], __unwrittenReceipts__: retained });
  const response = await h.send({ action: 'CLEAR_PUBLISH_LEDGER' });
  assert.equal(response.ok, true);
  assert.equal(h.data.publishLedger.length, 0);
  assert.equal(h.data.__unwrittenReceipts__.length, 651);
  assert.equal(new Set(h.data.__unwrittenReceipts__.map(item => item.id)).size, 651);
});

test('清空与后台新增回执并发时不丢失新记录', async () => {
  const h = harness({ publishLedger: [], __unwrittenReceipts__: [] });
  const add = h.run(`withScheduleMutation(async () => {
    const { publishLedger = [] } = await chrome.storage.local.get(['publishLedger']);
    await chrome.storage.local.set({ publishLedger: [{ id: 'new', mode: '真实发布', postUrl: 'https://weibo.com/detail/MOCK', writeBackOk: false }, ...publishLedger] });
  })`);
  const clear = h.send({ action: 'CLEAR_PUBLISH_LEDGER' });
  await Promise.all([add, clear]);
  assert.ok([...h.data.publishLedger, ...h.data.__unwrittenReceipts__].some(item => item.id === 'new'));
});

test('STOP只请求取消，不提前释放流水线排他锁', async () => {
  const h = harness();
  h.run('state.isRunning = true; activeJob = { aborted: false };');
  await h.send({ action: 'STOP_PIPELINE' });
  assert.equal(h.run('state.isRunning'), true);
  assert.equal(h.run('activeJob.aborted'), true);
  await assert.rejects(h.run('startPipeline({})'), /正在执行/);
});
test('演练不回写真实云文档，也不生成真实已发布计数', async () => {
  const h = harness(); stubPipeline(h, { ok: true, postUrl: 'https://weibo.com/detail/mock_dryrun_123', dryRun: true });
  const summary = await h.run(`startPipeline(${JSON.stringify({ dryRun: true, selectedTasks: [task] })})`);
  assert.equal(h.messages.some(m => m.action === 'TEST_WRITE'), false);
  assert.equal(summary.published, 0); assert.equal(summary.rehearsed, 1);
  const completed = h.messages.find(m => m.action === 'TASK_ITEM_COMPLETED').payload;
  assert.equal(completed.dryRun, true); assert.equal(completed.writeBackOk, false); assert.equal(completed.docId, 'slot_1');
});
test('真实发布前复核失败时不会调用发布函数', async () => {
  const h = harness();
  h.run('var actualPreflight = verifyCurrentDocumentTasks');
  stubPipeline(h);
  h.run(`verifyCurrentDocumentTasks = actualPreflight;
    executeInTabDirect = async (_id, fn) => {
      if (fn === directExtractDocTasks) return { ok: true, tasks: [] };
      if (fn === directPostToWeiboPlatform) { chrome.runtime.sendMessage({ action: 'TEST_POST' }); return { ok: true }; }
      return { ok: true };
    };`);
  await assert.rejects(h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`), /重新扫描/);
  assert.equal(h.messages.some(m => m.action === 'TEST_POST'), false);
});

test('旧定时任务复核所得快照会随发布回执保存', async () => {
  const scheduled = { ...task, id: 'sched_mock', fromSchedule: true };
  const h = harness({ scheduledTasks: [scheduled] });
  stubPipeline(h);
  h.run(`verifyCurrentDocumentTasks = async (_tab, items) => {
    items[0].task.writeSnapshot = { account: 'Mock账号', content: 'Mock正文', accountCol: 0 };
  };`);
  await h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [scheduled] })})`);
  assert.equal(h.data.scheduledTasks[0].writeSnapshot.content, 'Mock正文');
});

test('拦截重复发博时不得释放上一次仍有效的锁', async () => {
  const key = 'post::Mock账号::Mock正文';
  const h = harness({ __publishClaims__: { [key]: Date.now() } });
  stubPipeline(h);
  await assert.rejects(h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`), /已拦截重复发博/);
  assert.equal(typeof h.data.__publishClaims__[key], 'number');
});
test('已关闭的发博标签页会重开后继续发布', async () => {
  const h = harness();
  stubPipeline(h);
  h.run(`let opens = 0;
    findOrCreateTab = async () => ({ id: 1004325714 });`);
  h.chrome.tabs.get = async (id) => {
    if (id === 1004325714) throw new Error('No tab with id: 1004325714');
    return { id, url: 'https://ai-publish-platform.weibo.com/#/post', status: 'complete' };
  };
  h.chrome.tabs.create = async (value) => {
    h.calls.push(['tab.create', value]);
    return { id: 77, ...value };
  };
  const summary = await h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`);
  assert.equal(summary.published, 1);
  assert.equal(h.calls.filter(([type]) => type === 'tab.create').length, 1);
});
test('明确未提交的失败会释放内容锁，允许立刻重试同一文案', async () => {
  const h = harness();
  stubPipeline(h, { ok: false, submitted: false, error: '未找到目标账号' });
  await assert.rejects(h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`), /未找到目标账号/);
  assert.deepEqual(h.data.__publishClaims__ || {}, {});
  stubPipeline(h);
  const summary = await h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`);
  assert.equal(summary.published, 1);
});
test('注入前持久化群发成员，中断后重启及锁过期仍阻断定时重发', async () => {
  const scheduled = [task, { ...task, id: 'sched_mock_2', fromSchedule: true, account: 'Mock账号二', row: 3, targetCell: 'E3' }];
  scheduled[0] = { ...scheduled[0], id: 'sched_mock_1', fromSchedule: true };
  const h = harness({ scheduledTasks: scheduled }); stubPipeline(h);
  h.run(`executeInTabDirect = async (_id, fn) => {
    if (fn === directPostToWeiboPlatform) {
      const saved = await chrome.storage.local.get(['publishLedger']);
      if (saved.publishLedger.length !== 2 || !saved.publishLedger.every(x => x.submittedWithoutReceipt)) throw new Error('落盘时序错误');
      throw new Error('Mock中断');
    }
    return { ok: true };
  };`);
  await assert.rejects(h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: scheduled })})`), /Mock中断/);
  const restarted = harness({ ...h.data, __publishClaims__: {} }); stubPipeline(restarted);
  for (const item of scheduled) {
    await assert.rejects(restarted.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [item] })})`), /缺少回执/);
  }
  assert.equal(restarted.data.publishLedger.filter(x => x.submittedWithoutReceipt).length, 2);
});

test('缺少发布按钮明确未提交并撤销待确认记录', async () => {
  const h = harness();
  assert.match(h.run('directPostToWeiboPlatform.toString()'), /submitted:\s*false,\s*error:\s*"未在发稿页定位到【保存并发布】提交按钮"/);
  stubPipeline(h, { ok: false, submitted: false, error: '未在发稿页定位到【保存并发布】提交按钮' });
  await assert.rejects(h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`), /未在发稿页定位/);
  assert.equal(h.data.publishLedger.length, 0);
  assert.equal(h.data.__unwrittenReceipts__.length, 0);
});

test('待确认账号正文换文档行且锁过期仍阻止重发', async () => {
  const pending = { id: 'pending', submittedWithoutReceipt: true, resolvedAccount: task.account, fullContent: task.content,
    docUrl: task.docUrl, targetCell: task.targetCell };
  const h = harness({ publishLedger: [pending], __publishClaims__: {} }); stubPipeline(h);
  const moved = { ...task, docUrl: 'https://docs.qq.com/sheet/OTHER', targetCell: 'E99', row: 99, content: ` ${task.content} ` };
  await assert.rejects(h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [moved] })})`), /缺少回执/);
  assert.equal(h.data.publishLedger.length, 1);
});

test('成功回执升级待确认记录，且不遗留待确认副本', async () => {
  const h = harness(); stubPipeline(h);
  await h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`);
  assert.equal(h.data.publishLedger.length, 1);
  assert.equal(h.data.publishLedger[0].postUrl, 'https://weibo.com/123456/Abc123');
  assert.equal(h.data.publishLedger.some(x => x.submittedWithoutReceipt), false);
  assert.equal(h.data.__unwrittenReceipts__.some(x => x.submittedWithoutReceipt), false);
});

test('已明确未提交的失败不得恢复其他博文链接并伪报成功', async () => {
  const h = harness(); stubPipeline(h, { ok: false, submitted: false, error: '未找到目标账号' });
  await assert.rejects(h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`), /未找到目标账号/);
  assert.equal(h.messages.some(m => m.action === 'TEST_RECOVERY'), false);
});
test('真实发布缺回执必须失败，不制造mock链接', async () => {
  const h = harness(); stubPipeline(h, { ok: true, dryRun: false });
  await assert.rejects(h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`), /回执|链接/);
  assert.equal(h.data.publishLedger.length, 1);
  assert.equal(h.data.publishLedger[0].submittedWithoutReceipt, true);
  assert.equal(h.data.publishLedger[0].postUrl, '');
});
test('发布已成功但写回异常仍保留回执与完成状态，防止重发', async () => {
  const h = harness({ scheduledTasks: [{ ...task, id: 'sched_1', status: 'firing' }] }); stubPipeline(h);
  h.run(`const originalExecute = executeInTabDirect; executeInTabDirect = async (id, fn, ...rest) => {
    if (fn === directWriteCellToDoc) throw new Error('Mock写回故障'); return originalExecute(id, fn, ...rest);
  };`);
  await h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [{ ...task, id: 'sched_1', fromSchedule: true }] })})`);
  const saved = h.data.scheduledTasks[0];
  assert.equal(saved.status, 'done'); assert.equal(saved.postUrl, 'https://weibo.com/123456/Abc123');
  assert.match(saved.writeBackError, /Mock写回故障/); assert.equal(h.data.publishLedger.length, 1);
});
test('投票仅装配不算真实发布，并保留每个草稿页', async () => {
  const h = harness(); stubPipeline(h, { ok: true, preparedOnly: true, dryRun: false });
  const pollTask = { ...task, poll: { title: 'Mock?', options: ['A', 'B'] } };
  const summary = await h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [pollTask, { ...pollTask, row: 3 }] })})`);
  assert.equal(summary.published, 0); assert.equal(summary.prepared, 2);
  assert.equal(h.messages.some(m => m.action === 'TEST_WRITE'), false);
  assert.ok(h.calls.some(c => c[0] === 'tab.create'), '下一条任务使用新页面避免覆盖待人工发送草稿');
});
test('解析生成的无云文档任务允许立即执行并按fromSchedule追踪', async () => {
  const h = harness({ scheduledTasks: [{ id: 'parsed_1', status: 'pending', account: 'Mock账号', content: 'Mock正文', targetCell: '-', dryRun: true }] });
  h.run(`startPipeline = async config => { chrome.runtime.sendMessage({ action: 'TEST_START', payload: config }); return {}; };`);
  await h.run(`handleFireScheduleNow('parsed_1')`);
  await new Promise(resolve => setImmediate(resolve));
  const config = h.messages.find(m => m.action === 'TEST_START').payload;
  assert.equal(config.selectedTasks[0].fromSchedule, true);
  assert.notEqual(h.data.scheduledTasks[0].status, 'firing');
});
test('已完成任务不能再次立即发布', async () => {
  const h = harness({ scheduledTasks: [{ ...task, id: 'sched_done', status: 'done' }] });
  h.run('startPipeline = async () => ({});');
  await assert.rejects(h.run(`handleFireScheduleNow('sched_done')`), /完成|发布中|不可/);
});
test('批量中途失败不能把已完成任务覆盖为error', async () => {
  const h = harness({ scheduledTasks: [{ ...task, id: 'sched_1', status: 'pending' }, { ...task, id: 'sched_2', status: 'pending' }] });
  h.run(`startPipeline = async () => { const { scheduledTasks } = await chrome.storage.local.get(['scheduledTasks']);
    scheduledTasks[0].status = 'done'; scheduledTasks[0].postUrl = 'https://weibo.com/123456/Abc123';
    await chrome.storage.local.set({ scheduledTasks }); throw new Error('第二条失败'); };`);
  await h.run(`handleBatchFireSchedule(['sched_1', 'sched_2'])`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.data.scheduledTasks[0].status, 'done'); assert.equal(h.data.scheduledTasks[1].status, 'error');
});
test('编辑定时任务先落盘再触发，账号允许清空', async () => {
  const h = harness({ scheduledTasks: [{ ...task, id: 'sched_1', status: 'error', fireAtTimestamp: Date.now() + 999999 }] });
  h.run(`sweepAndRunDueSchedules = async () => { const { scheduledTasks } = await chrome.storage.local.get(['scheduledTasks']);
    chrome.runtime.sendMessage({ action: 'TEST_SWEEP', payload: scheduledTasks[0] }); };`);
  const ts = Date.now() - 1000;
  await h.run(`handleUpdateScheduleTask('sched_1', { account: '', fireAtTimestamp: ${ts} })`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.data.scheduledTasks[0].account, '');
  const observed = h.messages.find(m => m.action === 'TEST_SWEEP').payload;
  assert.equal(observed.fireAtTimestamp, ts); assert.equal(observed.status, 'pending');
});
test('编辑发布中的任务被拒绝，非法排程时间被拒绝', async () => {
  const h = harness({ scheduledTasks: [{ ...task, id: 'sched_1', status: 'firing' }] });
  await assert.rejects(h.run(`handleUpdateScheduleTask('sched_1', { content: '改写' })`), /发布中|执行中/);
  await assert.rejects(h.run(`handleAddScheduleTasks([{ content: 'Mock', fireAtTimestamp: NaN }])`), /时间/);
});
test('并发加入定时任务不丢失，重复ID被拒绝', async () => {
  const h = harness();
  await h.run(`Promise.all([handleAddScheduleTasks([{id:'a',content:'Mock A',fireAtTimestamp:Date.now()+999999}]),
    handleAddScheduleTasks([{id:'b',content:'Mock B',fireAtTimestamp:Date.now()+999999}])])`);
  assert.equal(h.data.scheduledTasks.length, 2);
  await assert.rejects(h.run(`handleAddScheduleTasks([{id:'a',content:'重复Mock',fireAtTimestamp:Date.now()+999999}])`), /重复/);
});
test('到期扫描不提前执行未来任务，逐条尊重各自演练模式', async () => {
  const now = Date.now();
  const h = harness({ scheduledTasks: [
    { ...task, id: 'future', status: 'pending', fireAtTimestamp: now + 4000 },
    { ...task, id: 'due-dry', status: 'pending', dryRun: true, fireAtTimestamp: now - 1000 },
    { ...task, id: 'due-live', status: 'pending', dryRun: false, fireAtTimestamp: now - 1000 }
  ] });
  h.run(`startPipeline = async config => { chrome.runtime.sendMessage({action:'TEST_START',payload:config}); };`);
  await h.run('sweepAndRunDueSchedules()');
  const config = h.messages.find(m => m.action === 'TEST_START').payload;
  assert.equal(config.selectedTasks.length, 2); assert.equal(config.useTaskDryRun, true);
});

test('切换演练模式只更新pending，保留完成历史与运行中任务', async () => {
  const h = harness({ scheduledTasks: [
    { id: 'pending', status: 'pending', dryRun: true },
    { id: 'done', status: 'done', dryRun: true },
    { id: 'firing', status: 'firing', dryRun: true }
  ] });
  const response = await h.send({ action: 'SET_DRY_RUN_MODE', dryRun: false });
  assert.equal(response.ok, true); assert.equal(h.data.dryRun, false);
  assert.deepEqual(h.data.scheduledTasks.map(t => t.dryRun), [false, true, true]);
});
test('并发立即发布被排他预订阻断，不抢占或丢失任务', async () => {
  const h = harness({ scheduledTasks: [{ ...task, id: 'a', status: 'pending' }, { ...task, id: 'b', status: 'pending' }] });
  h.run('startPipeline = () => new Promise(() => {});');
  await h.run(`handleFireScheduleNow('a')`);
  await assert.rejects(h.run(`handleFireScheduleNow('b')`), /正在执行/);
  assert.equal(h.data.scheduledTasks[1].status, 'pending');
});
test('执行中任务不允许被单条删除、批量删除或清空', async () => {
  const h = harness({ scheduledTasks: [{ ...task, id: 'running', status: 'firing' }] });
  await assert.rejects(h.run(`handleCancelScheduleTask('running')`), /发布中/);
  await assert.rejects(h.run(`handleBatchCancelSchedule(['running'])`), /发布中/);
  await assert.rejects(h.run('handleClearAllSchedule()'), /发布中/);
  assert.equal(h.data.scheduledTasks.length, 1);
});
test('清空队列只移除任务闹钟，保留心跳和无关闹钟', async () => {
  const h = harness({ scheduledTasks: [{ id: 'cancel', status: 'pending' }] });
  h.alarms.set('cancel', {}); h.alarms.set('unrelated', {});
  await h.run('handleClearAllSchedule()');
  assert.equal(h.alarms.has('cancel'), false); assert.equal(h.alarms.has('unrelated'), true);
  assert.equal(h.alarms.has('__schedule_heartbeat__'), true);
});
test('扫描全部失败不能伪报为没有待发任务', async () => {
  const h = harness();
  h.run(`findOrCreateTab = async () => ({id:7}); waitForTabLoaded = async () => ({});
    executeInTabDirect = async () => ({ok:false,error:'Mock表格运行时未加载'});`);
  await assert.rejects(h.run(`scanDocTasks({docUrl:'https://docs.qq.com/sheet/MOCK'})`), /所有文档扫描失败/);
});
test('配图部分下载失败阻断漏图发布', async () => {
  const h = harness(); stubPipeline(h);
  h.run(`downloadImagesViaDocTab = async () => [{dataUrl:'data:image/png;base64,AA=='}];`);
  await assert.rejects(h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [{ ...task, imgUrls: ['https://mock.invalid/1.png','https://mock.invalid/2.png'] }] })})`), /配图提取不完整/);
  assert.equal(h.data.publishLedger?.length || 0, 0);
});
test('文档页只下到部分配图时按原链接补齐后再发布', async () => {
  const h = harness(); stubPipeline(h);
  h.run(`downloadImagesViaDocTab = async (_id, _doc, urls) => [{ url: urls[0], dataUrl: 'data:image/png;base64,QQ==', mime: 'image/png' }];
    fetchImageAsBase64 = async (url) => ({ url, dataUrl: 'data:image/jpeg;base64,/9j/QQ==', mime: 'image/jpeg' });`);
  const summary = await h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [{ ...task, imgUrls: ['https://mock.invalid/1.png','https://mock.invalid/2.jpg'] }] })})`);
  assert.equal(summary.published, 1);
});
test('停止发生在准备阶段时不得再提交本条任务', async () => {
  const h = harness(); stubPipeline(h);
  h.run(`downloadImagesViaDocTab = async () => { activeJob.aborted = true; return [{dataUrl:'data:image/png;base64,AA=='}]; };`);
  await assert.rejects(h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [{ ...task, imgUrls: ['https://mock.invalid/1.png'] }] })})`), /手动取消/);
  assert.equal(h.data.publishLedger?.length || 0, 0);
});
test('停止发生在发布锁认领期间时仍应阻断本条提交', async () => {
  const h = harness(); stubPipeline(h);
  h.run(`claimPublishTaskLock = async () => { activeJob.aborted = true; return true; };`);
  await assert.rejects(h.run(`startPipeline(${JSON.stringify({ dryRun:false, selectedTasks:[task] })})`), /手动取消/);
  assert.equal(h.data.publishLedger?.length || 0, 0);
});
test('已保存回执的文档行重试仅补写，不重新调用发布函数', async () => {
  const h = harness({ publishLedger: [{ mode:'真实发布', docUrl:task.docUrl, targetCell:task.targetCell,
    targetSheetId:task.targetSheetId, resolvedAccount:task.account, fullContent:task.content,
    postUrl:'https://weibo.com/123456/Abc123', writeBackOk:false }] });
  stubPipeline(h);
  h.run(`const runBefore = executeInTabDirect; executeInTabDirect = async (id, fn, ...rest) => {
    if (fn === directPostToWeiboPlatform) throw new Error('禁止再次发布'); return runBefore(id, fn, ...rest); };`);
  const result = await h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`);
  assert.equal(result.writtenBack, 1);
});
test('缺失firingAt的旧僵死任务可被识别，不永久卡在发布中', async () => {
  const h = harness({ scheduledTasks: [{ id:'stale', status:'firing' }] });
  await h.run('sweepAndRunDueSchedules()');
  assert.equal(h.data.scheduledTasks[0].status, 'error');
});
test('复用文档标签页必须匹配完整路径，不能把ABC2当成ABC', async () => {
  const h = harness();
  h.chrome.tabs.query = async () => [{id:99, url:'https://docs.qq.com/sheet/ABC2',status:'complete'}];
  const tab = await h.run(`findOrCreateTab('https://docs.qq.com/sheet/ABC', 'https://docs.qq.com/sheet/ABC?tab=one')`);
  assert.equal(tab.id, 123);
});
test('页面返回错误回执URL时不允许写回或记为已发布', async () => {
  const h = harness(); stubPipeline(h, {ok:true, postUrl:'https://example.invalid/old'});
  await assert.rejects(h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`), /有效博文回执/);
  assert.equal(h.messages.some(m => m.action === 'TEST_WRITE'), false);
});

test('清空账本后通过隔离回执集合阻止真实重发并仅补写', async () => {
  const h = harness({
    publishLedger: [],
    __unwrittenReceipts__: [{
      mode: '真实发布',
      docUrl: task.docUrl,
      targetCell: task.targetCell,
      targetSheetId: task.targetSheetId,
      resolvedAccount: task.account,
      fullContent: task.content,
      postUrl: 'https://weibo.com/123456/Abc123',
      writeBackOk: false,
    }],
  });
  stubPipeline(h);
  h.run(`const runBefore = executeInTabDirect; executeInTabDirect = async (id, fn, ...rest) => {
    if (fn === directPostToWeiboPlatform) throw new Error('禁止再次发布'); return runBefore(id, fn, ...rest); };`);
  const result = await h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`);
  assert.equal(result.writtenBack, 1);
  assert.equal(h.data.__unwrittenReceipts__.length, 0);
});

test('预检探测到登录跳页时直接弹出登录提示且不调用发博函数', async () => {
  const h = harness();
  stubPipeline(h);
  h.run(`executeInTabDirect = async (id, fn) => {
    if (fn === directCheckWeiboPlatformReady) return { ok: false, needLogin: true, error: '发稿中台当前未登录' };
    if (fn === directPostToWeiboPlatform) throw new Error('禁止进入发博函数');
    return { ok: true };
  };`);
  await assert.rejects(
    h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`),
    /发稿中台当前未登录/
  );
  assert.equal(h.data.publishLedger?.length || 0, 0);
});

test('点击发布后返回空结果但sessionStorage确认已提交时，留在结果页复制链接并写回', async () => {
  const h = harness();
  stubPipeline(h);
  h.run(`const runBefore = executeInTabDirect;
    executeInTabDirect = async (id, fn, args, ...rest) => {
      if (fn === directCheckWeiboPlatformReady) return { ok: true, ready: true };
      if (fn === directPostToWeiboPlatform) throw new Error('页面执行函数返回了空结果 (undefined/null)');
      if (fn === directCopyPublishPageResult) return { ok: true, postUrl: 'https://weibo.com/123456/ResultCopy123', source: 'publish_model' };
      if (typeof fn === 'function' && fn !== directWriteCellToDoc && fn !== directRecoverPublishedWeiboUrl) {
        return { submitted: true };
      }
      return runBefore(id, fn, args, ...rest);
    };`);
  const result = await h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`);
  assert.equal(result.published, 1);
  assert.equal(result.writtenBack, 1);
  assert.equal(h.messages.some(m => m.action === 'TEST_WRITE'), true);
  assert.equal(h.messages.some(m => m.action === 'TEST_RECOVERY'), false);
});

test('钉钉文档可解析checkpoint子表、asl富文本、真实行号与相对路径配图', async () => {
  const h = harness();
  const workbook = {
    sheetsMeta: [
      { id: 'sheet_media', title: '媒介排期' },
      { id: 'sheet_copy', title: '运营文案' },
    ],
    content: {
      sheet_media: {
        rows: [
          [0, 0, [[0, { value: '账号' }], [1, { value: '文案' }], [2, { value: '链接' }]]],
        ],
      },
      sheet_copy: {
        rows: [
          [0, 0, [[0, { value: '平台' }], [1, { value: '账号' }], [2, { value: '文案' }], [3, { value: '素材' }], [4, { value: '时间' }], [5, { value: '链接' }]]],
          [2, 0, [
            [0, { value: '微博' }],
            [1, { value: 'Mock测试号A' }],
            [2, { value: { type: 'asl', data: [['p', {}, '这是第一条', ['span', {}, '钉钉正文']]] } }],
            [3, { value: { type: 'asl', data: [['img', { src: '/core/api/resources/img/mock1.png' }]] } }],
            [4, { value: 0.736111111111111 }],
          ]],
          [4, 0, [
            [2, { value: '延续账号的第二条' }],
            [3, { value: { type: 'image', url: '//alidocs.dingtalk.com/core/api/resources/img/mock2.jpg' } }],
            [5, { value: 'https://weibo.com/123/AlreadyDone' }],
          ]],
          [6, 0, [
            [2, { value: '第三条待发正文' }],
            [3, { value: { type: 'image', url: 'https://alidocs.dingtalk.com/core/api/resources/img/mock3.png' } }],
          ]],
        ],
      },
    },
  };
  const payload = { data: { documentContent: { checkpoint: { content: JSON.stringify(workbook) } } } };
  const res = await h.run(`parseDingTalkDocumentPayload(${JSON.stringify(payload)})`);
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'DingTalk');
  assert.equal(res.sheetName, '运营文案');
  assert.equal(res.tasks.length, 2);
  assert.equal(res.tasks[0].row, 3);
  assert.equal(res.tasks[0].account, 'Mock测试号A');
  assert.equal(res.tasks[0].content, '这是第一条钉钉正文');
  assert.equal(res.tasks[0].time, '17:40:00');
  assert.equal(res.tasks[0].targetCell, 'F3');
  assert.deepEqual([...res.tasks[0].imgUrls], ['https://alidocs.dingtalk.com/core/api/resources/img/mock1.png']);
  assert.equal(res.tasks[1].row, 7);
  assert.equal(res.tasks[1].account, 'Mock测试号A');
  assert.equal(res.tasks[1].targetCell, 'F7');
  assert.deepEqual([...res.tasks[1].imgUrls], ['https://alidocs.dingtalk.com/core/api/resources/img/mock3.png']);
});

test('钉钉文档扫描与反链接回写走allFrames接口读取与回读校验', async () => {
  const h = harness();
  const workbookBefore = {
    sheetsMeta: [{ id: 's1', title: '运营文案' }],
    content: {
      s1: {
        rows: [
          [0, 0, [[0, { value: '账号' }], [1, { value: '正文' }], [2, { value: '链接' }]]],
          [1, 0, [[0, { value: 'Mock测试号' }], [1, { value: '钉钉回写测试正文' }]]],
        ],
      },
    },
  };
  const workbookAfter = {
    sheetsMeta: [{ id: 's1', title: '运营文案' }],
    content: {
      s1: {
        rows: [
          [0, 0, [[0, { value: '账号' }], [1, { value: '正文' }], [2, { value: '链接' }]]],
          [1, 0, [[0, { value: 'Mock测试号' }], [1, { value: '钉钉回写测试正文' }], [2, { value: 'https://weibo.com/999/MockPost' }]]],
        ],
      },
    },
  };
  h.run(`
    chrome.tabs.query = async () => [{ id: 88, url: 'https://alidocs.dingtalk.com/i/nodes/MOCKNODE', status: 'complete' }];
    chrome.tabs.get = async (id) => ({ id, url: 'https://alidocs.dingtalk.com/i/nodes/MOCKNODE', status: 'complete' });
    let wrote = false;
    chrome.scripting.executeScript = async ({ target, args }) => {
      if (args && args.length === 2) {
        wrote = true;
        return [{ result: { ok: true, navigated: true, written: true } }];
      }
      const wb = wrote ? ${JSON.stringify(workbookAfter)} : ${JSON.stringify(workbookBefore)};
      return [{
        result: {
          isSheetFrame: true,
          hasContent: true,
          payload: { data: { documentContent: { checkpoint: { content: JSON.stringify(wb) } } } }
        }
      }];
    };
  `);

  const tasks = await h.run(`scanDocTasks({ docs: [{ id: 'd1', name: '钉钉测试表', url: 'https://alidocs.dingtalk.com/i/nodes/MOCKNODE', linkCol: 'C' }] })`);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].provider, 'DingTalk');
  assert.equal(tasks[0].targetCell, 'C2');

  const writeRes = await h.run(`writeDingTalkCellInTab(88, 'C2', 'https://weibo.com/999/MockPost', 's1')`);
  assert.equal(writeRes.ok, false);
  assert.match(writeRes.error, /阻断写入/);
});

test('钉钉写回不切用户当前页，也不在前台窗口点鼠标', async () => {
  const h = harness();
  h.chrome.debugger = {
    async attach() { h.calls.push(['debugger.attach']); },
    async detach() {},
    async sendCommand(_target, method, params) {
      h.calls.push(['cdp', method, params && params.type]);
    },
  };
  h.chrome.windows.get = async (id) => ({ id, focused: false, type: 'normal' });
  h.chrome.tabs.get = async (id) => ({
    id, windowId: 1, active: false, url: 'https://alidocs.dingtalk.com/i/nodes/MOCK', status: 'complete',
  });
  assert.equal(await h.run('dingTalkPointerAllowed(88)'), true);
  h.chrome.tabs.get = async (id) => ({
    id, windowId: 1, active: true, url: 'https://alidocs.dingtalk.com/i/nodes/MOCK', status: 'complete',
  });
  assert.equal(await h.run('dingTalkPointerAllowed(88)'), false);
  h.chrome.windows.get = async (id) => ({ id, focused: true, type: 'normal' });
  h.chrome.tabs.get = async (id) => ({
    id, windowId: 1, active: false, url: 'https://alidocs.dingtalk.com/i/nodes/MOCK', status: 'complete',
  });
  h.chrome.scripting.executeScript = async () => [{
    result: { isSheetFrame: true, currentAddr: 'A1', formulaValue: '', foundInp: true, focused: true, val: 'C2', activeTag: 'INPUT' },
  }];
  const blocked = await h.run(`writeDingTalkCellInTab(88, 'C2', 'https://weibo.com/999/MockPost', 's1')`);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /名称框未能定位/);
  assert.equal(h.calls.some((c) => c[0] === 'tab.update' && c[2] && c[2].active === true), false);
  assert.equal(h.calls.some((c) => c[0] === 'cdp' && c[1] === 'Input.dispatchMouseEvent'), false);
});

test('钉钉写回不再弹出离屏窗口', async () => {
  const h = harness();
  stubPipeline(h);
  h.run(`let docOpens = 0; const origRunner = createSilentRunnerWindow;
    createSilentRunnerWindow = async (url) => {
      if (String(url).includes('alidocs.dingtalk.com')) docOpens += 1;
      return origRunner(url);
    };`);
  const dingTask = { ...task, docUrl: 'https://alidocs.dingtalk.com/i/nodes/MOCKNODE', targetCell: 'C2' };
  const summary = await h.run(`startPipeline(${JSON.stringify({ dryRun: false, silentMode: true, selectedTasks: [dingTask] })})`);
  assert.equal(summary.published, 1);
  assert.equal(h.run('docOpens'), 0);
  assert.equal(h.messages.some((m) => m.action === 'PIPELINE_LOG' && String(m.payload.detail).includes('不切换当前页面')), true);
});

test('转发任务把原微博链接交给发博函数，不再拦截成不支持', async () => {
  const h = harness();
  stubPipeline(h);
  h.run(`var seenRepost = null; const originalExecute = executeInTabDirect;
    executeInTabDirect = async (id, fn, args) => {
      if (fn === directPostToWeiboPlatform) { seenRepost = args[0]; return testResult; }
      return originalExecute(id, fn, args);
    };`);
  const repostTask = {
    ...task,
    content: '转发评论文案',
    repostUrl: 'https://weibo.com/6723451236/Rr20v8BXT',
    commentOriginal: true,
  };
  const summary = await h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [repostTask] })})`);
  assert.equal(summary.published, 1);
  assert.equal(h.run('seenRepost.repostUrl'), repostTask.repostUrl);
  assert.equal(h.run('seenRepost.commentOriginal'), true);
  assert.equal(h.run('seenRepost.content'), repostTask.content);
});

test('静默发博窗口不得再使用屏幕外坐标', async () => {
  const h = harness();
  const created = [];
  h.chrome.windows.getCurrent = async () => ({ id: 3, left: 0, top: 0, width: 1280, height: 800, focused: true });
  h.chrome.windows.create = async (opts) => {
    created.push(opts);
    if (opts.left >= 2000 || opts.top >= 2000) {
      throw new Error('Invalid value for bounds. Bounds must be at least 50% within visible screen space.');
    }
    return { id: 9, tabs: [{ id: 44, url: opts.url }] };
  };
  h.chrome.windows.update = async (id, info) => { h.calls.push(['win.update', id, info]); };
  const bounds = await h.run('silentRunnerBounds({ left: 0, top: 0, width: 1280, height: 800 }, 0)');
  assert.ok(bounds.left < 2000 && bounds.top < 2000);
  assert.notEqual(bounds.left, 3600);
  const runner = await h.run(`createSilentRunnerWindow('https://ai-publish-platform.weibo.com/#/post')`);
  assert.equal(created.length, 1);
  assert.equal(created[0].focused, false);
  assert.equal(runner.tab.id, 44);
  assert.ok(h.calls.some((c) => c[0] === 'win.update' && c[1] === 3 && c[2].focused === true));
});

test('可见区域校验失败时改放到当前窗口原点再创建', async () => {
  const h = harness();
  const created = [];
  h.chrome.windows.getCurrent = async () => ({ id: 3, left: 10, top: 20, width: 1400, height: 900 });
  h.chrome.windows.create = async (opts) => {
    created.push(opts);
    if (created.length === 1) {
      throw new Error('Invalid value for bounds. Bounds must be at least 50% within visible screen space.');
    }
    return { id: 9, tabs: [{ id: 45 }] };
  };
  h.chrome.windows.update = async () => {};
  const runner = await h.run(`createSilentRunnerWindow('https://ai-publish-platform.weibo.com/#/post')`);
  assert.equal(created.length, 2);
  assert.equal(created[1].left, 10);
  assert.equal(created[1].top, 20);
  assert.equal(runner.tab.id, 45);
});

test('静默后台标签页发博挂载防降速并在结束后卸载debugger', async () => {
  const h = harness();
  stubPipeline(h);
  const debuggerCalls = [];
  h.chrome.debugger = {
    attach: async (target, version) => debuggerCalls.push(['attach', target.tabId, version]),
    sendCommand: async (target, method, params) => debuggerCalls.push(['cmd', target.tabId, method, params]),
    detach: async (target) => debuggerCalls.push(['detach', target.tabId]),
  };
  const summary = await h.run(`startPipeline(${JSON.stringify({ dryRun: true, silentMode: true, selectedTasks: [task] })})`);
  assert.equal(summary.rehearsed, 1);
  assert.ok(debuggerCalls.some((c) => c[0] === 'attach' && c[1] === 7), '静默发博前应挂载防降速debugger');
  assert.ok(debuggerCalls.some((c) => c[0] === 'detach' && c[1] === 7), '静默发博结束后应卸载debugger');
});

test('executeInTabDirect脚本执行挂起超时时立即报错退出不永久卡死', async () => {
  const h = harness();
  h.chrome.scripting.executeScript = () => new Promise(() => {});
  await assert.rejects(
    h.run(`executeInTabDirect(1, () => ({ ok: true }), [], 'MAIN', '', false, null, 30)`),
    /超时/
  );
});

test('无流水线运行时的近期孤儿firing任务可立即自愈为error', async () => {
  const h = harness({ scheduledTasks: [{ id: 'orphan_recent', status: 'firing', firingAt: Date.now() - 5000 }] });
  await h.run('sweepAndRunDueSchedules()');
  assert.equal(h.data.scheduledTasks[0].status, 'error');
  assert.match(h.data.scheduledTasks[0].error, /中断/);
});

test('钉钉文档接口拉取挂起超时时熔断退出不永久卡死', async () => {
  const h = harness();
  let attempts = 0;
  h.chrome.scripting.executeScript = () => {
    attempts += 1;
    return new Promise(() => {});
  };
  await assert.rejects(
    h.run(`fetchDingTalkDocumentPayloadInTab(1, 20)`),
    /钉钉文档接口拉取超时/
  );
  assert.equal(attempts, 15);
});

test('钉钉写回收到超时信号时不连接debugger', async () => {
  const h = harness();
  const calls = [];
  let attachCount = 0;
  h.chrome.tabs.get = async (id) => ({ id, active: false, windowId: 1 });
  h.chrome.windows.get = async () => ({ id: 1, focused: true });
  h.chrome.scripting.executeScript = async () => [{ result: { isSheetFrame: true, currentAddr: 'A1', formulaValue: '', activeSheetTitle: '' } }];
  h.chrome.debugger = {
    attach: async (target) => {
      attachCount += 1;
      calls.push(['attach', target.tabId]);
      if (attachCount === 1) throw new Error('Another debugger is already attached to the tab with id: 9');
    },
    sendCommand: async (target, method) => calls.push(['cmd', target.tabId, method]),
    detach: async (target) => calls.push(['detach', target.tabId]),
  };
  const res = await h.run(`writeDingTalkCellInTab(9, 'H2', 'https://weibo.com/123/Abc', '', { signal: { aborted: true } })`);
  assert.equal(res.ok, false);
  assert.match(res.error, /中止/);
  assert.equal(attachCount, 0);
  assert.equal(calls.length, 0);
});

test('结果页未取到链接时回退微博列表严格核对回执并写回文档', async () => {
  const h = harness();
  stubPipeline(h);
  h.run(`const runBefore = executeInTabDirect;
    executeInTabDirect = async (id, fn, args, ...rest) => {
      if (fn === directCheckWeiboPlatformReady) return { ok: true, ready: true };
      if (fn === directPostToWeiboPlatform) return { ok: false, submitted: true, error: '35秒内未捕获到回执微博链接' };
      if (fn === directCopyPublishPageResult) return { ok: false, error: '结果页未找到publish_model' };
      if (fn === directRecoverPublishedWeiboUrl) return { ok: true, postUrl: 'https://weibo.com/123456/WbListHit99', source: '微博列表操作列' };
      return runBefore(id, fn, args, ...rest);
    };`);
  const result = await h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: [task] })})`);
  assert.equal(result.published, 1);
  assert.equal(result.writtenBack, 1);
  assert.equal(h.messages.some((m) => m.action === 'TEST_WRITE'), true);
});

test('handleRetryWriteBack仅执行文档补写并同步更新scheduledTasks与publishLedger状态', async () => {
  const h = harness({
    scheduledTasks: [
      { id: 'sched_1', docUrl: 'https://docs.qq.com/sheet/mock', targetCell: 'E8', postUrl: 'https://weibo.com/123/RetryOk', writeBackOk: false, writeBackError: '写入超时' },
    ],
    publishLedger: [
      { id: 'led_1', docUrl: 'https://docs.qq.com/sheet/mock', targetCell: 'E8', postUrl: 'https://weibo.com/123/RetryOk', writeBackOk: false, writeBackError: '写入超时' },
    ],
    __unwrittenReceipts__: [
      { docUrl: 'https://docs.qq.com/sheet/mock', targetCell: 'E8', postUrl: 'https://weibo.com/123/RetryOk' },
    ],
  });
  let postCalled = false;
  h.run(`
    findOrCreateTab = async () => ({ id: 77, url: 'https://docs.qq.com/sheet/mock' });
    waitForTabLoaded = async () => {};
    executeInTabDirect = async (_tabId, fn) => {
      if (fn === directPostToWeiboPlatform) throw new Error('补写不得触发发博');
      return { ok: true };
    };
  `);
  const badRes = await h.run(`handleRetryWriteBack({ docUrl: 'https://docs.qq.com/sheet/mock', targetCell: 'E8', postUrl: 'not-a-url' })`);
  assert.equal(badRes.ok, false);

  const okRes = await h.run(`handleRetryWriteBack({ scheduleId: 'sched_1', docUrl: 'https://docs.qq.com/sheet/mock', targetCell: 'E8', postUrl: 'https://weibo.com/123/RetryOk' })`);
  assert.equal(okRes.ok, true);
  assert.equal(postCalled, false);
  assert.equal(h.data.scheduledTasks[0].writeBackOk, true);
  assert.equal(h.data.scheduledTasks[0].writeBackError, '');
  assert.equal(h.data.publishLedger[0].writeBackOk, false);
  assert.equal(h.data.__unwrittenReceipts__.length, 0);
});

test('补写仅清除同文档同子表的隔离回执', async () => {
  const base = { docUrl: 'https://docs.qq.com/sheet/mock', targetCell: 'E8', targetSheetId: 'sheet-a', postUrl: 'https://weibo.com/123/RetryOk' };
  const otherDoc = { ...base, docUrl: 'https://docs.qq.com/sheet/other' };
  const otherSheet = { ...base, targetSheetId: 'sheet-b' };
  const h = harness({ publishLedger: [{ ...base, id: 'a' }, { ...base, id: 'b' }, { ...otherSheet, id: 'c' }], __unwrittenReceipts__: [base, otherDoc, otherSheet] });
  h.run(`findOrCreateTab = async () => ({id: 77}); waitForTabLoaded = async () => {}; executeInTabDirect = async () => ({ok: true});`);
  const result = await h.run(`handleRetryWriteBack(${JSON.stringify({ ...base, ledgerId: 'a' })})`);
  assert.equal(result.ok, true);
  assert.equal(h.data.publishLedger[0].writeBackOk, true);
  assert.equal(h.data.publishLedger[1].writeBackOk, undefined);
  assert.equal(h.data.publishLedger[2].writeBackOk, undefined);
  assert.equal(h.data.__unwrittenReceipts__.length, 2);
});

test('handleBatchRescheduleTasks支持批量顺延待触发和异常任务并拒绝已完成或发布中任务', async () => {
  const now = Date.now();
  const h = harness({
    scheduledTasks: [
      { id: 'p1', status: 'pending', content: '待发1', fireAtTimestamp: now + 60000 },
      { id: 'e1', status: 'error', content: '异常1', error: '超时', fireAtTimestamp: now - 60000 },
      { id: 'd1', status: 'done', content: '已发1', fireAtTimestamp: now - 120000 },
    ],
    __publishClaims__: { 'sched::e1': { claimedAt: now } },
  });
  const res = await h.run(`handleBatchRescheduleTasks(['p1', 'e1'], { delayMinutes: 15 })`);
  assert.equal(res.updated, 2);
  const p1 = h.data.scheduledTasks.find((t) => t.id === 'p1');
  const e1 = h.data.scheduledTasks.find((t) => t.id === 'e1');
  assert.ok(p1.fireAtTimestamp >= now + 15 * 60000);
  assert.equal(e1.status, 'pending');
  assert.equal(e1.error, '');
  assert.equal('sched::e1' in h.data.__publishClaims__, false);
  await assert.rejects(() => h.run(`handleBatchRescheduleTasks(['d1'], { delayMinutes: 15 })`), /已完成/);
});

test('handleClearDoneSchedule清理已完成记录但保留待补写文档条目', async () => {
  const h = harness({
    scheduledTasks: [
      { id: 'p1', status: 'pending', content: '待发', dryRun: true },
      { id: 'd_ok', status: 'done', content: '已写回', dryRun: false, writeBackOk: true, docUrl: 'https://docs.qq.com/sheet/a', targetCell: 'E2', postUrl: 'https://weibo.com/1/A' },
      { id: 'd_dry', status: 'done', content: '演练', dryRun: true },
      { id: 'd_fail', status: 'done', content: '待补写', dryRun: false, writeBackOk: false, docUrl: 'https://docs.qq.com/sheet/a', targetCell: 'E3', postUrl: 'https://weibo.com/1/B' },
    ],
  });
  const res = await h.run(`handleClearDoneSchedule()`);
  assert.equal(res.cleared, 2);
  assert.equal(res.keptWriteBackFailed, 1);
  const ids = h.data.scheduledTasks.map((t) => t.id);
  assert.deepEqual(ids, ['p1', 'd_fail']);
});

test('cleanupExpiredDoneSchedules自动清理超过12小时的已完成记录且保留未到期与待发异常记录', async () => {
  const now = Date.now();
  const twelveHoursPlus = 12 * 60 * 60 * 1000 + 60 * 1000;
  const twoHours = 2 * 60 * 60 * 1000;
  const h = harness({
    scheduledTasks: [
      { id: 'd_old', status: 'done', content: '12小时前已发', completedAt: now - twelveHoursPlus },
      { id: 'd_old_legacy', status: 'done', content: '旧版无completedAt', fireAtTimestamp: now - twelveHoursPlus },
      { id: 'd_recent', status: 'done', content: '2小时前已发', completedAt: now - twoHours },
      { id: 'p_old', status: 'pending', content: '待发', fireAtTimestamp: now - twelveHoursPlus },
      { id: 'e_old', status: 'error', content: '异常', fireAtTimestamp: now - twelveHoursPlus },
    ],
  });
  const removed = await h.run(`cleanupExpiredDoneSchedules(${now})`);
  assert.equal(removed, 2);
  const ids = h.data.scheduledTasks.map((t) => t.id);
  assert.deepEqual(ids, ['d_recent', 'p_old', 'e_old']);
});

test('连续同文案多账号任务合并为单次群发并分别写入各自台账与内容锁', async () => {
  const postCalls = [];
  const accounts = ['虚构主号', '虚构小号1', '虚构小号2', '虚构小号3', '虚构小号4', '虚构小号5'];
  const h = harness();
  stubPipeline(h);
  h.context.postCalls = postCalls;
  h.run(`executeInTabDirect = async (id, func, args) => {
    if (func === directCheckWeiboPlatformReady) return { ok: true, ready: true, accounts: ${JSON.stringify(accounts)} };
    if (func === directPostToWeiboPlatform) {
      postCalls.push(args[0]);
      const postUrlsByAccount = {};
      (args[0].accounts || [args[0].account]).forEach((acct, idx) => {
        postUrlsByAccount[acct] = 'https://weibo.com/10000' + (idx + 1) + '/MOCK' + (idx + 1);
      });
      return {
        ok: true,
        postUrl: postUrlsByAccount[args[0].account],
        postUrlsByAccount,
        submitted: true,
      };
    }
    return { ok: true };
  };`);

  const selectedTasks = accounts.map((acct, idx) => ({
    docName: '任务解析',
    row: `${idx + 1}`,
    targetCell: '-',
    account: acct,
    content: 'China Haul 测试群发正文',
    imgUrls: [],
  }));

  const summary = await h.run(`startPipeline(${JSON.stringify({ docs: [], dryRun: false, silentMode: true, selectedTasks })})`);
  assert.equal(postCalls.length, 1);
  assert.deepEqual(Array.from(postCalls[0].accounts), accounts);
  assert.equal(summary.published, 6);
  assert.equal(h.data.publishLedger.length, 6);
  for (let i = 0; i < accounts.length; i++) {
    const rec = h.data.publishLedger.find((item) => item.resolvedAccount === accounts[i]);
    assert.ok(rec, `缺少账号 ${accounts[i]} 的台账记录`);
    assert.equal(rec.postUrl, `https://weibo.com/10000${i + 1}/MOCK${i + 1}`);
    assert.ok(h.data.__publishClaims__[`post::${accounts[i]}::China Haul 测试群发正文`]);
  }
});

test('合并群发批次个别账号缺回执时先落盘其余账号台账再报错且不释放已发锁', async () => {
  const accounts = ['虚构主号', '虚构小号1', '虚构小号2'];
  const h = harness();
  stubPipeline(h);
  h.run(`executeInTabDirect = async (id, func, args) => {
    if (func === directCheckWeiboPlatformReady) return { ok: true, ready: true };
    if (func === directPostToWeiboPlatform) {
      return {
        ok: true,
        postUrl: 'https://weibo.com/100001/M1',
        postUrlsByAccount: {
          '虚构主号': 'https://weibo.com/100001/M1',
          '虚构小号1': 'https://weibo.com/100002/M2',
        },
        submitted: true,
      };
    }
    if (func === directRecoverPublishedWeiboUrl) return { ok: false, error: '列表未找到' };
    return { ok: true };
  };`);

  const selectedTasks = accounts.map((acct, idx) => ({
    docName: '任务解析',
    row: `${idx + 1}`,
    targetCell: '-',
    account: acct,
    content: '缺回执批次正文',
    imgUrls: [],
  }));

  await assert.rejects(
    () => h.run(`startPipeline(${JSON.stringify({ docs: [], dryRun: false, silentMode: true, selectedTasks })})`),
    /虚构小号2/
  );
  assert.equal(h.data.publishLedger.length, 3);
  assert.deepEqual(
    h.data.publishLedger.map((item) => item.resolvedAccount).sort(),
    accounts.slice().sort()
  );
  const missing = h.data.publishLedger.find((item) => item.resolvedAccount === '虚构小号2');
  assert.equal(missing.postUrl, '');
  assert.equal(missing.submittedWithoutReceipt, true);
  for (const acct of accounts) {
    assert.ok(h.data.__publishClaims__[`post::${acct}::缺回执批次正文`], `账号 ${acct} 的锁不应被提前释放`);
  }
  assert.equal(h.data.__unwrittenReceipts__.some((item) => item.submittedWithoutReceipt && item.resolvedAccount === '虚构小号2'), true);
  await assert.rejects(() => h.run(`startPipeline(${JSON.stringify({ docs: [], dryRun: false, silentMode: true, selectedTasks: [selectedTasks[2]] })})`), /已提交但缺少回执/);
});

test('群发两个账号返回同一回执链接时不能写回任一账号', async () => {
  const h = harness();
  stubPipeline(h);
  h.run(`executeInTabDirect = async (_id, fn) => {
    if (fn === directPostToWeiboPlatform) return { ok: true, submitted: true, postUrl: 'https://weibo.com/100001/ABC', postUrlsByAccount: { '虚构甲': 'https://weibo.com/100001/ABC', '虚构乙': 'https://weibo.com/100001/ABC' } };
    if (fn === directRecoverPublishedWeiboUrl) return { ok: false };
    if (fn === directWriteCellToDoc) throw new Error('不应写入');
    return { ok: true, ready: true };
  };`);
  const tasks = ['虚构甲', '虚构乙'].map((account, i) => ({ account, content: '重复回执测试', row: i + 1, targetCell: '-' }));
  await assert.rejects(() => h.run(`startPipeline(${JSON.stringify({ dryRun: false, selectedTasks: tasks })})`), /回执/);
  assert.equal(h.data.publishLedger.length, 2);
  assert.ok(h.data.publishLedger.every((item) => item.submittedWithoutReceipt && !item.postUrl));
});

test('发博页残留上一次结果弹窗时自动刷新并重试一次而不是整批中断', async () => {
  const calls = [];
  const h = harness();
  stubPipeline(h);
  h.run(`executeInTabDirect = async (id, func, args) => {
    if (func === directCheckWeiboPlatformReady) return { ok: true, ready: true };
    if (func === directPostToWeiboPlatform) {
      calls.push(1);
      if (calls.length === 1) return { ok: false, submitted: false, error: '页面存在未关闭的弹窗，请先手动取消或关闭后重试' };
      return { ok: true, postUrl: 'https://weibo.com/123456/RetryOk', submitted: true };
    }
    return { ok: true };
  };`);
  h.context.calls = calls;

  const summary = await h.run(`startPipeline(${JSON.stringify({
    docs: [], dryRun: false, silentMode: true,
    selectedTasks: [{ docName: '任务解析', row: '1', targetCell: '-', account: '虚构重试号', content: '弹窗重试正文', imgUrls: [] }],
  })})`);
  assert.equal(calls.length, 2);
  assert.equal(summary.published, 1);
  assert.equal(h.data.publishLedger[0].postUrl, 'https://weibo.com/123456/RetryOk');
});

test('合并群发批次中任一账号内容锁被占用时立即释放已占锁并阻断调用发布函数', async () => {
  const postCalls = [];
  const h = harness({
    __publishClaims__: {
      'post::虚构小号2::并发测试正文': Date.now(),
    },
  });
  stubPipeline(h);
  h.context.postCalls = postCalls;
  h.run(`executeInTabDirect = async (id, func, args) => {
    if (func === directCheckWeiboPlatformReady) return { ok: true, ready: true };
    if (func === directPostToWeiboPlatform) {
      postCalls.push(args[0]);
      return { ok: true, postUrl: 'https://weibo.com/100001/MOCK' };
    }
    return { ok: true };
  };`);

  const selectedTasks = ['虚构主号', '虚构小号1', '虚构小号2'].map((acct, idx) => ({
    docName: '任务解析',
    row: `${idx + 1}`,
    targetCell: '-',
    account: acct,
    content: '并发测试正文',
    imgUrls: [],
  }));

  await assert.rejects(
    () => h.run(`startPipeline(${JSON.stringify({ docs: [], dryRun: false, silentMode: true, selectedTasks })})`),
    /已拦截重复发博/
  );
  assert.equal(postCalls.length, 0);
  assert.equal('post::虚构主号::并发测试正文' in h.data.__publishClaims__, false);
  assert.equal('post::虚构小号1::并发测试正文' in h.data.__publishClaims__, false);
  assert.ok('post::虚构小号2::并发测试正文' in h.data.__publishClaims__);
});

test('合并群发因中台缺少账号阻断时撤销待确认台账且不误拦后续单发', async () => {
  const h = harness({});
  stubPipeline(h);
  h.run(`executeInTabDirect = async (id, func) => {
    if (func === directCheckWeiboPlatformReady) return { ok: true, ready: true };
    if (func === directPostToWeiboPlatform) {
      return { ok: false, submitted: false, error: '未在发稿中台各分类下找到目标账号 [已下线账号]' };
    }
    return { ok: true };
  };`);

  const batchTasks = ['正常账号A', '已下线账号'].map((acct, idx) => ({
    docName: '任务解析',
    row: `${idx + 1}`,
    targetCell: '-',
    account: acct,
    content: '缺号阻断测试正文',
    imgUrls: [],
  }));

  await assert.rejects(
    () => h.run(`startPipeline(${JSON.stringify({ docs: [], dryRun: false, silentMode: true, selectedTasks: batchTasks })})`),
    /未在发稿中台各分类下找到目标账号/
  );
  assert.equal(h.data.publishLedger.length, 0);
  assert.equal(h.data.__unwrittenReceipts__.length, 0);

  h.run(`executeInTabDirect = async (id, func) => {
    if (func === directCheckWeiboPlatformReady) return { ok: true, ready: true };
    if (func === directPostToWeiboPlatform) return { ok: true, postUrl: 'https://weibo.com/100001/OK' };
    return { ok: true };
  };`);
  const retryRes = await h.run(`startPipeline(${JSON.stringify({
    docs: [],
    dryRun: false,
    silentMode: true,
    selectedTasks: [batchTasks[0]],
  })})`);
  assert.equal(retryRes.published, 1);
  assert.equal(h.data.publishLedger[0].postUrl, 'https://weibo.com/100001/OK');
});

test('静默模式新建的发博标签页在流水线结束后自动关闭，复用已有标签页时不关闭', async () => {
  const h1 = harness();
  h1.run('var actualFindOrCreateTab = findOrCreateTab;');
  stubPipeline(h1);
  h1.run('findOrCreateTab = actualFindOrCreateTab;');
  h1.chrome.tabs.query = async () => [];
  h1.chrome.tabs.create = async (value) => {
    h1.calls.push(['tab.create', value]);
    return { id: 88, ...value };
  };
  h1.chrome.tabs.get = async (id) => ({ id, url: 'https://ai-publish-platform.weibo.com/#/post', status: 'complete' });
  h1.chrome.tabs.remove = async (id) => {
    h1.calls.push(['tab.remove', id]);
  };
  const parserTask = { ...task, docUrl: '', targetCell: '-' };
  await h1.run(`startPipeline(${JSON.stringify({ docs: [], dryRun: true, silentMode: true, selectedTasks: [parserTask] })})`);
  assert.equal(h1.calls.filter(([type, arg]) => type === 'tab.create' && arg.active === false).length, 1);
  assert.deepEqual(h1.calls.filter(([type]) => type === 'tab.remove'), [['tab.remove', 88]]);

  const h2 = harness();
  h2.run('var actualFindOrCreateTab = findOrCreateTab;');
  stubPipeline(h2);
  h2.run('findOrCreateTab = actualFindOrCreateTab;');
  h2.chrome.tabs.query = async () => [{ id: 99, url: 'https://ai-publish-platform.weibo.com/#/post', status: 'complete' }];
  h2.chrome.tabs.get = async (id) => ({ id, url: 'https://ai-publish-platform.weibo.com/#/post', status: 'complete' });
  h2.chrome.tabs.remove = async (id) => {
    h2.calls.push(['tab.remove', id]);
  };
  await h2.run(`startPipeline(${JSON.stringify({ docs: [], dryRun: true, silentMode: true, selectedTasks: [parserTask] })})`);
  assert.equal(h2.calls.filter(([type]) => type === 'tab.remove').length, 0);
});

test('RETRY_TOPIC_PIN_TASK 重置失败或超时的子话题状态并触发队列重新处理', async () => {
  const topicPinnerSource = fs.readFileSync(path.join(__dirname, '../background/topic_pinner.js'), 'utf8');
  const h = harness({
    topicPinTasks: [{
      id: 'tpin_retry_1',
      mode: 'manual_apply',
      status: 'error',
      postUrl: 'https://weibo.com/2318910945/Test',
      topics: [
        { hashtag: '失败话题', status: 'error', note: '提交失败', pinAttempts: 2 },
        { hashtag: '已跳过话题', status: 'skipped_other_host', note: '已有竞争/其他主持人' },
      ],
    }],
  });
  h.run(topicPinnerSource);
  h.context.__queueTriggered = false;
  h.run(`processTopicPinQueue = async () => { __queueTriggered = true; };`);
  const resp = await h.send({ action: 'RETRY_TOPIC_PIN_TASK', taskId: 'tpin_retry_1' });
  assert.equal(resp.ok, true);
  assert.equal(h.context.__queueTriggered, true);
  const saved = h.data.topicPinTasks[0];
  assert.equal(saved.status, 'pending');
  assert.equal(saved.topics[0].status, 'pending');
  assert.equal(saved.topics[0].pinAttempts, 0);
  assert.equal(saved.topics[1].status, 'skipped_other_host');
});

test('initRefererRules 同时注册 docs.qq.com 与扩展后台直连微博 Referer/Origin 动态规则', async () => {
  const h = harness();
  let lastRulesPayload = null;
  h.chrome.runtime.id = 'mock_ext_id_123';
  h.chrome.declarativeNetRequest.updateDynamicRules = async (payload) => {
    lastRulesPayload = payload;
  };
  await h.run('initRefererRules()');
  assert.ok(lastRulesPayload);
  assert.deepEqual(Array.from(lastRulesPayload.removeRuleIds), [1001, 1002, 1003, 1004, 1005, 1006, 1007]);
  assert.equal(lastRulesPayload.addRules.length, 7);
  const mWeiboReferer = lastRulesPayload.addRules.find((r) => r.id === 1004);
  const mWeiboOrigin = lastRulesPayload.addRules.find((r) => r.id === 1007);
  assert.equal(mWeiboReferer.action.requestHeaders[0].value, 'https://m.s.weibo.com/');
  assert.deepEqual(Array.from(mWeiboReferer.condition.initiatorDomains), ['mock_ext_id_123']);
  assert.equal(mWeiboOrigin.action.requestHeaders[0].value, 'https://m.s.weibo.com');
  assert.deepEqual(Array.from(mWeiboOrigin.condition.requestMethods), ['post']);
});




