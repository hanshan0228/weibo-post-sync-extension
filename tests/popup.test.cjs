const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../popup/popup.js');
const html = fs.readFileSync(path.join(__dirname, '../popup/popup.html'), 'utf8');

class Element {
  constructor() {
    this.listeners = new Map();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.textContent = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 100;
    this.checked = false;
    this.disabled = false;
    this._html = '';
    this.nodes = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, value = !this.classes.has(name)) => value ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set innerHTML(value) { this._html = value; this.children = []; this.nodes.clear(); }
  get innerHTML() { return this._html; }
  addEventListener(name, fn) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), fn]);
  }
  async emit(name, event = {}) {
    for (const fn of this.listeners.get(name) || []) await fn({ target: this, ...event });
  }
  click() { return this.emit('click'); }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  prepend(child) { this.children.unshift(child); child.parentElement = this; return child; }
  insertBefore(child, ref) {
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx === -1) this.children.push(child);
    else this.children.splice(idx, 0, child);
    child.parentElement = this;
    return child;
  }
  get firstChild() { return this.children[0] || null; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((el) => el !== this); }
  focus() {}
  querySelector(selector) {
    if (selector === '.task-done-badge') return this.children.find((el) => el.classList.contains('task-done-badge')) || null;
    if (!this.nodes.has(selector)) {
      const node = new Element();
      if (selector === '.task-item-cb') {
        const match = this._html.match(/<input[^>]*class="task-item-cb"[^>]*>/);
        node.dataset.taskIndex = match?.[0].match(/data-task-index="(\d+)"/)?.[1];
        node.checked = /\schecked(?:\s|>)/.test(match?.[0] || '');
      }
      if (selector === '.task-delete-btn') {
        const match = this._html.match(/<button[^>]*class="[^"]*task-delete-btn[^"]*"[^>]*>/);
        node.dataset.taskIndex = match?.[0].match(/data-task-index="(\d+)"/)?.[1];
      }
      node.closest = (selector) => selector === '.task-item-card' ? this : null;
      this.nodes.set(selector, node);
    }
    return this.nodes.get(selector);
  }
  querySelectorAll(selector) {
    if (selector === '.chip') return this.chips || [];
    if (selector === '.task-item-card') return this.children.filter((el) => el.classList.contains('task-item-card'));
    if (['.task-item-cb', '.task-item-cb:checked', '.sched-card-header', '.task-delete-btn'].includes(selector)) {
      const cards = this.children.filter((el) => el.classList.contains('task-item-card'));
      const subSel = selector.endsWith(':checked') ? '.task-item-cb' : selector;
      const nodes = cards.map((card) => card.querySelector(subSel));
      return selector.endsWith(':checked') ? nodes.filter((node) => node.checked) : nodes;
    }
    if (selector === '.filter-chip') {
      if (!this.nodes.has(selector)) this.nodes.set(selector, [...this._html.matchAll(/data-doc="([^"]+)"/g)].map((match) => {
        const chip = new Element();
        chip.dataset.doc = match[1];
        return chip;
      }));
      return this.nodes.get(selector);
    }
    return [];
  }
}

async function loadPopup(stored = {}, responses = {}, overrides = {}) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => [m[1], new Element()]));
  elements.get('dryRunToggle').checked = true;
  elements.get('silentModeToggle').checked = true;
  elements.get('btnStop').disabled = true;
  elements.get('btnParserRunNow').disabled = true;
  elements.get('btnParserToSchedule').disabled = true;
  elements.get('schedDocFilter').value = 'all';
  elements.get('ledgerDocFilter').value = 'all';
  const aliasChip = new Element();
  aliasChip.dataset = { aliasFrom: '测试', aliasTo: '测试账号' };
  const delayChip = new Element();
  delayChip.dataset = { min: '10' };
  const editChip = new Element();
  editChip.dataset = { editMin: '30' };
  const schedFilterChips = ['pending', 'error', 'done', 'all'].map((f) => {
    const c = new Element();
    c.dataset = { filter: f };
    if (f === 'pending') c.classList.add('active');
    return c;
  });
  elements.get('quickAliasChips').chips = [aliasChip];
  const storage = { scheduledTasks: [], schedulePaused: true, ...stored };
  const sent = [];
  const alerts = [];
  const messages = [];
  let ready;
  const document = {
    addEventListener: (name, fn) => { if (name === 'DOMContentLoaded') ready = fn; },
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      for (const el of elements.values()) {
        const found = el.children.find((child) => child.id === id);
        if (found) return found;
      }
      return null;
    },
    createElement: () => new Element(),
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '.chip') return [aliasChip, delayChip, editChip];
      if (selector === '.chip[data-min]') return [delayChip];
      if (selector === '[data-edit-min]') return [editChip];
      if (selector.includes('#schedFilterChips')) return schedFilterChips;
      return [];
    },
  };
  const chrome = {
    storage: { local: {
      get(keys, callback) {
        const result = Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, structuredClone(storage[key])]));
        if (callback) { queueMicrotask(() => callback(result)); return; }
        return Promise.resolve(result);
      },
      set(values) { Object.assign(storage, structuredClone(values)); return Promise.resolve(); },
    } },
    runtime: {
      getURL: (file) => file,
      onMessage: { addListener: (fn) => messages.push(fn) },
      sendMessage(request, callback) {
        sent.push(request);
        const configured = responses[request.action];
        const response = typeof configured === 'function' ? configured(request) : configured || { ok: true };
        if (callback) { queueMicrotask(() => callback(response)); return; }
        return Promise.resolve(response);
      },
    },
    tabs: { query: async () => [], create: async () => ({}) },
  };
  const context = vm.createContext({ document, chrome, console, navigator: overrides.navigator || {}, setTimeout: () => 0, clearTimeout() {}, alert: (text) => alerts.push(text), confirm: overrides.confirm || (() => true), URL, Blob });
  const instrumented = fs.readFileSync(sourcePath, 'utf8').replace(/\n\}\);\s*$/, `
  globalThis.__test = { refreshScheduleQueue, renderTaskList, getSelectedTasks, getAccountAliases, detectPollFromLines,
    parseBatchTaskText, parseTableTime, escapeHtml, openEditScheduleModal, formatPipelineSummary,
    setScannedTasks: (tasks) => { scannedTasks = tasks; },
    setParsedTasks: (tasks) => { parsedTaskGroups = tasks; renderParsedTasksPreview(); } };
});`);
  vm.runInContext(instrumented, context, { filename: sourcePath });
  await ready();
  await new Promise((resolve) => setImmediate(resolve));
  return { api: context.__test, elements, storage, sent, alerts, messages, aliasChip, delayChip, editChip, schedFilterChips };
}

