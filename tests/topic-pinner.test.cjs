'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const topicPinnerSource = fs.readFileSync(
  path.join(__dirname, '../background/topic_pinner.js'),
  'utf8',
);

function createTopicHarness(initial = {}) {
  let data = structuredClone(initial);
  const messages = [];
  const alarms = new Map();
  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const list = Array.isArray(keys) ? keys : [keys];
          const val = Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
          if (cb) cb(val);
          return Promise.resolve(val);
        },
        async set(val) {
          data = { ...data, ...structuredClone(val) };
        },
      },
    },
    alarms: {
      get(name, cb) {
        const val = alarms.get(name);
        const res = val ? { name, scheduledTime: val.when, ...val } : undefined;
        if (cb) cb(res);
        return Promise.resolve(res);
      },
      async create(name, info) { alarms.set(name, info); },
      async clear(name) { alarms.delete(name); return true; },
    },
    runtime: {
      async sendMessage(msg) { messages.push(msg); },
    },
    tabs: {
      onCreated: { addListener() {}, removeListener() {} },
      async get(id) { return { id, url: 'https://weibo.com/', status: 'complete' }; },
      async create(opts) { return { id: 99, ...opts, status: 'complete' }; },
      async update(id, opts) { return { id, ...opts, status: 'complete' }; },
      async reload() {},
      async remove() {},
    },
    scripting: {
      async executeScript() { return [{ result: null }]; },
    },
  };

  const context = vm.createContext({
    chrome,
    console,
    URL,
    Date,
    Math,
    setTimeout: (fn) => { queueMicrotask(fn); return 1; },
    clearTimeout() {},
  });
  vm.runInContext(topicPinnerSource, context, { filename: path.join(__dirname, '../background/topic_pinner.js') });
  return {
    context,
    alarms,
    messages,
    get data() { return data; },
    run(code) { return vm.runInContext(code, context); },
  };
}

test('parseWeiboPostUrl 支持 PC 端与移动端链接解析', () => {
  const h = createTopicHarness();
  const pc = h.run(`parseWeiboPostUrl('https://weibo.com/1618051664/P123abc?from=page')`);
  assert.equal(pc.uid, '1618051664');
  assert.equal(pc.mblogid, 'P123abc');
  assert.equal(pc.canonicalUrl, 'https://weibo.com/1618051664/P123abc');

  const mobile = h.run(`parseWeiboPostUrl('https://m.weibo.cn/detail/509876543210')`);
  assert.equal(mobile.mid, '509876543210');
  assert.equal(mobile.canonicalUrl, 'https://m.weibo.cn/detail/509876543210');

  assert.throws(() => h.run(`parseWeiboPostUrl('https://example.com/123')`), /有效的微博域名/);
});

test('filterPostForTopicPin 正确执行投票、关键词、豁免话题和第3个话题规则', () => {
  const h = createTopicHarness();
  const res1 = JSON.parse(JSON.stringify(h.run(`filterPostForTopicPin({
    text: '#话题一# #热知识点# #话题二# #第3个话题# #话题四#',
    isVote: false
  }, {})`)));
  assert.equal(res1.shouldProcess, true);
  assert.deepEqual(res1.skippedTopics, ['热知识点']);
  assert.equal(res1.skippedThird, '第3个话题');
  assert.deepEqual(res1.topics, ['话题一', '话题二', '话题四']);

  const resVote = h.run(`filterPostForTopicPin({ text: '#测试#', isVote: true }, { skipVotes: true })`);
  assert.equal(resVote.shouldProcess, false);

  const resKw = h.run(`filterPostForTopicPin({ text: '#测试# 转发抽奖', isVote: false }, {})`);
  assert.equal(resKw.shouldProcess, false);
});

test('extractObjectIdAndQuery 正确提取管理参数', () => {
  const h = createTopicHarness();
  const ids = h.run(`extractObjectIdAndQuery('https://m.s.weibo.com/claim/manage?object_id=1022%3A231522abc&query=%23%E6%B5%8B%E8%AF%95%23', '测试')`);
  assert.equal(ids.oid, '1022:231522abc');
  assert.equal(ids.query, '#测试#');
});

test('发博后自动置顶开关关闭时不入队，开启时自动入队并推进', async () => {
  const hOff = createTopicHarness({ topicPinConfig: { autoPinOnPublish: false } });
  const rOff = await hOff.run(`maybeEnqueueAutoPinForPublishedPost({ postUrl: 'https://weibo.com/123/Abc', content: '#测试话题# 正文', account: '新浪热点' })`);
  assert.equal(rOff, null);

  const hOn = createTopicHarness({ topicPinConfig: { autoPinOnPublish: true } });
  hOn.run(`processTopicPinQueue = async () => {};`);
  const rOn = await hOn.run(`maybeEnqueueAutoPinForPublishedPost({ postUrl: 'https://weibo.com/123/Abc', content: '#测试话题# 正文', account: '新浪热点' })`);
  assert.equal(rOn.mode, 'auto_publish');
  assert.equal(rOn.topics[0].hashtag, '测试话题');
  assert.equal(hOn.data.topicPinTasks.length, 1);
});

test('手动申请主持人支持直接输入话题名，且等待审核时注册闹钟', async () => {
  const h = createTopicHarness({ topicPinConfig: { minWaitSec: 90, maxWaitSec: 600 } });
  h.run(`
    ensureTopicPinWorkerTab = async () => ({ id: 88 });
    inspectTopicInTab = async () => ({ loginRequired: false, manageHref: null, canApply: true, hasOtherHost: false });
    applyForHostInTab = async () => ({ status: 'applied' });
  `);
  const task = await h.run(`handleManualApplyHost({ input: '#测试新话题#', fastMode: true, autoPin: false })`);
  // Wait microtasks for queue processing
  await new Promise((r) => setTimeout(r, 20));
  const saved = h.data.topicPinTasks.find((t) => t.id === task.id);
  assert.equal(saved.status, 'done');
  assert.equal(saved.topics[0].status, 'applied_done');
});

test('申请主持人并自动置顶在等待审核时会设置 waiting_review 并创建 topicPinTick 闹钟', async () => {
  const h = createTopicHarness({ topicPinConfig: { minWaitSec: 120, maxWaitSec: 600 } });
  h.run(`
    ensureTopicPinWorkerTab = async () => ({ id: 88 });
    inspectTopicInTab = async () => ({ loginRequired: false, manageHref: null, canApply: true, hasOtherHost: false });
    applyForHostInTab = async () => ({ status: 'applied' });
  `);
  const task = await h.run(`enqueueTopicPinTask({ mode: 'manual_pin', postUrl: 'https://weibo.com/123/Abc', text: '#待审核话题#', hashtags: ['待审核话题'], autoPin: true })`);
  await new Promise((r) => setTimeout(r, 20));
  const saved = h.data.topicPinTasks.find((t) => t.id === task.id);
  assert.equal(saved.status, 'waiting_review');
  assert.equal(saved.topics[0].status, 'applied');
  assert.ok(h.alarms.has('topicPinTick'));
});

test('isInScheduleWindow 与 shouldMonitorRunNow 支持时间窗口(含跨午夜)、星期过滤与运行时长', () => {
  const h = createTopicHarness();
  // 2026-11-16 is Monday -> weekday 0
  const monMorning = new Date('2026-11-16T08:30:00');
  const monNight = new Date('2026-11-16T23:30:00');
  assert.equal(h.run(`isInScheduleWindow({ start: '07:00', end: '22:59', weekdays: [0,1,2] }, new Date('${monMorning.toISOString()}'))`), true);
  assert.equal(h.run(`isInScheduleWindow({ start: '07:00', end: '22:59', weekdays: [0,1,2] }, new Date('${monNight.toISOString()}'))`), false);
  // 跨午夜 22:00 -> 06:00
  assert.equal(h.run(`isInScheduleWindow({ start: '22:00', end: '06:00', weekdays: [0] }, new Date('${monNight.toISOString()}'))`), true);
  // 星期不匹配
  assert.equal(h.run(`isInScheduleWindow({ start: '07:00', end: '22:59', weekdays: [1,2] }, new Date('${monMorning.toISOString()}'))`), false);

  // duration 模式超期判定
  const expired = h.run(`shouldMonitorRunNow({
    monitorStartedAt: 1000,
    schedule: { enabled: true, mode: 'duration', durationHours: 2 }
  }, 1000 + 2 * 3600 * 1000 + 1)`);
  assert.equal(expired.allowed, false);
  assert.equal(expired.expired, true);
});

