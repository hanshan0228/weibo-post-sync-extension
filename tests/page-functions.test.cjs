const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'background/service_worker.js'), 'utf8');
const event = () => ({ addListener() {} });
function load(overrides = {}) {
  let clock = 1_000_000;
  class Clock extends Date { static now() { clock += 1000; return clock; } }
  const context = {
    console, URL, Uint8Array, Date: Clock,
    setTimeout: (fn) => { fn(); return 0; },
    window: {}, navigator: {}, crypto: { randomUUID: () => 'mock-id' },
    Event: class {}, KeyboardEvent: class {}, MouseEvent: class {},
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, body: { innerText: '', innerHTML: '' } },
    chrome: {
      storage: { local: { get: (_keys, cb) => { if (cb) cb({}); return Promise.resolve({}); }, set: () => Promise.resolve() } },
      runtime: { onInstalled: event(), onStartup: event(), onMessage: event(), sendMessage: () => Promise.resolve() },
      alarms: { get: (_name, cb) => cb({}), onAlarm: event(), create: () => Promise.resolve(), clear: () => Promise.resolve() },
      tabs: { get: () => Promise.resolve({ id: 1, status: 'complete', url: 'https://docs.qq.com/sheet/mock' }) },
      scripting: { executeScript: () => Promise.resolve([{ result: { ok: true } }]) },
    },
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: path.join(root, 'background/service_worker.js') });
  return context;
}
function spreadsheet(rows, sheetId = 'wanted') {
  const sheet = {
    getSheetId: () => sheetId, getIsInitialized: () => true,
    getRowCount: () => rows.length, getColCount: () => Math.max(...rows.map((r) => r.length)),
    getCellDataAtPosition: (r, c) => rows[r]?.[c] || '', getSheetName: () => 'Mock Sheet',
  };
  return { workbook: { worksheetManager: { sheetList: [sheet] } }, e2eTools: { getCellEditValue: (_wb, _r, _c, _sid, cell) => cell || '' } };
}

function legacyContext(file, document) {
  let listener;
  const context = {
    console, Date, Event: class {}, KeyboardEvent: class {},
    setTimeout: (fn) => { fn(); return 0; },
    window: { location: { href: 'https://ai-publish-platform.weibo.com/#/post', hostname: 'ai-publish-platform.weibo.com' } },
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
    document,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'content_scripts', file), 'utf8'), context,
    { filename: path.join(root, 'content_scripts', file) });
  return (request) => new Promise((resolve) => listener(request, {}, resolve));
}

test('发布按钮不可用时不得占用60秒防重指纹', async () => {
  const c = load({ window: { location: { href: 'https://ai-publish-platform.weibo.com/#/post' }, HTMLTextAreaElement: class { focus() {} dispatchEvent() {} } } });
  const textarea = new c.window.HTMLTextAreaElement();
  const publishBtn = { innerText: '保存并发布', disabled: true, getAttribute: () => null, classList: { contains: () => false }, click() { throw new Error('不可用按钮不应被点击'); } };
  c.document.querySelector = (sel) => String(sel).includes('textarea') ? textarea : null;
  c.document.querySelectorAll = (sel) => {
    const selector = String(sel);
    if (selector.includes('checkbox')) return [{}];
    if (selector.includes('button') || selector.includes('n-button')) return [publishBtn];
    return [];
  };
  c.document.getElementById = () => null;
  c.document.createElement = () => ({ style: {}, remove() {} });
  c.document.body = { appendChild() {} };
  const task = { content: '同一条文案' };
  const first = await c.directPostToWeiboPlatform(task, false);
  const second = await c.directPostToWeiboPlatform(task, false);
  assert.match(first.error, /不可用/);
  assert.match(second.error, /不可用/);
  assert.doesNotMatch(second.error, /60秒|重复提交/);
});

test('转发任务必须写入转发链接并勾选同时评论，缺输入框则不发布', async () => {
  const c = load({
    window: {
      location: { href: 'https://ai-publish-platform.weibo.com/#/post' },
      HTMLTextAreaElement: class { focus() {} dispatchEvent() {} },
      HTMLInputElement: class { focus() {} dispatchEvent() {} },
    },
  });
  const contentBox = { tagName: 'TEXTAREA', value: '', focus() {}, dispatchEvent() {} };
  const repostBox = { tagName: 'INPUT', value: '', focus() {}, dispatchEvent() {} };
  let commentChecked = false;
  const commentBox = {
    innerText: '同时评论给原微博',
    textContent: '同时评论给原微博',
    classList: { contains: (name) => commentChecked && name === 'n-checkbox--checked' },
    getAttribute: () => null,
    querySelector: () => null,
    closest() { return this; },
    click() { commentChecked = true; },
  };
  c.document.querySelector = (sel) => {
    const selector = String(sel);
    if (selector.includes('转发链接')) return repostBox;
    if (selector.includes('textarea')) return contentBox;
    return null;
  };
  c.document.querySelectorAll = (sel) => {
    const selector = String(sel);
    if (selector.includes('checkbox') || selector.includes('label')) return [commentBox];
    return [];
  };
  c.document.getElementById = () => null;
  c.document.createElement = () => ({ style: {}, remove() {} });
  c.document.body = { appendChild() {} };
  const task = {
    content: '转发评论文案',
    repostUrl: 'https://weibo.com/6723451236/Rr20v8BXT',
    commentOriginal: true,
  };
  const filled = await c.directPostToWeiboPlatform(task, true);
  assert.equal(filled.ok, true);
  assert.equal(filled.dryRun, true);
  assert.equal(repostBox.value, task.repostUrl);
  assert.equal(contentBox.value, task.content);
  assert.equal(commentChecked, true);

  c.document.querySelector = (sel) => String(sel).includes('textarea') && !String(sel).includes('转发链接') ? contentBox : null;
  const blocked = await c.directPostToWeiboPlatform(task, true);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.submitted, false);
  assert.match(blocked.error, /转发链接输入框/);
});

test('切Tab后暴露出其他已勾选账号时会自动取消勾选并通过校验', async () => {
  const c = load({ window: { location: { href: 'https://ai-publish-platform.weibo.com/#/post' }, HTMLTextAreaElement: class { focus() {} dispatchEvent() {} } } });
  let tabSwitched = false;
  let otherChecked = true;
  let targetChecked = false;
  const mkBox = (label, getChecked, toggle) => ({
    innerText: label,
    textContent: label,
    classList: {
      contains: (name) => (name === 'n-checkbox--checked' && getChecked()),
    },
    getAttribute: (attr) => (attr === 'aria-checked' ? String(getChecked()) : null),
    querySelector: () => null,
    closest() { return this; },
    click() { toggle(); },
  });
  const targetNode = mkBox('目标账号', () => targetChecked, () => { targetChecked = !targetChecked; });
  const otherNode = mkBox('手机头条', () => otherChecked, () => { otherChecked = !otherChecked; });
  const dummyBox = mkBox('无关未选账号', () => false, () => {});
  const tabBtn = {
    innerText: '热点',
    textContent: '热点',
    classList: { contains: () => false },
    getAttribute: () => '热点',
    click() { tabSwitched = true; },
  };
  const textarea = new c.window.HTMLTextAreaElement();
  c.document.querySelector = (sel) => String(sel).includes('textarea') ? textarea : null;
  c.document.querySelectorAll = (sel) => {
    const s = String(sel);
    if (s.includes('n-tabs-tab')) return [tabBtn];
    if (!(s.includes('checkbox') || s.includes('label') || s.includes('account_selector'))) return [];
    if (!tabSwitched) {
      return (s.includes('n-checkbox--checked') || s.includes('aria-checked="true"')) ? [] : [dummyBox];
    }
    if (s.includes('n-checkbox--checked') || s.includes('aria-checked="true"')) {
      return [targetNode, otherNode].filter((n) => n.getAttribute('aria-checked') === 'true');
    }
    return [targetNode, otherNode];
  };
  c.document.getElementById = () => null;
  c.document.createElement = () => ({ style: {}, remove() {} });
  c.document.body = { appendChild() {} };
  const res = await c.directPostToWeiboPlatform({ account: '目标账号', content: '测试正文' }, true);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(otherChecked, false);
  assert.equal(targetChecked, true);
});