test('扫描选择跨搜索、文档切换与排程广播保留，操作只处理当前筛选', async () => {
  const app = await loadPopup();
  const tasks = [
    { docId: 'a', docName: '甲表', docUrl: 'https://example.invalid/a', row: 2, account: 'Mock甲', content: '苹果' },
    { docId: 'b', docName: '乙表', docUrl: 'https://example.invalid/b', row: 2, account: 'Mock乙', content: '香蕉' },
  ];
  app.api.setScannedTasks(tasks);
  app.api.renderTaskList(tasks);
  const list = app.elements.get('taskListContainer');
  let cb = list.querySelectorAll('.task-item-cb')[0];
  cb.checked = false;
  await cb.emit('change');
  const search = app.elements.get('taskSearchInput');
  search.value = '香蕉';
  await search.emit('input');
  assert.deepEqual([...app.api.getSelectedTasks().map((t) => t.account)], ['Mock乙']);
  await app.elements.get('btnToggleSelectAll').click();
  search.value = '';
  await search.emit('input');
  assert.deepEqual(list.querySelectorAll('.task-item-cb').map((node) => node.checked), [false, false]);
  await list.children[0].querySelector('.sched-card-header').click();
  await app.elements.get('taskDocFilterChips').querySelectorAll('.filter-chip').find((chip) => chip.dataset.doc === '乙表').click();
  assert.equal(app.api.getSelectedTasks().length, 0, '隐藏的已选任务不参与当前筛选操作');
  await app.elements.get('btnToggleSelectAll').click();
  for (const fn of app.messages) fn({ action: 'SCHEDULE_UPDATED' });
  await new Promise((resolve) => setImmediate(resolve));
  await app.elements.get('taskDocFilterChips').querySelectorAll('.filter-chip').find((chip) => chip.dataset.doc === 'all').click();
  assert.deepEqual(list.querySelectorAll('.task-item-cb').map((node) => node.checked), [true, true]);
  cb = list.querySelectorAll('.task-item-cb')[0];
  cb.checked = false;
  await cb.emit('change');
  for (const fn of app.messages) fn({ action: 'SCHEDULE_UPDATED' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(list.querySelectorAll('.task-item-cb')[0].checked, false);
  assert.match(app.elements.get('btnToggleSelectAll').title, /当前筛选/);
});

test('排程默认值随队列变化，用户明确选择优先且任务删除后清理选择', async () => {
  const app = await loadPopup();
  const task = { docId: 'a', docUrl: 'https://example.invalid/a', row: 2, content: 'Mock正文' };
  app.api.setScannedTasks([task]);
  app.api.renderTaskList([task]);
  app.storage.scheduledTasks = [{ ...task, id: 'Mock排程', status: 'pending' }];
  for (const fn of app.messages) fn({ action: 'SCHEDULE_UPDATED' });
  await new Promise((resolve) => setImmediate(resolve));
  const list = app.elements.get('taskListContainer');
  assert.equal(list.querySelectorAll('.task-item-cb')[0].checked, false);
  const cb = list.querySelectorAll('.task-item-cb')[0];
  cb.checked = true;
  await cb.emit('change');
  app.api.renderTaskList([{ ...task, docName: 'Mock新名称' }]);
  assert.equal(list.querySelectorAll('.task-item-cb')[0].checked, true);
  app.api.renderTaskList([]);
  app.api.renderTaskList([task]);
  assert.equal(list.querySelectorAll('.task-item-cb')[0].checked, false);
});

test('手动话题置顶回车重入被同步拦截，失败后释放守卫', async () => {
  let rejectRequest;
  const app = await loadPopup({}, { MANUAL_TOPIC_PIN: () => new Promise((_resolve, reject) => { rejectRequest = reject; }) });
  const input = app.elements.get('manualPinUrlInput');
  input.value = 'https://example.invalid/Mock';
  const first = app.elements.get('btnManualPinSubmit').click();
  input.emit('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(app.sent.filter((m) => m.action === 'MANUAL_TOPIC_PIN').length, 1);
  rejectRequest(new Error('Mock发送失败'));
  await first;
  assert.equal(app.elements.get('btnManualPinSubmit').disabled, false);
  assert.ok(app.elements.get('logWindow').children.some((node) => node.textContent.includes('Mock发送失败')));
  const retry = app.elements.get('btnManualPinSubmit').click();
  assert.equal(app.sent.filter((m) => m.action === 'MANUAL_TOPIC_PIN').length, 2);
  rejectRequest(new Error('Mock再次失败'));
  await retry;
});

test('后台定时任务启动广播同步启用停止按钮并禁用启动入口', async () => {
  const app = await loadPopup();
  for (const fn of app.messages) fn({ action: 'PIPELINE_PROGRESS', payload: { stage: '定时执行', percentage: 30, isRunning: true } });
  assert.equal(app.elements.get('btnStop').disabled, false);
  for (const id of ['btnStart', 'btnScanTasks', 'btnParserRunNow', 'btnParserToSchedule']) {
    assert.equal(app.elements.get(id).disabled, true, id);
  }
});

test('初始化已运行的任务结束后所有运行按钮复位', async () => {
  const app = await loadPopup({}, { GET_PIPELINE_STATUS: { ok: true, state: { isRunning: true, stage: '发布中', percentage: 50 } } });
  assert.equal(app.elements.get('btnStop').disabled, false);
  for (const fn of app.messages) fn({ action: 'PIPELINE_PROGRESS', payload: { stage: '完成', percentage: 100, isRunning: false } });
  assert.equal(app.elements.get('btnStart').disabled, false);
  assert.equal(app.elements.get('btnScanTasks').disabled, false);
  assert.equal(app.elements.get('btnStop').disabled, true);
  assert.equal(app.elements.get('btnParserRunNow').disabled, true);
});

test('解析预览不能在流水线运行中重新启用执行按钮，结束后恢复', async () => {
  const app = await loadPopup();
  const tasks = [{ account: '虚构账号', content: '隔离文案', poll: null }];
  app.api.setParsedTasks(tasks);
  assert.equal(app.elements.get('btnParserRunNow').disabled, false);
  for (const fn of app.messages) fn({ action: 'PIPELINE_PROGRESS', payload: { stage: '运行', percentage: 30, isRunning: true } });
  app.api.setParsedTasks(tasks);
  assert.equal(app.elements.get('btnParserRunNow').disabled, true);
  assert.equal(app.elements.get('btnParserToSchedule').disabled, true);
  for (const fn of app.messages) fn({ action: 'PIPELINE_PROGRESS', payload: { stage: '停止中', percentage: 30, isRunning: true } });
  assert.equal(app.elements.get('btnStop').disabled, false);
  for (const fn of app.messages) fn({ action: 'PIPELINE_PROGRESS', payload: { stage: '已停止', percentage: 30, isRunning: false } });
  assert.equal(app.elements.get('btnParserRunNow').disabled, false);
  assert.equal(app.elements.get('btnParserToSchedule').disabled, false);
});

test('后台拒绝重复启动后仍保留已有流水线的停止入口', async () => {
  const app = await loadPopup({}, {
    START_PIPELINE: { ok: false, error: '已有流水线正在执行中' },
    GET_PIPELINE_STATUS: { ok: true, state: { isRunning: true, stage: '运行', percentage: 30 } },
  });
  app.api.setParsedTasks([{ account: '虚构账号', content: '隔离文案', poll: null }]);
  await app.elements.get('btnParserRunNow').click();
  assert.equal(app.elements.get('btnStop').disabled, false);
  assert.equal(app.elements.get('btnStart').disabled, true);
  assert.equal(app.elements.get('btnParserRunNow').disabled, true);
});

test('恢复关闭的静默模式，不在初始化时变回开启', async () => {
  const app = await loadPopup({ silentMode: false });
  assert.equal(app.elements.get('silentModeToggle').checked, false);
});

test('别名快捷按钮和编辑时间按钮不会污染统一定时时间', async () => {
  const app = await loadPopup({ accountAliases: {} });
  app.elements.get('customScheduleTime').value = '2026-12-01T10:00';
  await app.aliasChip.click();
  await app.editChip.click();
  assert.equal(app.elements.get('customScheduleTime').value, '2026-12-01T10:00');
  await app.delayChip.click();
  assert.match(app.elements.get('customScheduleTime').value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test('用户删除所有别名后，空字典不会自动恢复默认', async () => {
  const app = await loadPopup({ accountAliases: {} });
  assert.equal(Object.keys(await app.api.getAccountAliases()).length, 0);
  assert.equal(Object.keys(app.storage.accountAliases).length, 0);
});

test('数字与零均可安全渲染，不抛replace异常', async () => {
  const { api } = await loadPopup();
  assert.equal(api.escapeHtml(42), '42');
  assert.equal(api.escapeHtml(0), '0');
  assert.equal(api.escapeHtml(null), '');
  assert.equal(api.escapeHtml('<x>"&'), '&lt;x&gt;&quot;&amp;');
});

test('普通多行短文和编号列表不会被静默截成投票', async () => {
  const { api } = await loadPopup({ accountAliases: {} });
  assert.equal(api.detectPollFromLines(['今日天气', '晴空万里', '适宜出游']), null);
  assert.equal(api.detectPollFromLines(['今日工作安排', '1. 整理素材', '2. 检查文案']), null);
  assert.equal(api.detectPollFromLines(['美好的一天！', '晴空万里', '适宜出游']), null);
  const parsed = await api.parseBatchTaskText('今日天气\n晴空万里\n适宜出游');
  assert.equal(parsed[0].content, '今日天气\n晴空万里\n适宜出游');
  assert.equal(parsed[0].poll, null);
});

test('明确问句和强制投票模式仍能识别投票', async () => {
  const { api } = await loadPopup();
  assert.equal(api.detectPollFromLines(['你会选哪个？', 'A. 苹果', 'B. 香蕉']).options.length, 2);
  assert.equal(api.detectPollFromLines(['今日选择', '苹果', '香蕉'], true).options.length, 2);
});

test('定时队列非空时可完整渲染pending/done/error卡片', async () => {
  const app = await loadPopup();
  app.storage.scheduledTasks = ['pending', 'done', 'error'].map((status, i) => ({
    id: `sched_${i}`, status, content: '测试正文', account: '虚构账号', fireAtTimestamp: Date.now() + 60000,
  }));
  await app.schedFilterChips.find((c) => c.dataset.filter === 'all').click();
  await new Promise((r) => setImmediate(r));
  assert.equal(app.elements.get('schedListContainer').children.length, 3);
});

test('不同文档相同行具有独立卡片，完成消息只标记对应文档', async () => {
  const app = await loadPopup();
  const tasks = [
    { docId: 'slot_a', docUrl: 'https://docs.qq.com/sheet/a', targetSheetId: 's1', row: 2, targetCell: 'E2', content: '甲' },
    { docId: 'slot_b', docUrl: 'https://docs.qq.com/sheet/b', targetSheetId: 's1', row: 2, targetCell: 'E2', content: '乙' },
  ];
  app.api.setScannedTasks(tasks);
  app.api.renderTaskList(tasks);
  const cards = app.elements.get('taskListContainer').children;
  assert.notEqual(cards[0].id, cards[1].id);
  for (const fn of app.messages) fn({ action: 'TASK_ITEM_COMPLETED', payload: { ...tasks[1], dryRun: false, writeBackOk: true } });
  assert.equal(cards[0].classList.contains('is-completed'), false);
  assert.equal(cards[1].classList.contains('is-completed'), true);
  const badge = cards[1].querySelector('.sched-card-left-meta, .task-item-meta').children[0];
  assert.match(badge.textContent, /E2 已写回/);
});

test('演练与投票草稿不会显示为已写回', async () => {
  const app = await loadPopup();
  const task = { docId: 'slot_a', docUrl: 'https://docs.qq.com/sheet/a', row: 2, targetCell: 'E2', content: '甲' };
  app.api.setScannedTasks([task]);
  for (const state of [{ dryRun: true }, { preparedOnly: true }, { dryRun: false, writeBackOk: false }]) {
    app.api.renderTaskList([task]);
    for (const fn of app.messages) fn({ action: 'TASK_ITEM_COMPLETED', payload: { ...task, ...state } });
    const card = app.elements.get('taskListContainer').children[0];
    const badge = card.querySelector('.sched-card-left-meta, .task-item-meta').children[0];
    assert.ok(badge);
    assert.doesNotMatch(badge.textContent, /已写回/);
  }
});

test('编辑保存失败时不继续触发立即发布', async () => {
  const app = await loadPopup({}, { UPDATE_SCHEDULE_TASK: { ok: false, error: '任务已在执行' } });
  app.elements.get('editModalTaskId').value = 'sched_test';
  app.elements.get('editModalAccount').value = '虚构账号';
  app.elements.get('editModalContent').value = '隔离测试';
  await app.elements.get('btnEditModalFireNow').click();
  assert.equal(app.sent.some((request) => request.action === 'FIRE_SCHEDULE_NOW'), false);
  assert.ok(app.alerts.some((text) => text.includes('任务已在执行')));
});

test('单条定时任务立即执行失败会显示后台错误', async () => {
  const app = await loadPopup({}, { FIRE_SCHEDULE_NOW: { ok: false, error: '当前有任务正在执行' } });
  app.storage.scheduledTasks = [{ id: 'sched_test', status: 'pending', content: '隔离测试' }];
  const button = new Element();
  button.dataset.id = 'sched_test';
  app.elements.get('schedListContainer').querySelectorAll = (selector) => selector === '.btn-fire-now' ? [button] : [];
  await app.api.refreshScheduleQueue();
  await button.click();
  assert.ok(app.elements.get('logWindow').children.some((el) => el.textContent.includes('当前有任务正在执行')));
});

test('打开无日期任务不会继承上一条的日期', async () => {
  const app = await loadPopup();
  app.elements.get('editModalDateTime').value = '2026-12-01T12:00';
  app.storage.scheduledTasks = [{ id: 'sched_test', content: '隔离测试' }];
  await app.api.openEditScheduleModal('sched_test');
  assert.equal(app.elements.get('editModalDateTime').value, '');
});

test('批量立即发布不会通过textContent销毁计数span', async () => {
  const app = await loadPopup();
  app.storage.scheduledTasks = [{ id: 'sched_test', content: '隔离测试', status: 'pending' }];
  const checkbox = new Element();
  checkbox.dataset.id = 'sched_test';
  const list = app.elements.get('schedListContainer');
  list.querySelectorAll = (selector) => selector === '.sched-item-cb' ? [checkbox] : [];
  const selectAll = app.elements.get('schedSelectAllCb');
  selectAll.checked = true;
  await selectAll.emit('change');
  const button = app.elements.get('btnBatchFireSched');
  const original = button.textContent;
  await button.click();
  assert.equal(button.textContent, original);
});

test('日期与时刻越界会报错，而不是自动滚动成另一日期', async () => {
  const { api } = await loadPopup();
  for (const value of ['25:30', '12:99', '2026-02-30 12:30', '2026-13-01 12:30']) {
    assert.throws(() => api.parseTableTime(value), /时间|日期/);
  }
  assert.ok(Number.isFinite(api.parseTableTime('18:30').ts));
  assert.ok(Number.isFinite(api.parseTableTime('2026-12-01 18:30').ts));
  assert.throws(() => api.parseTableTime('2026-12-01'), /时刻|日期/);
  const dayOnly = api.parseTableTime('28日 09:15');
  assert.equal(new Date(dayOnly.ts).getDate(), 28);
  assert.equal(new Date(dayOnly.ts).getHours(), 9);
  assert.equal(new Date(dayOnly.ts).getMinutes(), 15);
});

test('定时完成列表准确区分演练、投票草稿与回写失败', async () => {
  const app = await loadPopup();
  const base = Date.now();
  app.storage.scheduledTasks = [
    { id: 'dry', status: 'done', content: '演练', dryRun: true, fireAtTimestamp: base + 3000 },
    { id: 'poll', status: 'done', content: '投票', dryRun: false, preparedOnly: true, fireAtTimestamp: base + 2000 },
    { id: 'failed-write', status: 'done', content: '实盘', dryRun: false, writeBackError: '无权限', fireAtTimestamp: base + 1000 },
  ];
  await app.schedFilterChips.find((c) => c.dataset.filter === 'done').click();
  await new Promise((r) => setImmediate(r));
  const cards = app.elements.get('schedListContainer').children;
  assert.match(cards[0].innerHTML, /演练完成/);
  assert.match(cards[1].innerHTML, /待人工发送/);
  assert.match(cards[2].innerHTML, /回写失败/);
});

test('批次摘要不会将演练与已装配投票计入真实发布', async () => {
  const { api } = await loadPopup();
  const text = api.formatPipelineSummary({ processed: 5, published: 1, rehearsed: 2, prepared: 2, writtenBack: 1 });
  assert.match(text, /已处理 5 条/);
  assert.match(text, /真实发布 1 条/);
  assert.match(text, /演练 2 条/);
  assert.match(text, /待人工发送 2 条/);
});

test('开关运行模式交由后台处理，不直接重写定时任务', async () => {
  const app = await loadPopup({ scheduledTasks: [], schedulePaused: true });
  app.storage.scheduledTasks = [{ id: 'done', status: 'done', dryRun: true }];
  app.elements.get('dryRunToggle').checked = false;
  await app.elements.get('dryRunToggle').emit('change');
  assert.equal(app.storage.scheduledTasks[0].dryRun, true);
  assert.ok(app.sent.some((request) => request.action === 'SET_DRY_RUN_MODE' && request.dryRun === false));
});

test('清空账本请求交给后台串行处理', async () => {
  const app = await loadPopup({
    publishLedger: [
      { id: 'item_1', mode: '真实发布', postUrl: 'https://weibo.com/123/Abc', writeBackOk: false },
      { id: 'item_2', mode: '真实发布', postUrl: 'https://weibo.com/123/Def', writeBackOk: true },
      { id: 'item_3', mode: '安全演练', postUrl: '', writeBackOk: false },
    ],
    __unwrittenReceipts__: [],
  });
  const btnClear = app.elements.get('btnClearLedger');
  await btnClear.click();
  assert.ok(app.sent.some((request) => request.action === 'CLEAR_PUBLISH_LEDGER'));
  assert.equal(app.storage.publishLedger.length, 3);
  assert.equal(app.storage.__unwrittenReceipts__.length, 0);
});

test('含图投票草稿装配在卡片上展示需人工补传', async () => {
  const app = await loadPopup();
  const task = { docId: 'slot_a', docUrl: 'https://docs.qq.com/sheet/a', row: 2, targetCell: 'E2', content: '投票' };
  app.api.setScannedTasks([task]);
  app.api.renderTaskList([task]);
  for (const fn of app.messages) {
    fn({ action: 'TASK_ITEM_COMPLETED', payload: { ...task, preparedOnly: true, manualImagesRequired: true } });
  }
  const card = app.elements.get('taskListContainer').children[0];
  const badge = card.querySelector('.sched-card-left-meta, .task-item-meta').children[0];
  assert.match(badge.textContent, /需人工补传/);
});

test('智能解析投票卡片渲染全部选项并包含补加选项交互入口', async () => {
  const app = await loadPopup();
  app.api.setParsedTasks([
    {
      account: '测试号',
      content: '你觉得张康乐这次的造型可以打几分？',
      poll: {
        title: '你觉得张康乐这次的造型可以打几分？',
        options: ['10分满分！太惊艳了！', '8-9分，帅得很突出', '6-7分，中规中矩吧', '5分以下，感觉一般般'],
      },
    },
  ]);
  const card = app.elements.get('parsedTasksPreviewContainer').children[0];
  assert.match(card.innerHTML, /投票\(4项\)/);
  assert.match(card.innerHTML, /5分以下，感觉一般般/);
  assert.match(card.innerHTML, /btn-add-parsed-opt/);
  assert.match(card.innerHTML, /\+ 补加选项/);
});

test('无@符号的账号名冒号前缀多任务（含video链接与首行问句）可正确拆分且不误判投票', async () => {
  const { api } = await loadPopup();
  const sample = [
    '瑞峰财经：如果有一个不被打扰的下午，你最想做什么呢?',
    '有人想安静独处，有人想尽兴玩一场，我们想要的自由往往就是一句「按自己的需求来」。#智能通信自助餐# #按需消费才是真自由#',
    '💡联通魔方，满足多种使用场景，按需自由搭配，就像你的生活，本该由你自己选择。https://video.weibo.com/show?fid=1034:5364349145907229',
    '',
    '新浪科普：#智能通信自助餐# #按需消费才是真自由#全国首个万兆AI商圈落地广州正佳广场，中国联通以万兆光网+AI重塑消费体验：消费者秒级支付，商户直播不卡顿、AI精准引流，运营管理更智能。从扫码点餐到直播带货，让每一刻都精彩在线！https://video.weibo.com/show?fid=1034:5364106023075912',
  ].join('\n');

  const tasks = await api.parseBatchTaskText(sample);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].account, '瑞峰财经');
  assert.equal(tasks[0].poll, null);
  assert.ok(tasks[0].content.startsWith('如果有一个不被打扰的下午'));
  assert.ok(tasks[0].content.includes('https://video.weibo.com/show?fid=1034:5364349145907229'));

  assert.equal(tasks[1].account, '新浪科普');
  assert.equal(tasks[1].poll, null);
  assert.ok(tasks[1].content.startsWith('#智能通信自助餐#'));
  assert.ok(tasks[1].content.includes('https://video.weibo.com/show?fid=1034:5364106023075912'));
});

test('无空行紧邻的已知账号前缀与多账号顿号连写均可准确拆分，正文小标题不误判', async () => {
  const { api } = await loadPopup();

  const tight = await api.parseBatchTaskText([
    '瑞峰财经：第一条财经快讯正文',
    '网友热议：这不会被误判成新账号',
    '新浪科普：第二条科普长文正文',
  ].join('\n'));
  assert.equal(tight.length, 2);
  assert.equal(tight[0].account, '瑞峰财经');
  assert.ok(tight[0].content.includes('网友热议：这不会被误判成新账号'));
  assert.equal(tight[1].account, '新浪科普');
  assert.equal(tight[1].content, '第二条科普长文正文');

  const multiLeading = await api.parseBatchTaskText('瑞峰财经、新浪科普：双账号共发一条正文');
  assert.equal(multiLeading.length, 2);
  assert.deepEqual([...multiLeading.map((t) => t.account)], ['瑞峰财经', '新浪科普']);
  assert.equal(multiLeading[0].content, '双账号共发一条正文');
});

test('别名直写与行尾指令后缀剥离对齐原系统规则', async () => {
  const { api } = await loadPopup();
  const tasks = await api.parseBatchTaskText('对焦：今日科技看点 https://video.weibo.com/show?fid=1034:999 @锐视频 辛苦发下');
  assert.equal(tasks.length, 2);
  assert.deepEqual([...tasks.map((t) => t.account)], ['对焦Focus', '锐视频RAYVIDEO']);
  assert.equal(tasks[0].content, '今日科技看点 https://video.weibo.com/show?fid=1034:999');
});

test('结尾含特殊空白符与N小号随机抽号指令（如辛苦+3小号发）可正确剥离并展开多账号', async () => {
  const { api } = await loadPopup();
  const sample = [
    '【测试长标题】这是一段带话题和短链的测试正文。#测试话题# http://t.cn/MOCK123',
    '',
    ' @BOOM视频值班 辛苦+3小号发',
  ].join('\n');
  const tasks = await api.parseBatchTaskText(sample);
  assert.equal(tasks.length, 4);
  assert.equal(tasks[0].account, 'BOOM视频');
  assert.equal(new Set(tasks.map((t) => t.account)).size, 4);
  assert.equal(tasks[0].content, '【测试长标题】这是一段带话题和短链的测试正文。#测试话题# http://t.cn/MOCK123');
});

test('投票任务末尾含评论区聊聊与辛苦发布投票指令时完整保留全部3个选项', async () => {
  const { api } = await loadPopup();
  const sample = [
    '【#测试话题A#】节目中嘉宾谈到情绪消费。#测试话题B#',
    '平时花钱，你更愿意为哪种东西买单？',
    '买潮玩、周边，花小钱买情绪价值',
    '买大牌、硬通货，贵一点但能用很久',
    '评论区聊聊',
    '',
    ' @BOOM视频值班 辛苦发布投票',
  ].join('\n');
  const tasks = await api.parseBatchTaskText(sample);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].account, 'BOOM视频');
  assert.equal(tasks[0].poll.days, 30);
  assert.equal(tasks[0].poll.title, '平时花钱，你更愿意为哪种东西买单？');
  assert.deepEqual([...tasks[0].poll.options], [
    '买潮玩、周边，花小钱买情绪价值',
    '买大牌、硬通货，贵一点但能用很久',
    '评论区聊聊',
  ]);
});

test('带转发链接的多段@账号派单文本可剥离头部并精准拆分为对应账号转发任务', async () => {
  const app = await loadPopup();
  const { api } = app;
  const sample = [
    '@Mock主号值班 辛苦转发评论支持',
    '《前主编》11月12日账号推广',
    '转发链接：https://weibo.com/6723451236/Rr20v8BXT',
    '',
    '@对焦 @BOOM 视频',
    '#英国国王查尔斯承认历史不公#新浪新闻@前主编 Global | 第一段转发评论正文。',
    '',
    '@手机头条 @新浪新闻滚动',
    '#英国国王查尔斯承认历史不公#新浪新闻@前主编 Global | 第二段转发评论正文。',
    '',
    '@瑞峰财经 @微资讯',
    '#英国国王查尔斯承认历史不公#新浪新闻@前主编 Global | 第三段转发评论正文。',
  ].join('\n');
  const tasks = await api.parseBatchTaskText(sample);
  assert.equal(tasks.length, 6);
  assert.deepEqual([...tasks.map((t) => t.account)], [
    '对焦Focus', 'BOOM视频', '手机头条', '新浪新闻滚动', '瑞峰财经', '微资讯',
  ]);
  assert.equal(tasks[0].repostUrl, 'https://weibo.com/6723451236/Rr20v8BXT');
  assert.equal(tasks[0].commentOriginal, true);
  assert.equal(tasks[0].content, '#英国国王查尔斯承认历史不公#新浪新闻@前主编 Global | 第一段转发评论正文。');
  assert.equal(tasks[1].content, '#英国国王查尔斯承认历史不公#新浪新闻@前主编 Global | 第一段转发评论正文。');

  api.setParsedTasks(tasks);
  const card = app.elements.get('parsedTasksPreviewContainer').children[0];
  assert.match(card.innerHTML, /parsed-repost-url-input/);
  assert.match(card.innerHTML, /https:\/\/weibo\.com\/6723451236\/Rr20v8BXT/);
  assert.match(card.innerHTML, /parsed-comment-orig-input/);
  assert.match(card.innerHTML, /parsed-content-input/);

  await app.elements.get('btnParserRunNow').click();
  const started = app.sent.find((m) => m.action === 'START_PIPELINE');
  assert.equal(started.config.selectedTasks[0].repostUrl, 'https://weibo.com/6723451236/Rr20v8BXT');
  assert.equal(started.config.selectedTasks[0].commentOriginal, true);
  assert.equal(started.config.selectedTasks[2].repostUrl, 'https://weibo.com/6723451236/Rr20v8BXT');

  await app.elements.get('btnParserToSchedule').click();
  assert.equal(app.elements.get('enqueueScheduleModal').style.display, 'flex');
  await app.elements.get('btnEnqueueConfirm').click();
  const queued = app.sent.find((m) => m.action === 'ADD_SCHEDULE_TASKS');
  assert.equal(queued.tasks[0].repostUrl, 'https://weibo.com/6723451236/Rr20v8BXT');
  assert.equal(queued.tasks[0].commentOriginal, true);
});

test('账本合并清账保留记录并按编号去重，展示人工补录核对信息', async () => {
  const pending = { id: 'manual', mode: '真实发布', submittedWithoutReceipt: true, account: '虚构账号', fullContent: '虚构正文', docName: '模拟表', row: 2 };
  const app = await loadPopup({ publishLedger: [pending], __unwrittenReceipts__: [pending, { ...pending, id: 'retained', account: '另一个虚构账号' }] });
  await app.elements.get('tabNavLedger').click();
  await new Promise((r) => setImmediate(r));
  const cards = app.elements.get('ledgerListContainer').children;
  assert.equal(cards.length, 2);
  assert.match(cards[0].innerHTML, /虚构账号/);
  assert.match(cards[0].innerHTML, /虚构正文/);
  assert.match(cards[1].innerHTML, /btn-manual-receipt/);
});

test('发博账本支持一键复制全部成功发布账号名与链接及单条复制入口', async () => {
  const copied = [];
  const app = await loadPopup(
    {
      publishLedger: [
        { id: '1', account: '瑞峰财经', docName: '主表', mode: '真实发布', postUrl: 'https://weibo.com/111/Aaa' },
        { id: '2', account: '新浪科普', docName: '主表', mode: '安全演练', postUrl: '' },
        { id: '3', account: '对焦Focus', docName: '主表', mode: '真实发布', postUrl: 'https://weibo.com/222/Bbb' },
      ],
    },
    {},
    {
      navigator: { clipboard: { writeText: async (text) => { copied.push(text); } } },
    }
  );

  await app.elements.get('tabNavLedger').click();
  await new Promise((r) => setImmediate(r));
  const cards = app.elements.get('ledgerListContainer').children;
  assert.equal(cards.length, 3);
  assert.match(cards[0].innerHTML, /btn-copy-ledger-url/);
  assert.match(cards[0].innerHTML, /🔗 链接/);
  assert.match(cards[0].innerHTML, /btn-copy-ledger-item/);
  assert.match(cards[0].innerHTML, /📋 账号\+链接/);
  assert.doesNotMatch(cards[1].innerHTML, /btn-copy-ledger-url/);
  assert.doesNotMatch(cards[1].innerHTML, /btn-copy-ledger-item/);

  await app.elements.get('btnCopyLedgerLinks').click();
  assert.equal(copied.length, 1);
  assert.equal(copied[0], '瑞峰财经 https://weibo.com/111/Aaa\n对焦Focus https://weibo.com/222/Bbb');
});

test('发博账本支持按文档/任务解析/演练草稿/账号筛选及按文档分组展示', async () => {
  const now = Date.now();
  const app = await loadPopup({
    publishLedger: [
      { id: '1', account: '瑞峰财经', docName: '表A', docUrl: 'https://docs.qq.com/sheet/A', mode: '真实发布', writeBackOk: true, postUrl: 'https://weibo.com/1/A', timestamp: now },
      { id: '2', account: '新浪科普', docName: '任务解析', mode: '真实发布', writeBackOk: false, postUrl: 'https://weibo.com/2/B', timestamp: now - 1000 },
      { id: '3', account: '瑞峰财经', docName: '表B', docUrl: 'https://docs.qq.com/sheet/B', mode: '安全演练', postUrl: '', timestamp: now - 2000 },
    ],
  });

  await app.elements.get('tabNavLedger').click();
  await new Promise((r) => setImmediate(r));
  assert.equal(app.elements.get('ledgerListContainer').children.length, 3);

  // 按账号筛选
  app.elements.get('ledgerAccountFilter').value = '瑞峰财经';
  await app.elements.get('ledgerAccountFilter').listeners.get('change')[0]();
  assert.equal(app.elements.get('ledgerListContainer').children.length, 2);

  // 按文档分组
  app.elements.get('ledgerAccountFilter').value = 'all';
  app.elements.get('ledgerGroupMode').value = 'doc';
  await app.elements.get('ledgerGroupMode').listeners.get('change')[0]();
  const groups = app.elements.get('ledgerListContainer').children;
  assert.equal(groups.length, 3);
  assert.match(groups[0].children[0].innerHTML, /📁 表A/);
  assert.match(groups[1].children[0].innerHTML, /📁 任务解析/);

  // 任务解析无云文档记录不应混入“待处理”
  const pendingChip = Array.from(app.elements.get('ledgerFilterChips')?.children || [])
    .find((c) => c?.dataset?.ledgerFilter === 'writeback_fail');
  if (pendingChip) {
    await pendingChip.click();
    assert.equal(app.elements.get('ledgerListContainer').children.length, 0);
  }
});

test('扫图后支持在前端渲染配图缩略图、防盗链回退拉取以及点击放大预览', async () => {
  const app = await loadPopup(
    {},
    {
      FETCH_PREVIEW_IMAGE: {
        ok: true,
        dataUrl: 'data:image/png;base64,MOCKFALLBACK',
      },
    }
  );
  const img1 = 'https://docs.qq.com/image/mock1.png';
  const img2 = 'https://docs.qq.com/image/mock2.png';
  const thumb1 = { dataset: { taskIndex: '0', imgIndex: '0', rawUrl: img1 }, src: img1, style: {}, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } };
  const thumb2 = { dataset: { taskIndex: '0', imgIndex: '1', rawUrl: img2 }, src: img2, style: {}, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } };

  app.elements.get('taskListContainer').querySelectorAll = (selector) => {
    if (selector === '.task-thumb-img, .modal-thumb-img') return [thumb1, thumb2];
    return [];
  };

  app.api.renderTaskList([
    {
      docId: 'slot_a',
      docUrl: 'https://docs.qq.com/sheet/a',
      row: 2,
      account: '测试号',
      content: '带图博文测试',
      imgUrls: [img1, img2],
    },
  ]);

  const card = app.elements.get('taskListContainer').children[0];
  assert.match(card.innerHTML, /task-images-row/);
  assert.match(card.innerHTML, /task-thumb-img/);

  // 触发防盗链加载失败回退
  await thumb1.listeners.error();
  assert.ok(app.sent.some((req) => req.action === 'FETCH_PREVIEW_IMAGE' && req.url === img1));
  assert.equal(thumb1.src, 'data:image/png;base64,MOCKFALLBACK');

  // 点击第一张缩略图打开放大预览弹窗并切换第二张
  thumb1.listeners.click({});
  assert.equal(app.elements.get('imagePreviewModal').style.display, 'flex');
  assert.equal(app.elements.get('imagePreviewCounter').textContent, '1 / 2');
  assert.equal(app.elements.get('imagePreviewImg').src, 'data:image/png;base64,MOCKFALLBACK');

  await app.elements.get('btnImagePreviewNext').click();
  assert.equal(app.elements.get('imagePreviewCounter').textContent, '2 / 2');
  assert.equal(app.elements.get('imagePreviewImg').src, img2);

  await app.elements.get('btnImagePreviewClose').click();
  assert.equal(app.elements.get('imagePreviewModal').style.display, 'none');
});