test('自定义扫首页间隔 monitorIntervalSec 与时间窗口计划会正确注册 topicMonitorTick 闹钟', async () => {
  const h = createTopicHarness();
  await h.run(`saveTopicPinConfig({
    autoMonitorEnabled: false,
    monitorUid: '1618051664',
    monitorIntervalSec: 90,
    schedule: { enabled: true, mode: 'window', start: '07:00', end: '22:59', weekdays: [0,1,2,3,4,5,6] }
  })`);
  assert.equal(h.data.topicPinConfig.monitorIntervalSec, 90);
  assert.ok(h.alarms.has('topicMonitorTick'));
  const alarm = h.alarms.get('topicMonitorTick');
  assert.ok(typeof alarm.when === 'number' && alarm.when > Date.now());
});

test('classifyClaimSubmitOutcome 准确识别 window.close 钩子、末尾 Toast、接口回包并排除静态"审核"误判', () => {
  const h = createTopicHarness();

  // 静态表单页含"审核通过后将自动上线"，不得误判为审核中
  const staticOnly = JSON.parse(JSON.stringify(h.run(`classifyClaimSubmitOutcome({
    url: 'https://m.s.weibo.com/claim/info?object_id=1022:123',
    fullText: '话题名称 国足扳回一球1比2落后 完善信息（审核通过后将自动上线） 话题头像* 话题分类* 请选择 社会',
    stillHasSubmit: true,
    closeCalled: false,
    network: [],
    toasts: [],
    alerts: [],
  })`)));
  assert.equal(staticOnly.done, false);

  // window.close() 被调用但页面未真正关闭（chrome.tabs.update 导航场景）
  const closeHooked = JSON.parse(JSON.stringify(h.run(`classifyClaimSubmitOutcome({
    url: 'https://m.s.weibo.com/claim/info?object_id=1022:123',
    fullText: '完善信息（审核通过后将自动上线）',
    stillHasSubmit: true,
    closeCalled: true,
    network: [],
    toasts: [],
    alerts: [],
  })`)));
  assert.equal(closeHooked.done, true);
  assert.equal(closeHooked.status, 'applied');

  // 末尾 Toast 错误提示（如未上传头像）不被截断
  const errToast = JSON.parse(JSON.stringify(h.run(`classifyClaimSubmitOutcome({
    url: 'https://m.s.weibo.com/claim/info?object_id=1022:123',
    fullText: '完善信息（审核通过后将自动上线）',
    stillHasSubmit: true,
    closeCalled: false,
    network: [],
    toasts: ['请上传话题头像'],
    alerts: [],
  })`)));
  assert.equal(errToast.done, true);
  assert.equal(errToast.status, 'failed');
  assert.match(errToast.reason, /请上传话题头像/);

  // 微博接口返回重复申请 -> in_review；返回"操作未成功" -> 不得误判为成功
  const dupNet = JSON.parse(JSON.stringify(h.run(`classifyClaimSubmitOutcome({
    url: 'https://m.s.weibo.com/claim/info?object_id=1022:123',
    network: [{ url: '/ajax_claim/apply', json: { code: '100002', msg: '您已申请过该话题，请勿重复提交' } }],
  })`)));
  assert.equal(dupNet.done, true);
  assert.equal(dupNet.status, 'in_review');

  const failNet = JSON.parse(JSON.stringify(h.run(`classifyClaimSubmitOutcome({
    url: 'https://m.s.weibo.com/claim/info?object_id=1022:123',
    network: [{ url: '/ajax_claim/apply', json: { code: '100002', msg: '操作未成功' } }],
  })`)));
  assert.equal(failNet.done, true);
  assert.equal(failNet.status, 'failed');
});

test('手动申请开启 autoPin 时，即使申请阶段未检测到响应，已有主持人权限仍继续完成置顶', async () => {
  const h = createTopicHarness({ topicPinConfig: { minWaitSec: 90, pollIntervalSec: 45, maxWaitSec: 600 } });
  h.context.__testCounters = { applyCalls: 0, pinCalls: 0 };
  h.run(`
    ensureTopicPinWorkerTab = async () => ({ id: 88 });
    applyForHostInTab = async () => {
      __testCounters.applyCalls += 1;
      return { status: 'failed', reason: '点击提交后未检测到成功响应' };
    };
    inspectTopicInTab = async () => ({
      loginRequired: false,
      manageHref: 'https://m.s.weibo.com/claim/manage?object_id=1022%3A231522abc&query=%23%E5%9B%BD%E8%B6%B3%23',
      canApply: false,
      hasOtherHost: false,
      alreadyPinned: false,
    });
    pinPostToTopicInTab = async () => {
      __testCounters.pinCalls += 1;
      return { ok: true, alreadyPinned: false };
    };
  `);
  const task = await h.run(`enqueueTopicPinTask({
    mode: 'manual_apply',
    postUrl: 'https://weibo.com/2318910945/RrPUlEvPr',
    text: '#国足扳回一球1比2落后#',
    hashtags: ['国足扳回一球1比2落后'],
    fastMode: true,
    autoPin: true,
  })`);
  await new Promise((r) => setTimeout(r, 30));
  const saved = h.data.topicPinTasks.find((t) => t.id === task.id);
  assert.equal(h.context.__testCounters.applyCalls, 1);
  assert.equal(h.context.__testCounters.pinCalls, 1);
  assert.equal(saved.status, 'done');
  assert.equal(saved.topics[0].status, 'pinned');
});

test('手动申请开启 autoPin 时，申请阶段失败且仍在可申请/审核等待态会保留轮询重试且同轮不重复申请', async () => {
  // 情况A：话题页已无申请入口（已提交审核中）-> 转入 waiting_review
  const hReview = createTopicHarness({ topicPinConfig: { pollIntervalSec: 45, maxWaitSec: 600 } });
  hReview.context.__cnt = 0;
  hReview.run(`
    ensureTopicPinWorkerTab = async () => ({ id: 88 });
    applyForHostInTab = async () => { __cnt += 1; return { status: 'failed', reason: '未检测到成功响应' }; };
    inspectTopicInTab = async () => ({ loginRequired: false, manageHref: null, canApply: false, hasOtherHost: false });
  `);
  const tReview = await hReview.run(`enqueueTopicPinTask({
    mode: 'manual_apply',
    postUrl: 'https://weibo.com/2318910945/RrPUlEvPr',
    text: '#国足扳回一球1比2落后#',
    hashtags: ['国足扳回一球1比2落后'],
    autoPin: true,
  })`);
  await new Promise((r) => setTimeout(r, 30));
  const savedReview = hReview.data.topicPinTasks.find((t) => t.id === tReview.id);
  assert.equal(hReview.context.__cnt, 1);
  assert.equal(savedReview.status, 'waiting_review');
  assert.equal(savedReview.topics[0].status, 'applied');
  assert.ok(hReview.alarms.has('topicPinTick'));

  // 情况B：话题页仍有申请入口 -> 同一轮不再重复调用 applyForHostInTab，保留 pending 等待下轮重试
  const hRetry = createTopicHarness({ topicPinConfig: { pollIntervalSec: 45, maxWaitSec: 600 } });
  hRetry.context.__cnt = 0;
  hRetry.run(`
    ensureTopicPinWorkerTab = async () => ({ id: 88 });
    applyForHostInTab = async () => { __cnt += 1; return { status: 'failed', reason: '页面校验失败' }; };
    inspectTopicInTab = async () => ({ loginRequired: false, manageHref: null, canApply: true, hasOtherHost: false });
  `);
  const tRetry = await hRetry.run(`enqueueTopicPinTask({
    mode: 'manual_apply',
    postUrl: 'https://weibo.com/2318910945/RrPUlEvPr',
    text: '#国足扳回一球1比2落后#',
    hashtags: ['国足扳回一球1比2落后'],
    autoPin: true,
  })`);
  await new Promise((r) => setTimeout(r, 30));
  const savedRetry = hRetry.data.topicPinTasks.find((t) => t.id === tRetry.id);
  assert.equal(hRetry.context.__cnt, 1);
  assert.equal(savedRetry.status, 'waiting_review');
  assert.equal(savedRetry.topics[0].status, 'pending');
  assert.ok(hRetry.alarms.has('topicPinTick'));
});