test('目标账号之外仍有勾选时必须阻断', async () => {
  const c = load({ window: { location: { href: 'https://ai-publish-platform.weibo.com/#/post' }, HTMLTextAreaElement: class { focus() {} dispatchEvent() {} } } });
  const box = (label) => ({
    innerText: label,
    textContent: label,
    classList: { contains: (name) => name === 'n-checkbox--checked' },
    getAttribute: () => null,
    querySelector: () => null,
    closest() { return this; },
    click() {},
  });
  const targetNode = box('目标账号');
  const otherNode = box('其他账号');
  const textarea = new c.window.HTMLTextAreaElement();
  c.document.querySelector = (sel) => String(sel).includes('textarea') ? textarea : null;
  c.document.querySelectorAll = (sel) => {
    const selector = String(sel);
    if (selector.includes('n-tabs') || selector.includes('[role="tab"]')) return [];
    if (selector.includes('checkbox') || selector.includes('label') || selector.includes('account_selector')) return [targetNode, otherNode];
    return [];
  };
  c.document.getElementById = () => null;
  c.document.createElement = () => ({ style: {}, remove() {} });
  c.document.body = { appendChild() {} };
  const result = await c.directPostToWeiboPlatform({ account: '目标账号', content: '正文' }, true);
  assert.equal(result.ok, false);
  assert.equal(result.submitted, false);
  assert.match(result.error, /其他账号/);
  assert.equal(textarea.value || '', '');
});