test('定时管理与发博账本展示回写失败原因并提供一键补写文档入口', async () => {
  const app = await loadPopup({
    scheduledTasks: [
      {
        id: 'sched_wb_fail',
        docUrl: 'https://docs.qq.com/sheet/mock',
        docName: '主表',
        row: 8,
        targetCell: 'E8',
        account: '测试号',
        content: '回写失败测试正文',
        fireAtTimestamp: Date.now() - 1000,
        fireAtTime: '12:00',
        status: 'done',
        dryRun: false,
        preparedOnly: false,
        postUrl: 'https://weibo.com/123/WbFail8',
        writeBackOk: false,
        writeBackError: '表格写入超时',
      },
    ],
    publishLedger: [
      {
        id: 'led_wb_fail',
        docUrl: 'https://docs.qq.com/sheet/mock',
        docName: '主表',
        row: 8,
        targetCell: 'E8',
        account: '测试号',
        contentSummary: '回写失败测试正文',
        mode: '真实发布',
        postUrl: 'https://weibo.com/123/WbFail8',
        writeBackOk: false,
        writeBackError: '表格写入超时',
      },
    ],
  });

  await app.elements.get('tabNavSchedule').click();
  await app.schedFilterChips.find((c) => c.dataset.filter === 'done').click();
  await new Promise((r) => setImmediate(r));
  const schedCard = app.elements.get('schedListContainer').children[0];
  assert.match(schedCard.innerHTML, /回写失败原因: 表格写入超时/);
  assert.match(schedCard.innerHTML, /btn-retry-writeback/);

  await app.elements.get('tabNavLedger').click();
  await new Promise((r) => setImmediate(r));
  const ledgerCard = app.elements.get('ledgerListContainer').children[0];
  assert.match(ledgerCard.innerHTML, /回写失败原因: 表格写入超时/);
  assert.match(ledgerCard.innerHTML, /btn-retry-ledger-writeback/);
});