test('applyForHostInTab 默认静默走 DOM 点击不挂调试器，DOM 无响应时再兜底 CDP 点击并卸载', async () => {
  // 场景 A：DOM 点击直接成功 -> 全程 0 次调试器挂载（不闪烁顶部黄条）
  const hSilent = createTopicHarness();
  let silentAttachCount = 0;
  let silentCropStage = 0;
  hSilent.context.holdBackgroundTabAwake = async () => { silentAttachCount += 1; return true; };
  hSilent.context.releaseBackgroundTab = async () => {};
  hSilent.context.sendCdpClick = async () => {};
  let urlA = 'https://s.weibo.com/weibo?q=%23%E6%B5%8B%E8%AF%95%23';
  hSilent.context.chrome.tabs.update = async (id, opts) => { urlA = opts.url; return { id, url: urlA, status: 'complete' }; };
  hSilent.context.chrome.tabs.get = async (id) => ({ id, url: urlA, status: 'complete' });
  hSilent.context.chrome.scripting.executeScript = async ({ func }) => {
    const src = String(func);
    if (src.includes('hostName') && src.includes('claim/apply')) {
      return [{ result: { status: 'has_url', url: 'https://m.s.weibo.com/claim/apply?object_id=1022:123' } }];
    }
    if (src.includes('allowFallback') && src.includes('loading_cond')) {
      urlA = 'https://m.s.weibo.com/claim/info?object_id=1022:123';
      return [{ result: { status: 'at_form', url: urlA } }];
    }
    if (src.includes('__topicPinProbe') && src.includes('MutationObserver')) {
      return [{ result: { netLen: 0, toastLen: 0, alertLen: 0 } }];
    }
    if (src.includes('DataTransfer') && src.includes('fileInput')) {
      return [{ result: { fileSet: true, beforeImgs: [], netBefore: 0 } }];
    }
    if (src.includes('crop-confirm') && src.includes('shouldClick')) {
      silentCropStage += 1;
      return [{ result: silentCropStage === 1 ? { found: true, x: 200, y: 300 } : { found: false } }];
    }
    if (src.includes('pendingRequests') && src.includes('beforeImgs')) {
      return [{ result: { imgChanged: true, netSettled: true, pending: 0 } }];
    }
    if (src.includes('selectOptionByLabel')) {
      return [{ result: { catSelected: true, regSelected: true } }];
    }
    if (src.includes('findSubmitBtn')) {
      return [{ result: { status: 'ready', btnText: '提交申请', coords: { x: 150, y: 420 }, mark: { netLen: 0, toastLen: 0, alertLen: 0 }, url: urlA } }];
    }
    if (src.includes('fullText') && src.includes('stillHasSubmit')) {
      return [{
        result: {
          tabGone: false, url: urlA, fullText: '完善信息（审核通过后将自动上线）', txt: '完善信息',
          stillHasSubmit: true, closeCalled: true,
          network: [{ url: '/ajax_claim/apply', json: { code: '100000', msg: '提交成功' } }],
          toasts: [], alerts: [],
        },
      }];
    }
    return [{ result: { status: 'ok', url: urlA } }];
  };
  const silentRes = JSON.parse(JSON.stringify(await hSilent.run(`applyForHostInTab(88, '测试话题', {
    hostAccountName: '新浪热点',
    hostApply: { category: '社会', region: '全国', imageDataUrl: 'data:image/png;base64,AA==' },
  }, true)`)));
  assert.equal(silentRes.status, 'applied');
  assert.equal(silentAttachCount, 0);

  // 场景 B：DOM 点击裁剪框未关闭 & 提交无响应 -> 按需触发 CDP 点击并最终卸载调试器
  const h = createTopicHarness();
  const cdpCalls = [];
  const detachedTabs = [];
  let attached = false;
  let cropStage = 0;
  let probeReads = 0;

  h.context.holdBackgroundTabAwake = async (tabId) => { attached = Boolean(tabId); return true; };
  h.context.releaseBackgroundTab = async (tabId) => { detachedTabs.push(tabId); attached = false; };
  h.context.sendCdpClick = async (tabId, x, y) => { cdpCalls.push({ tabId, x, y }); };

  let currentUrl = 'https://s.weibo.com/weibo?q=%23%E6%B5%8B%E8%AF%95%23';
  h.context.chrome.tabs.update = async (id, opts) => {
    currentUrl = opts.url;
    return { id, url: currentUrl, status: 'complete' };
  };
  h.context.chrome.tabs.get = async (id) => ({ id, url: currentUrl, status: 'complete' });
  h.context.chrome.scripting.executeScript = async ({ func }) => {
    const src = String(func);
    if (src.includes('hostName') && src.includes('claim/apply')) {
      return [{ result: { status: 'has_url', url: 'https://m.s.weibo.com/claim/apply?object_id=1022:123' } }];
    }
    if (src.includes('allowFallback') && src.includes('loading_cond')) {
      currentUrl = 'https://m.s.weibo.com/claim/info?object_id=1022:123';
      return [{ result: { status: 'at_form', url: currentUrl } }];
    }
    if (src.includes('__topicPinProbe') && src.includes('MutationObserver')) {
      return [{ result: { netLen: 0, toastLen: 0, alertLen: 0 } }];
    }
    if (src.includes('DataTransfer') && src.includes('fileInput')) {
      return [{ result: { fileSet: true, beforeImgs: [], netBefore: 0 } }];
    }
    if (src.includes('crop-confirm') && src.includes('shouldClick')) {
      cropStage += 1;
      // 第1次发现，第2次 DOM click，第3次(w=0)仍开，第4次(w=1)仍开 -> 触发 CDP，第5次已关
      if (cropStage <= 4) return [{ result: { found: true, x: 200, y: 300 } }];
      return [{ result: { found: false } }];
    }
    if (src.includes('pendingRequests') && src.includes('beforeImgs')) {
      return [{ result: { imgChanged: true, netSettled: true, pending: 0 } }];
    }
    if (src.includes('selectOptionByLabel')) {
      return [{ result: { catSelected: true, regSelected: true } }];
    }
    if (src.includes('findSubmitBtn')) {
      return [{ result: { status: 'ready', btnText: '提交申请', coords: { x: 150, y: 420 }, mark: { netLen: 0, toastLen: 0, alertLen: 0 }, url: currentUrl } }];
    }
    if (src.includes('fullText') && src.includes('stillHasSubmit')) {
      probeReads += 1;
      if (probeReads === 1) {
        // DOM 提交后暂无任何变化 -> 触发 CDP 点击提交
        return [{
          result: { tabGone: false, url: currentUrl, fullText: '完善信息', txt: '完善信息', stillHasSubmit: true, closeCalled: false, network: [], toasts: [], alerts: [] },
        }];
      }
      return [{
        result: {
          tabGone: false, url: currentUrl, fullText: '完善信息（审核通过后将自动上线）', txt: '完善信息',
          stillHasSubmit: true, closeCalled: true,
          network: [{ url: '/ajax_claim/apply', json: { code: '100000', msg: '提交成功' } }],
          toasts: [], alerts: [],
        },
      }];
    }
    return [{ result: { status: 'ok', url: currentUrl } }];
  };

  const res = JSON.parse(JSON.stringify(await h.run(`applyForHostInTab(88, '测试话题', {
    hostAccountName: '新浪热点',
    hostApply: { category: '社会', region: '全国', imageDataUrl: 'data:image/png;base64,AA==' },
  }, true)`)));
  assert.equal(res.status, 'applied');
  assert.equal(cdpCalls.length, 2); // 1次裁剪确定兜底 + 1次提交申请兜底
  assert.deepEqual(cdpCalls[0], { tabId: 88, x: 200, y: 300 });
  assert.deepEqual(cdpCalls[1], { tabId: 88, x: 150, y: 420 });
  assert.deepEqual(detachedTabs, [88]);
  assert.equal(attached, false);
});