test('旧内容脚本找不到指定账号时须拒绝并且不填正文', async () => {
  const textarea = { value: '', focus() {}, dispatchEvent() {} };
  const document = { querySelector: () => textarea, querySelectorAll: () => [] };
  const send = legacyContext('weibo_poster.js', document);
  const result = await send({ action: 'POST_WEIBO_TASK', dryRun: true, task: { account: 'Mock不存在账号', content: '测试正文' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /账号/);
  assert.equal(textarea.value, '');
});

test('旧文档脚本不得写入当前焦点的无关输入框', async () => {
  const input = { value: '原值', tagName: 'INPUT', focus() {}, dispatchEvent() {} };
  const send = legacyContext('doc_parser.js', { activeElement: input, querySelector: () => null });
  const result = await send({ action: 'WRITE_CELL_LINK', cellAddr: 'E2', value: 'https://weibo.com/detail/MOCK' });
  assert.equal(result.ok, false);
  assert.equal(input.value, '原值');
});

test('非幂等注入遇到快速 Frame 错误也绝不重放', async () => {
  const c = load();
  let injections = 0;
  c.chrome.scripting.executeScript = async () => { if (++injections === 1) throw new Error('Frame removed'); return [{ result: { ok: true } }]; };
  await assert.rejects(c.executeInTabDirect(1, () => true, [], 'MAIN', '', false), /Frame/);
  assert.equal(injections, 1);
});

test('标签页已关闭时立即失败，不得空等成加载超时', async () => {
  const c = load();
  c.chrome.tabs.get = async () => { throw new Error('No tab with id: 1004325747'); };
  await assert.rejects(c.waitForTabLoaded(1004325747, 15000), /已关闭或不存在/);
});

test('标签页加载超时不得返回 about:blank 为就绪', async () => {
  const c = load();
  c.chrome.tabs.get = async () => ({ id: 1, status: 'complete', url: 'about:blank' });
  await assert.rejects(c.waitForTabLoaded(1, 1000), /加载|就绪|超时/);
});

test('表格运行时没挂上时不得用页面文本猜任务', () => {
  const c = load();
  c.document.querySelectorAll = () => [{ innerText: '08:00\tMock账号\t这不是可靠正文\t\t' }];
  const result = c.directExtractDocTasks('', 'E', '');
  assert.equal(result.ok, false);
  assert.match(result.error, /运行时|阻断/);
  assert.equal(result.tasks, undefined);
});
test('没有正文列表头时不得默认把 C 列当文案', () => {
  const c = load({ window: { SpreadsheetApp: spreadsheet([['时间', '备注', '说明'], ['08:00', '不要发', '普通说明']]) } });
  const result = c.directExtractDocTasks('wanted', 'E', '');
  assert.equal(result.ok, false);
  assert.match(result.error, /正文|文案/);
});
test('文档指定子表不存在必须失败，不得改扫当前表', () => {
  const c = load({ window: { SpreadsheetApp: spreadsheet([['时间', '账号', '正文', '配图', '链接'], ['', 'Mock账号', '内容', '', '']], 'other') } });
  const result = c.directExtractDocTasks('missing', 'E', '');
  assert.equal(result.ok, false);
});

test('腾讯文档沿用合并账号，且素材链接不能抢走微博链接列', () => {
  const rows = [
    ['账号', '正文', '素材链接', '微博链接'],
    ['Mock账号', '第一条', '', ''],
    ['', '第二条', 'https://example.invalid/a.png', ''],
  ];
  const c = load({ window: { SpreadsheetApp: spreadsheet(rows) } });
  const result = c.directExtractDocTasks('wanted', 'E', 'Mock账号');
  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[1].account, 'Mock账号');
  assert.equal(result.tasks[0].targetCell, 'D2');
  assert.equal(result.tasks[1].targetCell, 'D3');
});

test('表格运行时缺失时不得盲写公式栏', async () => {
  const formula = { value: '原公式', tagName: 'INPUT', isContentEditable: false, focus() {}, dispatchEvent() {} };
  const nameBox = { value: 'A1', tagName: 'INPUT', focus() {}, dispatchEvent() {} };
  const c = load();
  c.document.querySelector = (selector) => {
    const text = String(selector);
    if (text.includes('bar-label') || text.includes('name-box') || text.includes('position')) return nameBox;
    if (text.includes('formula') || text.includes('alloy-simple')) return formula;
    return null;
  };
  const result = await c.directWriteCellToDoc('E2', 'https://weibo.com/detail/MOCK', null);
  assert.equal(result.ok, false);
  assert.equal(formula.value, '原公式');
  assert.equal(nameBox.value, 'A1');
});

test('文档回写列支持 AA，不得生成乱码地址', () => {
  const header = Array(27).fill(''); header[1] = '账号'; header[2] = '正文';
  const row = Array(27).fill(''); row[1] = 'Mock账号'; row[2] = '内容';
  const c = load({ window: { SpreadsheetApp: spreadsheet([header, row]) } });
  const result = c.directExtractDocTasks('wanted', 'AA', '');
  assert.equal(result.ok, true);
  assert.equal(result.tasks[0].targetCell, 'AA2');
});

test('选中更优表头时，未出现的配图和时间列不可残留旧行坐标', () => {
  const rows = [
    ['发布时间', '', '需求内容', '配图'],
    ['', '账号', '正文', '', '链接'],
    ['不是时间', 'Mock账号', '内容', 'https://example.invalid/old.png', ''],
  ];
  const c = load({ window: { SpreadsheetApp: spreadsheet(rows) } });
  const result = c.directExtractDocTasks('wanted', 'E', '');
  assert.equal(result.tasks[0].time, '');
  assert.equal(result.tasks[0].materialCol, '');
});

test('无回写编辑器时不得报告成功', async () => {
  const c = load();
  const result = await c.directWriteCellToDoc('E2', 'https://weibo.com/detail/MOCK', null);
  assert.equal(result.ok, false);
});

test('非法单元格地址在任何写动作前拒绝', async () => {
  const c = load();
  for (const cell of ['A0', 'A-2', 'A1junk2', 'A1:B2']) {
    assert.equal((await c.directWriteCellToDoc(cell, 'https://weibo.com/detail/MOCK', null)).ok, false, cell);
  }
});

test('指定不存在的钉钉子表不得改扫其他表', () => {
  const workbook = {
    sheetsMeta: [{ id: 'sheet_copy', title: '运营文案' }],
    content: { sheet_copy: { rows: [
      [0, 0, [[0, { value: '账号' }], [1, { value: '文案' }], [2, { value: '链接' }]]],
      [1, 0, [[0, { value: 'Mock账号' }], [1, { value: '正文' }]]],
    ] } },
  };
  const c = load();
  const res = c.parseDingTalkDocumentPayload(
    { data: { documentContent: { checkpoint: { content: JSON.stringify(workbook) } } } },
    { targetSheetId: 'missing' }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /未找到指定钉钉子表/);
});

test('钉钉账号类型列不能抢发布账号列', () => {
  const workbook = {
    sheetsMeta: [{ id: 's1', title: '运营文案' }],
    content: { s1: { rows: [
      [0, 0, [[0, { value: '账号类型' }], [1, { value: '发布账号' }], [2, { value: '文案' }], [3, { value: '素材链接' }], [4, { value: '微博链接' }]]],
      [1, 0, [[0, { value: '垂类' }], [1, { value: 'Mock账号' }], [2, { value: '正文' }], [3, { value: 'https://example.invalid/a.png' }]]],
    ] } },
  };
  const c = load();
  const res = c.parseDingTalkDocumentPayload(
    { data: { documentContent: { checkpoint: { content: JSON.stringify(workbook) } } } },
    { targetSheetId: 's1' }
  );
  assert.equal(res.ok, true);
  assert.equal(res.tasks[0].account, 'Mock账号');
  assert.equal(res.tasks[0].content, '正文');
  assert.equal(res.tasks[0].targetCell, 'E2');
});

test('名称框没聚焦到目标地址时不得提交跳转', () => {
  const c = load();
  assert.equal(c.shouldCommitDingTalkNameBox({ foundInp: true, focused: true, val: 'AG1208' }, 'G209'), false);
  assert.equal(c.shouldCommitDingTalkNameBox({ foundInp: true, focused: false, val: 'G209' }, 'G209'), false);
  assert.equal(c.shouldCommitDingTalkNameBox({ foundInp: false, focused: false, val: '' }, 'G209'), false);
  assert.equal(c.shouldCommitDingTalkNameBox({ foundInp: true, focused: true, val: 'G209' }, 'G209'), true);
});

test('钉钉回读不得拿其他子表或更长文本冒充写回成功', () => {
  const workbook = { content: { other: { rows: [[1, 0, [[2, { value: 'https://weibo.com/999/MockPost' }]]]] } } };
  const c = load();
  const payload = { data: { documentContent: { checkpoint: { content: JSON.stringify(workbook) } } } };
  assert.equal(c.readDingTalkCellFromPayload(payload, 'missing', 2, 3), '');
  assert.equal(c.dingTalkCellWriteMatches('备注 https://weibo.com/999/MockPost', 'https://weibo.com/999/MockPost'), false);
  assert.equal(c.dingTalkCellWriteMatches('https://weibo.com/999/MockPost', 'https://weibo.com/999/MockPost'), true);
});

test('指定回写子表缺失时不得写入其他表', async () => {
  const app = spreadsheet([['', '', '', '', '']], 'other');
  let writes = 0;
  app.behaviorApi = { cellApi: { setSingleValue: async () => { writes++; } } };
  const c = load({ window: { SpreadsheetApp: app } });
  assert.equal((await c.directWriteCellToDoc('E1', 'https://weibo.com/detail/MOCK', 'missing')).ok, false);
  assert.equal(writes, 0);
});

test('文档回写验证必须完整相等，不能拿 URL 前缀当成功', async () => {
  const app = spreadsheet([['', '', '', '', 'https://weibo.com/']]);
  app.behaviorApi = { cellApi: { setSingleValue: async () => {} } };
  const c = load({ window: { SpreadsheetApp: app } });
  assert.equal((await c.directWriteCellToDoc('E1', 'https://weibo.com/detail/MOCK', 'wanted')).ok, false);
});

test('演练模式不得点击遗留确认弹窗中的默认按钮', async () => {
  let clicks = 0;
  const confirmButton = { click: () => { clicks++; } };
  const modal = { querySelector: (selector) => selector.includes(', button') ? confirmButton : null };
  const c = load({ window: { location: { href: 'https://ai-publish-platform.weibo.com/#/post' }, dispatchEvent() {} } });
  c.document.querySelectorAll = (selector) => selector === '.n-dialog, .n-modal, [role="dialog"], .n-modal-container' ? [modal] : [];
  await c.directPostToWeiboPlatform({ account: 'Mock账号', content: '测试正文' }, true);
  assert.equal(clicks, 0);
});

test('投票准备单击完成、保留全部选项并把标题作为纯文本显示', async () => {
  let modalOpen = true;
  let doneClicks = 0;
  let textClicks = 0;
  const bannerNodes = [];
  class Input {
    constructor(placeholder, tagName = 'INPUT') { this.placeholder = placeholder; this.tagName = tagName; this.value = ''; }
    focus() {}
    dispatchEvent() {}
    getAttribute(name) { return name === 'placeholder' ? this.placeholder : ''; }
    getBoundingClientRect() { return { width: 100, height: 40 }; }
  }
  const editor = new Input('有什么新鲜事想分享给大家', 'TEXTAREA');
  const title = new Input('填写标题');
  const options = [new Input('选项1'), new Input('选项2')];
  const clickable = (text, onClick) => ({
    tagName: 'BUTTON', innerText: text, children: [],
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    dispatchEvent: (event) => { if (event.type === 'click') onClick(); },
    click: onClick,
  });
  const done = clickable('完成', () => { doneClicks++; modalOpen = false; });
  const textTab = clickable('文字', () => { textClicks++; });
  const modal = {
    innerText: '投票 标题 选项 完成',
    getBoundingClientRect: () => ({ width: 600, height: 500 }),
    querySelector: () => title,
    querySelectorAll: (selector) => selector === 'input, textarea, .n-input__input-el' ? [title, ...options] : [done, textTab],
  };
  const c = load({
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    window: {
      location: { href: 'https://weibo.com/' },
      HTMLTextAreaElement: Input, HTMLInputElement: Input,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      dispatchEvent: () => { modalOpen = false; },
    },
  });
  c.document.querySelectorAll = (selector) => {
    if (selector.startsWith('textarea[')) return [editor];
    if (selector.includes('.woo-modal-main')) return modalOpen ? [modal] : [];
    return [];
  };
  c.document.getElementById = () => null;
  c.document.createElement = (tag) => {
    const element = { tagName: tag, style: {}, children: [], replaceChildren() { this.children = []; }, append(...nodes) { this.children.push(...nodes); }, addEventListener() {} };
    bannerNodes.push(element);
    return element;
  };
  c.document.body.appendChild = () => {};
  const maliciousTitle = '<img src=x onerror=alert(1)>';
  const result = await c.directPostPollToWeiboHome({ content: '投票正文', poll: { title: maliciousTitle, options: ['甲', '乙'] } }, true);
  assert.equal(result.ok, true);
  assert.equal(result.preparedOnly, true);
  assert.equal(result.postUrl, '');
  assert.equal(doneClicks, 1);
  assert.equal(textClicks, 1);
  assert.equal(options[0].value, '甲');
  assert.equal(options[1].value, '乙');
  assert.equal(bannerNodes.length, 0);
});

test('回执找回不得把不匹配账号正文的旧剪贴板链接归给当前任务', async () => {
  const c = load({ window: { __clipCaptured: 'https://weibo.com/123456/OLDPOST' } });
  assert.equal((await c.directRecoverPublishedWeiboUrl('Mock账号', '全新的测试正文')).ok, false);
});

test('主发布拒绝的提交前旧链接不得被恢复函数重新接受', async () => {
  const old = 'https://weibo.com/123456/OLDPOST';
  const c = load({window: { __clipCaptured: old, __weiboSyncSubmission: {
    account:'Mock账号',content:'目标正文',submitted:true,startedAt:1000000,previousUrls:[old]
  } }});
  assert.equal((await c.directRecoverPublishedWeiboUrl('Mock账号','目标正文')).ok, false);
});
test('正文前缀匹配的旧列表行不能充当本次发布回执', async () => {
  const row = { innerText:'Mock账号 目标正文加后缀', innerHTML:'', closest:() => null,
    querySelector:() => ({href:'https://weibo.com/123456/OLDPOST'}),
    querySelectorAll:() => [{innerText:'Mock账号'}, {innerText:'目标正文加后缀'}] };
  const c = load({window:{__weiboSyncSubmission:{account:'Mock账号',content:'目标正文',submitted:true,startedAt:1000000}},
    document:{body:{},querySelectorAll:() => [row],addEventListener(){},removeEventListener(){}}});
  assert.equal((await c.directRecoverPublishedWeiboUrl('Mock账号','目标正文')).ok, false);
});
function uploadPageContext(status = 'error', dataMime = 'image/png') {
  class Textarea { focus() {} dispatchEvent() {} }
  const textarea = new Textarea();
  const fileInput = { dispatchEvent() {} };
  const item = {
    className: `n-upload-file-info n-upload-file-info--${status}`,
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
    getAttribute: () => null,
    querySelector: () => null,
  };
  item.classList = { contains: (name) => item.className.split(' ').includes(name) };
  const container = { querySelectorAll: (selector) => selector === '.n-upload-file-info' ? [item] : [] };
  const c = load({
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    File: class { constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options.type; } },
    DataTransfer: class { constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; } },
    window: { location: { href: 'https://ai-publish-platform.weibo.com/#/post' }, HTMLTextAreaElement: Textarea },
  });
  c.document.querySelector = (selector) => selector.includes('textarea') ? textarea : selector.includes('input[type="file"]') ? fileInput : selector.includes('.n-upload') ? container : null;
  c.document.querySelectorAll = (selector) => selector === '.n-checkbox, input[type="checkbox"]' ? [{}] : [];
  c.document.getElementById = () => null;
  c.document.createElement = () => ({ style: {}, remove() {} });
  c.document.body.appendChild = () => {};
  return { context: c, task: { content: '配图测试正文', imagesData: [{ dataUrl: `data:${dataMime};base64,AQID`, mime: dataMime, filename: 'mock.png' }] } };
}