test('弹窗重开时自动恢复上次扫描缓存的任务列表，并在真实写回完成后自动剔除已发条目', async () => {
  const cachedItem = {
    docId: 'slot_1',
    docName: '主表',
    docUrl: 'https://docs.qq.com/sheet/mock',
    targetSheetId: 's1',
    row: 5,
    targetCell: 'E5',
    account: '测试号',
    content: '缓存待发正文',
    imgUrls: [],
  };
  const app = await loadPopup({
    cachedScannedTasks: [cachedItem],
    cachedScannedAt: Date.now() - 60000,
  });

  const taskCards = app.elements.get('taskListContainer').children;
  assert.equal(taskCards.length, 1);
  assert.match(app.elements.get('taskCountBadge').textContent, /缓存/);

  for (const fn of app.messages) {
    fn({
      action: 'TASK_ITEM_COMPLETED',
      payload: {
        docId: 'slot_1',
        docUrl: 'https://docs.qq.com/sheet/mock',
        targetSheetId: 's1',
        row: 5,
        targetCell: 'E5',
        dryRun: false,
        preparedOnly: false,
        writeBackOk: true,
      },
    });
  }
  assert.equal(app.storage.cachedScannedTasks.length, 0);
});

test('定时管理默认只展示待触发任务并按触发时间升序排序，全部视图下异常置顶', async () => {
  const app = await loadPopup();
  const base = Date.now() + 60000;
  app.storage.scheduledTasks = [
    { id: 'later', status: 'pending', content: '较晚任务', account: 'A', fireAtTimestamp: base + 300000 },
    { id: 'done1', status: 'done', content: '已完成', account: 'B', fireAtTimestamp: base - 10000 },
    { id: 'err1', status: 'error', content: '异常任务', account: 'C', fireAtTimestamp: base + 10000 },
    { id: 'sooner', status: 'pending', content: '较早任务', account: 'D', fireAtTimestamp: base + 60000 },
  ];
  await app.api.refreshScheduleQueue();
  const pendingCards = app.elements.get('schedListContainer').children;
  assert.equal(pendingCards.length, 2);
  assert.equal(pendingCards[0].id, 'sched-card-sooner');
  assert.equal(pendingCards[1].id, 'sched-card-later');

  await app.schedFilterChips.find((c) => c.dataset.filter === 'all').click();
  await new Promise((r) => setImmediate(r));
  const allCards = app.elements.get('schedListContainer').children;
  assert.equal(allCards.length, 4);
  assert.equal(allCards[0].id, 'sched-card-err1');
  assert.equal(allCards[1].id, 'sched-card-sooner');
  assert.equal(allCards[3].id, 'sched-card-done1');
});