test('ensureTopicPinWorkerTab 仅在现有普通窗口内开后台标签页，绝不弹出独立窗口闪屏', async () => {
  const h = createTopicHarness();
  const createdTabs = [];
  let popupWindowCalled = 0;
  h.context.createSilentRunnerWindow = async () => { popupWindowCalled += 1; return { window: { id: 1 }, tab: { id: 1 } }; };
  h.context.chrome.windows = {
    async getAll() { return [{ id: 5, type: 'normal', focused: true }]; },
    async create() { popupWindowCalled += 1; return { id: 9, tabs: [{ id: 99 }] }; },
  };
  h.context.chrome.tabs.create = async (opts) => {
    createdTabs.push(opts);
    return { id: 66, ...opts, status: 'complete' };
  };
  const tab = JSON.parse(JSON.stringify(await h.run(`ensureTopicPinWorkerTab('https://weibo.com/')`)));
  assert.equal(tab.id, 66);
  assert.equal(popupWindowCalled, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(createdTabs)), [{ url: 'https://weibo.com/', windowId: 5, active: false }]);
});

test('normalizeTopicPinConfig 在未传入 monitorUid 时保留默认监控 UID，显式传空串则清空', () => {
  const h = createTopicHarness();
  const defCfg = JSON.parse(JSON.stringify(h.run(`normalizeTopicPinConfig({ autoMonitorEnabled: true })`)));
  assert.equal(defCfg.monitorUid, '2318910945');

  const clearedCfg = JSON.parse(JSON.stringify(h.run(`normalizeTopicPinConfig({ monitorUid: '' })`)));
  assert.equal(clearedCfg.monitorUid, '');
});

test('ensureTopicPinAlarms 在扩展重启/心跳自愈时自动补建丢失的巡检闹钟并恢复中断任务', async () => {
  const now = Date.now();
  const h = createTopicHarness({
    topicPinConfig: { autoMonitorEnabled: true, monitorUid: '2318910945', monitorIntervalSec: 180 },
    topicMonitorStatus: { lastRunAt: now - 30000, ok: true },
    topicPinTasks: [
      {
        id: 't_orphan',
        mode: 'manual_apply',
        status: 'running',
        postUrl: 'https://weibo.com/2318910945/Test',
        topics: [{ hashtag: '测试', status: 'pending', note: '等待检测' }],
        deadlineAt: now + 600000,
      },
    ],
  });
  h.context.__ranQueue = false;
  h.run(`processTopicPinQueue = async () => { __ranQueue = true; };`);

  await h.run(`ensureTopicPinAlarms({ recoverRunningTasks: true })`);
  assert.ok(h.alarms.has('topicMonitorTick'));
  const monAlarm = h.alarms.get('topicMonitorTick');
  assert.ok(monAlarm.when > now && monAlarm.when <= now + 185000);
  assert.equal(h.data.topicPinTasks[0].status, 'pending');
  assert.equal(h.context.__ranQueue, true);

  // 若上次巡检已超间隔，ensureTopicPinAlarms 应立即补检并刷新状态
  const hOverdue = createTopicHarness({
    topicPinConfig: { autoMonitorEnabled: true, monitorUid: '2318910945', monitorIntervalSec: 120 },
    topicMonitorStatus: { lastRunAt: now - 300000, ok: true },
  });
  hOverdue.context.__checked = 0;
  hOverdue.run(`checkWeiboMonitorOnce = async () => { __checked += 1; return { ok: true, newPost: false }; };`);
  await hOverdue.run(`ensureTopicPinAlarms({ recoverRunningTasks: false })`);
  assert.equal(hOverdue.context.__checked, 1);
  assert.ok(hOverdue.alarms.has('topicMonitorTick'));
});

test('checkWeiboMonitorOnce 与 processTopicPinQueue 串行共享浏览器窗口且失败时记录状态', async () => {
  const h = createTopicHarness({
    topicPinConfig: { autoMonitorEnabled: true, monitorUid: '2318910945', monitorIntervalSec: 150 },
  });
  const events = [];
  h.context.__events = events;
  h.run(`
    ensureTopicPinWorkerTab = async () => { __events.push('open_tab'); return { id: 77 }; };
    closeTopicPinWorkerWindow = async () => { __events.push('close_tab'); };
    navigateTabAndWait = async () => { __events.push('nav'); };
    runInMainWorld = async () => ({ ok: false, error: 'HTTP 403' });
  `);
  const res = JSON.parse(JSON.stringify(await h.run(`checkWeiboMonitorOnce({ manual: true })`)));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'HTTP 403');
  assert.equal(h.data.topicMonitorStatus.ok, false);
  assert.equal(h.data.topicMonitorStatus.reason, 'HTTP 403');
  assert.deepEqual(events, ['open_tab', 'nav', 'close_tab']);
});

test('isVotePostPayload 兼容 page_info type=25、url_struct.ori_url 与巡检投票跳过', async () => {
  const h = createTopicHarness({ topicPinConfig: { autoMonitorEnabled: true, monitorUid: '2318910945', skipVotes: true } });
  assert.equal(h.run(`isVotePostPayload({ page_info: { type: '25', page_url: 'https://vote.weibo.com/h5/123' } }, '#测试#')`), true);
  assert.equal(h.run(`isVotePostPayload({ url_struct: [{ ori_url: 'https://vote.weibo.com/h5/456', url_title: '投票' }] }, '#测试#')`), true);
  assert.equal(h.run(`isVotePostPayload({ title: { text: '发起了投票' } }, '#测试#')`), true);
  assert.equal(h.run(`isVotePostPayload(null, '#测试# 【投票：选哪个】')`), true);

  // checkWeiboMonitorOnce 通过 postRaw 识别 type=25 投票贴并标记 skipped
  h.run(`
    ensureTopicPinWorkerTab = async () => ({ id: 77 });
    closeTopicPinWorkerWindow = async () => {};
    navigateTabAndWait = async () => {};
    processTopicPinQueue = async () => {};
    runInMainWorld = async () => ({
      ok: true,
      post: { id: '999001', mblogid: 'AbcVote', url: 'https://weibo.com/2318910945/AbcVote', text: '#测试投票#', isVote: false },
      postRaw: { page_info: { type: '25', vote_id: '888' }, text_raw: '#测试投票#' },
    });
  `);
  const mRes = await h.run(`checkWeiboMonitorOnce({ manual: true })`);
  assert.equal(mRes.ok, true);
  assert.equal(mRes.newPost, true);
  assert.equal(h.data.topicPinTasks[0].status, 'skipped');
  assert.match(h.data.topicPinTasks[0].error, /投票/);
});