for (const status of ['error', 'rejected']) {
  test(`上传${status}项目不能算作图片成功`, async () => {
    const { context, task } = uploadPageContext(status);
    const result = await context.directPostToWeiboPlatform(task, true);
    assert.equal(result.ok, false);
    assert.equal(result.submitted, false);
    assert.match(result.error, /配图|图片|上传/);
  });
}

test('图片注入入口拒绝非image MIME数据', async () => {
  const { context, task } = uploadPageContext('finished', 'text/html');
  const result = await context.directPostToWeiboPlatform(task, true);
  assert.equal(result.ok, false);
  assert.equal(result.submitted, false);
});

test('无Content-Type的HTML不得因.png后缀被当成图片', async () => {
  const c = load({
    fetch: async () => ({ ok: true, headers: { get: () => '' }, blob: async () => new Blob(['<html>登录</html>']) }),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  });
  assert.equal(await c.fetchImageAsBase64('https://example.invalid/login.png'), null);
});

test('真实PNG字节即使没有Content-Type也能通过', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const c = load({
    fetch: async () => ({ ok: true, headers: { get: () => '' }, blob: async () => new Blob([png]) }),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  });
  const item = await c.fetchImageAsBase64('https://example.invalid/photo.png');
  assert.equal(typeof item?.dataUrl, 'string');
  assert.match(item.dataUrl, /^data:image\/png;base64,/);
});

test('文档环境下载拒绝无类型的HTML正文', async () => {
  const c = load({
    fetch: async () => ({ ok: true, headers: { get: () => '' }, arrayBuffer: async () => new TextEncoder().encode('<html>登录</html>').buffer }),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    Image: class { set src(_value) { this.onerror(); } },
  });
  c.executeInTabDirect = async (_tab, fn, args) => fn(...args);
  const result = await c.downloadImagesViaDocTab(1, 'https://docs.qq.com/sheet/mock', ['https://example.invalid/login.png']);
  assert.equal(result.length, 0);
});

test('后台图片下载拒绝HTTP 200登录HTML', async () => {
  const c = load({
    fetch: async () => ({ ok: true, blob: async () => new Blob(['<html>登录</html>'], { type: 'text/html' }) }),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  });
  assert.equal(await c.fetchImageAsBase64('https://example.invalid/login.png'), null);
});

test('文档环境图片下载拒绝非image响应', async () => {
  const c = load({
    fetch: async () => ({ ok: true, headers: { get: () => 'text/html' }, arrayBuffer: async () => new TextEncoder().encode('login').buffer }),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    Image: class { set src(_value) { this.onerror(); } },
  });
  c.executeInTabDirect = async (_tab, fn, args) => fn(...args);
  const result = await c.downloadImagesViaDocTab(1, 'https://docs.qq.com/sheet/mock', ['https://example.invalid/login.png']);
  assert.equal(result.length, 0);
});

test('即使账号正文相同，发布时间早于本次提交也不能恢复', async () => {
  const row = { innerText:'Mock账号 目标正文', innerHTML:'', closest:() => null,
    querySelector:sel => sel.includes('time') ? {dateTime:'1970-01-01T00:00:00Z',getAttribute:()=>'1970-01-01T00:00:00Z'} : {href:'https://weibo.com/123456/OLDPOST'},
    querySelectorAll:() => [{innerText:'Mock账号'}, {innerText:'目标正文'}], getAttribute:()=>null };
  const c = load({window:{__weiboSyncSubmission:{account:'Mock账号',content:'目标正文',submitted:true,startedAt:1000000}},
    document:{body:{},querySelectorAll:()=>[row],addEventListener(){},removeEventListener(){}}});
  assert.equal((await c.directRecoverPublishedWeiboUrl('Mock账号','目标正文')).ok, false);
});

test('跳转到wb-list导致window上下文丢失时，可通过sessionStorage.__weiboSyncSubmission成功恢复回执链接', async () => {
  const row = {
    innerText: 'Mock账号 目标正文',
    innerHTML: '',
    closest: () => null,
    querySelector: (sel) => sel.includes('time')
      ? { getAttribute: () => new Date(1000500).toISOString() }
      : { href: 'https://weibo.com/123456/NEWPOST999' },
    querySelectorAll: () => [{ innerText: 'Mock账号' }, { innerText: '目标正文' }],
    getAttribute: () => null,
  };
  const c = load({
    sessionStorage: {
      getItem: (key) => key === '__weiboSyncSubmission'
        ? JSON.stringify({ account: 'Mock账号', content: '目标正文', submitted: true, startedAt: 1000000, previousUrls: [] })
        : null,
    },
    window: {},
    document: { body: {}, querySelectorAll: (sel) => sel.includes('columnheader') ? [{ innerText: '发布账号' }] : [row], addEventListener() {}, removeEventListener() {} },
  });
  const res = await c.directRecoverPublishedWeiboUrl('Mock账号', '目标正文');
  assert.equal(res.ok, true);
  assert.equal(res.postUrl, 'https://weibo.com/123456/NEWPOST999');
});

test('带配图的微博投票草稿返回manualImagesRequired标志且不向页面插入Banner提示', async () => {
  let modalOpen = true;
  const bannerNodes = [];
  class Input {
    constructor(placeholder, tagName = 'INPUT') { this.placeholder = placeholder; this.tagName = tagName; this.value = ''; }
    focus() {}
    dispatchEvent() {}
    getAttribute(name) { return name === 'placeholder' ? this.placeholder : ''; }
    getBoundingClientRect() { return { width: 100, height: 40 }; }
  }
  const editor = new Input('有什么新鲜事想分享给大家', 'TEXTAREA');
  const title = new Input('填写标题');
  const options = [new Input('选项1'), new Input('选项2')];
  const clickable = (text, onClick) => ({
    tagName: 'BUTTON', innerText: text, children: [],
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    dispatchEvent: (event) => { if (event.type === 'click') onClick(); },
    click: onClick,
  });
  const done = clickable('完成', () => { modalOpen = false; });
  const textTab = clickable('文字', () => {});
  const modal = {
    innerText: '投票 标题 选项 完成',
    getBoundingClientRect: () => ({ width: 600, height: 500 }),
    querySelector: () => title,
    querySelectorAll: (selector) => selector === 'input, textarea, .n-input__input-el' ? [title, ...options] : [done, textTab],
  };
  const c = load({
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    window: {
      location: { href: 'https://weibo.com/' },
      HTMLTextAreaElement: Input, HTMLInputElement: Input,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      dispatchEvent: () => { modalOpen = false; },
    },
  });
  c.document.querySelectorAll = (selector) => {
    if (selector.startsWith('textarea[')) return [editor];
    if (selector.includes('.woo-modal-main')) return modalOpen ? [modal] : [];
    return [];
  };
  c.document.getElementById = () => null;
  c.document.createElement = (tag) => {
    const element = { tagName: tag, style: {}, children: [], replaceChildren() { this.children = []; }, append(...nodes) { this.children.push(...nodes); }, addEventListener() {} };
    bannerNodes.push(element);
    return element;
  };
  c.document.body.appendChild = () => {};
  const result = await c.directPostPollToWeiboHome({
    content: '带图投票正文',
    imgUrls: ['https://example.invalid/1.png', 'https://example.invalid/2.png'],
    poll: { title: '选哪个', options: ['甲', '乙'] },
  }, false);
  assert.equal(result.ok, true);
  assert.equal(result.preparedOnly, true);
  assert.equal(result.manualImagesRequired, true);
  assert.equal(result.imageCount, 2);
  assert.equal(bannerNodes.length, 0);
});