test('清理已完成按钮发送CLEAR_DONE_SCHEDULE消息且不触发全量清空', async () => {
  const app = await loadPopup();
  await app.elements.get('btnClearDoneSched').click();
  assert.ok(app.sent.some((m) => m.action === 'CLEAR_DONE_SCHEDULE'));
  assert.equal(app.sent.some((m) => m.action === 'CLEAR_ALL_SCHEDULE'), false);
});

test('定时队列支持按账号和正文关键词搜索过滤', async () => {
  const app = await loadPopup();
  const base = Date.now() + 60000;
  app.storage.scheduledTasks = [
    { id: 's1', status: 'pending', account: '新浪军事', content: '航母最新动态', docName: '主表', fireAtTimestamp: base },
    { id: 's2', status: 'pending', account: '新浪手机', content: '旗舰新机评测', docName: '副表', fireAtTimestamp: base + 1000 },
  ];
  app.elements.get('schedSearchInput').value = '军事';
  await app.elements.get('schedSearchInput').emit('input');
  await new Promise((r) => setImmediate(r));
  const cards = app.elements.get('schedListContainer').children;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'sched-card-s1');
});

test('同步发布列表对已排程行标记已排程并默认取消勾选防重复入队', async () => {
  const docUrl = 'https://docs.qq.com/sheet/mock';
  const app = await loadPopup({
    scheduledTasks: [
      { id: 'p1', status: 'pending', docUrl, targetSheetId: 's1', row: 2, content: '已排程行' },
    ],
  });
  const tasks = [
    { docId: 'slot_1', docUrl, targetSheetId: 's1', row: 2, targetCell: 'E2', account: 'A', content: '已排程行' },
    { docId: 'slot_1', docUrl, targetSheetId: 's1', row: 3, targetCell: 'E3', account: 'B', content: '未排程行' },
  ];
  app.api.setScannedTasks(tasks);
  app.api.renderTaskList(tasks);
  const cards = app.elements.get('taskListContainer').children;
  assert.equal(cards.length, 2);
  assert.match(cards[0].innerHTML, /已排程/);
  assert.doesNotMatch(cards[0].innerHTML, /checked/);
  assert.match(cards[1].innerHTML, /checked/);
});

test('高频实盘流默认直接显示立即发布与定时发布且点击直接执行，开启演练时显示提示条并可一键关闭', async () => {
  const app = await loadPopup({
    docPresets: [{ id: 'slot_1', name: '主表', url: 'https://docs.qq.com/sheet/mock', linkCol: 'E' }],
  });
  assert.equal(app.elements.get('dryRunToggle').checked, false);
  assert.equal(app.elements.get('dryRunActiveBanner').style.display, 'none');
  assert.equal(app.elements.get('btnStartText').textContent, '🚀 立即发布');
  assert.equal(app.elements.get('btnAddToSchedule').textContent, '⏰ 定时发布');

  app.api.setScannedTasks([]);
  await app.elements.get('btnStart').click();
  assert.equal(app.sent.some((m) => m.action === 'START_PIPELINE' && m.config?.dryRun === false), true);

  app.elements.get('dryRunToggle').checked = true;
  await app.elements.get('dryRunToggle').emit('change');
  assert.equal(app.elements.get('dryRunActiveBanner').style.display, 'flex');
  assert.equal(app.elements.get('btnStartText').textContent, '🛡️ 演练执行');

  await app.elements.get('btnDisableDryRunQuick').click();
  assert.equal(app.elements.get('dryRunToggle').checked, false);
  assert.equal(app.elements.get('dryRunActiveBanner').style.display, 'none');
  assert.equal(app.sent.some((m) => m.action === 'SET_DRY_RUN_MODE' && m.dryRun === false), true);
});

test('同步发布搜索框过滤任务列表并支持任务解析一键收起原文', async () => {
  const app = await loadPopup();
  const tasks = [
    { docId: 'slot_1', docUrl: 'https://docs.qq.com/sheet/a', targetSheetId: 's1', row: 2, targetCell: 'E2', account: '新浪军事', content: '航母消息' },
    { docId: 'slot_1', docUrl: 'https://docs.qq.com/sheet/a', targetSheetId: 's1', row: 3, targetCell: 'E3', account: '新浪手机', content: '新品发布' },
  ];
  app.api.setScannedTasks(tasks);
  app.elements.get('taskSearchInput').value = '手机';
  await app.elements.get('taskSearchInput').emit('input');
  const cards = app.elements.get('taskListContainer').children;
  assert.equal(cards.length, 1);
  assert.match(cards[0].innerHTML, /新浪手机/);

  await app.elements.get('btnToggleParserInput').click();
  assert.equal(app.elements.get('taskParserInput').style.display, 'none');
  await app.elements.get('btnToggleParserInput').click();
  assert.equal(app.elements.get('taskParserInput').style.display, 'block');
});

test('任务解析优先使用中台动态缓存的cachedPlatformAccounts进行小号抽号', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: ['虚构主号', '动态小号甲', '动态小号乙'],
  });
  const parsed = await app.api.parseBatchTaskText('这是测试正文\n@虚构主号 辛苦+2小号发');
  const accts = parsed.map((t) => t.account);
  assert.ok(accts.includes('虚构主号'));
  assert.ok(accts.includes('动态小号甲'));
  assert.ok(accts.includes('动态小号乙'));
  assert.equal(accts.length, 3);
});

test('同步发布扫表后点击加入定时管理直接入队，不再弹出二次确认框', async () => {
  const app = await loadPopup();
  app.api.setScannedTasks([
    { docId: 'slot_1', docUrl: 'https://docs.qq.com/sheet/a', targetSheetId: 's1', row: 2, targetCell: 'E2', account: '虚构测试账号', content: '测试定时入队正文' },
  ]);
  app.elements.get('taskListContainer').querySelectorAll = (sel) => (sel === '.task-item-cb:checked' ? [{ dataset: { taskIndex: '0' } }] : []);
  await app.elements.get('btnAddToSchedule').click();
  assert.notEqual(app.elements.get('enqueueScheduleModal').style.display, 'flex');
  const addMsg = app.sent.find((m) => m.action === 'ADD_SCHEDULE_TASKS');
  assert.ok(addMsg);
  assert.equal(addMsg.tasks.length, 1);
  assert.equal(addMsg.tasks[0].account, '虚构测试账号');
});