test('置顶失败首次自动转入下轮重试，连续两次失败才标 error', async () => {
  const h = createTopicHarness({ topicPinConfig: { pollIntervalSec: 40, maxWaitSec: 600 } });
  h.context.__pinCalls = 0;
  h.run(`
    ensureTopicPinWorkerTab = async () => ({ id: 77 });
    inspectTopicInTab = async () => ({
      loginRequired: false,
      manageHref: 'https://m.s.weibo.com/claim/manage?object_id=1022%3A231522abc&query=%23%E6%B5%8B%E8%AF%95%23',
      canApply: false,
      hasOtherHost: false,
      alreadyPinned: false,
    });
    pinPostToTopicInTab = async () => {
      __pinCalls += 1;
      return { ok: false, error: '置顶提交后复核未见置顶记录' };
    };
  `);
  const task = await h.run(`enqueueTopicPinTask({
    mode: 'manual_pin',
    postUrl: 'https://weibo.com/2318910945/TestPin',
    text: '#测试话题#',
    hashtags: ['测试话题'],
    autoPin: true,
  })`);
  await new Promise((r) => setTimeout(r, 30));
  let saved = h.data.topicPinTasks.find((t) => t.id === task.id);
  assert.equal(h.context.__pinCalls, 1);
  assert.equal(saved.status, 'waiting_review');
  assert.equal(saved.topics[0].status, 'applied');
  assert.equal(saved.topics[0].pinAttempts, 1);

  // 第2轮再失败 -> 最终标为 error
  await h.run(`updateTopicPinTask('${task.id}', { nextCheckAt: Date.now() - 1000 })`);
  await h.run(`processTopicPinQueue()`);
  saved = h.data.topicPinTasks.find((t) => t.id === task.id);
  assert.equal(h.context.__pinCalls, 2);
  assert.equal(saved.status, 'error');
  assert.equal(saved.topics[0].status, 'error');
});

function attachHttpGlobals(h, { fetchMock, xsrfToken = 'mock_xsrf_123' } = {}) {
  h.context.URLSearchParams = URLSearchParams;
  h.context.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  h.context.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  h.context.Uint8Array = Uint8Array;
  h.context.Blob = Blob;
  h.context.chrome.cookies = {
    async get({ name }) {
      return name === 'XSRF-TOKEN' && xsrfToken ? { value: xsrfToken } : null;
    },
  };
  h.context.fetch = fetchMock;
}