test('注入返回空结果时自动采集现场URL，登录跳页给出明确登录提示', async () => {
  const c = load();
  c.chrome.scripting.executeScript = async () => [{ result: null }];
  c.chrome.tabs.get = async () => ({ id: 1, status: 'complete', url: 'https://cas.erp.sina.com.cn/login?service=xyz', title: '统一登录' });
  await assert.rejects(
    c.executeInTabDirect(1, () => null, [], 'MAIN', '', false),
    /发稿中台已自动跳转至登录页.*cas\.erp\.sina\.com\.cn/
  );
});

test('非登录跳页返回空结果时报错包含现场URL与状态诊断', async () => {
  const c = load();
  c.chrome.scripting.executeScript = async () => [{ result: undefined }];
  c.chrome.tabs.get = async () => ({ id: 2, status: 'complete', url: 'https://ai-publish-platform.weibo.com/#/wb-list', title: '微博列表' });
  await assert.rejects(
    c.executeInTabDirect(2, () => null, [], 'MAIN', '', false),
    /页面执行函数返回了空结果.*#\/wb-list.*微博列表/
  );
});

test('预检探针在未挂载时返回ready:false，登录页返回needLogin:true', async () => {
  const c = load({
    window: { location: { href: 'https://cas.erp.sina.com.cn/login' } },
  });
  const loginRes = await c.directCheckWeiboPlatformReady();
  assert.equal(loginRes.ok, false);
  assert.equal(loginRes.needLogin, true);

  const c2 = load({
    window: { location: { href: 'https://ai-publish-platform.weibo.com/#/post' } },
  });
  const notReadyRes = await c2.directCheckWeiboPlatformReady();
  assert.equal(notReadyRes.ok, true);
  assert.equal(notReadyRes.ready, false);
});

test('投票克隆不被3项预览截胡，全局选取最多4项完整选项', async () => {
  const c = load({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        text_raw: '你觉得张康乐这次的造型可以打几分？',
        page_info: {
          cards: [
            {
              title: '你觉得张康乐这次的造型可以打几分？',
              items: [
                { item_title: '10分满分！太惊艳了！' },
                { item_title: '8-9分，帅得很突出' },
                { item_title: '6-7分，中规中矩吧' },
              ],
            },
          ],
          media_info: {
            vote_info: {
              question: '你觉得张康乐这次的造型可以打几分？',
              vote_options: [
                { choice: '10分满分！太惊艳了！' },
                { item: '8-9分，帅得很突出' },
                { desc_raw: '6-7分，中规中矩吧' },
                { vote_title: '5分以下，感觉一般般' },
              ],
            },
          },
        },
      }),
    }),
  });
  const res = await c.directExtractPollFromWeiboPage(['51234567890']);
  assert.equal(res.ok, true);
  assert.equal(res.pollOptions.length, 4);
  assert.deepEqual([...res.pollOptions], [
    '10分满分！太惊艳了！',
    '8-9分，帅得很突出',
    '6-7分，中规中矩吧',
    '5分以下，感觉一般般',
  ]);
});

test('若接口和DOM最多仅拿到3项且存在vote.weibo.com，触发独立投票页穿透核对', async () => {
  const c = load({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        text_raw: '测试投票？ https://vote.weibo.com/h5/index/index?vote_id=123',
        page_info: {
          vote_options: [
            { text: '选项A' },
            { text: '选项B' },
            { text: '选项C' },
          ],
        },
      }),
    }),
  });
  const res = await c.directExtractPollFromWeiboPage(['51234567890']);
  assert.equal(res.ok, false);
  assert.equal(res.needVotePage, true);
  assert.equal(res.voteUrl, 'https://vote.weibo.com/h5/index/index?vote_id=123');
  assert.equal(res.fallbackResult.pollOptions.length, 3);
});