test('指令行含大号+N个小号发布与特殊空白符时可正确识别并展开账号', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: ['虚构主号', '小号1', '小号2', '小号3', '小号4', '小号5'],
  });
  const sample = [
    '【双11囤Token成消费新场景】#现在省钱还靠双十一吗# 测试正文内容。（央视）https://video.weibo.com/show?fid=1034:5364194120237091',
    '',
    '  @虚构主号值班 辛苦老师大号+5个小号发布',
  ].join('\n');
  const parsed = await app.api.parseBatchTaskText(sample);
  assert.ok(parsed.some((t) => t.account === '虚构主号'));
  assert.equal(parsed.filter((t) => t.account.startsWith('小号')).length, 5);
  assert.ok(parsed[0].content.includes('【双11囤Token成消费新场景】'));
  assert.ok(parsed[0].content.includes('https://video.weibo.com/show?fid=1034:5364194120237091'));
});

test('指令行含连接词(和/一起)与含空格别名(@新浪 AI)时不拆出残缺账号', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: ['新浪AI', '虚构主号', '小号A', '小号B'],
  });
  const sample = [
    '测试一条AI行业快讯正文内容。',
    '',
    '@新浪 AI @虚构主号值班 辛苦帮忙和2个小号一起发布',
  ].join('\n');
  const parsed = await app.api.parseBatchTaskText(sample);
  const accts = parsed.map((t) => t.account);
  assert.ok(accts.includes('新浪AI'));
  assert.ok(accts.includes('虚构主号'));
  assert.ok(accts.includes('小号A'));
  assert.ok(accts.includes('小号B'));
  assert.equal(accts.includes('新浪'), false);
  assert.equal(accts.length, 4);
});

test('普通多段任务中含转发字样和文末微博链接时不误切掉前文，且@账号不带末尾标点', async () => {
  const app = await loadPopup();
  const sample = [
    '@虚构账号甲！ 辛苦发下',
    '这条新闻引发网友大量转发讨论。',
    '',
    '@虚构账号乙。',
    '第二条正文附带参考链接 https://weibo.com/12345678/AbCdEf99',
  ].join('\n');
  const parsed = await app.api.parseBatchTaskText(sample);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].account, '虚构账号甲');
  assert.equal(parsed[1].account, '虚构账号乙');
  assert.equal(parsed[0].repostUrl, '');
});

test('顶部全局停止按钮在流水线运行时显示并可随时发送STOP_PIPELINE', async () => {
  const app = await loadPopup({}, { GET_PIPELINE_STATUS: { ok: true, state: { isRunning: true } } });
  const globalStop = app.elements.get('btnGlobalStop');
  assert.equal(globalStop.style.display, 'inline-flex');
  assert.equal(globalStop.disabled, false);
  await globalStop.click();
  assert.ok(app.sent.some((m) => m.action === 'STOP_PIPELINE'));
});

test('同步发布支持文档卡槽折叠持久化、空态隐藏过滤栏与多文档芯片渲染', async () => {
  const app = await loadPopup({ docSlotsCollapsed: true });
  const container = app.elements.get('docSlotsContainer');
  const toggleBtn = app.elements.get('btnToggleDocSlots');
  const filterBar = app.elements.get('taskFilterBar');
  const docChips = app.elements.get('taskDocFilterChips');

  assert.equal(container.style.display, 'none');
  assert.equal(toggleBtn.textContent, '🔽 展开');
  app.api.renderTaskList([]);
  assert.equal(filterBar.style.display, 'none');

  await toggleBtn.click();
  assert.equal(container.style.display, 'flex');
  assert.equal(toggleBtn.textContent, '🔼 收起');
  assert.equal(app.storage.docSlotsCollapsed, false);

  const tasks = [
    { docId: 'slot_1', docName: '主表', docUrl: 'https://docs.qq.com/sheet/a', targetSheetId: 's1', row: 2, targetCell: 'E2', account: '虚构号1', content: '内容A' },
    { docId: 'slot_2', docName: '副表', docUrl: 'https://docs.qq.com/sheet/b', targetSheetId: 's2', row: 3, targetCell: 'E3', account: '虚构号2', content: '内容B' },
  ];
  app.api.setScannedTasks(tasks);
  app.api.renderTaskList(tasks);

  assert.equal(filterBar.style.display, 'block');
  assert.equal(docChips.style.display, 'flex');
  assert.match(docChips.innerHTML, /全部 \(2\)/);
  assert.match(docChips.innerHTML, /主表/);
  assert.match(docChips.innerHTML, /副表/);
});

test('同步发布选中数量变化时动态更新数量角标与加入定时按钮文案', async () => {
  const app = await loadPopup();
  const tasks = [
    { docId: 'slot_1', docName: '主表', docUrl: 'https://docs.qq.com/sheet/a', targetSheetId: 's1', row: 2, targetCell: 'E2', account: '虚构号1', content: '内容A' },
    { docId: 'slot_1', docName: '主表', docUrl: 'https://docs.qq.com/sheet/a', targetSheetId: 's1', row: 3, targetCell: 'E3', account: '虚构号2', content: '内容B' },
  ];
  app.api.setScannedTasks(tasks);
  app.elements.get('taskListContainer').querySelectorAll = (sel) => (sel === '.task-item-cb:checked' ? [{ dataset: { taskIndex: '0' } }] : []);
  app.api.renderTaskList(tasks);

  assert.equal(app.elements.get('taskCountBadge').textContent, '已选 1 / 共 2 条');
  assert.equal(app.elements.get('btnAddToSchedule').textContent, '⏰ 定时发布 (1)');

  app.api.setScannedTasks([]);
  app.api.renderTaskList([]);
  assert.equal(app.elements.get('taskFilterBar').style.display, 'none');
  assert.equal(app.elements.get('taskCountBadge').textContent, '0 条');
});

test('文档卡槽支持自定义名称并持久化，同时联动更新已扫描任务的文档名', async () => {
  const app = await loadPopup({
    docPresets: [
      { id: 'slot_1', name: '文档 1 (主表)', url: 'https://docs.qq.com/sheet/a', linkCol: 'E' },
      { id: 'slot_2', name: '文档 2 (副表)', url: 'https://docs.qq.com/sheet/b', linkCol: 'E' },
    ],
  });
  const tasks = [
    { docId: 'slot_1', docName: '文档 1 (主表)', docUrl: 'https://docs.qq.com/sheet/a', targetSheetId: 's1', row: 2, targetCell: 'E2', account: '虚构号1', content: '内容A' },
    { docId: 'slot_2', docName: '文档 2 (副表)', docUrl: 'https://docs.qq.com/sheet/b', targetSheetId: 's2', row: 3, targetCell: 'E3', account: '虚构号2', content: '内容B' },
  ];
  app.api.setScannedTasks(tasks);
  app.api.renderTaskList(tasks);

  const firstRow = app.elements.get('docSlotsContainer').children[0];
  const nameInput = firstRow.querySelector('.doc-slot-name-input');
  nameInput.value = '双11主推表';
  await nameInput.emit('input');

  assert.equal(app.storage.docPresets[0].name, '双11主推表');
  assert.equal(tasks[0].docName, '双11主推表');
  assert.match(app.elements.get('taskDocFilterChips').innerHTML, /双11主推表/);

  nameInput.value = '   ';
  await nameInput.emit('blur');
  assert.equal(app.storage.docPresets[0].name, '文档 1 (主表)');
  assert.equal(nameInput.value, '文档 1 (主表)');
});

test('大号+N小号抽号自动过滤仅蓝V、同时评论给原微博等非账号复选框与已下线账号', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: [
      '新浪热点',
      '仅蓝V',
      '仅蓝v',
      '仅视频',
      '同时评论给原微博',
      '全选',
      '新浪运动',
      '新浪航天',
      '新浪医典',
      '新浪科普',
      '新浪生活',
      '新浪文旅',
    ],
  });
  const text = [
    '【郎平期待朱婷在国际赛场为中国代言】#郎平不认同竞技体育菜是原罪#在《体坛零距离》节目最后，郎平谈及对朱婷未来的期待。 http://t.cn/AXzrLUX3',
    '',
    '@新浪热点值班 辛苦大号+3小号发',
  ].join('\n');
  const tasks = await app.api.parseBatchTaskText(text);
  assert.equal(tasks.length, 4);
  assert.equal(tasks[0].account, '新浪热点');
  const subAccounts = tasks.slice(1).map((t) => t.account);
  for (const bad of ['仅蓝V', '仅蓝v', '仅视频', '同时评论给原微博', '全选', '新浪运动', '新浪航天', '新浪医典']) {
    assert.equal(subAccounts.includes(bad), false, `不应抽到非账号或已下线账号: ${bad}`);
  }
  assert.deepEqual(new Set(subAccounts), new Set(['新浪科普', '新浪生活', '新浪文旅']));
});

test('@新浪热点值班 仅跟 N小号（无大号/+小号/和小号）时仅抽取小号，不加入新浪热点', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: [
      '新浪热点',
      '新浪科普',
      '新浪生活',
      '新浪文旅',
      '新浪手机',
    ],
  });
  const text = [
    '郎平“吐槽”女儿饭量大，做事情商低，鲁豫：这是亲妈吗？#郎平讲到职业时简直在发光##热浪之外#http://t.cn/A6x2BV4c',
    '',
    ' @新浪热点值班 辛苦4小号',
  ].join('\n');
  const tasks = await app.api.parseBatchTaskText(text);
  assert.equal(tasks.length, 4);
  const accts = tasks.map((t) => t.account);
  assert.equal(accts.includes('新浪热点'), false);
  assert.deepEqual(new Set(accts), new Set(['新浪科普', '新浪生活', '新浪文旅', '新浪手机']));
});

test('点击智能解析预览左侧的一键粘贴解析按钮可将剪贴板内容填入解析框并立即完成解析预览', async () => {
  const clipText = '测试剪贴板派单正文\n@新浪热点值班 辛苦4小号';
  const app = await loadPopup({
    cachedPlatformAccounts: ['新浪热点', '小号1', '小号2', '小号3', '小号4'],
  }, {}, {
    navigator: { clipboard: { readText: async () => clipText } },
  });
  const input = app.elements.get('taskParserInput');
  input.style.display = 'none';
  await app.elements.get('btnPasteParser').click();
  assert.equal(input.value, clipText);
  assert.equal(input.style.display, 'block');
  assert.equal(app.elements.get('btnToggleParserInput').textContent, '🔼 收起原文');
  assert.equal(app.elements.get('parserCountBadge').textContent, '已解析 4 条任务');
});