test('checkWeiboMonitorOnce 默认通过后台 HTTP 接口巡检，全程 0 次打开标签页与窗口', async () => {
  const h = createTopicHarness({
    topicPinConfig: { autoMonitorEnabled: true, monitorUid: '2318910945', monitorIntervalSec: 150 },
  });
  let tabsCreated = 0;
  let windowsCreated = 0;
  h.context.chrome.tabs.create = async () => { tabsCreated += 1; return { id: 99, status: 'complete' }; };
  h.context.chrome.windows = {
    async getAll() { return [{ id: 1, type: 'normal', focused: true }]; },
    async create() { windowsCreated += 1; return { id: 2, tabs: [{ id: 99 }] }; },
  };
  const requestedHeaders = [];
  attachHttpGlobals(h, {
    xsrfToken: 'xsrf_abc',
    fetchMock: async (url, init) => {
      requestedHeaders.push({ url, headers: init?.headers || {}, credentials: init?.credentials });
      if (url.includes('/ajax/statuses/mymblog')) {
        return {
          ok: true,
          status: 200,
          url,
          async text() {
            return JSON.stringify({
              ok: 1,
              data: {
                list: [
                  { id: '100', isTop: 1, text_raw: '#旧置顶#' },
                  { id: '509999', mblogid: 'NewPost9', user: { id: '2318910945' }, text_raw: '#纯后台巡检# 最新一条' },
                ],
              },
            });
          },
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  h.run(`processTopicPinQueue = async () => {};`);

  const res = JSON.parse(JSON.stringify(await h.run(`checkWeiboMonitorOnce({ manual: true })`)));
  assert.equal(res.ok, true);
  assert.equal(res.newPost, true);
  assert.equal(res.postId, '509999');
  assert.equal(tabsCreated, 0);
  assert.equal(windowsCreated, 0);
  assert.equal(requestedHeaders[0].credentials, 'include');
  assert.equal(requestedHeaders[0].headers['X-XSRF-TOKEN'], 'xsrf_abc');
  assert.equal(h.data.topicPinTasks.length, 1);
  assert.equal(h.data.topicPinTasks[0].topics[0].hashtag, '纯后台巡检');
});

test('handleManualApplyHost 与置顶全流程走后台 HTTP 接口（0 标签页、0 调试器）', async () => {
  const h = createTopicHarness({
    topicPinConfig: {
      hostAccountName: '新浪热点',
      minWaitSec: 10,
      pollIntervalSec: 10,
      maxWaitSec: 600,
      hostApply: { category: '社会', region: '全国', imageDataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
    },
  });
  let tabsCreated = 0;
  let windowsCreated = 0;
  let debuggerAttached = 0;
  h.context.chrome.tabs.create = async () => { tabsCreated += 1; return { id: 99, status: 'complete' }; };
  h.context.chrome.windows = {
    async getAll() { return [{ id: 1, type: 'normal', focused: true }]; },
    async create() { windowsCreated += 1; return { id: 2, tabs: [{ id: 99 }] }; },
  };
  h.context.holdBackgroundTabAwake = async () => { debuggerAttached += 1; return true; };

  let stage = 'apply';
  let cardtitleAttempts = 0;
  let cardVerifyCalls = 0;
  const capturedApplyBodies = [];
  const capturedCardTitleBodies = [];

  attachHttpGlobals(h, {
    fetchMock: async (url, init) => {
      const jsonResp = (obj) => ({ ok: true, status: 200, url, async text() { return JSON.stringify(obj); } });
      const htmlResp = (html) => ({ ok: true, status: 200, url, async text() { return html; } });
      if (url.includes('/ajax/statuses/show')) {
        return jsonResp({ id: '888', mblogid: 'RrPUlEvPr', user: { id: '2318910945' }, text_raw: '#国足扳回一球1比2落后# 测试正文' });
      }
      if (url.startsWith('https://s.weibo.com/weibo')) {
        if (stage === 'apply') {
          return htmlResp('<html><body><div class="m-side">话题主持人 暂无主持人 <a href="https://m.s.weibo.com/claim/apply?object_id=1022%3A231522abc&query=%23%E5%9B%BD%E8%B6%B3%E6%89%B3%E5%9B%9E%E4%B8%80%E7%90%831%E6%AF%942%E8%90%BD%E5%90%8E%23&uid=2318910945">申请主持人</a></div></body></html>');
        }
        return htmlResp('<html><body><div class="m-side"><a href="https://m.s.weibo.com/claim/manage?object_id=1022%3A231522abc&query=%23%E5%9B%BD%E8%B6%B3%E6%89%B3%E5%9B%9E%E4%B8%80%E7%90%831%E6%AF%942%E8%90%BD%E5%90%8E%23">话题管理</a></div></body></html>');
      }
      if (url.includes('/ajax_pclaim/applypre')) {
        return jsonResp({
          code: '100000',
          data: { data: { check_status: 1, retData: { has_claim: 0, check_list: [{ module: 1, status: 1 }, { module: 3, status: 1 }] } } },
        });
      }
      if (url.includes('/ajax_claim/category')) {
        return jsonResp({ code: '100000', data: { '0': { id: 101, name: '社会' }, '1': { id: 102, name: '体育' } } });
      }
      if (url.includes('/ajax_claim/location')) {
        return jsonResp({ code: '100000', data: { '0': { id: 1, name: '全国' }, '1': { id: 11, name: '北京' } } });
      }
      if (url.includes('/ajax_claim/uploadpic')) {
        assert.ok(String(init?.body || '').includes('pic_data='));
        return jsonResp({ code: '100000', data: { original_pic: 'http://wx1.sinaimg.cn/large/mock_avatar.jpg' } });
      }
      if (url.includes('/ajax_claim/apply')) {
        capturedApplyBodies.push(Object.fromEntries(new URLSearchParams(String(init?.body || ''))));
        return jsonResp({ code: '100000', msg: '申请成功' });
      }
      if (url.includes('/ajax_claim/weiboSearch')) {
        return jsonResp({ code: '100000', data: { mid: '509876543210' } });
      }
      if (url.includes('/ajax_pclaim/card')) {
        cardVerifyCalls += 1;
        return jsonResp({
          code: '100000',
          data: {
            topMaxNum: 1,
            top_operate_show: 0,
            top_info: { replace_tip: cardVerifyCalls >= 2 ? 1 : 0, midtop_num: cardVerifyCalls >= 2 ? 1 : 0, info: { label: '置顶', etime: 1900000000 } },
          },
        });
      }
      if (url.includes('/ajax_claim/cardtitle')) {
        cardtitleAttempts += 1;
        const bodyObj = Object.fromEntries(new URLSearchParams(String(init?.body || '')));
        capturedCardTitleBodies.push(bodyObj);
        if (cardtitleAttempts === 1) return jsonResp({ code: '100002', msg: 'is owner' });
        return jsonResp({ code: '100000', msg: '保存成功' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const task = await h.run(`handleManualApplyHost({ input: 'https://weibo.com/2318910945/RrPUlEvPr', fastMode: true, autoPin: true })`);
  await new Promise((r) => setTimeout(r, 40));

  let saved = h.data.topicPinTasks.find((t) => t.id === task.id);
  assert.equal(saved.status, 'waiting_review');
  assert.equal(saved.topics[0].status, 'applied');
  assert.equal(capturedApplyBodies.length, 1);
  assert.equal(capturedApplyBodies[0].category, '101');
  assert.equal(capturedApplyBodies[0].avatar_url, 'https://wx1.sinaimg.cn/large/mock_avatar.jpg');
  const parsedForm = JSON.parse(capturedApplyBodies[0].data);
  assert.equal(parsedForm.location, '1');
  assert.equal(parsedForm.category, '社会|101');

  // 审核通过后第2轮自动走纯 HTTP 置顶
  stage = 'manage';
  await h.run(`updateTopicPinTask('${task.id}', { nextCheckAt: Date.now() - 1000 })`);
  await h.run(`processTopicPinQueue()`);
  saved = h.data.topicPinTasks.find((t) => t.id === task.id);
  assert.equal(saved.status, 'done');
  assert.equal(saved.topics[0].status, 'pinned');
  assert.equal(cardtitleAttempts, 2); // 自动将 is_owner_mid 从 0 重试为 1
  assert.equal(capturedCardTitleBodies[0].is_owner_mid, '0');
  assert.equal(capturedCardTitleBodies[1].is_owner_mid, '1');
  assert.equal(tabsCreated, 0);
  assert.equal(windowsCreated, 0);
  assert.equal(debuggerAttached, 0);
});

test('parseTopicSearchHtml 正确解析 claim/manage、JSON 转义链接与置顶徽标，并识别访客校验', () => {
  const h = createTopicHarness();
  const escapedManage = JSON.parse(JSON.stringify(h.run(`parseTopicSearchHtml(${JSON.stringify(
    '<html><body><div>话题管理</div><script>var u="https:\\/\\/m.s.weibo.com\\/claim\\/manage?object_id=1022%3A231522xyz&amp;query=%23%E6%B5%8B%E8%AF%95%23";</script><span class="top">置顶</span>' + ' '.repeat(300) + '</body></html>'
  )}, '测试', '新浪热点')`)));
  assert.equal(escapedManage.manageHref, 'https://m.s.weibo.com/claim/manage?object_id=1022%3A231522xyz&query=%23%E6%B5%8B%E8%AF%95%23');
  assert.equal(escapedManage.alreadyPinned, true);

  const visitor = JSON.parse(JSON.stringify(h.run(`parseTopicSearchHtml('<html><title>Sina Visitor System</title></html>', '测试', '新浪热点')`)));
  assert.equal(visitor.needTabFallback, true);
  assert.equal(visitor.reason, 'visitor_challenge');
});

test('当 s.weibo.com 触发访客校验时才懒加载后台标签页兜底完成任务', async () => {
  const h = createTopicHarness({ topicPinConfig: { pollIntervalSec: 40, maxWaitSec: 600 } });
  let tabsOpened = 0;
  let closedTabs = 0;
  let inspectTabCalls = 0;
  h.run(`
    ensureTopicPinWorkerTab = async () => { tabsOpened += 1; topicPinWorkerTabId = 91; return { id: 91 }; };
    closeTopicPinWorkerWindow = async () => { closedTabs += 1; };
    inspectTopicInTab = async () => {
      inspectTabCalls += 1;
      return { loginRequired: false, manageHref: null, canApply: false, hasOtherHost: true, alreadyPinned: false };
    };
  `);
  h.context.ensureTopicPinWorkerTab = async () => { tabsOpened += 1; h.context.topicPinWorkerTabId = 91; return { id: 91 }; };
  h.context.closeTopicPinWorkerWindow = async () => { closedTabs += 1; };
  h.context.inspectTopicInTab = async () => {
    inspectTabCalls += 1;
    return { loginRequired: false, manageHref: null, canApply: false, hasOtherHost: true, alreadyPinned: false };
  };
  attachHttpGlobals(h, {
    fetchMock: async (url) => ({
      ok: true,
      status: 200,
      url: 'https://passport.weibo.com/visitor/visitor?a=enter',
      async text() { return '<html>Sina Visitor System</html>'; },
    }),
  });

  const task = await h.run(`enqueueTopicPinTask({
    mode: 'manual_pin',
    postUrl: 'https://weibo.com/2318910945/TestFallback',
    text: '#测试兜底#',
    hashtags: ['测试兜底'],
    autoPin: true,
  })`);
  await new Promise((r) => setTimeout(r, 30));
  const saved = h.data.topicPinTasks.find((t) => t.id === task.id);
  assert.equal(inspectTabCalls, 1);
  assert.equal(tabsOpened, 1);
  assert.equal(closedTabs, 1);
  assert.equal(saved.status, 'done');
  assert.equal(saved.topics[0].status, 'skipped_other_host');
});

test('回归：链接解析拒绝伪造域名和非 HTTP 协议', () => {
  const h = createTopicHarness();
  for (const url of [
    'https://weibo.com.evil.test/123/Abc',
    'https://evilweibo.cn/123/Abc',
    'https://weibo.cn.evil.test/detail/123',
    'ftp://weibo.com/123/Abc',
  ]) {
    assert.throws(() => h.run(`parseWeiboPostUrl(${JSON.stringify(url)})`), /微博域名|协议/);
  }
  assert.equal(h.run(`parseWeiboPostUrl('https://www.weibo.com/123/Abc').mblogid`), 'Abc');
});

test('回归：队列运行中入队的新 pending 会自动继续处理', async () => {
  const h = createTopicHarness({ topicPinTasks: [{ id: 'first', status: 'pending', topics: [] }] });
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const processed = [];
  h.context.processSingleTopicPinTask = async (task) => {
    processed.push(task.id);
    if (task.id === 'first') { entered(); await blocked; }
    await h.context.updateTopicPinTask(task.id, { status: 'done' });
  };
  const running = h.run('processTopicPinQueue()');
  await started;
  const next = await h.run(`enqueueTopicPinTask({ mode: 'manual_apply', hashtags: ['Mock新任务'], autoPin: false })`);
  release();
  await running;
  assert.deepEqual(processed, ['first', next.id]);
  assert.equal(h.data.topicPinTasks.find((task) => task.id === next.id).status, 'done');
});

test('回归：巡检入队持久化失败后不标 seen，下轮能重新入队', async () => {
  const h = createTopicHarness({ topicPinConfig: { monitorUid: '100001' } });
  h.run(`
    ensureTopicPinWorkerTab = async () => ({ id: 77 });
    navigateTabAndWait = async () => {};
    processTopicPinQueue = async () => {};
    runInMainWorld = async () => ({ ok: true, post: {
      id: 'mock-monitor-post', url: 'https://weibo.com/100001/Mock', text: '#Mock巡检#'
    } });
  `);
  const originalSet = h.context.chrome.storage.local.set;
  let failOnce = true;
  h.context.chrome.storage.local.set = async (value) => {
    if (value.topicPinTasks && failOnce) { failOnce = false; throw new Error('mock storage failure'); }
    if (value.topicPinTasks) assert.equal(value.topicPinLastPostId, 'mock-monitor-post');
    if (value.topicPinLastPostId) assert.ok(value.topicPinTasks, '任务和 seen 必须原子写入');
    return originalSet(value);
  };
  const first = await h.run('checkWeiboMonitorOnce({ manual: true })');
  assert.equal(first.ok, false);
  assert.notEqual(h.data.topicPinLastPostId, 'mock-monitor-post');
  const retry = await h.run('checkWeiboMonitorOnce({ manual: true })');
  assert.equal(retry.newPost, true);
  assert.equal(h.data.topicPinTasks.length, 1);
  assert.equal(h.data.topicPinLastPostId, 'mock-monitor-post');
  const repeated = await h.run('checkWeiboMonitorOnce({ manual: true })');
  assert.equal(repeated.newPost, false);
  assert.equal(h.data.topicPinTasks.length, 1);
});

for (const response of ['network', 'html', 'visitor', 'unknown-json']) {
  test(`回归：申请 POST 结果未知（${response}）不触发页面重复提交`, async () => {
    const h = createTopicHarness();
    let submitCalls = 0;
    let fallbackCalls = 0;
    attachHttpGlobals(h, { fetchMock: async (url) => {
      const json = (obj) => ({ ok: true, status: 200, url, async text() { return JSON.stringify(obj); } });
      if (url.includes('/category')) return json({ data: [{ id: 1, name: '社会' }] });
      if (url.includes('/location')) return json({ data: [{ id: 1, name: '全国' }] });
      if (url.includes('/uploadpic')) return json({ data: { original_pic: 'https://mock.invalid/avatar.jpg' } });
      assert.equal(url, 'https://m.s.weibo.com/ajax_claim/apply');
      submitCalls += 1;
      if (response === 'network') throw new Error('mock lost response');
      if (response === 'unknown-json') return json({});
      return { ok: true, status: 200, url: response === 'visitor' ? 'https://passport.weibo.com/visitor/' : url,
        async text() { return '<html>mock response</html>'; } };
    } });
    h.context.applyForHostInTab = async () => { fallbackCalls += 1; return { status: 'applied' }; };
    const result = await h.run(`applyForHostSmart(async () => 88, 'Mock话题', {
      hostAccountName: 'Mock主持人', hostApply: { imageDataUrl: 'data:image/jpeg;base64,/9j/4A==' }
    }, false, { canApply: true, applyHref: 'https://m.s.weibo.com/claim/info?object_id=mock' })`);
    assert.equal(result.status, 'unknown');
    assert.equal(submitCalls, 1);
    assert.equal(fallbackCalls, 0);
  });
}

test('回归：未知申请结果跨轮只复核权限，禁止重提且不误报申请成功', async () => {
  for (const autoPin of [true, false]) {
    const h = createTopicHarness({ topicPinConfig: { hostAccountName: 'Mock主持人' } });
    let calls = 0;
    h.context.applyForHostSmart = async () => { calls += 1; return { status: 'unknown', reason: 'mock response lost' }; };
    h.context.inspectTopicSmart = async () => ({ canApply: true });
    const task = await h.run(`enqueueTopicPinTask({ mode: 'manual_apply', hashtags: ['Mock未知结果'], autoPin: ${autoPin} })`);
    await h.run('processTopicPinQueue()');
    let saved = h.data.topicPinTasks.find((item) => item.id === task.id);
    assert.equal(calls, 1);
    assert.equal(saved.status, autoPin ? 'waiting_review' : 'error');
    assert.equal(saved.topics[0].status, autoPin ? 'applied' : 'error');
    if (autoPin) {
      await h.run(`updateTopicPinTask('${task.id}', { nextCheckAt: 0 })`);
      await h.run('processTopicPinQueue()');
      saved = h.data.topicPinTasks.find((item) => item.id === task.id);
      assert.equal(calls, 1);
      assert.equal(saved.status, 'waiting_review');
    }
  }
});

test('回归：重试重置 pending 后保留未知提交标记，所有申请入口均禁止重提', async () => {
  for (const mode of ['manual_apply', 'manual_pin']) {
    for (const autoPin of [true, false]) {
      const h = createTopicHarness({ topicPinConfig: { hostAccountName: 'Mock主持人' } });
      let applyCalls = 0;
      let inspectCalls = 0;
      h.context.applyForHostSmart = async () => { applyCalls += 1; return { status: 'unknown', reason: 'mock unknown' }; };
      h.context.inspectTopicSmart = async () => { inspectCalls += 1; return { canApply: true }; };
      const task = await h.run(`enqueueTopicPinTask({ mode: '${mode}', hashtags: ['Mock重试'], autoPin: ${autoPin} })`);
      await h.run('processTopicPinQueue()');
      const first = h.data.topicPinTasks.find((item) => item.id === task.id);
      assert.equal(first.topics[0].submissionUnknown, true);
      const beforeInspects = inspectCalls;
      await h.context.updateTopicPinTask(task.id, {
        status: 'pending', nextCheckAt: null,
        topics: first.topics.map((topic) => ({ ...topic, status: 'pending', note: '等待重试' })),
      });
      await h.run('processTopicPinQueue()');
      const retried = h.data.topicPinTasks.find((item) => item.id === task.id);
      assert.equal(applyCalls, 1);
      assert.equal(inspectCalls, beforeInspects + 1);
      assert.equal(retried.topics[0].submissionUnknown, true);
      assert.equal(retried.status, autoPin ? 'waiting_review' : 'error');
    }
  }
});

test('回归：多话题后续异常不会丢失已提交未知标记，重试不重提第一话题', async () => {
  const h = createTopicHarness();
  let firstCalls = 0;
  h.context.applyForHostSmart = async (_resolve, hashtag) => {
    if (hashtag === 'Mock第一话题') { firstCalls += 1; return { status: 'unknown', reason: 'mock unknown' }; }
    throw new Error('mock second topic failure');
  };
  const task = await h.run(`enqueueTopicPinTask({ mode: 'manual_apply', hashtags: ['Mock第一话题', 'Mock第二话题'], autoPin: true })`);
  await h.run('processTopicPinQueue()');
  let saved = h.data.topicPinTasks.find((item) => item.id === task.id);
  assert.equal(saved.status, 'error');
  assert.equal(saved.topics[0].submissionUnknown, true);
  h.context.inspectTopicSmart = async () => ({ canApply: true });
  await h.context.updateTopicPinTask(task.id, { status: 'pending', topics: saved.topics.map((topic) => ({ ...topic, status: 'pending' })) });
  await h.run('processTopicPinQueue()');
  saved = h.data.topicPinTasks.find((item) => item.id === task.id);
  assert.equal(firstCalls, 1);
  assert.equal(saved.topics[0].submissionUnknown, true);
});

for (const popupUrl of [
  'https://m.s.weibo.com.evil.test/claim/info',
  'https://unrelated.invalid/claim/info',
  'https://m.s.weibo.com/profile',
  'https://m.s.weibo.com/claim/manage',
  'about:blank',
  'delayed-claim',
]) {
  test(`回归：同 opener 弹窗需真实申请 URL 才可接管或清理（${popupUrl}）`, async () => {
    const h = createTopicHarness();
    let listener;
    let popupReads = 0;
    let currentPopupUrl = 'about:blank';
    const inspected = [];
    const updated = [];
    const removed = [];
    const searchUrl = 'https://s.weibo.com/weibo?q=%23Mock%E5%BC%B9%E7%AA%97%23';
    h.context.chrome.tabs.onCreated = { addListener(fn) { listener = fn; }, removeListener() {} };
    h.context.navigateTabAndWait = async () => {};
    h.context.chrome.tabs.get = async (id) => {
      if (id === 88) return { id, url: searchUrl, status: 'complete' };
      popupReads += 1;
      currentPopupUrl = popupUrl === 'delayed-claim'
        ? (popupReads < 3 ? 'about:blank' : 'https://m.s.weibo.com/claim/info?object_id=mock')
        : popupUrl;
      return { id, url: currentPopupUrl, status: 'complete' };
    };
    h.context.chrome.tabs.update = async (id) => { assert.notEqual(currentPopupUrl, 'about:blank'); updated.push(id); };
    h.context.chrome.tabs.remove = async (id) => { removed.push(id); };
    h.context.waitForTabComplete = async (id) => {
      assert.notEqual(currentPopupUrl, 'about:blank');
      return h.context.chrome.tabs.get(id);
    };
    h.context.runInMainWorld = async (id) => {
      inspected.push(id);
      if (id === 88) { listener({ id: 901, openerTabId: 88, url: 'about:blank' }); return { status: 'clicked' }; }
      assert.equal(currentPopupUrl, 'https://m.s.weibo.com/claim/info?object_id=mock');
      return { status: 'other_host' };
    };
    const result = await h.run(`applyForHostInTab(88, 'Mock弹窗', { hostAccountName: 'Mock主持人' }, true)`);
    if (popupUrl === 'delayed-claim') {
      assert.equal(result.status, 'other_host');
      assert.ok(popupReads >= 3);
      assert.deepEqual(inspected, [88, 901]);
      assert.deepEqual(updated, [901]);
      assert.deepEqual(removed, [901]);
    } else {
      assert.deepEqual(inspected, [88]);
      assert.deepEqual(updated, []);
      assert.deepEqual(removed, []);
    }
  });
}

for (const owned of [false, true]) {
  test(`回归：申请弹窗仅接管自身 opener，等待失败清理（owned=${owned}）`, async () => {
    const h = createTopicHarness();
    const removed = [];
    const inspected = [];
    let listener;
    let listenerRemoved = false;
    h.context.chrome.tabs.onCreated = {
      addListener(fn) { listener = fn; },
      removeListener(fn) { assert.equal(fn, listener); listenerRemoved = true; },
    };
    h.context.chrome.tabs.remove = async (id) => { removed.push(id); };
    h.context.chrome.tabs.get = async (id) => ({ id, status: 'complete', url: id === 901
      ? 'https://m.s.weibo.com/claim/info?object_id=mock'
      : 'https://s.weibo.com/weibo?q=%23Mock%E5%BC%B9%E7%AA%97%23' });
    h.context.navigateTabAndWait = async () => {};
    h.context.waitForTabComplete = async (id) => {
      if (owned) throw new Error(`mock wait failed ${id}`);
      return { id, url: 'https://m.s.weibo.com/claim/info', status: 'complete' };
    };
    h.context.runInMainWorld = async (id) => {
      inspected.push(id);
      if (inspected.length === 1) {
        listener({ id: 901, openerTabId: owned ? 88 : 777, url: 'about:blank' });
        listener({ id: 902, url: 'about:blank' });
        return { status: 'clicked' };
      }
      return { status: 'other_host' };
    };
    try { await h.run(`applyForHostInTab(88, 'Mock弹窗', { hostAccountName: 'Mock主持人' }, true)`); }
    catch (error) { assert.match(error.message, /mock wait failed/); }
    assert.equal(listenerRemoved, true);
    assert.ok(inspected.every((id) => id === 88));
    assert.deepEqual(removed, owned ? [901] : []);
  });
}

test('回归：工作标签加载等待失败时先清理再回退，最终失败无泄漏', async () => {
  const h = createTopicHarness();
  let nextId = 90;
  const removed = [];
  h.context.chrome.windows = { async getAll() { return [{ id: 5, focused: true }]; } };
  h.context.chrome.tabs.create = async (opts) => ({ id: ++nextId, ...opts });
  h.context.chrome.tabs.remove = async (id) => { removed.push(id); };
  h.context.waitForTabLoaded = async () => { throw new Error('mock loading failed'); };
  await assert.rejects(h.run('ensureTopicPinWorkerTab()'), /mock loading failed/);
  assert.deepEqual(removed, [91, 92]);
  assert.equal(h.run('topicPinWorkerTabId'), null);
});

test('回归：外部加载等待返回 about:blank 时禁止继续查询 DOM', async () => {
  const h = createTopicHarness();
  h.context.chrome.tabs.get = async (id) => ({ id, status: 'complete', url: 'about:blank' });
  h.context.waitForTabLoaded = h.context.chrome.tabs.get;
  await assert.rejects(h.run('waitForTabComplete(88, 10)'), /加载|about:blank/);
});

test('encodeAvatarToWeiboJpegBase64 通过 OffscreenCanvas 将 PNG 中心裁剪缩放至 200~500 像素 JPEG', async () => {
  const h = createTopicHarness();
  attachHttpGlobals(h, { fetchMock: async () => { throw new Error('unused'); } });
  const canvasCalls = [];
  let closed = false;
  h.context.createImageBitmap = async () => ({ width: 698, height: 349, close() { closed = true; } });
  h.context.OffscreenCanvas = class MockOffscreenCanvas {
    constructor(w, hh) { this.w = w; this.h = hh; }
    getContext() {
      return {
        drawImage: (...args) => canvasCalls.push({ w: this.w, h: this.h, args }),
      };
    }
    async convertToBlob({ type }) {
      assert.equal(type, 'image/jpeg');
      return new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])], { type });
    }
  };
  const b64 = await h.run(`encodeAvatarToWeiboJpegBase64('data:image/png;base64,iVBORw0KGgo=')`);
  assert.equal(b64, '/9j/4A==');
  assert.equal(closed, true);
  assert.deepEqual(canvasCalls[0].args.slice(1), [174, 0, 349, 349, 0, 0, 349, 349]);
});

test('话题置顶自动清理仅清除超过1天的已完成任务，保留待处理与异常任务', async () => {
  const now = 1_700_000_000_000;
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
  const halfDayAgo = now - 12 * 60 * 60 * 1000;
  const h = createTopicHarness({
    topicPinTasks: [
      { id: 'tp_old_done', status: 'done', updatedAt: twoDaysAgo },
      { id: 'tp_recent_done', status: 'done', updatedAt: halfDayAgo },
      { id: 'tp_old_error', status: 'error', updatedAt: twoDaysAgo },
      { id: 'tp_old_wait', status: 'waiting_review', updatedAt: twoDaysAgo },
    ],
  });

  const removed = await h.run(`cleanupExpiredTopicPinTasks(${now})`);
  assert.equal(removed, 1);
  const { topicPinTasks } = await h.context.chrome.storage.local.get(['topicPinTasks']);
  assert.deepEqual(
    topicPinTasks.map((t) => t.id),
    ['tp_recent_done', 'tp_old_error', 'tp_old_wait']
  );
});