test('微博列表无账号列时不能将相同正文的链接归属到目标账号', async () => {
  const targetContent = '#热知识点#测试正文内容，附带原链 http://t.cn/ORIG999 看看效果';
  const now = new Date(1_002_000);
  const pad = (n) => String(n).padStart(2, '0');
  const pubTimeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const rowText = `${targetContent} http://t.cn/MOCK1234 1 发布成功 未编辑 立即发布 ${pubTimeStr} operator1 7`;
  const headers = [
    { innerText: '微博内容' },
    { innerText: '状态' },
    { innerText: '发布时间' },
    { innerText: '操作人' },
  ];
  const row = {
    innerText: rowText,
    innerHTML: '',
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel.includes('td')) {
        return [
          { innerText: `${targetContent} http://t.cn/MOCK1234`, getAttribute: () => null },
          { innerText: '1', getAttribute: () => null },
          { innerText: '发布成功', getAttribute: () => null },
          { innerText: pubTimeStr, getAttribute: () => null },
          { innerText: 'operator1', getAttribute: () => null },
        ];
      }
      return [];
    },
  };
  const startedAt = 1_000_000;
  const c = load({
    window: {
      __weiboSyncSubmission: {
        account: '虚构测试账号',
        content: targetContent,
        submitted: true,
        startedAt,
      },
    },
    document: {
      body: {},
      querySelectorAll: (sel) => {
        if (sel.includes('columnheader')) return headers;
        return [row];
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const res = await c.directRecoverPublishedWeiboUrl('虚构测试账号', targetContent);
  assert.equal(res.ok, false);
  assert.notEqual(res.postUrl, 'http://t.cn/MOCK1234');
});


test('独立投票页提取函数可完整保留全部4个选项与标题', () => {
  const c = load({
    document: {
      body: {
        innerText: [
          '微博投票',
          '1234人参与',
          '你觉得张康乐这次的造型可以打几分？',
          '10分满分！太惊艳了！ 40%',
          '8-9分，帅得很突出 30%',
          '6-7分，中规中矩吧 20%',
          '5分以下，感觉一般般 10%',
          '已结束',
        ].join('\n'),
      },
    },
  });
  const res = c.directExtractVotePageOptions('');
  assert.equal(res.ok, true);
  assert.equal(res.pollTitle, '你觉得张康乐这次的造型可以打几分？');
  assert.deepEqual([...res.pollOptions], [
    '10分满分！太惊艳了！',
    '8-9分，帅得很突出',
    '6-7分，中规中矩吧',
    '5分以下，感觉一般般',
  ]);
});

test('通道B在存在展开按钮与多投票容器时优先选取4项完整DOM容器', async () => {
  let expanded = false;
  const makeEl = (text) => ({ innerText: text, textContent: text });
  const c = load({
    fetch: async () => ({ ok: false }),
    document: {
      querySelector: (sel) => (sel.includes('wbtext') ? makeEl('你觉得张康乐这次的造型可以打几分？') : null),
      querySelectorAll: (sel) => {
        if (!sel.includes('vote')) return [];
        const vc = {
          scrollHeight: 400,
          clientHeight: 200,
          scrollTop: 0,
          scrollIntoView() {},
          querySelector: (q) => (q.includes('title') ? makeEl('你觉得张康乐这次的造型可以打几分？') : null),
          querySelectorAll: (q) => {
            if (q.includes('button, [role="button"], a, span, div')) {
              return [{ innerText: '展开全部', click() { expanded = true; } }];
            }
            const base = [
              makeEl('10分满分！太惊艳了！'),
              makeEl('8-9分，帅得很突出'),
              makeEl('6-7分，中规中矩吧'),
            ];
            return expanded ? [...base, makeEl('5分以下，感觉一般般')] : base;
          },
        };
        return [vc];
      },
    },
  });
  const res = await c.directExtractPollFromWeiboPage(['51234567890']);
  assert.equal(expanded, true);
  assert.equal(res.ok, true);
  assert.equal(res.pollOptions.length, 4);
  assert.deepEqual([...res.pollOptions], [
    '10分满分！太惊艳了！',
    '8-9分，帅得很突出',
    '6-7分，中规中矩吧',
    '5分以下，感觉一般般',
  ]);
});

test('投票弹窗存在无placeholder或readonly下拉框时不得冒充选项3，必须点击添加选项并填满全部3项', async () => {
  let modalOpen = true;
  let addClicks = 0;
  let doneClicks = 0;
  class Input {
    constructor(placeholder, tagName = 'INPUT', readOnly = false) {
      this.placeholder = placeholder;
      this.tagName = tagName;
      this.value = '';
      this.readOnly = readOnly;
    }
    focus() {}
    dispatchEvent() {}
    getAttribute(name) {
      if (name === 'placeholder') return this.placeholder;
      if (name === 'readonly') return this.readOnly ? '' : null;
      return '';
    }
    getBoundingClientRect() { return { width: 100, height: 40 }; }
  }
  const editor = new Input('有什么新鲜事想分享给大家', 'TEXTAREA');
  const title = new Input('填写标题');
  const options = [new Input('选项1'), new Input('选项2')];
  const fakeDropdownInput = new Input('', 'INPUT', false);
  const clickable = (text, onClick) => ({
    tagName: 'BUTTON', innerText: text, children: [],
    scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    dispatchEvent: (event) => { if (event.type === 'click') onClick(); },
    click: onClick,
  });
  const addBtn = clickable('添加选项', () => {
    addClicks++;
    options.push(new Input(`选项${options.length + 1}`));
  });
  const doneBtn = clickable('完成', () => { doneClicks++; modalOpen = false; });
  const textTab = clickable('文字', () => {});
  const modal = {
    innerText: '投票 标题 选项 添加选项 完成',
    getBoundingClientRect: () => ({ width: 600, height: 500 }),
    querySelector: () => title,
    querySelectorAll: (selector) => selector.includes('input')
      ? [title, ...options, fakeDropdownInput]
      : [addBtn, doneBtn, textTab],
  };
  const c = load({
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    window: {
      location: { href: 'https://weibo.com/' },
      HTMLTextAreaElement: Input, HTMLInputElement: Input,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      dispatchEvent: () => { modalOpen = false; },
    },
  });
  c.document.querySelectorAll = (selector) => {
    if (selector.startsWith('textarea[')) return [editor];
    if (selector.includes('.woo-modal-main')) return modalOpen ? [modal] : [];
    return [];
  };
  c.document.getElementById = () => null;
  const result = await c.directPostPollToWeiboHome({
    content: '平时花钱，你更愿意为哪种东西买单？',
    poll: {
      title: '平时花钱，你更愿意为哪种东西买单？',
      options: ['买潮玩、周边，花小钱买情绪价值', '买大牌、硬通货，贵一点但能用很久', '评论区聊聊'],
    },
  }, false);
  assert.equal(result.ok, true);
  assert.equal(addClicks, 1);
  assert.equal(doneClicks, 1);
  assert.equal(options.length, 3);
  assert.equal(options[2].value, '评论区聊聊');
  assert.equal(fakeDropdownInput.value, '');
});

test('投票弹窗默认将截止时间切换为一个月', async () => {
  let modalOpen = true;
  let multiselectOpened = false;
  let selectedLabel = '一天';
  class Input {
    constructor(placeholder, tagName = 'INPUT') { this.placeholder = placeholder; this.tagName = tagName; this.value = ''; }
    focus() {}
    dispatchEvent() {}
    getAttribute(name) { return name === 'placeholder' ? this.placeholder : ''; }
    getBoundingClientRect() { return { width: 100, height: 40 }; }
  }
  const editor = new Input('有什么新鲜事想分享给大家', 'TEXTAREA');
  const title = new Input('填写标题');
  const options = [new Input('选项1'), new Input('选项2')];
  const clickable = (text, onClick) => ({
    tagName: 'BUTTON', innerText: text, children: [],
    scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    dispatchEvent: (event) => { if (event.type === 'click') onClick(); },
    click: onClick,
  });
  const singleNode = {
    get innerText() { return selectedLabel; },
    getBoundingClientRect: () => ({ width: 80, height: 30 }),
  };
  const multiselectTags = {
    innerText: '一天',
    scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 120, height: 36 }),
    dispatchEvent: (event) => { if (event.type === 'click') multiselectOpened = true; },
  };
  const optOneDay = clickable('一天', () => { selectedLabel = '一天'; });
  const optOneMonth = clickable('一个月', () => { selectedLabel = '一个月'; });
  const doneBtn = clickable('完成', () => { modalOpen = false; });
  const textTab = clickable('文字', () => {});
  const modal = {
    innerText: '投票 标题 选项 完成 截止时间',
    getBoundingClientRect: () => ({ width: 600, height: 500 }),
    querySelector: (sel) => {
      if (sel.includes('填写标题')) return title;
      if (sel.includes('.multiselect__tags')) return multiselectTags;
      if (sel.includes('.multiselect__single')) return singleNode;
      return null;
    },
    querySelectorAll: (selector) => {
      if (selector.includes('multiselect__option')) return multiselectOpened ? [optOneDay, optOneMonth] : [];
      if (selector.includes('input')) return [title, ...options];
      return [doneBtn, textTab];
    },
  };
  const c = load({
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    window: {
      location: { href: 'https://weibo.com/' },
      HTMLTextAreaElement: Input, HTMLInputElement: Input,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      dispatchEvent: () => { modalOpen = false; },
    },
  });
  c.document.querySelector = (sel) => (sel.includes('.multiselect') ? multiselectTags : null);
  c.document.querySelectorAll = (selector) => {
    if (selector.startsWith('textarea[')) return [editor];
    if (selector.includes('.woo-modal-main')) return modalOpen ? [modal] : [];
    if (selector.includes('.multiselect__single')) return [singleNode];
    if (selector.includes('multiselect__option')) return multiselectOpened ? [optOneDay, optOneMonth] : [];
    return [];
  };
  c.document.getElementById = () => null;
  const result = await c.directPostPollToWeiboHome({
    content: '你更喜欢哪种？',
    poll: { title: '你更喜欢哪种？', options: ['甲', '乙'] },
  }, false);
  assert.equal(result.ok, true);
  assert.equal(multiselectOpened, true);
  assert.equal(selectedLabel, '一个月');
  assert.equal(result.deadlineWarning, '');
});

test('下拉浮层挂载在弹窗外层body且触发器仅显示一天文字时，仍可全局定位并切换为一个月', async () => {
  let modalOpen = true;
  let popupOpened = false;
  let selectedLabel = '一天';
  class Input {
    constructor(placeholder, tagName = 'INPUT') { this.placeholder = placeholder; this.tagName = tagName; this.value = ''; }
    focus() {}
    dispatchEvent() {}
    getAttribute(name) { return name === 'placeholder' ? this.placeholder : ''; }
    getBoundingClientRect() { return { width: 100, height: 40 }; }
  }
  const editor = new Input('有什么新鲜事想分享给大家', 'TEXTAREA');
  const title = new Input('填写标题');
  const options = [new Input('选项1'), new Input('选项2')];
  const clickable = (text, onClick) => ({
    tagName: 'SPAN', innerText: text, children: [],
    scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 90, height: 32, left: 10, top: 10 }),
    dispatchEvent: (event) => { if (event.type === 'click') onClick(); },
    click: onClick,
  });
  const dayTrigger = {
    tagName: 'SPAN',
    get innerText() { return selectedLabel; },
    children: [],
    scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 80, height: 30, left: 10, top: 10 }),
    dispatchEvent: (event) => { if (event.type === 'click') popupOpened = true; },
    click() { popupOpened = true; },
  };
  const bodyOptionMonth = clickable('一个月', () => { selectedLabel = '一个月'; });
  const doneBtn = clickable('完成', () => { modalOpen = false; });
  const textTab = clickable('文字', () => {});
  const modal = {
    innerText: '投票 标题 选项 一天 完成',
    getBoundingClientRect: () => ({ width: 600, height: 500 }),
    querySelector: (sel) => (sel.includes('填写标题') ? title : null),
    querySelectorAll: (selector) => {
      if (selector.includes('input')) return [title, ...options];
      if (selector.includes('[role="combobox"]')) return [dayTrigger];
      return [doneBtn, textTab];
    },
  };
  const c = load({
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    window: {
      location: { href: 'https://weibo.com/' },
      HTMLTextAreaElement: Input, HTMLInputElement: Input,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      dispatchEvent: () => { modalOpen = false; },
    },
  });
  c.document.querySelectorAll = (selector) => {
    if (selector.startsWith('textarea[')) return [editor];
    if (selector.includes('.woo-modal-main')) return modalOpen ? [modal] : [];
    if (selector.includes('[role="option"]') || selector.includes('li, div, span')) {
      return popupOpened ? [bodyOptionMonth] : [];
    }
    return [];
  };
  c.document.getElementById = () => null;
  const result = await c.directPostPollToWeiboHome({
    content: '外层浮层测试？',
    poll: { title: '外层浮层测试？', options: ['甲', '乙'] },
  }, false);
  assert.equal(result.ok, true);
  assert.equal(popupOpened, true);
  assert.equal(selectedLabel, '一个月');
  assert.equal(result.deadlineWarning, '');
});