test('运行状态日志倒序渲染，最新日志在最上面且靠近顶部时保持置顶', async () => {
  const app = await loadPopup({}, {
    GET_PIPELINE_STATUS: {
      ok: true,
      state: {
        isRunning: false,
        stage: '',
        percentage: 0,
        logs: [
          { detail: '第一条旧日志', level: 'info', time: '10:00:01' },
          { detail: '第二条日志', level: 'info', time: '10:00:02' },
        ],
      },
    },
  });
  const logWindow = app.elements.get('logWindow');
  assert.equal(logWindow.children.length, 2);
  assert.ok(logWindow.children[0].textContent.includes('第二条日志'));
  assert.ok(logWindow.children[1].textContent.includes('第一条旧日志'));
  assert.equal(logWindow.scrollTop, 0);

  logWindow.scrollTop = 10;
  for (const fn of app.messages) {
    fn({
      action: 'PIPELINE_LOG',
      payload: { detail: '第三条最新日志', level: 'success', time: '10:00:03' },
    });
  }
  assert.ok(logWindow.children[0].textContent.includes('第三条最新日志'));
  assert.equal(logWindow.scrollTop, 0);

  logWindow.scrollTop = 80;
  for (const fn of app.messages) {
    fn({
      action: 'PIPELINE_LOG',
      payload: { detail: '第四条日志', level: 'info', time: '10:00:04' },
    });
  }
  assert.ok(logWindow.children[0].textContent.includes('第四条日志'));
  assert.equal(logWindow.scrollTop, 80);
});

test('立即巡检失败时日志打印错误原因且不再误报暂无新微博', async () => {
  const app = await loadPopup({}, {
    GET_TOPIC_PIN_STATE: {
      ok: true,
      config: { autoMonitorEnabled: true, monitorUid: '2318910945', monitorIntervalSec: 180 },
      tasks: [],
      monitorStatus: { alarmActive: true, nextRunAt: Date.now() + 60000, lastRunAt: Date.now() - 30000, ok: true, newPost: false },
    },
    SAVE_TOPIC_PIN_CONFIG: { ok: true, config: { autoMonitorEnabled: true, monitorUid: '2318910945', monitorIntervalSec: 180 } },
    RUN_TOPIC_MONITOR_NOW: { ok: true, res: { ok: false, reason: '微博登录态失效' } },
  });
  await app.elements.get('btnRunTopicMonitorNow').click();
  const logWindow = app.elements.get('logWindow');
  const logsText = logWindow.children.map((c) => c.textContent).join('\n');
  assert.match(logsText, /巡检失败: 微博登录态失效/);
  assert.doesNotMatch(logsText, /暂无新微博/);
  assert.match(app.elements.get('topicMonitorStatusText').textContent, /巡检运行中/);
});

test('设置页支持展示、新增、删除与恢复支持的发布账号，并联动任务解析', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: ['新浪热点', '新浪科普', '新浪生活'],
  });

  // 1. 初始渲染包含当前支持的 3 个账号
  assert.equal(app.elements.get('supportedAccountsCountBadge').textContent, '3 个账号');
  const container = app.elements.get('supportedAccountsListContainer');
  assert.equal(container.children.length, 3);

  // 2. 新增发布账号
  app.elements.get('newSupportedAccountInput').value = '新浪新账号';
  await app.elements.get('btnAddSupportedAccount').click();
  assert.equal(app.elements.get('supportedAccountsCountBadge').textContent, '4 个账号');
  assert.deepEqual(app.storage.customAccounts, ['新浪新账号']);

  // 新增账号可被任务解析识别
  const parsedAdded = await app.api.parseBatchTaskText('@新浪新账号\n测试新增账号发博文案');
  assert.equal(parsedAdded.length, 1);
  assert.equal(parsedAdded[0].account, '新浪新账号');

  // 3. 删除发布账号（从列表中移除并写入 disabledAccounts，任务解析抽号不再抽到它）
  const lifePill = container.children.find((p) => p.children?.[0]?.textContent === '新浪生活');
  assert.ok(lifePill);
  const lifeDelBtn = lifePill.children[1];
  assert.ok(lifeDelBtn);
  await lifeDelBtn.click();
  assert.equal(app.elements.get('supportedAccountsCountBadge').textContent, '3 个账号');
  assert.ok(app.storage.disabledAccounts.includes('新浪生活'));

  const parsedWithoutLife = await app.api.parseBatchTaskText('测试文案\n@新浪热点值班 辛苦+全部小号');
  const extractedAccounts = parsedWithoutLife.map((t) => t.account);
  assert.equal(extractedAccounts.includes('新浪生活'), false);
  assert.ok(extractedAccounts.includes('新浪新账号'));

  // 4. 恢复默认清空自定义与移除记录
  await app.elements.get('btnResetDefaultAccounts').click();
  assert.deepEqual(app.storage.customAccounts, []);
  assert.deepEqual(app.storage.disabledAccounts, []);
  assert.equal(app.elements.get('supportedAccountsCountBadge').textContent, '3 个账号');
});

test('话题置顶页面支持状态筛选、关键词搜索、批量粘贴链接与批量重试异常任务', async () => {
  const app = await loadPopup({}, {
    GET_TOPIC_PIN_STATE: {
      ok: true,
      config: { autoMonitorEnabled: true, monitorUid: '2318910945', monitorIntervalSec: 150 },
      tasks: [
        {
          id: 'tp_1',
          mode: 'manual_pin',
          status: 'done',
          postUrl: 'https://weibo.com/2318910945/Done1',
          topics: [{ hashtag: '科技前沿', status: 'pinned', note: '已置顶' }],
        },
        {
          id: 'tp_2',
          mode: 'auto_monitor',
          status: 'waiting_review',
          postUrl: 'https://weibo.com/2318910945/Wait2',
          topics: [{ hashtag: '体育快讯', status: 'waiting_review', note: '审核中' }],
        },
        {
          id: 'tp_3',
          mode: 'manual_pin',
          status: 'error',
          postUrl: 'https://weibo.com/2318910945/Err3',
          error: '网络超时',
          topics: [{ hashtag: '财经热点', status: 'error', note: '失败' }],
        },
      ],
      monitorStatus: { alarmActive: true, ok: true, lastRunAt: Date.now() - 10000, newPost: false },
    },
    MANUAL_TOPIC_PIN: { ok: true },
    RETRY_ALL_ERROR_TOPIC_PIN_TASKS: { ok: true, retriedCount: 1 },
  });

  // 1. 巡检状态条显示运行中，重试异常按钮显示异常数量
  const monEl = app.elements.get('topicMonitorStatusText');
  assert.ok(monEl.classList.contains('is-running'));
  assert.equal(app.elements.get('btnRetryAllErrorTopicPins').style.display, 'inline-flex');
  assert.equal(app.elements.get('btnRetryAllErrorTopicPins').textContent, '🔁 重试异常 (1)');

  // 2. 关键词搜索过滤
  const searchInput = app.elements.get('topicPinSearchInput');
  searchInput.value = '体育快讯';
  await searchInput.emit('input');
  const listEl = app.elements.get('topicPinListContainer');
  assert.match(listEl.innerHTML, /Wait2/);
  assert.doesNotMatch(listEl.innerHTML, /Done1/);
  assert.doesNotMatch(listEl.innerHTML, /Err3/);

  // 清空搜索后，点击批量重试异常
  searchInput.value = '';
  await searchInput.emit('input');
  await app.elements.get('btnRetryAllErrorTopicPins').click();
  assert.ok(app.sent.some((m) => m.action === 'RETRY_ALL_ERROR_TOPIC_PIN_TASKS'));

  // 3. 手动置顶支持一次提交多条空格/换行分隔的微博链接
  app.sent.length = 0;
  app.elements.get('manualPinUrlInput').value = 'https://weibo.com/1/A\nhttps://weibo.com/1/B';
  await app.elements.get('btnManualPinSubmit').click();
  const manualCalls = app.sent.filter((m) => m.action === 'MANUAL_TOPIC_PIN');
  assert.equal(manualCalls.length, 2);
  assert.equal(manualCalls[0].url, 'https://weibo.com/1/A');
  assert.equal(manualCalls[1].url, 'https://weibo.com/1/B');
});

test('待发任务清单支持单条删除、批量删除已选与清空清单并同步缓存', async () => {
  const app = await loadPopup({
    cachedScannedTasks: [
      { docUrl: 'https://alidocs.dingtalk.com/i/nodes/1', docName: '主表', row: 2, account: '新浪财经', content: '任务一' },
      { docUrl: 'https://alidocs.dingtalk.com/i/nodes/1', docName: '主表', row: 3, account: '新浪体育', content: '任务二' },
      { docUrl: 'https://alidocs.dingtalk.com/i/nodes/1', docName: '主表', row: 4, account: '新浪科技', content: '任务三' },
    ],
    cachedScannedAt: Date.now() - 1000,
  });

  const list = app.elements.get('taskListContainer');
  assert.equal(list.children.length, 3);
  assert.equal(app.elements.get('btnDeleteSelectedTasks').style.display, 'inline-block');
  assert.equal(app.elements.get('btnClearScannedTasks').style.display, 'inline-block');

  // 1. 单条删除第一条任务
  const firstDelBtn = list.querySelectorAll('.task-delete-btn')[0];
  await firstDelBtn.click({ stopPropagation() {} });
  assert.equal(list.children.length, 2);
  assert.equal(app.storage.cachedScannedTasks.length, 2);

  // 2. 勾选第一条并点击“删除已选”
  app.elements.get('taskListContainer').querySelectorAll = (sel) => (
    sel === '.task-item-cb:checked' ? [{ dataset: { taskIndex: '0' } }] : []
  );
  await app.elements.get('btnDeleteSelectedTasks').click();
  assert.equal(list.children.length, 1);
  assert.equal(app.storage.cachedScannedTasks.length, 1);
  assert.equal(app.storage.cachedScannedTasks[0].content, '任务三');

  // 3. 点击“清空”按钮
  await app.elements.get('btnClearScannedTasks').click();
  assert.equal(app.storage.cachedScannedTasks.length, 0);
  assert.equal(app.elements.get('taskCountBadge').textContent, '0 条');
  assert.equal(app.elements.get('btnDeleteSelectedTasks').style.display, 'none');
  assert.equal(app.elements.get('btnClearScannedTasks').style.display, 'none');
});