test('微博列表点击获取链接后从weibo-links-dialog按账号精准提取无href链接并关闭弹窗', async () => {
  const targetContent = '在《赛博对话》中，科技博主@潘乱 表示，双十一越来越像春晚。#测试话题#';
  const now = new Date(1_002_000);
  const pad = (n) => String(n).padStart(2, '0');
  const pubTimeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  let dialogOpen = false;
  let dialogClosed = false;
  const headers = [
    { innerText: '标题' },
    { innerText: '微博数量' },
    { innerText: '任务状态' },
    { innerText: '任务创建时间' },
    { innerText: '操作' },
  ];
  const getLinkBtn = {
    innerText: '获取链接',
    dispatchEvent() {},
    click() { dialogOpen = true; },
  };
  const closeBtn = {
    click() { dialogClosed = true; dialogOpen = false; },
  };
  const makeDialogItem = (nick, url) => ({
    querySelector: (sel) => {
      if (sel.includes('nickname')) return { innerText: `${nick}:` };
      if (sel.includes('link')) return { innerText: url, getAttribute: () => null };
      return null;
    },
  });
  const linksDialog = {
    querySelector: (sel) => (sel.includes('close') ? closeBtn : null),
    querySelectorAll: (sel) => (sel.includes('weibo-link-item')
      ? [
          makeDialogItem('虚构账号A', 'https://weibo.com/111111/MOCKA111'),
          makeDialogItem('虚构目标账号', 'https://weibo.com/222222/MOCKTARGET222'),
        ]
      : []),
  };
  const row = {
    innerText: `${targetContent} 2 发布成功 ${pubTimeStr} 获取链接`,
    innerHTML: '',
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel.includes('td')) {
        return [
          { innerText: targetContent, getAttribute: () => null },
          { innerText: '2', getAttribute: () => null },
          { innerText: '发布成功', getAttribute: () => null },
          { innerText: pubTimeStr, getAttribute: () => null },
          { innerText: '获取链接', getAttribute: () => null },
        ];
      }
      if (sel.includes('button')) return [getLinkBtn];
      return [];
    },
  };
  const c = load({
    window: {
      __weiboSyncSubmission: {
        account: '虚构目标账号',
        content: targetContent,
        submitted: true,
        startedAt: 1_000_000,
      },
    },
    document: {
      body: {},
      querySelectorAll: (sel) => {
        if (sel.includes('columnheader')) return headers;
        if (sel.includes('weibo-links-dialog')) return dialogOpen ? [linksDialog] : [];
        return [row];
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const res = await c.directRecoverPublishedWeiboUrl('虚构目标账号', targetContent);
  assert.equal(res.ok, true);
  assert.equal(res.postUrl, 'https://weibo.com/222222/MOCKTARGET222');
  assert.equal(dialogClosed, true);
});

test('微博列表获取链接弹窗内无匹配目标账号时不得误取其他账号链接', async () => {
  const targetContent = '在《赛博对话》中，科技博主@潘乱 表示，双十一越来越像春晚。#测试话题#';
  const now = new Date(1_002_000);
  const pad = (n) => String(n).padStart(2, '0');
  const pubTimeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  let dialogOpen = false;
  const getLinkBtn = {
    innerText: '获取链接',
    dispatchEvent() {},
    click() { dialogOpen = true; },
  };
  const linksDialog = {
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes('weibo-link-item')
      ? [{
          querySelector: (q) => (q.includes('nickname')
            ? { innerText: '无关账号:' }
            : { innerText: 'https://weibo.com/999999/OTHER999', getAttribute: () => null }),
        }]
      : []),
  };
  const row = {
    innerText: `${targetContent} 1 发布成功 ${pubTimeStr} 获取链接`,
    innerHTML: '',
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel.includes('td')) {
        return [
          { innerText: targetContent, getAttribute: () => null },
          { innerText: '1', getAttribute: () => null },
          { innerText: '发布成功', getAttribute: () => null },
          { innerText: pubTimeStr, getAttribute: () => null },
        ];
      }
      if (sel.includes('button')) return [getLinkBtn];
      return [];
    },
  };
  const c = load({
    window: {
      __weiboSyncSubmission: {
        account: '虚构目标账号',
        content: targetContent,
        submitted: true,
        startedAt: 1_000_000,
      },
    },
    document: {
      body: {},
      querySelectorAll: (sel) => {
        if (sel.includes('columnheader')) return [{ innerText: '标题' }, { innerText: '操作' }];
        if (sel.includes('weibo-links-dialog')) return dialogOpen ? [linksDialog] : [];
        return [row];
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const res = await c.directRecoverPublishedWeiboUrl('虚构目标账号', targetContent);
  assert.equal(res.ok, false);
  assert.match(res.error, /状态=发布成功/);
});

test('连续两批群发时上一批账号会被自动取消勾选且不误阻断新批次', async () => {
  const checkedState = { '虚构甲号': true, '虚构乙号': true, '虚构丙号': false };
  const makeBox = (name) => ({
    innerText: name,
    textContent: name,
    get classList() {
      return { contains: (cls) => cls === 'n-checkbox' || (cls === 'n-checkbox--checked' && !!checkedState[name]) };
    },
    getAttribute: (attr) => (attr === 'aria-checked' ? String(!!checkedState[name]) : null),
    closest: () => null,
    querySelector: () => null,
    scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 100, height: 24 }),
    getClientRects: () => [{ width: 100, height: 24 }],
    click() { checkedState[name] = !checkedState[name]; },
  });
  const boxes = Object.keys(checkedState).map(makeBox);
  const textarea = { value: '', focus() {}, dispatchEvent() {} };
  const publishBtn = {
    innerText: '立即发布',
    getAttribute: () => null,
    classList: { contains: () => false },
    closest() { return this; },
    getBoundingClientRect: () => ({ width: 80, height: 32 }),
    getClientRects: () => [{ width: 80, height: 32 }],
    click() {},
  };
  const c = load({
    window: {
      location: { href: 'https://ai-publish-platform.weibo.com/#/post', hostname: 'ai-publish-platform.weibo.com' },
      HTMLTextAreaElement: function HTMLTextAreaElement() {},
      HTMLInputElement: function HTMLInputElement() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      dispatchEvent() {},
    },
    document: {
      title: '发稿中台',
      body: { innerText: '', innerHTML: '', appendChild() {} },
      documentElement: { outerHTML: '' },
      getElementById: () => null,
      createElement: () => ({ style: {}, remove() {}, innerText: '' }),
      querySelector: (sel) => (sel.includes('textarea') ? textarea : null),
      querySelectorAll: (sel) => {
        if (sel.includes('.n-checkbox--checked') || sel.includes('aria-checked="true"')) {
          return boxes.filter((b) => checkedState[b.innerText]);
        }
        if (sel.includes('.n-checkbox__label') || sel.includes('account_selector_checkbox')) return boxes;
        if (sel.includes('button')) return [publishBtn];
        return [];
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });

  const res = await c.directPostToWeiboPlatform({ account: '虚构丙号', content: '第二批正文' }, true);
  assert.equal(res.ok, true, res.error);
  assert.equal(checkedState['虚构甲号'], false, '上一批账号必须被取消勾选');
  assert.equal(checkedState['虚构乙号'], false, '上一批账号必须被取消勾选');
  assert.equal(checkedState['虚构丙号'], true, '本批目标账号必须被勾选');
});

test('群发回执被平台写进同一行剪贴板时仍能按账号拆分映射', async () => {
  const checkedState = { '虚构甲号': false, '虚构乙号': false };
  const makeBox = (name) => ({
    innerText: name,
    textContent: name,
    get classList() {
      return { contains: (cls) => cls === 'n-checkbox' || (cls === 'n-checkbox--checked' && !!checkedState[name]) };
    },
    getAttribute: (attr) => (attr === 'aria-checked' ? String(!!checkedState[name]) : null),
    closest: () => null,
    querySelector: () => null,
    scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 100, height: 24 }),
    getClientRects: () => [{ width: 100, height: 24 }],
    click() { checkedState[name] = !checkedState[name]; },
  });
  const boxes = Object.keys(checkedState).map(makeBox);
  const textarea = { value: '', focus() {}, dispatchEvent() {} };
  const win = {
    location: { href: 'https://ai-publish-platform.weibo.com/#/post', hostname: 'ai-publish-platform.weibo.com' },
    HTMLTextAreaElement: function HTMLTextAreaElement() {},
    HTMLInputElement: function HTMLInputElement() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    dispatchEvent() {},
    __clipCaptured: '',
  };
  const publishBtn = {
    innerText: '立即发布',
    getAttribute: () => null,
    classList: { contains: () => false },
    closest() { return this; },
    getBoundingClientRect: () => ({ width: 80, height: 32 }),
    getClientRects: () => [{ width: 80, height: 32 }],
    click() {
      win.__clipCaptured = '虚构甲号: https://weibo.com/100001/AAA 虚构乙号: https://weibo.com/100002/BBB';
    },
  };
  const c = load({
    window: win,
    document: {
      title: '发稿中台',
      body: { innerText: '', innerHTML: '', appendChild() {} },
      documentElement: { outerHTML: '' },
      getElementById: () => null,
      createElement: () => ({ style: {}, remove() {}, innerText: '' }),
      querySelector: (sel) => (sel.includes('textarea') ? textarea : null),
      querySelectorAll: (sel) => {
        if (sel.includes('.n-checkbox--checked') || sel.includes('aria-checked="true"')) {
          return boxes.filter((b) => checkedState[b.innerText]);
        }
        if (sel.includes('.n-checkbox__label') || sel.includes('account_selector_checkbox')) return boxes;
        if (sel.includes('button')) return [publishBtn];
        return [];
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });

  const res = await c.directPostToWeiboPlatform({
    account: '虚构甲号',
    accounts: ['虚构甲号', '虚构乙号'],
    content: '同一行剪贴板回执正文',
  }, false);

  assert.equal(res.ok, true, res.error);
  assert.equal(res.postUrlsByAccount['虚构甲号'], 'https://weibo.com/100001/AAA');
  assert.equal(res.postUrlsByAccount['虚构乙号'], 'https://weibo.com/100002/BBB');
});

test('directPostToWeiboPlatform支持跨Tab一次勾选多账号并精准映射各自博文链接', async () => {
  let activeTab = '热点';
  const checkedState = {
    '虚构主号': false,
    '旧残留号': true,
    '虚构小号A': false,
    '虚构小号B': false,
  };
  const makeCheckbox = (name, tabOwner) => ({
    innerText: name,
    textContent: name,
    get classList() {
      return {
        contains: (cls) => cls === 'n-checkbox' || (cls === 'n-checkbox--checked' && !!checkedState[name]),
      };
    },
    getAttribute: (attr) => (attr === 'aria-checked' ? String(!!checkedState[name]) : null),
    closest: () => null,
    querySelector: () => null,
    scrollIntoView() {},
    getBoundingClientRect: () => (activeTab === tabOwner ? { width: 100, height: 24 } : { width: 0, height: 0 }),
    getClientRects: () => (activeTab === tabOwner ? [{ width: 100, height: 24 }] : []),
    click() {
      checkedState[name] = !checkedState[name];
    },
  });
  const boxes = [
    makeCheckbox('虚构主号', '热点'),
    makeCheckbox('旧残留号', '热点'),
    makeCheckbox('虚构小号A', '填充'),
    makeCheckbox('虚构小号B', '填充'),
  ];
  const makeTab = (tabName) => ({
    innerText: tabName,
    textContent: tabName,
    classList: { contains: () => false },
    getAttribute: (attr) => (attr === 'data-name' ? tabName : null),
    scrollIntoView() {},
    querySelector: () => null,
    click() {
      activeTab = tabName;
    },
  });
  const tabs = [makeTab('热点'), makeTab('填充')];
  const textarea = {
    value: '',
    focus() {},
    dispatchEvent() {},
    getBoundingClientRect: () => ({ width: 300, height: 100 }),
    getClientRects: () => [{ width: 300, height: 100 }],
  };
  let publishedModalVisible = false;
  const publishBtn = {
    innerText: '立即发布',
    disabled: false,
    getAttribute: () => null,
    classList: { contains: () => false },
    closest() { return this; },
    getBoundingClientRect: () => ({ width: 80, height: 32 }),
    getClientRects: () => [{ width: 80, height: 32 }],
    click() {
      publishedModalVisible = true;
    },
  };
  const modalItems = [
    {
      querySelector: (sel) => (sel.includes('nickname')
        ? { innerText: '虚构主号:' }
        : { innerText: 'https://weibo.com/111111/MAIN01', getAttribute: () => null }),
    },
    {
      querySelector: (sel) => (sel.includes('nickname')
        ? { innerText: '虚构小号A:' }
        : { innerText: 'https://weibo.com/222222/SUBA02', getAttribute: () => null }),
    },
    {
      querySelector: (sel) => (sel.includes('nickname')
        ? { innerText: '虚构小号B:' }
        : { innerText: 'https://weibo.com/333333/SUBB03', getAttribute: () => null }),
    },
  ];
  const c = load({
    window: {
      location: { href: 'https://ai-publish-platform.weibo.com/#/post', hostname: 'ai-publish-platform.weibo.com' },
      HTMLTextAreaElement: function HTMLTextAreaElement() {},
      HTMLInputElement: function HTMLInputElement() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      dispatchEvent() {},
    },
    document: {
      title: '发稿中台',
      body: { innerText: '', innerHTML: '' },
      documentElement: { outerHTML: '' },
      querySelector: (sel) => {
        if (sel.includes('textarea')) return textarea;
        return null;
      },
      querySelectorAll: (sel) => {
        if (sel.includes('.n-checkbox--checked') || sel.includes('aria-checked="true"')) {
          return boxes.filter((b) => checkedState[b.innerText] && b.getBoundingClientRect().width > 0);
        }
        if (sel.includes('.n-checkbox__label') || sel.includes('account_selector_checkbox')) {
          return boxes;
        }
        if (sel.includes('.n-tabs-tab')) return tabs;
        if (sel.includes('.publish_model_item') || sel.includes('.weibo-link-item')) {
          return publishedModalVisible ? modalItems : [];
        }
        if (sel.includes('button')) return [publishBtn];
        return [];
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });

  const res = await c.directPostToWeiboPlatform({
    account: '虚构主号',
    accounts: ['虚构主号', '虚构小号A', '虚构小号B'],
    content: '多账号群发单测正文',
  }, false);

  assert.equal(res.ok, true, res.error);
  assert.equal(checkedState['旧残留号'], false);
  assert.equal(checkedState['虚构主号'], true);
  assert.equal(checkedState['虚构小号A'], true);
  assert.equal(checkedState['虚构小号B'], true);
  assert.equal(res.postUrlsByAccount['虚构主号'], 'https://weibo.com/111111/MAIN01');
  assert.equal(res.postUrlsByAccount['虚构小号A'], 'https://weibo.com/222222/SUBA02');
  assert.equal(res.postUrlsByAccount['虚构小号B'], 'https://weibo.com/333333/SUBB03');
});

test('群发非首账号可凭提交上下文恢复，正文自带旧直链不可充当回执', async () => {
  const content = '正文 https://weibo.com/123456/OLD';
  const old = 'https://weibo.com/123456/OLD';
  const cells = [{ innerText: content, getAttribute: () => null }, { innerText: '虚构小号', getAttribute: () => null }, { innerText: '1970-01-01 00:16:42', getAttribute: () => null }];
  const row = { innerText: content, innerHTML: `<a href="${old}">${old}</a>`, closest: () => null,
    querySelector: (sel) => sel.includes('a[href') ? { href: old } : null,
    querySelectorAll: (sel) => sel.includes('td') ? cells : [] };
  const c = load({ window: { __weiboSyncSubmission: { account: '虚构主号', accounts: ['虚构主号', '虚构小号'], content, submitted: true, startedAt: 1_000_000 } },
    document: { body: {}, addEventListener() {}, removeEventListener() {}, querySelectorAll: (sel) => sel.includes('columnheader') ? [{ innerText: '发布账号' }] : [row] } });
  const result = await c.directRecoverPublishedWeiboUrl('虚构小号', content);
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /缺少本次提交上下文/);
});