test('任务解析：@xxx值班老师 仅抽小号时不误加主号，且普通短句不被当成指令吞掉', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: ['新浪热点', '小号甲', '小号乙'],
  });
  const tasks1 = await app.api.parseBatchTaskText('这是测试正文\n@新浪热点值班老师 辛苦2个小号发');
  assert.equal(tasks1.length, 2);
  assert.equal(tasks1.some((t) => t.account === '新浪热点'), false);

  const tasks2 = await app.api.parseBatchTaskText('@小号甲\n第一句内容\n今天产品正式发布！');
  assert.equal(tasks2.length, 1);
  assert.equal(tasks2[0].content, '第一句内容\n今天产品正式发布！');
});

test('任务解析：投票有效选项不足2个或正文为空时，拦截立即执行', async () => {
  const app = await loadPopup();
  let startCalled = 0;
  app.onMessage = async (msg) => {
    if (msg.action === 'START_PIPELINE') startCalled += 1;
    return { ok: true };
  };
  app.api.setParsedTasks([{ account: '小号甲', content: '投票正文', poll: { title: '投票', options: ['只有一项', '   '], days: 30 } }]);
  await app.elements.get('btnParserRunNow').click();
  assert.equal(startCalled, 0);

  app.api.setParsedTasks([{ account: '小号甲', content: '   ', poll: null }]);
  await app.elements.get('btnParserRunNow').click();
  assert.equal(startCalled, 0);
});

test('任务解析：文末含“散列发布/错峰发布”等修饰词的派单指令能正确识别并绑定到上方正文', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: ['新浪热点', '小号1', '小号2', '小号3', '小号4', '小号5'],
  });
  const sample = [
    '就在不久前，我们还惊叹于人形机器人登台扭秧歌。#周跃峰表示智能体时代需要硅基黑土地#（央视网）http://t.cn/AXof4aVp',
    '',
    '\u2005\u2005@新浪热点值班\u2005\u2005辛苦老师大号+5个小号散列发布',
  ].join('\n');
  const tasks = await app.api.parseBatchTaskText(sample);
  assert.equal(tasks.length, 6);
  assert.ok(tasks.every((t) => t.scatterPublish === true));
  assert.ok(tasks.some((t) => t.account === '新浪热点'));
  assert.equal(tasks.filter((t) => t.account.startsWith('小号')).length, 5);
  assert.equal(tasks[0].content, '就在不久前，我们还惊叹于人形机器人登台扭秧歌。#周跃峰表示智能体时代需要硅基黑土地#（央视网）http://t.cn/AXof4aVp');
});

test('末尾带“大号发布投票+小号原发”的纯派单指令行不会误解析成新浪热点正文任务', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: ['新浪热点', '新浪新闻滚动', '新浪健康派', '硬核大脑'],
  });
  const sample = [
    '@新浪新闻滚动 、@新浪健康派、@硬核大脑',
    '#尹烨称生命不能被浓缩成token#活到100岁，是福气还是折磨？（尹烨）#尹烨谈为什么AI干不掉生命科学# #新浪新闻探索大会#',
    'http://t.cn/AXWWTNPk ',
    '',
    '\u2005@新浪热点值班\u2005辛苦老师 大号发布投票+小号原发   ',
  ].join('\n');
  const tasks = await app.api.parseBatchTaskText(sample);
  assert.deepEqual(Array.from(tasks, (t) => t.account), ['新浪新闻滚动', '新浪健康派', '硬核大脑']);
  assert.ok(tasks.every((t) => t.content.includes('#尹烨称生命不能被浓缩成token#')));
});

test('末尾带“@新浪热点值班 辛苦转发博文”的纯派单指令行不会误解析成新浪热点正文任务', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: ['新浪热点', '瑞峰财经', '微资讯', '新浪新闻滚动', '新浪健康派', '硬核大脑', '新浪运动'],
  });
  const sample = [
    '转发链接：https://weibo.com/1618051664/Rs7TBEYQY?refer_flag=1001030103_ ',
    '',
    '转发文案：',
    '@新浪热点 @瑞峰财经、@微资讯、@新浪新闻滚动',
    '#尹烨称生命不能被浓缩成token#如果AI能把新药研发缩到几周，人类寿命可能大大增加！#尹烨谈为什么AI干不掉生命科学# #新浪新闻探索大会#',
    '',
    '',
    '@新浪健康派、@硬核大脑、@新浪运动',
    '#尹烨称生命不能被浓缩成token#AI收割了翻译、写作、编程、数学，却在生物学门前倒下。#尹烨谈为什么AI干不掉生命科学# #新浪新闻探索大会#',
    '',
    '\u2005@新浪热点值班\u2005 辛苦转发博文',
  ].join('\n');
  const tasks = await app.api.parseBatchTaskText(sample);
  assert.deepEqual(
    Array.from(tasks, (t) => t.account),
    ['新浪热点', '瑞峰财经', '微资讯', '新浪新闻滚动', '新浪健康派', '硬核大脑']
  );
  assert.ok(tasks.every((t) => t.repostUrl.includes('Rs7TBEYQY')));
  assert.ok(tasks.every((t) => t.content.includes('#尹烨称生命不能被浓缩成token#')));
});

test('末尾带“辛苦老师仅转发”的纯派单指令不误拆任务且默认跳过已下线账号新浪运动', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: ['新浪热点', 'BOOM视频', '民生温度计', '手机头条', '瑞峰财经', '微资讯', '新浪健康派', '硬核大脑', '新浪新闻滚动'],
  });
  const sample = [
    '转发链接：https://weibo.com/2028810631/Rs8qEb8YY?refer_flag=1001030103_',
    '',
    '@新浪热点、@BOOM视频、@民生温度计',
    '郝景芳畅想，AI时代人人都可能成为一个小的创业团队。',
    '',
    '@手机头条、@瑞峰财经、@微资讯',
    '郝景芳期待AI算法2.0。',
    '',
    '@新浪健康派、@硬核大脑、@新浪运动、@新浪新闻滚动',
    '郝景芳说最希望参与改变的事。',
    '',
    '\u2005\u2005@新浪热点值班\u2005\u2005辛苦老师仅转发',
  ].join('\n');
  const tasks = await app.api.parseBatchTaskText(sample);
  assert.deepEqual(
    Array.from(tasks, (t) => t.account),
    ['新浪热点', 'BOOM视频', '民生温度计', '手机头条', '瑞峰财经', '微资讯', '新浪健康派', '硬核大脑', '新浪新闻滚动']
  );
  assert.ok(!tasks.some((t) => t.account === '新浪运动'));
  assert.ok(!tasks.some((t) => t.content === '仅转发'));
});

test('扫描文档返回docTitles时自动同步前端文档卡槽名称', async () => {
  const docTitle = '蒙牛 #祖传的喝奶说法怎么越听越烧心#11月20日18点';
  const app = await loadPopup({
    docPresets: [{ id: 'slot_1', name: '文档 1 (主表)', url: 'https://docs.qq.com/sheet/DSUZrVkNrdFFYb1h5?tab=1qv4tm', linkCol: 'E' }],
  }, {
    SCAN_DOC_TASKS: {
      ok: true,
      docTitles: { slot_1: docTitle },
      tasks: [{ docId: 'slot_1', docName: docTitle, docTitle, docUrl: 'https://docs.qq.com/sheet/DSUZrVkNrdFFYb1h5?tab=1qv4tm', targetSheetId: '1qv4tm', row: 2, targetCell: 'E2', account: '新浪热点', content: '测试文案', imgUrls: [] }],
    },
  });
  await app.elements.get('btnScanTasks').click();
  const slotCard = app.elements.get('docSlotsContainer').children[0];
  assert.equal(app.storage.docPresets[0].name, docTitle);
  assert.ok(slotCard.innerHTML.includes(docTitle));
});

test('任务解析勾选“本次放行重发”后透传allowDuplicateBypass并在执行结束后自动复位', async () => {
  let capturedConfig = null;
  const app = await loadPopup({
    cachedPlatformAccounts: ['新浪热点'],
  }, {
    START_PIPELINE: (msg) => {
      capturedConfig = msg.config;
      return { ok: true, summary: { processed: 1, published: 1 } };
    },
  });
  app.elements.get('taskParserInput').value = '@新浪热点\n测试放行重发正文';
  await app.elements.get('btnParseTasks').click();
  const onceToggle = app.elements.get('parserAllowDuplicateOnceToggle');
  onceToggle.checked = true;
  await app.elements.get('btnParserRunNow').click();
  assert.equal(capturedConfig.allowDuplicateBypass, true);
  assert.equal(onceToggle.checked, false);
});

test('问句末尾紧跟话题标签且下方带A/B/C/D选项时无需勾选优先投票即可自动识别为投票任务', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: ['新浪热点'],
  });
  const sample = [
    '你觉得生命难以被AI复刻的主要原因是？#尹烨称生命的验证昂贵不可逆##新浪新闻探索大会#',
    'A. 生命超高维度多模态，系统极度复杂',
    'B. 生命存在动态变化演化',
    'C. 生命验证成本高昂、过程不可逆',
    'D. 环境语境会改变基因表达，变量太多',
    '',
    '\u2005@新浪热点值班\u2005\u2005辛苦老师发布投票',
  ].join('\n');
  const tasks = await app.api.parseBatchTaskText(sample);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].account, '新浪热点');
  assert.ok(tasks[0].poll);
  assert.equal(tasks[0].poll.title, '你觉得生命难以被AI复刻的主要原因是？');
  assert.deepEqual(Array.from(tasks[0].poll.options), [
    '生命超高维度多模态，系统极度复杂',
    '生命存在动态变化演化',
    '生命验证成本高昂、过程不可逆',
    '环境语境会改变基因表达，变量太多',
  ]);
});

test('大号+全部小号或N个小号解析时自动排除新浪军事', async () => {
  const app = await loadPopup({
    cachedPlatformAccounts: ['新浪热点', '新浪军事', '微资讯', '瑞峰财经'],
  });
  const tasksAll = await app.api.parseBatchTaskText('测试正文\n@新浪热点值班 辛苦大号+全部小号');
  assert.deepEqual(Array.from(tasksAll, (t) => t.account), ['新浪热点', '微资讯', '瑞峰财经']);
  assert.ok(!tasksAll.some((t) => t.account === '新浪军事'));

  const tasksExplicit = await app.api.parseBatchTaskText('@新浪军事\n显式指定军事正文');
  assert.deepEqual(Array.from(tasksExplicit, (t) => t.account), ['新浪军事']);
});













