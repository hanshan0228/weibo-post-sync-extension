/**
 * topic_pinner.js - 微博话题自动置顶与主持人申请引擎 (Chrome MV3)
 * 整合自 weibo-autopinner：支持发博后自动联动、主页定时巡检、手动链接置顶与手动申请主持人
 */

const DEFAULT_TOPIC_PIN_CONFIG = {
  autoPinOnPublish: false,
  autoMonitorEnabled: false,
  monitorUid: "2318910945",
  monitorIntervalSec: 150,
  monitorStartedAt: 0,
  hostAccountName: "新浪热点",
  minWaitSec: 120,
  pollIntervalSec: 60,
  maxWaitSec: 600,
  skipVotes: true,
  skipThirdTopic: true,
  skipTopics: [
    "热知识点",
    "公司该给员工报销AI使用费吗",
    "为什么AI不能长期免费",
    "#张雪峰常去的饺子馆摆满鲜花#",
    "一分钟回顾微博毕业见面会",
    "人微阎轻",
    "樊登谈AI时代孩子要怎么学",
  ],
  skipKeywords: [
    "习近平",
    "前主编",
    "新浪新闻",
    "头条新闻",
    "共产党",
    "毛泽东",
    "李克强",
    "抽奖",
  ],
  hostApply: {
    category: "社会",
    region: "全国",
    imageDataUrl: "",
    imageName: "",
  },
  schedule: {
    enabled: false,
    mode: "window",
    start: "07:00",
    end: "22:59",
    durationHours: 8,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  },
};

const TOPIC_PIN_ALARM_TICK = "topicPinTick";
const TOPIC_PIN_ALARM_MONITOR = "topicMonitorTick";

let topicPinMutationQueue = Promise.resolve();
let topicPinBrowserQueue = Promise.resolve();
let topicPinBrowserWaiters = 0;
let topicPinRunningPromise = null;
let topicMonitorRunningPromise = null;
let topicPinWorkerTabId = null;
let topicPinWorkerWindowId = null;

function topicPinLog(msg, level = "info") {
  const line = `[话题置顶] ${msg}`;
  if (typeof appendLog === "function") {
    appendLog(line, level);
  } else {
    console.log(line);
  }
}

function withTopicPinMutation(operation) {
  const result = topicPinMutationQueue.then(operation);
  topicPinMutationQueue = result.catch((err) => {
    console.warn("话题置顶队列操作失败:", err?.message || err);
  });
  return result;
}

function withTopicPinBrowserLock(operation) {
  topicPinBrowserWaiters += 1;
  const run = topicPinBrowserQueue.then(async () => {
    topicPinBrowserWaiters = Math.max(0, topicPinBrowserWaiters - 1);
    try {
      return await operation();
    } finally {
      if (topicPinBrowserWaiters === 0) {
        await closeTopicPinWorkerWindow().catch(() => {});
      }
    }
  });
  topicPinBrowserQueue = run.catch(() => {});
  return run;
}

function normalizeTopicPinConfig(raw = {}) {
  const base = DEFAULT_TOPIC_PIN_CONFIG;
  const hostApplyRaw = raw.hostApply && typeof raw.hostApply === "object" ? raw.hostApply : {};
  const toStrArray = (val, fallback) => {
    if (Array.isArray(val)) return val.map((x) => String(x || "").trim()).filter(Boolean);
    if (typeof val === "string") {
      return val.split(/[\n,，]+/).map((x) => x.trim()).filter(Boolean);
    }
    return [...fallback];
  };
  const clampInt = (val, fallback, min, max) => {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  };

  const schedRaw = raw.schedule && typeof raw.schedule === "object" ? raw.schedule : {};
  const validWeekdays = Array.isArray(schedRaw.weekdays)
    ? schedRaw.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : [...base.schedule.weekdays];
  const durationNum = Number(schedRaw.durationHours ?? schedRaw.duration_hours);
  const durationHours = Number.isFinite(durationNum) ? Math.max(0.5, Math.min(24, durationNum)) : base.schedule.durationHours;
  const timeOrDefault = (val, def) => (/^\d{2}:\d{2}$/.test(String(val || "").trim()) ? String(val).trim() : def);

  const autoMonitorEnabled = Boolean(raw.autoMonitorEnabled);
  const monitorStartedAt = autoMonitorEnabled
    ? (Number(raw.monitorStartedAt) > 0 ? Number(raw.monitorStartedAt) : Date.now())
    : 0;

  return {
    autoPinOnPublish: Boolean(raw.autoPinOnPublish),
    autoMonitorEnabled,
    monitorUid: raw.monitorUid !== undefined ? String(raw.monitorUid || "").trim() : base.monitorUid,
    monitorIntervalSec: clampInt(raw.monitorIntervalSec, base.monitorIntervalSec, 60, 3600),
    monitorStartedAt,
    hostAccountName: String(raw.hostAccountName || base.hostAccountName).trim() || base.hostAccountName,
    minWaitSec: clampInt(raw.minWaitSec, base.minWaitSec, 15, 600),
    pollIntervalSec: clampInt(raw.pollIntervalSec, base.pollIntervalSec, 20, 600),
    maxWaitSec: clampInt(raw.maxWaitSec, base.maxWaitSec, 60, 3600),
    skipVotes: raw.skipVotes !== undefined ? Boolean(raw.skipVotes) : base.skipVotes,
    skipThirdTopic: raw.skipThirdTopic !== undefined ? Boolean(raw.skipThirdTopic) : base.skipThirdTopic,
    skipTopics: toStrArray(raw.skipTopics, base.skipTopics),
    skipKeywords: toStrArray(raw.skipKeywords, base.skipKeywords),
    hostApply: {
      category: String(hostApplyRaw.category || base.hostApply.category).trim() || "社会",
      region: String(hostApplyRaw.region || base.hostApply.region).trim() || "全国",
      imageDataUrl: String(hostApplyRaw.imageDataUrl || ""),
      imageName: String(hostApplyRaw.imageName || ""),
    },
    schedule: {
      enabled: Boolean(schedRaw.enabled),
      mode: schedRaw.mode === "duration" ? "duration" : "window",
      start: timeOrDefault(schedRaw.start, base.schedule.start),
      end: timeOrDefault(schedRaw.end, base.schedule.end),
      durationHours,
      weekdays: [...new Set(validWeekdays)].sort((a, b) => a - b),
    },
  };
}

async function getTopicPinConfig() {
  const { topicPinConfig } = await chrome.storage.local.get(["topicPinConfig"]);
  return normalizeTopicPinConfig(topicPinConfig || {});
}

async function saveTopicPinConfig(raw) {
  const next = normalizeTopicPinConfig(raw || {});
  await chrome.storage.local.set({ topicPinConfig: next });
  await syncTopicMonitorAlarm(next);
  chrome.runtime.sendMessage({ action: "TOPIC_PIN_UPDATED" }).catch(() => {});
  return next;
}

function normalizeWeiboTopic(topic) {
  return String(topic || "").trim().replace(/^#+|#+$/g, "").trim();
}

function parseWeiboPostUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) throw new Error("请输入微博链接");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`无效的微博链接: ${raw}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.includes("weibo.com") && !host.includes("weibo.cn")) {
    throw new Error(`不是有效的微博域名: ${raw}`);
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  let uid = "";
  let mblogid = "";
  let mid = "";

  if (host === "m.weibo.cn") {
    if ((parts[0] === "detail" || parts[0] === "status") && parts[1]) {
      mid = parts[1];
    }
  } else if (parts[0] === "detail" && parts[1]) {
    mid = parts[1];
  } else if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
    uid = parts[0];
    mblogid = parts[1];
  }

  if (!mblogid && !mid) {
    throw new Error(`无法从链接解析微博 ID: ${raw}`);
  }

  const canonicalUrl = uid && mblogid
    ? `https://weibo.com/${uid}/${mblogid}`
    : mid
      ? `https://m.weibo.cn/detail/${mid}`
      : raw.split("?")[0];

  return { uid, mblogid, mid, canonicalUrl };
}

function extractHashtagsFromText(text) {
  const raw = String(text || "");
  const matches = raw.match(/#([^#\n]{1,50}?)#/g) || [];
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const clean = normalizeWeiboTopic(m);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function isVotePostPayload(item = null, text = "") {
  const obj = item && typeof item === "object" ? item : {};
  if ([true, 1, "1", "true", "True"].includes(obj.is_vote)) return true;
  if (obj.vote || obj.vote_id) return true;

  const titleObj = obj.title;
  if (titleObj && typeof titleObj === "object" && String(titleObj.text || "").includes("投票")) return true;
  if (typeof titleObj === "string" && titleObj.includes("投票")) return true;

  const checkCard = (card) => {
    if (!card || typeof card !== "object") return false;
    const cType = String(card.type || "").toLowerCase();
    const cObjType = String(card.object_type || "").toLowerCase();
    const cUrl = String(card.page_url || "");
    const cTitle = String(card.page_title || "");
    if (["vote", "poll"].includes(cType) || ["vote", "poll"].includes(cObjType)) return true;
    if (cType === "25" && !["video", "audio", "article"].includes(cObjType)) {
      if (/vote\.weibo\.com/i.test(cUrl) || cTitle.includes("投票") || card.vote_id) return true;
    }
    if (cType.includes("vote") || cObjType.includes("vote")) return true;
    if (/vote\.weibo\.com/i.test(cUrl)) return true;
    if (cTitle.includes("投票") && (cTitle.includes("参与") || cType.includes("投票"))) return true;
    if (card.vote_id) return true;
    return false;
  };

  const pageInfo = obj.page_info;
  if (checkCard(pageInfo)) return true;
  if (Array.isArray(pageInfo?.cards) && pageInfo.cards.some(checkCard)) return true;

  if (Array.isArray(obj.url_struct)) {
    for (const u of obj.url_struct) {
      if (!u || typeof u !== "object") continue;
      const urls = `${u.ori_url || ""} ${u.url_long || ""} ${u.long_url || ""} ${u.short_url || ""}`;
      if (/vote\.weibo\.com/i.test(urls)) return true;
      if (String(u.url_title || "").includes("投票") || String(u.url_type_pic || "").toLowerCase().includes("vote")) return true;
    }
  }

  const haystack = `${text || ""} ${obj.text_raw || ""} ${obj.text || ""} ${obj.raw_text || ""}`;
  if (/vote\.weibo\.com|发起了投票|【投票[：:]/i.test(haystack)) return true;
  if (haystack.includes("参与投票") && /投票已结束|人参与|单选|多选/.test(haystack)) return true;
  return false;
}

function filterPostForTopicPin(post, cfg) {
  const config = normalizeTopicPinConfig(cfg);
  const text = String(post?.text || "");
  const hashtags = Array.isArray(post?.hashtags) && post.hashtags.length > 0
    ? post.hashtags.map(normalizeWeiboTopic).filter(Boolean)
    : extractHashtagsFromText(text);

  if (config.skipVotes && (post?.isVote || isVotePostPayload(post, text))) {
    return { shouldProcess: false, reason: "投票微博，按配置跳过", topics: [], skippedTopics: [], skippedThird: null };
  }

  if (config.skipKeywords.length > 0) {
    const hit = config.skipKeywords.find((kw) => kw && text.includes(kw));
    if (hit) {
      return { shouldProcess: false, reason: `正文含跳过关键词「${hit}」`, topics: [], skippedTopics: [], skippedThird: null };
    }
  }

  const skipSet = new Set(config.skipTopics.map(normalizeWeiboTopic).filter(Boolean));
  const skippedTopics = hashtags.filter((t) => skipSet.has(t));
  let pending = hashtags.filter((t) => !skipSet.has(t));
  let skippedThird = null;

  if (config.skipThirdTopic && pending.length > 2) {
    skippedThird = pending[2];
    pending = [...pending.slice(0, 2), ...pending.slice(3)];
  }

  if (pending.length === 0) {
    return {
      shouldProcess: false,
      reason: hashtags.length === 0 ? "正文未包含 #话题#" : "所有话题均已被豁免或跳过",
      topics: [],
      skippedTopics,
      skippedThird,
    };
  }

  return { shouldProcess: true, reason: "", topics: pending, skippedTopics, skippedThird };
}

function extractObjectIdAndQuery(manageHref, hashtag) {
  const href = String(manageHref || "");
  const oidMatch = href.match(/object_id=([^&\s]+)/);
  if (!oidMatch) return null;
  const qMatch = href.match(/[?&]query=([^&\s]*)/);
  let oid = oidMatch[1];
  let query = qMatch ? qMatch[1] : `#${hashtag}#`;
  try { oid = decodeURIComponent(oid); } catch {}
  try { query = decodeURIComponent(query); } catch {}
  return { oid, query: query || `#${hashtag}#` };
}

function isInScheduleWindow(schedule = {}, nowDate = new Date()) {
  const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [0, 1, 2, 3, 4, 5, 6];
  // JS getDay(): 0=Sun..6=Sat -> Python weekday: 0=Mon..6=Sun
  const weekday = (nowDate.getDay() + 6) % 7;
  if (!weekdays.includes(weekday)) return false;

  const [sh, sm] = String(schedule.start || "00:00").split(":").map(Number);
  const [eh, em] = String(schedule.end || "23:59").split(":").map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return true;

  const cur = nowDate.getHours() * 60 + nowDate.getMinutes();
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e);
}

function shouldMonitorRunNow(cfg, nowMs = Date.now()) {
  const sched = cfg?.schedule || {};
  if (!sched.enabled) return { allowed: true, reason: "" };

  if (sched.mode === "duration") {
    const startedAt = Number(cfg.monitorStartedAt || 0);
    const maxMs = Number(sched.durationHours || 8) * 3600 * 1000;
    if (startedAt > 0 && nowMs - startedAt >= maxMs) {
      return { allowed: false, expired: true, reason: `已运行 ${sched.durationHours} 小时，到达定时停止时长` };
    }
    return { allowed: true, reason: "" };
  }

  const inWin = isInScheduleWindow(sched, new Date(nowMs));
  if (!inWin) {
    return { allowed: false, expired: false, reason: `当前不在运行窗口 (${sched.start}–${sched.end})` };
  }
  return { allowed: true, reason: "" };
}

function computeJitteredMonitorDelayMs(intervalSec = 150) {
  const base = Math.max(60, Number(intervalSec) || 150);
  const jitterRatio = (Math.random() * 0.3) - 0.15; // ±15% 防风控随机抖动
  return Math.max(30000, Math.round(base * (1 + jitterRatio) * 1000));
}

function shouldMonitorAlarmBeArmed(cfg) {
  return Boolean(cfg?.monitorUid) && (
    Boolean(cfg.autoMonitorEnabled) ||
    Boolean(cfg.schedule?.enabled && cfg.schedule?.mode === "window")
  );
}

async function getChromeAlarm(name) {
  if (!chrome?.alarms?.get) return null;
  return new Promise((resolve) => {
    try {
      const maybePromise = chrome.alarms.get(name, (alarm) => resolve(alarm || null));
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then((alarm) => resolve(alarm || null)).catch(() => resolve(null));
      }
    } catch {
      resolve(null);
    }
  });
}

function getAlarmScheduledTime(alarm) {
  const t = Number(alarm?.scheduledTime ?? alarm?.when ?? 0);
  return Number.isFinite(t) ? t : 0;
}

async function getTopicMonitorStatus() {
  const { topicMonitorStatus = null } = await chrome.storage.local.get(["topicMonitorStatus"]);
  const alarm = await getChromeAlarm(TOPIC_PIN_ALARM_MONITOR);
  const nextRunAt = alarm ? getAlarmScheduledTime(alarm) : Number(topicMonitorStatus?.nextRunAt || 0) || null;
  return {
    ...(topicMonitorStatus && typeof topicMonitorStatus === "object" ? topicMonitorStatus : {}),
    alarmActive: Boolean(alarm),
    nextRunAt,
  };
}

async function saveTopicMonitorStatus(patch = {}) {
  const { topicMonitorStatus = {} } = await chrome.storage.local.get(["topicMonitorStatus"]);
  const next = {
    ...(topicMonitorStatus && typeof topicMonitorStatus === "object" ? topicMonitorStatus : {}),
    ...patch,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ topicMonitorStatus: next });
  chrome.runtime.sendMessage({ action: "TOPIC_PIN_UPDATED" }).catch(() => {});
  return next;
}

async function syncTopicMonitorAlarm(cfg, explicitDelayMs = null) {
  if (!chrome.alarms) return;
  if (shouldMonitorAlarmBeArmed(cfg)) {
    const delayMs = Number.isFinite(explicitDelayMs) && explicitDelayMs > 0
      ? Math.max(15000, Math.round(explicitDelayMs))
      : computeJitteredMonitorDelayMs(cfg.monitorIntervalSec);
    const when = Date.now() + delayMs;
    await chrome.alarms.create(TOPIC_PIN_ALARM_MONITOR, { when });
    await saveTopicMonitorStatus({ nextRunAt: when }).catch(() => {});
  } else {
    await chrome.alarms.clear(TOPIC_PIN_ALARM_MONITOR);
    await saveTopicMonitorStatus({ nextRunAt: null }).catch(() => {});
  }
}

async function ensureTopicPinAlarms({ recoverRunningTasks = false } = {}) {
  const cfg = await getTopicPinConfig();
  const now = Date.now();

  if (chrome.alarms) {
    const existingMonitor = await getChromeAlarm(TOPIC_PIN_ALARM_MONITOR);
    if (shouldMonitorAlarmBeArmed(cfg)) {
      const schedTime = getAlarmScheduledTime(existingMonitor);
      const missingOrStale = !existingMonitor || (schedTime > 0 && schedTime < now - 120000);
      if (missingOrStale) {
        const status = await getTopicMonitorStatus();
        const lastRunAt = Number(status?.lastRunAt || 0);
        const intervalMs = Math.max(60, Number(cfg.monitorIntervalSec) || 150) * 1000;
        const gate = shouldMonitorRunNow(cfg, now);
        if (gate.allowed && (!lastRunAt || now - lastRunAt >= intervalMs)) {
          await syncTopicMonitorAlarm(cfg);
          checkWeiboMonitorOnce().catch((err) => topicPinLog(`恢复巡检异常: ${err?.message || err}`, "warn"));
        } else {
          const remainingMs = lastRunAt ? Math.max(15000, intervalMs - (now - lastRunAt)) : null;
          await syncTopicMonitorAlarm(cfg, remainingMs);
        }
      }
    } else if (existingMonitor) {
      await chrome.alarms.clear(TOPIC_PIN_ALARM_MONITOR);
      await saveTopicMonitorStatus({ nextRunAt: null }).catch(() => {});
    }
  }

  if (recoverRunningTasks && !topicPinRunningPromise) {
    let recovered = false;
    await withTopicPinMutation(async () => {
      const tasks = await getTopicPinTasks();
      if (tasks.some((t) => t && t.status === "running")) {
        const next = tasks.map((t) =>
          t && t.status === "running"
            ? { ...t, status: "pending", note: "扩展重启，恢复待处理", updatedAt: Date.now() }
            : t
        );
        await saveTopicPinTasks(next);
        recovered = true;
      }
    });
    if (recovered) {
      topicPinLog("检测到扩展重启，已恢复中断的话题置顶任务", "info");
    }
  }

  if (!topicPinRunningPromise) {
    const tasks = await getTopicPinTasks();
    const hasRunnable = tasks.some((t) =>
      t && (t.status === "pending" || (t.status === "waiting_review" && (!t.nextCheckAt || t.nextCheckAt <= now + 2000)))
    );
    if (hasRunnable) {
      processTopicPinQueue().catch((err) => topicPinLog(`恢复置顶队列异常: ${err?.message || err}`, "warn"));
      return;
    }
    const nextWait = tasks
      .filter((t) => t && t.status === "waiting_review" && t.nextCheckAt)
      .map((t) => t.nextCheckAt)
      .sort((a, b) => a - b)[0];
    if (nextWait && chrome.alarms) {
      const existingPin = await getChromeAlarm(TOPIC_PIN_ALARM_TICK);
      const pinSchedTime = getAlarmScheduledTime(existingPin);
      if (!existingPin || (pinSchedTime > 0 && pinSchedTime < now - 60000)) {
        await chrome.alarms.create(TOPIC_PIN_ALARM_TICK, { when: Math.max(now + 5000, nextWait) });
      }
    }
  }
}

async function getTopicPinTasks() {
  const { topicPinTasks = [] } = await chrome.storage.local.get(["topicPinTasks"]);
  return Array.isArray(topicPinTasks) ? topicPinTasks : [];
}

async function saveTopicPinTasks(tasks) {
  const trimmed = tasks.slice(0, 100);
  await chrome.storage.local.set({ topicPinTasks: trimmed });
  chrome.runtime.sendMessage({ action: "TOPIC_PIN_UPDATED" }).catch(() => {});
  return trimmed;
}

async function appendTopicTaskLog(taskId, message) {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  await withTopicPinMutation(async () => {
    const tasks = await getTopicPinTasks();
    const next = tasks.map((t) => {
      if (t.id !== taskId) return t;
      const logs = [...(t.logs || []), `[${ts}] ${message}`].slice(-40);
      return { ...t, logs, updatedAt: Date.now() };
    });
    await saveTopicPinTasks(next);
  });
}

async function updateTopicPinTask(taskId, patch) {
  await withTopicPinMutation(async () => {
    const tasks = await getTopicPinTasks();
    const next = tasks.map((t) => (t.id === taskId ? { ...t, ...patch, updatedAt: Date.now() } : t));
    await saveTopicPinTasks(next);
  });
}

async function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId, timeoutMs = 20000, expectNav = false) {
  if (typeof waitForTabLoaded === "function") {
    return waitForTabLoaded(tabId, timeoutMs, expectNav);
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && tab.url && !tab.url.startsWith("about:blank")) {
      return tab;
    }
    await sleepMs(350);
  }
  return chrome.tabs.get(tabId);
}

async function ensureTopicPinWorkerTab(initialUrl = "https://weibo.com/") {
  if (topicPinWorkerTabId) {
    try {
      const existing = await chrome.tabs.get(topicPinWorkerTabId);
      if (existing && existing.id) return existing;
    } catch {
      topicPinWorkerTabId = null;
      topicPinWorkerWindowId = null;
    }
  }

  // 严格静默：只在现有普通浏览器窗口内创建 active:false 后台标签页，绝不弹出新窗口抢焦点闪屏
  if (chrome.windows?.getAll) {
    try {
      const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
      const targetWin = wins.find((w) => w.focused) || wins[0];
      if (targetWin?.id) {
        const tab = await chrome.tabs.create({ url: initialUrl, windowId: targetWin.id, active: false });
        topicPinWorkerTabId = tab.id;
        topicPinWorkerWindowId = null;
        await waitForTabComplete(tab.id, 20000);
        return chrome.tabs.get(tab.id);
      }
      if (chrome.windows?.create) {
        const win = await chrome.windows.create({ url: initialUrl, state: "minimized" });
        const tab = win?.tabs?.[0] || (await chrome.tabs.query({ windowId: win.id }))[0];
        if (tab?.id) {
          topicPinWorkerWindowId = win.id;
          topicPinWorkerTabId = tab.id;
          await waitForTabComplete(tab.id, 20000);
          return chrome.tabs.get(tab.id);
        }
      }
    } catch (_) {
      // fallback to tabs.create below
    }
  }

  const tab = await chrome.tabs.create({ url: initialUrl, active: false });
  topicPinWorkerTabId = tab.id;
  topicPinWorkerWindowId = null;
  await waitForTabComplete(tab.id, 20000);
  return chrome.tabs.get(tab.id);
}

async function closeTopicPinWorkerWindow() {
  const winId = topicPinWorkerWindowId;
  const tabId = topicPinWorkerTabId;
  topicPinWorkerWindowId = null;
  topicPinWorkerTabId = null;
  if (winId && chrome.windows?.remove) {
    await chrome.windows.remove(winId).catch(() => {});
  } else if (tabId && chrome.tabs?.remove) {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

async function navigateTabAndWait(tabId, url, timeoutMs = 25000) {
  await chrome.tabs.update(tabId, { url });
  await sleepMs(400);
  return waitForTabComplete(tabId, timeoutMs, true);
}

async function dispatchTrustedClick(tabId, coords, useDebugger) {
  if (!useDebugger || !coords || !Number.isFinite(coords.x) || !Number.isFinite(coords.y)) {
    return false;
  }
  try {
    if (typeof sendCdpClick === "function") {
      await sendCdpClick(tabId, coords.x, coords.y);
      return true;
    }
    if (chrome?.debugger?.sendCommand) {
      const px = Math.round(coords.x);
      const py = Math.round(coords.y);
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: px,
        y: py,
        button: "left",
        clickCount: 1,
      });
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: px,
        y: py,
        button: "left",
        clickCount: 1,
      });
      return true;
    }
  } catch (_) {}
  return false;
}

async function runInMainWorld(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args,
  });
  return results && results[0] ? results[0].result : null;
}

async function fetchPostInfoInTab(tabId, postUrl) {
  const parsed = parseWeiboPostUrl(postUrl);
  await navigateTabAndWait(tabId, "https://weibo.com/", 20000);
  await sleepMs(500);

  if (parsed.mblogid || parsed.mid) {
    const idParam = parsed.mblogid || parsed.mid;
    const apiRes = await runInMainWorld(tabId, async (id) => {
      try {
        const xsrf = (document.cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("XSRF-TOKEN=")) || "").split("=")[1] || "";
        const headers = { Accept: "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" };
        if (xsrf) headers["X-XSRF-TOKEN"] = decodeURIComponent(xsrf);
        const r = await fetch(`https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(id)}`, {
          credentials: "include",
          headers,
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { ok: r.ok, status: r.status, url: location.href, json };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, [idParam]);

    if (apiRes?.url && /passport\.weibo\.com|newlogin|retcode=6102/i.test(apiRes.url)) {
      throw new Error("微博登录态失效，请先在当前浏览器登录 weibo.com");
    }

    const item = apiRes?.json;
    if (item && (item.id || item.idstr) && item.ok !== 0) {
      const textRaw = item.text_raw || item.text || "";
      const cleanText = String(textRaw).replace(/<[^>]+>/g, "");
      const uid = String(item.user?.id || item.user?.idstr || parsed.uid || "");
      const mblogid = String(item.mblogid || parsed.mblogid || "");
      const canonical = uid && mblogid ? `https://weibo.com/${uid}/${mblogid}` : parsed.canonicalUrl;
      return {
        id: String(item.id || item.idstr),
        mblogid,
        url: canonical,
        text: cleanText,
        hashtags: extractHashtagsFromText(cleanText),
        isVote: isVotePostPayload(item, textRaw),
      };
    }
  }

  // Fallback: navigate directly to post URL and extract from DOM (exclude sidebar/nav pollution)
  await navigateTabAndWait(tabId, parsed.canonicalUrl, 25000);
  await sleepMs(1200);
  const domRes = await runInMainWorld(tabId, () => {
    const cur = location.href;
    if (/passport\.weibo\.com|newlogin|retcode=6102/i.test(cur)) {
      return { loginRequired: true };
    }
    const normalize = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const navMarkers = ["无障碍", "首页", "全部关注", "最新微博", "特别关注", "好友圈", "自定义分组", "热搜"];
    const directSelectors = ["[class*='detail_wbtext']", "[class*='wbtext']", ".weibo-text"];
    let text = "";
    for (const sel of directSelectors) {
      const el = document.querySelector(sel);
      if (el && !el.closest("nav, aside, [class*='side'], [class*='Side'], [class*='Hot']") && normalize(el.innerText)) {
        text = normalize(el.innerText);
        break;
      }
    }
    if (!text) {
      const candidates = Array.from(document.querySelectorAll("article, [mid], [data-mid], [class*='_detail_']"))
        .filter((el) => !el.closest("nav, aside, [class*='side'], [class*='Side']"))
        .map((el) => normalize(el.innerText))
        .filter((t) => t.includes("#") && t.length > 15);
      candidates.sort((a, b) => {
        const navScore = (t) => navMarkers.filter((m) => t.includes(m)).length;
        return navScore(a) - navScore(b) || a.length - b.length;
      });
      text = candidates[0] || "";
    }
    if (text) {
      const firstHash = text.indexOf("#");
      if (firstHash > 0) {
        const prefix = text.slice(0, firstHash);
        if (navMarkers.filter((m) => prefix.includes(m)).length >= 2) {
          text = text.slice(firstHash);
        }
      }
    }
    const hasVoteDom = Boolean(
      document.querySelector("a[href*='vote.weibo.com'], [class*='vote'], [class*='Vote']")
    );
    return { loginRequired: false, url: cur, text, hasVoteDom };
  });

  if (domRes?.loginRequired) {
    throw new Error("微博登录态失效，请先在当前浏览器登录 weibo.com");
  }

  const text = String(domRes?.text || "");
  return {
    id: parsed.mid || parsed.mblogid,
    mblogid: parsed.mblogid,
    url: parsed.canonicalUrl,
    text,
    hashtags: extractHashtagsFromText(text),
    isVote: Boolean(domRes?.hasVoteDom) || isVotePostPayload(null, text),
  };
}

async function inspectTopicInTab(tabId, hashtag, hostAccountName = "新浪热点") {
  const searchUrl = `https://s.weibo.com/weibo?q=%23${encodeURIComponent(hashtag)}%23`;
  await navigateTabAndWait(tabId, searchUrl, 25000);
  await sleepMs(700);

  return runInMainWorld(tabId, (hostName) => {
    const cur = location.href;
    if (/passport\.weibo\.com|newlogin|retcode=6102/i.test(cur)) {
      return { loginRequired: true };
    }

    let manageHref = null;
    const directManage = document.querySelector('a[href*="claim/manage"]');
    if (directManage) {
      const h = directManage.getAttribute("href") || "";
      if (h && !h.includes("javascript")) manageHref = h;
    }

    if (!manageHref) {
      const btns = Array.from(document.querySelectorAll("a, button, span"));
      const manageBtn = btns.find((el) => (el.innerText || "").includes("话题管理"));
      if (manageBtn) {
        const onclick = manageBtn.getAttribute("onclick") || "";
        const m = onclick.match(/window\.open\(\s*['"]([^'"]+)['"]/);
        if (m && m[1].includes("claim/manage")) {
          manageHref = m[1].replace(/&amp;/g, "&");
        }
        // 仅在页面确实存在「话题管理」按钮时，才全局扫描脚本/属性提取 claim/manage
        if (!manageHref) {
          const seen = new Set();
          const urls = [];
          const scan = (val) => {
            if (!val) return;
            const normalized = String(val).replace(/\\\//g, "/");
            const m2 = normalized.match(/(?:https?:)?\/\/[^'"\s<>]*claim\/manage[^'"\s<>]*/);
            if (m2) {
              const u = m2[0].startsWith("//") ? `https:${m2[0]}` : m2[0];
              if (!seen.has(u)) {
                seen.add(u);
                urls.push(u);
              }
            }
          };
          for (const el of document.querySelectorAll("*")) {
            for (const attr of el.attributes) scan(attr.value);
          }
          for (const s of document.querySelectorAll("script")) {
            scan(s.textContent || "");
          }
          if (urls.length > 0) manageHref = urls[0].replace(/&amp;/g, "&");
        }
      }
    }

    if (manageHref) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let alreadyPinned = false;
      let node;
      while ((node = walker.nextNode())) {
        if ((node.textContent || "").trim() !== "置顶") continue;
        const el = node.parentElement;
        if (!el) continue;
        if (el.tagName === "A" || el.tagName === "BUTTON") continue;
        if (el.closest('[class*="side"], [class*="widget"], [class*="manage"]')) continue;
        alreadyPinned = true;
        break;
      }
      return {
        loginRequired: false,
        manageHref,
        canApply: false,
        hasOtherHost: false,
        alreadyPinned,
        hostStatus: "self",
      };
    }

    const applyEl = Array.from(document.querySelectorAll("a, span, button"))
      .find((el) => (el.innerText || "").includes("申请主持人"));

    const bodyText = document.body.innerText || "";
    const idx = bodyText.indexOf("话题主持人");
    let hostStatus = "none";
    if (idx !== -1) {
      const snippet = bodyText.slice(idx, idx + 160);
      if (snippet.includes(hostName)) {
        hostStatus = "self";
      } else if (/暂无|虚位以待|申请主持人|立即申请/.test(snippet) && applyEl) {
        hostStatus = "none";
      } else {
        hostStatus = "other";
      }
    }
    if (hostStatus === "other") {
      return {
        loginRequired: false,
        manageHref: null,
        canApply: false,
        hasOtherHost: true,
        alreadyPinned: false,
        hostStatus,
      };
    }

    return {
      loginRequired: false,
      manageHref: null,
      canApply: Boolean(applyEl),
      hasOtherHost: false,
      alreadyPinned: false,
      hostStatus,
    };
  }, [hostAccountName]);
}

function uint8ToBase64(bytes) {
  if (!bytes || !bytes.length) return "";
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

let cachedBundledAvatarDataUrl = "";
async function getEffectiveHostAvatarDataUrl(cfg) {
  const custom = String(cfg?.hostApply?.imageDataUrl || "").trim();
  if (custom.startsWith("data:")) return custom;
  if (cachedBundledAvatarDataUrl) return cachedBundledAvatarDataUrl;
  try {
    if (typeof chrome?.runtime?.getURL === "function" && typeof fetch === "function") {
      const url = chrome.runtime.getURL("icons/host_avatar.png");
      const resp = await fetch(url);
      if (resp && resp.ok) {
        const buf = await resp.arrayBuffer();
        cachedBundledAvatarDataUrl = `data:image/png;base64,${uint8ToBase64(new Uint8Array(buf))}`;
        return cachedBundledAvatarDataUrl;
      }
    }
  } catch (_) {}
  return "";
}

function isWeiboVisitorText(url = "", body = "") {
  return /passport\.weibo\.com\/visitor/i.test(String(url || "")) || /Sina Visitor System/i.test(String(body || ""));
}

function isWeiboLoginRequiredUrl(url = "") {
  const u = String(url || "");
  if (isWeiboVisitorText(u, "")) return false;
  return /passport\.weibo\.(?:com|cn)|newlogin|login\.sina\.com|retcode=6102/i.test(u);
}

async function getWeiboXsrfToken(url) {
  try {
    if (!chrome?.cookies?.get) return "";
    const cookie = await chrome.cookies.get({ url, name: "XSRF-TOKEN" });
    if (cookie?.value) return decodeURIComponent(cookie.value);
  } catch (_) {}
  return "";
}

async function weiboFetch(url, { method = "GET", formParams = null, accept = "application/json, text/plain, */*", xRequestedWith = true } = {}) {
  if (typeof fetch !== "function") {
    return { httpOk: false, status: 0, url, text: "", json: null, needTabFallback: true, error: "fetch unavailable" };
  }
  const headers = { Accept: accept };
  if (xRequestedWith) headers["X-Requested-With"] = "XMLHttpRequest";
  const xsrf = await getWeiboXsrfToken(url);
  if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;

  const init = { method, credentials: "include", headers };
  if (formParams !== null && formParams !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    init.body = typeof formParams === "string" ? formParams : new URLSearchParams(formParams).toString();
  }

  try {
    const resp = await fetch(url, init);
    const finalUrl = String(resp.url || url);
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const visitor = isWeiboVisitorText(finalUrl, text);
    const msgExpired = /登陆信息过期|登录信息过期|请先登录/.test(String(json?.msg || ""));
    const loginRequired = isWeiboLoginRequiredUrl(finalUrl) || isWeiboLoginRequiredUrl(json?.url || "") || json?.ok === -100 || msgExpired;
    return {
      httpOk: Boolean(resp.ok),
      status: Number(resp.status || 0),
      url: finalUrl,
      text,
      json,
      loginRequired,
      visitorChallenge: visitor,
      needTabFallback: visitor,
    };
  } catch (err) {
    return {
      httpOk: false,
      status: 0,
      url,
      text: "",
      json: null,
      loginRequired: false,
      visitorChallenge: false,
      networkError: true,
      needTabFallback: false,
      error: err?.message || String(err),
    };
  }
}

function normalizeWeiboPostItem(item, fallbackUid = "") {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || item.idstr || "").trim();
  if (!id) return null;
  const mblogid = String(item.mblogid || "").trim();
  const uid = String(item.user?.id || item.user?.idstr || fallbackUid || "").trim();
  const textRaw = item.text_raw || item.text || "";
  const cleanText = String(textRaw).replace(/<[^>]+>/g, "");
  return {
    post: {
      id,
      mblogid,
      url: mblogid && uid ? `https://weibo.com/${uid}/${mblogid}` : `https://weibo.com/detail/${id}`,
      text: cleanText,
      hashtags: extractHashtagsFromText(cleanText),
      isVote: isVotePostPayload(item, textRaw),
    },
    postRaw: {
      is_vote: item.is_vote,
      vote: item.vote,
      vote_id: item.vote_id,
      title: item.title,
      page_info: item.page_info,
      url_struct: item.url_struct,
      text_raw: textRaw,
      text: item.text,
      raw_text: item.raw_text,
    },
  };
}

async function fetchPostInfoViaHttp(postUrl) {
  const parsed = parseWeiboPostUrl(postUrl);
  const idParam = parsed.mblogid || parsed.mid;
  if (!idParam) return { ok: false, needTabFallback: true };

  const res = await weiboFetch(`https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(idParam)}`);
  if (res.loginRequired) {
    throw new Error("微博登录态失效，请先在当前浏览器登录 weibo.com");
  }
  if (res.visitorChallenge || res.networkError) {
    return { ok: false, needTabFallback: true };
  }
  const item = res.json;
  if (item && (item.id || item.idstr) && item.ok !== 0) {
    const norm = normalizeWeiboPostItem(item, parsed.uid);
    if (norm?.post) {
      const uid = String(item.user?.id || item.user?.idstr || parsed.uid || "");
      const mblogid = String(item.mblogid || parsed.mblogid || "");
      const canonical = uid && mblogid ? `https://weibo.com/${uid}/${mblogid}` : parsed.canonicalUrl;
      return {
        ...norm.post,
        url: canonical,
        ok: true,
      };
    }
  }
  return { ok: false, needTabFallback: true };
}

async function fetchLatestWeiboPostViaHttp(uid) {
  const cleanUid = String(uid || "").trim();
  if (!cleanUid) return { ok: false, error: "未配置监控 UID" };

  const myRes = await weiboFetch(`https://weibo.com/ajax/statuses/mymblog?uid=${encodeURIComponent(cleanUid)}&page=1&feature=0`);
  if (myRes.loginRequired) {
    return { ok: false, loginRequired: true, error: "微博登录态失效，请先在当前浏览器登录 weibo.com" };
  }
  if (myRes.visitorChallenge) {
    return { ok: false, needTabFallback: true, error: "触发微博访客校验" };
  }
  const myList = Array.isArray(myRes.json?.data?.list) ? myRes.json.data.list : [];
  const myFirst = myList.find((it) => !it.isTop && (it.id || it.idstr)) || myList.find((it) => it.id || it.idstr);
  if (myFirst) {
    const norm = normalizeWeiboPostItem(myFirst, cleanUid);
    if (norm) return { ok: true, source: "mymblog", ...norm };
  }

  const feedRes = await weiboFetch(`https://weibo.com/ajax/feed/friendstimeline?list_id=10001${encodeURIComponent(cleanUid)}&refresh=4&since_id=0&count=15`);
  if (feedRes.loginRequired) {
    return { ok: false, loginRequired: true, error: "微博登录态失效，请先在当前浏览器登录 weibo.com" };
  }
  if (feedRes.visitorChallenge) {
    return { ok: false, needTabFallback: true, error: "触发微博访客校验" };
  }
  const feedList = feedRes.json?.statuses || feedRes.json?.data?.statuses || feedRes.json?.data?.list || [];
  const feedMatch = (Array.isArray(feedList) ? feedList : []).find((it) => {
    const owner = String(it?.user?.id || it?.user?.idstr || "");
    return (!owner || owner === cleanUid) && !it.isTop && (it.id || it.idstr);
  });
  if (feedMatch) {
    const norm = normalizeWeiboPostItem(feedMatch, cleanUid);
    if (norm) return { ok: true, source: "timeline", ...norm };
  }

  if (myRes.networkError || feedRes.networkError) {
    return { ok: false, needTabFallback: false, error: myRes.error || feedRes.error || "网络请求失败" };
  }
  if ((myRes.status && myRes.status !== 200) || !myRes.json) {
    if (!myRes.json && myRes.status === 200) {
      return { ok: false, needTabFallback: true, error: "主页接口返回非JSON" };
    }
    return { ok: false, needTabFallback: false, error: `HTTP ${myRes.status || feedRes.status || 0}` };
  }
  return { ok: false, needTabFallback: true, error: "未获取到最新微博" };
}

function normalizeSWeiboHref(raw) {
  if (!raw) return "";
  let u = String(raw).replace(/\\\//g, "/").replace(/&amp;/gi, "&").trim();
  if (!u || /^javascript:/i.test(u) || u.startsWith("#")) return "";
  if (u.startsWith("//")) u = `https:${u}`;
  try {
    return new URL(u, "https://s.weibo.com").href;
  } catch {
    return "";
  }
}

function parseTopicSearchHtml(html, hashtag, hostAccountName = "新浪热点") {
  const raw = String(html || "");
  if (isWeiboVisitorText("", raw)) {
    return { needTabFallback: true, reason: "visitor_challenge" };
  }
  if (raw.length < 80 || /<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(raw)) {
    return { needTabFallback: true, reason: "html_unrendered" };
  }

  const noScriptHtml = raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const bodyText = noScriptHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

  if (/请先登录|立即登录/.test(bodyText) && !bodyText.includes(hashtag) && !bodyText.includes("话题")) {
    return { loginRequired: true };
  }

  const normalizedRaw = raw.replace(/\\\//g, "/");
  const extractClaimHref = (kindPattern, allowFullScan) => {
    const aRe = new RegExp(`<a\\b[^>]*href\\s*=\\s*(['"])([^'"]*claim\\/(?:${kindPattern})[^'"]*)\\1`, "i");
    const aMatch = noScriptHtml.match(aRe);
    if (aMatch?.[2]) {
      const normalized = normalizeSWeiboHref(aMatch[2]);
      if (normalized) return normalized;
    }
    if (!allowFullScan) return "";
    const openRe = new RegExp(`window\\.open\\(\\s*['"]([^'"]*claim\\/(?:${kindPattern})[^'"]*)['"]`, "i");
    const openMatch = normalizedRaw.match(openRe);
    if (openMatch?.[1]) {
      const normalized = normalizeSWeiboHref(openMatch[1]);
      if (normalized) return normalized;
    }
    const urlRe = new RegExp(`((?:https?:)?\\/\\/[^'"\\s<>]*claim\\/(?:${kindPattern})[^'"\\s<>]*|\\/claim\\/(?:${kindPattern})[^'"\\s<>]*)`, "i");
    const urlMatch = normalizedRaw.match(urlRe);
    return urlMatch?.[1] ? normalizeSWeiboHref(urlMatch[1]) : "";
  };

  const hasManageText = bodyText.includes("话题管理");
  const manageHref = extractClaimHref("manage", hasManageText);
  if (manageHref) {
    const cleanedForPin = noScriptHtml
      .replace(/<a\b[\s\S]*?<\/a>/gi, " ")
      .replace(/<button\b[\s\S]*?<\/button>/gi, " ");
    let alreadyPinned = false;
    const pinTagRe = /<([a-z0-9-]+)\b([^>]*)>\s*置顶\s*<\/\1>/gi;
    let pm;
    while ((pm = pinTagRe.exec(cleanedForPin)) !== null) {
      if (!/side|widget|manage/i.test(pm[2] || "")) {
        alreadyPinned = true;
        break;
      }
    }
    return {
      loginRequired: false,
      manageHref,
      applyHref: null,
      canApply: false,
      hasOtherHost: false,
      alreadyPinned,
      hostStatus: "self",
    };
  }
  if (hasManageText) {
    return { needTabFallback: true, reason: "manage_url_not_found_in_html" };
  }

  const hasApplyText = bodyText.includes("申请主持人");
  const applyHref = extractClaimHref("apply|info", hasApplyText);
  const idx = bodyText.indexOf("话题主持人");
  let hostStatus = "none";
  if (idx !== -1) {
    const snippet = bodyText.slice(idx, idx + 160);
    if (snippet.includes(hostAccountName)) {
      hostStatus = "self";
    } else if (/暂无|虚位以待|申请主持人|立即申请/.test(snippet) && (hasApplyText || applyHref)) {
      hostStatus = "none";
    } else {
      hostStatus = "other";
    }
  }

  if (hostStatus === "other") {
    return {
      loginRequired: false,
      manageHref: null,
      applyHref: null,
      canApply: false,
      hasOtherHost: true,
      alreadyPinned: false,
      hostStatus: "other",
    };
  }
  if (hostStatus === "self") {
    return { needTabFallback: true, reason: "host_self_without_manage_href" };
  }

  if (hasApplyText || applyHref) {
    return {
      loginRequired: false,
      manageHref: null,
      applyHref: applyHref || null,
      canApply: true,
      hasOtherHost: false,
      alreadyPinned: false,
      hostStatus,
    };
  }

  if (!bodyText.includes(hashtag) && !/微博|搜索|话题/.test(bodyText)) {
    return { needTabFallback: true, reason: "unexpected_topic_html" };
  }

  return {
    loginRequired: false,
    manageHref: null,
    applyHref: null,
    canApply: false,
    hasOtherHost: false,
    alreadyPinned: false,
    hostStatus,
  };
}

async function inspectTopicViaHttp(hashtag, hostAccountName = "新浪热点") {
  const searchUrl = `https://s.weibo.com/weibo?q=%23${encodeURIComponent(hashtag)}%23`;
  const res = await weiboFetch(searchUrl, {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    xRequestedWith: false,
  });
  if (res.loginRequired) return { loginRequired: true };
  if (res.needTabFallback || !res.httpOk) {
    return { needTabFallback: true, reason: res.error || `HTTP ${res.status}` };
  }
  return parseTopicSearchHtml(res.text, hashtag, hostAccountName);
}

async function encodeAvatarToWeiboJpegBase64(imageDataUrl) {
  const raw = String(imageDataUrl || "").trim();
  if (!raw.startsWith("data:")) return null;

  if (typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function") {
    try {
      let blob = null;
      const b64Match = raw.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
      if (b64Match && typeof Blob === "function") {
        const bin = atob(b64Match[2].replace(/\s+/g, ""));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes], { type: b64Match[1] });
      } else if (typeof fetch === "function") {
        const resp = await fetch(raw);
        blob = await resp.blob();
      }
      if (blob) {
        const bitmap = await createImageBitmap(blob);
        try {
          const w = Number(bitmap.width || 0);
          const h = Number(bitmap.height || 0);
          if (w > 0 && h > 0) {
            const side = Math.min(w, h);
            const sx = Math.floor((w - side) / 2);
            const sy = Math.floor((h - side) / 2);
            const target = Math.max(200, Math.min(500, side));
            const canvas = new OffscreenCanvas(target, target);
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, target, target);
              for (const quality of [0.9, 0.72]) {
                const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality });
                if (outBlob.size <= 1.45 * 1024 * 1024 || quality === 0.72) {
                  const bytes = new Uint8Array(await outBlob.arrayBuffer());
                  return uint8ToBase64(bytes);
                }
              }
            }
          }
        } finally {
          try { bitmap.close?.(); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  const jpegMatch = raw.match(/^data:image\/jpe?g;base64,([A-Za-z0-9+/=]+)$/i);
  return jpegMatch ? jpegMatch[1] : null;
}

function matchWeiboCategoryAndRegion(categoryData, locationData, { category = "社会", region = "全国" } = {}) {
  const toList = (raw) => (Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []));
  const cats = toList(categoryData);
  const locs = toList(locationData);
  const wantedCat = String(category || "").trim();
  const wantedReg = String(region || "").trim();

  let cat0 = null;
  let cat1 = null;
  if (wantedCat) {
    for (const pred of [(n) => n === wantedCat, (n) => n.includes(wantedCat)]) {
      cat0 = cats.find((c) => pred(String(c?.name || "").trim())) || null;
      if (cat0) break;
      for (const p of cats) {
        const children = toList(p?.children);
        const child = children.find((ch) => pred(String(ch?.name || "").trim()));
        if (child) {
          cat0 = p;
          cat1 = child;
          break;
        }
      }
      if (cat0) break;
    }
  }

  let loc0 = null;
  if (wantedReg) {
    loc0 = locs.find((l) => String(l?.name || "").trim() === wantedReg)
      || locs.find((l) => String(l?.name || "").trim().includes(wantedReg))
      || null;
  }

  if (!cat0 || !loc0) return null;
  const catStr = cat1 ? `${cat0.name}|${cat0.id}-${cat1.name}|${cat1.id}` : `${cat0.name}|${cat0.id}`;
  return {
    categoryStr: catStr,
    categoryId: String(cat1 ? cat1.id : cat0.id),
    locationStr: String(loc0.id),
  };
}

async function applyForHostViaHttp(hashtag, cfg, _fastMode = false, preInspected = null) {
  const hostName = cfg?.hostAccountName || "新浪热点";
  const inspected = preInspected && (preInspected.applyHref || preInspected.manageHref || preInspected.hasOtherHost)
    ? preInspected
    : await inspectTopicViaHttp(hashtag, hostName);

  if (inspected?.loginRequired) return { status: "login_required" };
  if (inspected?.needTabFallback) return { status: "fallback_needed", reason: inspected.reason };
  if (inspected?.manageHref) return { status: "already_host", inspected };
  if (inspected?.hasOtherHost) return { status: "other_host" };
  if (!inspected?.canApply) return { status: "failed", reason: "未找到申请主持人入口" };
  if (!inspected?.applyHref) return { status: "fallback_needed", reason: "未直接提取到申请入口 URL" };

  let parsedUrl;
  try {
    parsedUrl = new URL(inspected.applyHref, "https://m.s.weibo.com");
  } catch {
    return { status: "fallback_needed", reason: "申请入口 URL 解析失败" };
  }
  const objectId = parsedUrl.searchParams.get("object_id") || "";
  const query = parsedUrl.searchParams.get("query") || `#${hashtag}#`;
  const uid = parsedUrl.searchParams.get("uid") || "";
  const checkOption = parsedUrl.searchParams.get("check_option") || "";
  if (!objectId) return { status: "fallback_needed", reason: "申请链接缺少 object_id" };

  if (!parsedUrl.pathname.includes("/claim/info")) {
    const preUrl = `https://m.s.weibo.com/ajax_pclaim/applypre?object_id=${encodeURIComponent(objectId)}&query=${encodeURIComponent(query)}`;
    const preRes = await weiboFetch(preUrl);
    if (preRes.loginRequired) return { status: "login_required" };
    if (preRes.needTabFallback || !preRes.json) {
      return { status: "fallback_needed", reason: preRes.error || "applypre 返回非 JSON" };
    }
    const payload = preRes.json?.data?.data && typeof preRes.json.data.data === "object"
      ? preRes.json.data.data
      : preRes.json?.data;
    if (!payload || typeof payload !== "object") {
      if (preRes.json?.msg) {
        const outcome = classifyClaimSubmitOutcome({ url: preUrl, network: [{ url: preUrl, json: preRes.json }] });
        if (outcome.done) return { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) };
      }
      return { status: "fallback_needed", reason: "applypre 数据结构异常" };
    }
    if (!payload.check_status) {
      const infoTxt = String(payload.info || "").trim();
      if (/竞争主持人|竞争申请|已有主持人/.test(infoTxt)) return { status: "other_host" };
      if (/审核中|已在审核|申请审核中|正在审核|请勿重复|已提交|申请已提交/.test(infoTxt)) return { status: "in_review" };
      return infoTxt ? { status: "failed", reason: infoTxt } : { status: "fallback_needed", reason: "applypre 未返回条件详情" };
    }
    if (Number(payload.retData?.has_claim || 0) > 0) {
      return { status: "other_host" };
    }
    const checkList = Array.isArray(payload.retData?.check_list) ? payload.retData.check_list : [];
    const condMap = { 1: "近24小时带话题发博", 2: "贡献度达到25", 3: "完成实名认证", 4: "近一个月无违规" };
    const unmet = checkList.filter((item) => Number(item?.status) !== 1).map((item) => condMap[item?.module] || `条件${item?.module}`);
    if (unmet.length > 0) {
      return { status: "failed", reason: `不满足申请条件（${unmet.join("、")}）` };
    }
  }

  const ha = cfg?.hostApply || {};
  const [catRes, locRes] = await Promise.all([
    weiboFetch(`https://m.s.weibo.com/ajax_claim/category?object_id=${encodeURIComponent(objectId)}&query=${encodeURIComponent(query)}`),
    weiboFetch(`https://m.s.weibo.com/ajax_claim/location?object_id=${encodeURIComponent(objectId)}&key=province`),
  ]);
  if (catRes.loginRequired || locRes.loginRequired) return { status: "login_required" };
  if (catRes.needTabFallback || locRes.needTabFallback || !catRes.json?.data || !locRes.json?.data) {
    return { status: "fallback_needed", reason: "后台获取分类/地区列表失败" };
  }

  const matchedFields = matchWeiboCategoryAndRegion(catRes.json.data, locRes.json.data, {
    category: ha.category || "社会",
    region: ha.region || "全国",
  });
  if (!matchedFields) {
    return { status: "fallback_needed", reason: "分类或地区未在后台字典中精确匹配，回退页面选择" };
  }

  const effectiveAvatarDataUrl = await getEffectiveHostAvatarDataUrl(cfg);
  const avatarJpegB64 = await encodeAvatarToWeiboJpegBase64(effectiveAvatarDataUrl);
  if (!avatarJpegB64) {
    return { status: "fallback_needed", reason: "后台头像转码不可用，回退页面上传" };
  }

  const upRes = await weiboFetch("https://m.s.weibo.com/ajax_claim/uploadpic", {
    method: "POST",
    formParams: { pic_data: avatarJpegB64 },
  });
  if (upRes.loginRequired) return { status: "login_required" };
  if (upRes.needTabFallback || !upRes.json) {
    return { status: "fallback_needed", reason: "后台头像上传返回非 JSON" };
  }
  const uploadedAvatarUrl = String(upRes.json?.data?.original_pic || "").replace(/^http:/i, "https:");
  if (!uploadedAvatarUrl) {
    return upRes.json?.msg
      ? { status: "failed", reason: `头像上传失败: ${upRes.json.msg}` }
      : { status: "fallback_needed", reason: "头像上传未返回地址" };
  }

  const infoFormData = {
    object_id: objectId,
    query,
    display_name: hashtag,
    image_url: uploadedAvatarUrl,
    summary: "",
    topic_tag: "",
    category: matchedFields.categoryStr,
    label: "无置顶",
    weibo_url: "",
    location: matchedFields.locationStr,
  };
  const submitRes = await weiboFetch("https://m.s.weibo.com/ajax_claim/apply", {
    method: "POST",
    formParams: {
      object_id: objectId,
      query,
      data: JSON.stringify(infoFormData),
      uid: String(uid || ""),
      check_option: checkOption === "" ? "0" : "1",
      avatar_url: uploadedAvatarUrl,
      category: matchedFields.categoryId,
      pattern_type: "1",
      apply_version: "1",
      label: "无置顶",
      weibo_url: "",
    },
  });
  if (submitRes.loginRequired) return { status: "login_required" };
  if (submitRes.needTabFallback || !submitRes.json) {
    return { status: "fallback_needed", reason: "提交申请接口返回非 JSON" };
  }

  topicPinLog(`已静默提交 #${hashtag}# 主持人申请（0标签页），正在核验接口结果...`);
  const outcome = classifyClaimSubmitOutcome({
    url: "https://m.s.weibo.com/claim/info",
    network: [{ url: "/ajax_claim/apply", json: submitRes.json }],
  });
  if (outcome.done) {
    return { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }
  return { status: "fallback_needed", reason: "提交响应未明确，回退页面模式确认" };
}

async function pinPostToTopicViaHttp(postUrl, objectId, query = "") {
  const searchRes = await weiboFetch("https://m.s.weibo.com/ajax_claim/weiboSearch", {
    method: "POST",
    formParams: { urls: String(postUrl || "").trim() },
  });
  if (searchRes.loginRequired) return { ok: false, loginRequired: true, error: "微博登录态失效，请先在当前浏览器登录 weibo.com" };
  if (searchRes.needTabFallback || !searchRes.json) return { ok: false, needTabFallback: true };

  const mid = String(searchRes.json?.data?.mid || "").trim();
  if (!mid || String(searchRes.json?.code ?? "") !== "100000") {
    return { ok: false, error: searchRes.json?.msg || "未解析到微博 mid（链接可能无效）" };
  }

  const cardUrl = `https://m.s.weibo.com/ajax_pclaim/card?object_id=${encodeURIComponent(objectId)}&query=${encodeURIComponent(query)}&a=add&type=top&data=${encodeURIComponent(mid)}`;
  const cardRes = await weiboFetch(cardUrl);
  if (cardRes.loginRequired) return { ok: false, loginRequired: true, error: "微博登录态失效，请先在当前浏览器登录 weibo.com" };
  if (cardRes.needTabFallback || !cardRes.json) return { ok: false, needTabFallback: true };

  const cardData = cardRes.json?.data || {};
  const beforeReplaceTip = Number(cardData?.top_info?.replace_tip || 0);
  const beforeMidtopNum = Number(cardData?.top_info?.midtop_num ?? -1);
  if (beforeReplaceTip === 1) {
    return { ok: true, alreadyPinned: true };
  }

  const topOperateShow = Number(cardData?.top_operate_show || 0);
  const submitCardTitle = async (ownerVal) => {
    const params = {
      object_id: objectId,
      query,
      a: "add",
      type: "top",
      data: mid,
      mid,
      label: "置顶",
      is_owner_mid: String(ownerVal),
      etime: String(Math.floor(Date.now() / 1000) + 90 * 24 * 3600),
      position: "1",
      is_vote_mid: "0",
      ride_hype_confirm: "0",
      ...(topOperateShow === 1 ? { allow_cover: "0" } : {}),
    };
    return weiboFetch("https://m.s.weibo.com/ajax_claim/cardtitle", { method: "POST", formParams: params });
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await sleepMs(10000 * (attempt - 1));
    let titleRes = await submitCardTitle(0);
    if (String(titleRes.json?.code ?? titleRes.text).includes("100002")) {
      titleRes = await submitCardTitle(1);
    }
    if (titleRes.loginRequired) return { ok: false, loginRequired: true, error: "微博登录态失效，请先在当前浏览器登录 weibo.com" };
    if (titleRes.needTabFallback || !titleRes.json) {
      return { ok: false, error: `置顶接口返回非 JSON: ${String(titleRes.text || titleRes.error || "").slice(0, 120)}` };
    }
    const code = String(titleRes.json.code ?? "");
    const msg = String(titleRes.json.msg ?? "");
    const accepted = code === "0" || code === "100000" || ["保存成功", "ok", "success"].includes(msg);
    if (!accepted) {
      return { ok: false, error: `置顶接口拒绝: code=${code} msg=${msg}` };
    }

    await sleepMs(1800);
    const verifyRes = await weiboFetch(cardUrl);
    if (verifyRes.json?.code === "100000") {
      const afterTop = verifyRes.json?.data?.top_info || {};
      const confirmed = Number(afterTop.replace_tip || 0) === 1
        || (beforeMidtopNum >= 0 && Number(afterTop.midtop_num || 0) > beforeMidtopNum)
        || JSON.stringify(afterTop).includes(mid);
      if (confirmed) {
        return { ok: true, alreadyPinned: false, attempt };
      }
    }
  }

  return { ok: false, error: "置顶提交后复核未见置顶记录，请人工核对" };
}

async function resolvePostInfoSmart(canonicalUrl) {
  if (typeof fetch === "function") {
    const httpPost = await fetchPostInfoViaHttp(canonicalUrl);
    if (httpPost && httpPost.ok && !httpPost.needTabFallback) return httpPost;
  }
  return withTopicPinBrowserLock(async () => {
    const workerTab = await ensureTopicPinWorkerTab();
    return fetchPostInfoInTab(workerTab.id, canonicalUrl);
  });
}

async function inspectTopicSmart(resolveTabId, hashtag, hostAccountName = "新浪热点") {
  if (typeof fetch === "function") {
    const httpRes = await inspectTopicViaHttp(hashtag, hostAccountName);
    if (httpRes && !httpRes.needTabFallback) return httpRes;
  }
  const tabId = await resolveTabId();
  return inspectTopicInTab(tabId, hashtag, hostAccountName);
}

async function applyForHostSmart(resolveTabId, hashtag, cfg, fastMode = false, preInspected = null) {
  if (typeof fetch === "function") {
    const httpRes = await applyForHostViaHttp(hashtag, cfg, fastMode, preInspected);
    if (httpRes && httpRes.status !== "fallback_needed") return httpRes;
  }
  const tabId = await resolveTabId();
  return applyForHostInTab(tabId, hashtag, cfg, fastMode);
}

async function pinPostToTopicSmart(resolveTabId, postUrl, objectId, query = "") {
  if (typeof fetch === "function") {
    const httpRes = await pinPostToTopicViaHttp(postUrl, objectId, query);
    if (httpRes && !httpRes.needTabFallback) return httpRes;
  }
  const tabId = await resolveTabId();
  return pinPostToTopicInTab(tabId, postUrl, objectId, query);
}

function classifyClaimSubmitOutcome(snapshot = {}) {
  const {
    tabGone = false,
    url = "",
    fullText = "",
    stillHasSubmit = true,
    closeCalled = false,
    network = [],
    toasts = [],
    alerts = [],
  } = snapshot || {};

  const REVIEW_RE = /审核中|已在审核|申请审核中|正在审核|请勿重复提交|请勿重复|申请已提交|已申请|已提交/;
  const OTHER_HOST_RE = /竞争主持人|竞争申请|已有主持人/;
  const SUCCESS_TEXT_RE = /申请成功|提交成功/;
  const ERROR_HINT_RE = /请上传|请选择|不能为空|失败|错误|不符合|格式|频繁|异常|白色|无效|未满足|不足/;

  for (const item of network) {
    if (/beacon|trace|report|stat\./i.test(String(item?.url || ""))) continue;
    const j = item?.json;
    if (!j || typeof j !== "object") continue;
    const code = j.code !== undefined && j.code !== null ? String(j.code) : "";
    const okVal = j.ok;
    const msg = String(j.msg || j.message || j.errmsg || "").trim();

    const isSuccessMsg = /(?:申请|提交|保存|操作)成功|^ok$|^success$/i.test(msg) && !/(?:未|不|没).*成功/.test(msg);
    if (code === "100000" || code === "0" || okVal === 1 || okVal === true || isSuccessMsg) {
      return { done: true, status: "applied", reason: "" };
    }
    if (OTHER_HOST_RE.test(msg)) {
      return { done: true, status: "other_host", reason: msg };
    }
    if (REVIEW_RE.test(msg)) {
      return { done: true, status: "in_review", reason: msg };
    }
    if ((code && code !== "100000" && code !== "0") || okVal === 0 || okVal === false || msg) {
      return { done: true, status: "failed", reason: `微博接口提示: ${msg || `code=${code}`}` };
    }
  }

  const dynamicMessages = [...(alerts || []), ...(toasts || [])]
    .map((m) => String(m || "").trim())
    .filter(Boolean);
  for (const msg of dynamicMessages) {
    if (OTHER_HOST_RE.test(msg)) return { done: true, status: "other_host", reason: msg };
    if (REVIEW_RE.test(msg)) return { done: true, status: "in_review", reason: msg };
    if (SUCCESS_TEXT_RE.test(msg)) return { done: true, status: "applied", reason: "" };
  }
  const errHint = dynamicMessages.find((msg) => ERROR_HINT_RE.test(msg));
  if (errHint) {
    return { done: true, status: "failed", reason: `页面提示: ${errHint}` };
  }

  if (tabGone || closeCalled) {
    return { done: true, status: "applied", reason: "" };
  }

  const curUrl = String(url || "");
  if (curUrl && !curUrl.includes("claim/info") && !curUrl.includes("claim/apply") && !/passport\.weibo\.com|newlogin/i.test(curUrl) && !stillHasSubmit) {
    return { done: true, status: "applied", reason: "" };
  }

  const body = String(fullText || "");
  if (SUCCESS_TEXT_RE.test(body)) {
    return { done: true, status: "applied", reason: "" };
  }
  if (REVIEW_RE.test(body)) {
    return { done: true, status: "in_review", reason: "" };
  }

  return { done: false, status: "", reason: "" };
}

async function installClaimInfoProbe(tabId) {
  return runInMainWorld(tabId, () => {
    if (!window.__topicPinProbe) {
      const probe = {
        alerts: [],
        toasts: [],
        network: [],
        pendingRequests: 0,
        closeCalled: false,
      };
      const pushToast = (raw) => {
        const txt = String(raw || "").replace(/\s+/g, " ").trim();
        if (!txt || txt.length > 180) return;
        if (probe.toasts[probe.toasts.length - 1] !== txt) {
          probe.toasts.push(txt);
          if (probe.toasts.length > 30) probe.toasts.shift();
        }
      };
      const pushNet = (url, method, status, text) => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        probe.network.push({
          url: String(url || ""),
          method: String(method || "GET").toUpperCase(),
          status: Number(status || 0),
          text: String(text || "").slice(0, 400),
          json,
        });
        if (probe.network.length > 30) probe.network.shift();
      };

      try {
        const origAlert = window.alert;
        window.alert = (msg) => {
          pushToast(msg);
          probe.alerts.push(String(msg || "").trim());
          try { if (typeof origAlert === "function") return undefined; } catch {}
        };
      } catch (_) {}

      try {
        window.confirm = (msg) => {
          pushToast(msg);
          probe.alerts.push(String(msg || "").trim());
          return true;
        };
      } catch (_) {}

      try {
        const origClose = window.close;
        window.close = function (...args) {
          probe.closeCalled = true;
          try { return origClose.apply(this, args); } catch (_) { return undefined; }
        };
      } catch (_) {}

      try {
        const origFetch = window.fetch;
        if (typeof origFetch === "function") {
          window.fetch = async function (input, init) {
            const reqUrl = typeof input === "string" ? input : (input?.url || "");
            const method = (init?.method || (typeof input === "object" && input?.method) || "GET");
            probe.pendingRequests += 1;
            try {
              const resp = await origFetch.apply(this, arguments);
              try {
                const cloned = resp.clone();
                cloned.text().then((txt) => pushNet(reqUrl, method, resp.status, txt)).catch(() => {});
              } catch (_) {}
              return resp;
            } finally {
              probe.pendingRequests = Math.max(0, probe.pendingRequests - 1);
            }
          };
        }
      } catch (_) {}

      try {
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__tpUrl = String(url || "");
          this.__tpMethod = String(method || "GET").toUpperCase();
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
          probe.pendingRequests += 1;
          let finished = false;
          const finish = () => {
            if (!finished) {
              finished = true;
              probe.pendingRequests = Math.max(0, probe.pendingRequests - 1);
            }
          };
          this.addEventListener("loadend", () => {
            try {
              let txt = "";
              if (this.responseType === "" || this.responseType === "text") {
                txt = this.responseText || "";
              } else if (this.responseType === "json" && this.response) {
                txt = JSON.stringify(this.response);
              }
              pushNet(this.__tpUrl, this.__tpMethod, this.status, txt);
            } catch (_) {}
            finish();
          });
          this.addEventListener("abort", finish);
          this.addEventListener("error", finish);
          try {
            return origSend.apply(this, arguments);
          } catch (err) {
            finish();
            throw err;
          }
        };
      } catch (_) {}

      try {
        const observer = new MutationObserver((mutations) => {
          for (const mut of mutations) {
            for (const node of mut.addedNodes || []) {
              if (!node || node.nodeType !== 1) continue;
              const cls = String(node.className || "").toLowerCase();
              const isToastLike = /toast|message|tip|layer|modal|dialog|alert/.test(cls)
                || node.getAttribute?.("role") === "alert";
              const txt = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
              if (txt && (isToastLike || txt.length <= 80)) {
                pushToast(txt);
              }
            }
          }
        });
        if (document.body) {
          observer.observe(document.body, { childList: true, subtree: true });
        }
      } catch (_) {}

      window.__topicPinProbe = probe;
    }
    const p = window.__topicPinProbe;
    p.closeCalled = false;
    return {
      netLen: p.network.length,
      toastLen: p.toasts.length,
      alertLen: p.alerts.length,
    };
  }).catch(() => ({ netLen: 0, toastLen: 0, alertLen: 0 }));
}

async function readClaimInfoProbe(tabId, mark = { netLen: 0, toastLen: 0, alertLen: 0 }) {
  return runInMainWorld(tabId, (since) => {
    const p = window.__topicPinProbe || { network: [], toasts: [], alerts: [], closeCalled: false };
    const fullText = document.body?.innerText || "";
    const stillHasSubmit = Array.from(document.querySelectorAll("button, a, input[type='submit'], .submit-btn")).some((el) => {
      const t = (el.innerText || el.value || "").trim();
      if (t.includes("申请主持人")) return false;
      return ["同意并提交", "提交申请"].some((k) => t.includes(k));
    });
    return {
      tabGone: false,
      url: location.href,
      fullText,
      txt: fullText.replace(/\s+/g, " ").slice(0, 140),
      stillHasSubmit,
      closeCalled: Boolean(p.closeCalled),
      network: (p.network || []).slice(since?.netLen || 0),
      toasts: (p.toasts || []).slice(since?.toastLen || 0),
      alerts: (p.alerts || []).slice(since?.alertLen || 0),
    };
  }, [mark]);
}

async function uploadAndConfirmAvatarInTab(tabId, { imageDataUrl, imageName, ensureDebugger = null }) {
  if (!imageDataUrl || !String(imageDataUrl).startsWith("data:")) {
    return { fileSet: false, cropDetected: false, cropConfirmed: false, uploadSettled: false };
  }

  const prep = await runInMainWorld(tabId, async (payload) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let fileInput = null;
    for (let i = 0; i < 8; i++) {
      fileInput = document.querySelector('input[type="file"]');
      if (fileInput) break;
      await wait(250);
    }
    if (!fileInput) return { fileSet: false, beforeImgs: [] };

    const beforeImgs = Array.from(document.querySelectorAll("img"))
      .map((img) => img.getAttribute("src") || img.src || "")
      .filter(Boolean);
    const netBefore = window.__topicPinProbe?.network?.length || 0;

    try {
      const [meta, b64] = payload.imageDataUrl.split(",");
      const mimeMatch = meta.match(/data:([^;]+)/);
      const mime = mimeMatch ? mimeMatch[1] : "image/png";
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], payload.imageName || "host_avatar.png", { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      return { fileSet: true, beforeImgs, netBefore };
    } catch (_) {
      return { fileSet: false, beforeImgs, netBefore };
    }
  }, [{ imageDataUrl, imageName }]);

  if (!prep?.fileSet) {
    return { fileSet: false, cropDetected: false, cropConfirmed: false, uploadSettled: false };
  }

  const locateOrClickCropConfirm = async (doClick = false) => runInMainWorld(tabId, (shouldClick) => {
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const tiers = [
      '.m-layer button, .m-layer a, .crop-confirm, [class*="crop"] button, [class*="crop"] a, [class*="modal"] button, [class*="dialog"] button',
      'button.u-btn-b, .u-btn-b',
      'button, [role="button"], a',
    ];
    for (const sel of tiers) {
      const els = Array.from(document.querySelectorAll(sel)).filter((el) => {
        if (!isVisible(el)) return false;
        const txt = (el.innerText || el.textContent || "").trim();
        return txt && !txt.includes("取消") && !txt.includes("关闭") && txt.includes("确定");
      });
      const exact = els.find((el) => (el.innerText || el.textContent || "").trim() === "确定") || els[0];
      if (exact) {
        exact.scrollIntoView({ block: "center", inline: "center" });
        const r = exact.getBoundingClientRect();
        if (shouldClick) exact.click();
        return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return { found: false };
  }, [doClick]).catch(() => ({ found: false }));

  let cropDetected = false;
  let cropConfirmed = false;
  let cropBtnInfo = { found: false };
  for (let c = 0; c < 15; c++) {
    await sleepMs(300);
    cropBtnInfo = await locateOrClickCropConfirm(false);
    if (cropBtnInfo?.found) {
      cropDetected = true;
      break;
    }
  }

  if (cropBtnInfo?.found) {
    // 优先纯 DOM 点击，避免默认挂载调试器导致浏览器顶部黄条闪烁
    await locateOrClickCropConfirm(true);

    // 确认裁剪框真正关闭，仅在 DOM 点击未关掉时按需启用可信 CDP 点击兜底
    for (let w = 0; w < 10; w++) {
      await sleepMs(300);
      const stillOpen = await locateOrClickCropConfirm(false);
      if (!stillOpen?.found) {
        cropConfirmed = true;
        break;
      }
      if (w === 1) {
        const hasDbg = typeof ensureDebugger === "function" ? await ensureDebugger() : false;
        const cdpOk = await dispatchTrustedClick(tabId, stillOpen, hasDbg);
        if (!cdpOk) {
          await locateOrClickCropConfirm(true);
        }
      }
    }
  }

  let uploadSettled = false;
  for (let u = 0; u < 10; u++) {
    const check = await runInMainWorld(tabId, (beforeImgs, netBefore) => {
      const curImgs = Array.from(document.querySelectorAll("img"))
        .map((img) => img.getAttribute("src") || img.src || "")
        .filter(Boolean);
      const imgChanged = curImgs.some((src) => !beforeImgs.includes(src));
      const p = window.__topicPinProbe || { network: [], pendingRequests: 0 };
      const newNets = (p.network || []).slice(netBefore || 0);
      const pending = Number(p.pendingRequests || 0);
      return { imgChanged, netSettled: newNets.length > 0, pending };
    }, [prep.beforeImgs || [], prep.netBefore || 0]).catch(() => ({ imgChanged: false, netSettled: false, pending: 0 }));
    if (check?.pending === 0 && (check?.netSettled || (check?.imgChanged && u >= 1))) {
      uploadSettled = true;
      await sleepMs(250);
      break;
    }
    if (!cropDetected && check?.pending === 0 && u >= 2) break;
    await sleepMs(250);
  }

  return { fileSet: true, cropDetected, cropConfirmed, uploadSettled };
}

async function selectHostFormFieldsInTab(tabId, { category, region }) {
  return runInMainWorld(tabId, async (payload) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const { category: cat, region: reg } = payload;

    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const selectOptionByLabel = (sel, targetText) => {
      if (!sel || !targetText) return false;
      const opts = Array.from(sel.options || sel.querySelectorAll("option"));
      const getOptLabel = (o) => String(o.label || o.text || o.textContent || o.innerText || "").trim();
      const matched = opts.find((o) => getOptLabel(o) === targetText)
        || opts.find((o) => getOptLabel(o).includes(targetText));
      if (!matched) return false;
      const idx = opts.indexOf(matched);
      opts.forEach((o, i) => { o.selected = (i === idx); });
      const valSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (valSetter && matched.value !== undefined) {
        valSetter.call(sel, matched.value);
      }
      sel.selectedIndex = idx;
      sel.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      const selectedOpt = sel.options?.[sel.selectedIndex];
      return Boolean(selectedOpt && getOptLabel(selectedOpt).includes(targetText));
    };

    let catSelected = false;
    let regSelected = false;
    for (let sTry = 0; sTry < 12; sTry++) {
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        if (!catSelected && cat && selectOptionByLabel(sel, cat)) {
          catSelected = true;
          await wait(250);
          continue;
        }
        if (!regSelected && reg && selectOptionByLabel(sel, reg)) {
          regSelected = true;
          await wait(250);
        }
      }
      if ((catSelected || !cat) && (regSelected || !reg)) break;
      await wait(300);
    }

    const selectCustomDropdown = async (triggerSelectors, targetText) => {
      for (const tSel of triggerSelectors) {
        const trigger = document.querySelector(tSel);
        if (!trigger || !isVisible(trigger)) continue;
        trigger.click();
        await wait(400);
        const opt = Array.from(document.querySelectorAll("li, a, span, div.option, .m-select-item"))
          .find((el) => isVisible(el) && el.children.length === 0 && (el.innerText || el.textContent || "").trim() === targetText);
        if (opt) {
          opt.click();
          await wait(300);
          return true;
        }
      }
      return false;
    };

    if (!catSelected && cat) {
      catSelected = await selectCustomDropdown(
        ['[placeholder*="分类"]', '[class*="categ"]', '[class*="type-select"]', '.m-select:first-of-type'],
        cat
      );
    }
    if (!regSelected && reg) {
      regSelected = await selectCustomDropdown(
        ['[placeholder*="地区"]', '[class*="area"]', '[class*="region"]', '.m-select:last-of-type'],
        reg
      );
    }

    return { catSelected, regSelected };
  }, [{ category, region }]);
}

async function applyForHostInTab(tabId, hashtag, cfg, fastMode = false) {
  const searchUrl = `https://s.weibo.com/weibo?q=%23${encodeURIComponent(hashtag)}%23`;
  await navigateTabAndWait(tabId, searchUrl, fastMode ? 18000 : 25000);
  await sleepMs(fastMode ? 400 : 700);

  const createdTabs = [];
  const onCreated = (tab) => { if (tab?.id) createdTabs.push(tab.id); };
  chrome.tabs.onCreated.addListener(onCreated);

  let targetTabId = tabId;
  let popupTabId = null;
  let debuggerAttached = false;
  try {
    const preCheck = await runInMainWorld(tabId, (hostName) => {
      const cur = location.href;
      if (/passport\.weibo\.com|newlogin|retcode=6102/i.test(cur)) return { status: "login_required" };
      if (document.querySelector('a[href*="claim/manage"]')) return { status: "already_host" };
      const allEls = Array.from(document.querySelectorAll("a, span, button"));
      if (allEls.some((el) => (el.innerText || "").includes("话题管理"))) return { status: "already_host" };

      // 优先精确匹配 <a> 或叶子节点「申请主持人」，禁止盲目点 .s-side a:last-child 误入他人主页
      const exactA = Array.from(document.querySelectorAll("a")).find((el) => (el.innerText || "").trim() === "申请主持人")
        || Array.from(document.querySelectorAll("a")).find((el) => (el.innerText || "").includes("申请主持人"))
        || document.querySelector('a[href*="claim/apply"]');
      const leafEl = Array.from(document.querySelectorAll("span, button")).find(
        (el) => el.children.length === 0 && (el.innerText || "").includes("申请主持人")
      );
      const applyEl = exactA || leafEl;

      if (!applyEl) {
        const bodyText = document.body.innerText || "";
        const idx = bodyText.indexOf("话题主持人");
        if (idx !== -1) {
          const snippet = bodyText.slice(idx, idx + 160);
          if (snippet.includes(hostName)) return { status: "already_host" };
          if (!/暂无|虚位以待|申请主持人|立即申请/.test(snippet)) return { status: "other_host" };
        }
        return { status: "no_entry" };
      }

      const anchor = applyEl.closest?.("a") || applyEl;
      const href = (anchor.getAttribute?.("href") || applyEl.getAttribute?.("href") || "").trim();
      const onclick = (anchor.getAttribute?.("onclick") || applyEl.getAttribute?.("onclick") || "");
      const winOpenMatch = onclick.match(/window\.open\(\s*['"]([^'"]+)['"]/);
      const isValidHref = href && !href.startsWith("#") && !href.toLowerCase().startsWith("javascript");
      let directUrl = isValidHref ? href : (winOpenMatch ? winOpenMatch[1] : "");

      if (!directUrl) {
        const scan = (val) => {
          if (!val) return "";
          const m = String(val).match(/(?:https?:)?\/\/[^'"\s<>]*claim\/apply[^'"\s<>]*/);
          return m ? m[0] : "";
        };
        for (const el of document.querySelectorAll("*")) {
          for (const attr of el.attributes) {
            const hit = scan(attr.value);
            if (hit) { directUrl = hit; break; }
          }
          if (directUrl) break;
        }
      }

      if (directUrl) return { status: "has_url", url: directUrl.replace(/&amp;/g, "&") };

      try {
        if (anchor.tagName === "A") anchor.removeAttribute("target");
        window.open = (u) => {
          if (u && !String(u).startsWith("javascript")) location.href = u;
          return window;
        };
      } catch (_) {}

      anchor.click();
      if (applyEl !== anchor) applyEl.click();
      return { status: "clicked" };
    }, [cfg?.hostAccountName || "新浪热点"]);

    if (preCheck?.status === "login_required") return { status: "login_required" };
    if (preCheck?.status === "already_host") return { status: "already_host" };
    if (preCheck?.status === "other_host") return { status: "other_host" };
    if (preCheck?.status === "no_entry") return { status: "failed", reason: "未找到申请主持人入口" };

    if (preCheck?.status === "has_url" && preCheck.url) {
      const fullUrl = preCheck.url.startsWith("http")
        ? preCheck.url
        : new URL(preCheck.url, "https://s.weibo.com").href;
      topicPinLog(`进入申请条件页: ${fullUrl.slice(0, 80)}...`);
      await navigateTabAndWait(tabId, fullUrl, 20000);
    } else {
      for (let i = 0; i < 20; i++) {
        await sleepMs(250);
        if (createdTabs.length > 0) {
          popupTabId = createdTabs[createdTabs.length - 1];
          targetTabId = popupTabId;
          await chrome.tabs.update(popupTabId, { active: false }).catch(() => {});
          await waitForTabComplete(targetTabId, 15000);
          break;
        }
        const t = await chrome.tabs.get(tabId);
        if (t.url && t.url !== searchUrl && !t.url.startsWith("about:blank")) {
          await waitForTabComplete(tabId, 15000);
          break;
        }
      }
    }
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }

  const cleanupPopup = async () => {
    if (debuggerAttached && typeof releaseBackgroundTab === "function") {
      await releaseBackgroundTab(targetTabId).catch(() => {});
      debuggerAttached = false;
    }
    if (popupTabId) {
      try { await chrome.tabs.remove(popupTabId); } catch {}
    }
  };

  try {
    await sleepMs(fastMode ? 400 : 700);
    let condCheck = null;
    for (let waitCond = 0; waitCond < 12; waitCond++) {
      condCheck = await runInMainWorld(targetTabId, (allowFallback) => {
        const curUrl = location.href || "";
        if (/passport\.weibo\.com|newlogin|retcode=6102/i.test(curUrl)) {
          return { status: "login_required" };
        }
        const txt = document.body.innerText || "";
        if (["竞争主持人", "竞争申请", "已有主持人", "竞争"].some((k) => txt.includes(k))) {
          return { status: "other_host" };
        }
        if (["审核中", "已在审核", "申请审核中", "正在审核", "请勿重复提交", "已提交", "申请已提交"].some((k) => txt.includes(k))) {
          return { status: "in_review" };
        }
        const hasSubmit = Array.from(document.querySelectorAll("button, a, input[type='submit']")).some((el) => {
          const t = (el.innerText || el.value || "").trim();
          if (t.includes("申请主持人")) return false;
          return ["同意并提交", "提交申请"].some((k) => t.includes(k));
        });
        if (!hasSubmit || curUrl.includes("claim/apply")) {
          let condBtn = document.querySelector("button.btn_enable, .btn_enable");
          if (!condBtn && allowFallback) {
            const candidate = Array.from(document.querySelectorAll("button, a")).find((el) => (el.innerText || "").includes("申请主持人"))
              || document.querySelector(".btn-orange, .apply-btn");
            if (candidate) {
              const cls = String(candidate.className || "").toLowerCase();
              if (candidate.disabled || cls.includes("disable") || cls.includes("gray") || cls.includes("grey")) {
                return { status: "cond_not_met", url: curUrl };
              }
              condBtn = candidate;
            }
          }
          if (condBtn) {
            try {
              if (condBtn.tagName === "A") condBtn.removeAttribute("target");
              const parentA = condBtn.closest?.("a");
              if (parentA) parentA.removeAttribute("target");
              window.open = (u) => {
                if (u && !String(u).startsWith("javascript")) location.href = u;
                return window;
              };
            } catch (_) {}
            condBtn.click();
            return { status: "clicked_cond", url: curUrl };
          }
          return { status: "loading_cond", url: curUrl };
        }
        return { status: "at_form", url: curUrl };
      }, [waitCond >= 9]);
      if (condCheck?.status !== "loading_cond") break;
      await sleepMs(300);
    }

    if (condCheck?.status === "login_required") {
      await cleanupPopup();
      return { status: "login_required" };
    }
    if (condCheck?.status === "other_host" || condCheck?.status === "in_review") {
      await cleanupPopup();
      return { status: condCheck.status };
    }
    if (condCheck?.status === "cond_not_met") {
      await cleanupPopup();
      return { status: "failed", reason: "不满足申请条件（需近24小时内带该话题发博）" };
    }

    if (condCheck?.status === "clicked_cond") {
      await sleepMs(450);
      await waitForTabComplete(targetTabId, 15000, true).catch(() => {});
      let reachedForm = false;
      for (let i = 0; i < 16; i++) {
        await sleepMs(300);
        try {
          const ready = await runInMainWorld(targetTabId, () => {
            const txt = document.body.innerText || "";
            if (["审核中", "已在审核", "申请审核中", "正在审核", "请勿重复提交", "已提交", "申请已提交", "竞争主持人", "已有主持人"].some((k) => txt.includes(k))) return true;
            return Array.from(document.querySelectorAll("button, a, input[type='submit']")).some((el) => {
              const t = (el.innerText || el.value || "").trim();
              if (t.includes("申请主持人")) return false;
              return ["同意并提交", "提交申请"].some((k) => t.includes(k));
            });
          });
          if (ready) {
            reachedForm = true;
            break;
          }
        } catch (_) {}
      }
      if (!reachedForm) {
        const curTab = await chrome.tabs.get(targetTabId).catch(() => null);
        if (curTab?.url && curTab.url.includes("/claim/apply")) {
          const infoUrl = curTab.url.replace("/claim/apply", "/claim/info");
          topicPinLog(`条件页直接跳转表单页: ${infoUrl.slice(0, 80)}...`);
          await navigateTabAndWait(targetTabId, infoUrl, 15000);
        }
      }
    }

    await sleepMs(fastMode ? 350 : 600);

    // 进入表单页后先检查是否已处于审核/竞争状态
    const formPreState = await runInMainWorld(targetTabId, () => {
      const curUrl = location.href || "";
      if (/passport\.weibo\.com|newlogin|retcode=6102/i.test(curUrl)) return { status: "login_required" };
      const txt = document.body.innerText || "";
      if (["竞争主持人", "竞争申请", "已有主持人"].some((k) => txt.includes(k))) return { status: "other_host" };
      if (["审核中", "已在审核", "申请审核中", "正在审核", "请勿重复提交", "已提交", "申请已提交"].some((k) => txt.includes(k))) {
        return { status: "in_review" };
      }
      return { status: "ok", url: curUrl };
    }).catch(() => ({ status: "ok" }));

    if (formPreState?.status === "login_required" || formPreState?.status === "other_host" || formPreState?.status === "in_review") {
      await cleanupPopup();
      return { status: formPreState.status };
    }

    // 仅安装轻量页面探针；默认不挂载 chrome.debugger，避免顶部调试黄条闪烁，仅当 DOM 点击无响应时按需兜底挂载
    const ensureDebugger = async () => {
      if (debuggerAttached) return true;
      if (typeof holdBackgroundTabAwake === "function") {
        debuggerAttached = await holdBackgroundTabAwake(targetTabId).catch(() => false);
      }
      return debuggerAttached;
    };
    await installClaimInfoProbe(targetTabId);

    const ha = cfg.hostApply || {};
    const effectiveAvatarDataUrl = await getEffectiveHostAvatarDataUrl(cfg);
    const avatarRes = await uploadAndConfirmAvatarInTab(targetTabId, {
      imageDataUrl: effectiveAvatarDataUrl,
      imageName: ha.imageName || "host_avatar.png",
      ensureDebugger,
    });

    const selectRes = await selectHostFormFieldsInTab(targetTabId, {
      category: ha.category || "社会",
      region: ha.region || "全国",
    });

    await sleepMs(350);

    // 定位可见且可用的提交按钮，并记录提交前探针游标
    const submitTarget = await runInMainWorld(targetTabId, async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const st = window.getComputedStyle(el);
        if (!st || st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const isEnabled = (el) => {
        const cls = String(el.className || "").toLowerCase();
        return !el.disabled && !cls.includes("disable") && !cls.includes("gray") && !cls.includes("grey");
      };

      if (location.href.includes("claim/apply")) {
        return { status: "failed", reason: "仍停留在申请条件页（未满足近24小时带话题发博条件或按钮未激活）" };
      }

      const findSubmitBtn = (requireEnabled) => {
        const candidates = Array.from(document.querySelectorAll("button, a, input[type='submit'], .submit-btn"))
          .filter((el) => isVisible(el) && (!requireEnabled || isEnabled(el)));
        return candidates.find((el) => {
          const t = (el.innerText || el.value || "").trim();
          if (t.includes("申请主持人")) return false;
          return ["同意并提交", "提交申请"].some((k) => t.includes(k));
        }) || candidates.find((el) => {
          const t = (el.innerText || el.value || "").trim();
          if (t.includes("申请主持人")) return false;
          return t === "提交" || (el.tagName === "INPUT" && el.type === "submit");
        });
      };

      let submitBtn = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        submitBtn = findSubmitBtn(true);
        if (submitBtn) break;
        await wait(300);
      }

      if (!submitBtn) {
        const disabledBtn = findSubmitBtn(false);
        if (disabledBtn) {
          return { status: "failed", reason: "提交按钮处于禁用状态（可能头像未上传完成或必填项未通过校验）" };
        }
        const bodyTxt = document.body.innerText || "";
        if (["审核中", "请勿重复提交", "已提交", "申请已提交", "已在审核", "已申请"].some((k) => bodyTxt.includes(k))) {
          return { status: "in_review" };
        }
        const btns = Array.from(document.querySelectorAll("button, input[type='submit'], a.btn, a"))
          .map((b) => (b.innerText || b.value || "").trim())
          .filter(Boolean)
          .slice(0, 8);
        return { status: "failed", reason: `未找到提交按钮 (URL: ${location.href}, 按钮: [${btns.join(", ")}])` };
      }

      submitBtn.scrollIntoView({ block: "center", inline: "center" });
      const rect = submitBtn.getBoundingClientRect();
      const btnText = (submitBtn.innerText || submitBtn.value || "").trim();
      const p = window.__topicPinProbe || { network: [], toasts: [], alerts: [] };
      p.closeCalled = false;
      return {
        status: "ready",
        btnText,
        coords: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        mark: {
          netLen: p.network.length,
          toastLen: p.toasts.length,
          alertLen: p.alerts.length,
        },
        url: location.href,
      };
    });

    if (submitTarget?.status === "in_review" || submitTarget?.status === "failed") {
      await cleanupPopup();
      return submitTarget;
    }

    const mark = submitTarget?.mark || { netLen: 0, toastLen: 0, alertLen: 0 };
    const clickDomSubmit = async () => runInMainWorld(targetTabId, () => {
      const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const st = window.getComputedStyle(el);
        if (!st || st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const candidates = Array.from(document.querySelectorAll("button, a, input[type='submit'], .submit-btn")).filter(isVisible);
      const btn = candidates.find((el) => {
        const t = (el.innerText || el.value || "").trim();
        return !t.includes("申请主持人") && ["同意并提交", "提交申请"].some((k) => t.includes(k));
      }) || candidates.find((el) => {
        const t = (el.innerText || el.value || "").trim();
        return !t.includes("申请主持人") && (t === "提交" || (el.tagName === "INPUT" && el.type === "submit"));
      });
      if (btn) btn.click();
      return Boolean(btn);
    }).catch(() => false);

    await clickDomSubmit();
    // 若 DOM 点击 450ms 内未产生任何网络/提示/关闭/跳转响应，再按需启用 CDP 真实坐标点击兜底
    await sleepMs(450);
    const probeCheck = await readClaimInfoProbe(targetTabId, mark).catch(() => null);
    if (
      probeCheck &&
      !probeCheck.closeCalled &&
      (probeCheck.network || []).length === 0 &&
      (probeCheck.toasts || []).length === 0 &&
      (probeCheck.alerts || []).length === 0 &&
      String(probeCheck.url || "").includes("claim/info")
    ) {
      const hasDbg = await ensureDebugger();
      await dispatchTrustedClick(targetTabId, submitTarget?.coords, hasDbg);
    }

    const avatarDesc = avatarRes?.cropConfirmed
      ? "已传(裁剪已确认)"
      : avatarRes?.fileSet
        ? (avatarRes?.cropDetected ? "已选(裁剪未关)" : "已选(无裁剪框)")
        : "未传";
    topicPinLog(`已点击「${submitTarget?.btnText || "提交申请"}」(头像:${avatarDesc}, 分类:${selectRes?.catSelected ? "已选" : "未选"}, 地区:${selectRes?.regSelected ? "已选" : "未选"})，正在核验提交结果...`);

    // 4. 核验提交结果：综合网络回包、Toast/Alert、window.close() 钩子、页面跳转与标签页关闭
    let outcome = { done: false, status: "", reason: "" };
    let lastBodySnippet = "";
    for (let i = 0; i < 14; i++) {
      await sleepMs(350);
      const tabInfo = await chrome.tabs.get(targetTabId).catch(() => null);
      if (!tabInfo) {
        outcome = classifyClaimSubmitOutcome({ tabGone: true });
        break;
      }
      try {
        const snap = await readClaimInfoProbe(targetTabId, mark);
        lastBodySnippet = snap?.txt || "";
        outcome = classifyClaimSubmitOutcome(snap);
        if (outcome.done) break;
      } catch {
        const tabAfter = await chrome.tabs.get(targetTabId).catch(() => null);
        if (!tabAfter) {
          outcome = classifyClaimSubmitOutcome({ tabGone: true });
          break;
        }
        if (tabAfter.url && !tabAfter.url.includes("claim/info") && !tabAfter.url.includes("claim/apply")) {
          outcome = classifyClaimSubmitOutcome({ url: tabAfter.url, stillHasSubmit: false });
          break;
        }
      }
    }

    await cleanupPopup();
    if (!outcome.done) {
      return { status: "failed", reason: `点击提交后未检测到成功响应 (页面内容: ${lastBodySnippet || "无变化"})` };
    }
    return { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  } catch (err) {
    await cleanupPopup();
    return { status: "failed", reason: err.message || String(err) };
  }
}

async function pinPostToTopicInTab(tabId, postUrl, objectId, query = "") {
  const addUrl = `https://m.s.weibo.com/claim/addweibo?object_id=${encodeURIComponent(objectId)}&query=${encodeURIComponent(query)}&sp_btn=istop`;
  await navigateTabAndWait(tabId, addUrl, 25000);
  await sleepMs(600);

  const submitRes = await runInMainWorld(tabId, (url) => {
    const input = document.querySelector("textarea") || document.querySelector("input[type='text']");
    if (!input) return { ok: false, error: "未找到微博链接输入框" };
    input.focus();
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(input, url);
    else input.value = url;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const btn = document.querySelector(".btn-orange")
      || document.querySelector("button[type='submit']")
      || document.querySelector("input[type='submit']")
      || document.querySelector("button");
    if (!btn) return { ok: false, error: "未找到提交按钮" };
    btn.click();
    return { ok: true };
  }, [postUrl]);

  if (!submitRes?.ok) return { ok: false, error: submitRes?.error || "提交微博链接失败" };

  // Wait for cardaddtop confirmation page
  let onConfirmPage = false;
  for (let i = 0; i < 20; i++) {
    await sleepMs(400);
    const t = await chrome.tabs.get(tabId);
    if (t.url && t.url.includes("cardaddtop")) {
      onConfirmPage = true;
      break;
    }
  }
  if (!onConfirmPage) {
    const errCtx = await runInMainWorld(tabId, () => ({
      url: location.href,
      txt: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 100),
    })).catch(() => null);
    return { ok: false, error: `未跳转到置顶确认页 (cardaddtop)${errCtx?.txt ? `: ${errCtx.txt}` : ""}` };
  }

  const waitForCardState = async () => {
    for (let i = 0; i < 20; i++) {
      await sleepMs(450);
      const st = await runInMainWorld(tabId, () => {
        if (document.querySelector(".card-top-add")) return "add";
        if (document.querySelector(".card-top-info")) return "info";
        return "loading";
      });
      if (st && st !== "loading") return st;
    }
    return "loading";
  };

  let pageState = await waitForCardState();
  if (pageState === "info") {
    return { ok: true, alreadyPinned: true };
  }

  const postCardTitle = async (isOwnerMidVal) => {
    return runInMainWorld(tabId, async (ownerVal) => {
      const s = {};
      location.search.replace(/([^?&=]+)=([^&]+)/g, (_, k, v) => {
        try { s[k] = decodeURIComponent(v); } catch { s[k] = v; }
      });
      s.label = "置顶";
      s.is_owner_mid = String(ownerVal);
      s.etime = String(Math.floor(Date.now() / 1000) + 90 * 24 * 3600);
      s.position = "1";
      s.is_vote_mid = "0";
      s.ride_hype_confirm = "0";
      if (!s.mid) s.mid = s.data;
      const body = new URLSearchParams(s).toString();
      const xsrf = (document.cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("XSRF-TOKEN=")) || "").split("=")[1] || "";
      const headers = { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" };
      if (xsrf) headers["X-XSRF-TOKEN"] = decodeURIComponent(xsrf);
      try {
        const r = await fetch("/ajax_claim/cardtitle", { method: "POST", headers, body, credentials: "include" });
        return await r.text();
      } catch (e) {
        return `FETCH_ERROR: ${e.message}`;
      }
    }, [isOwnerMidVal]);
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await sleepMs(10000 * (attempt - 1));
    let respText = await postCardTitle(0);
    if (String(respText).includes("100002")) {
      respText = await postCardTitle(1);
    }
    let data = null;
    try { data = JSON.parse(respText); } catch {}
    if (!data) {
      return { ok: false, error: `置顶接口返回非 JSON: ${String(respText).slice(0, 120)}` };
    }
    const code = String(data.code ?? "");
    const msg = String(data.msg ?? "");
    const accepted = code === "0" || code === "100000" || ["保存成功", "ok", "success"].includes(msg);
    if (!accepted) {
      return { ok: false, error: `置顶接口拒绝: code=${code} msg=${msg}` };
    }

    await sleepMs(1800);
    await chrome.tabs.reload(tabId);
    await sleepMs(350);
    await waitForTabComplete(tabId, 20000, true);
    pageState = await waitForCardState();
    if (pageState === "info") {
      return { ok: true, alreadyPinned: false, attempt };
    }
  }

  return { ok: false, error: "置顶提交后复核未见置顶记录，请人工核对" };
}

function summarizeTaskStatus(task) {
  const items = task.topics || [];
  if (items.length === 0) return "done";
  const stillOpen = items.some((it) => ["pending", "applied"].includes(it.status));
  if (stillOpen) return "waiting_review";
  const anyError = items.some((it) => it.status === "error" || it.status === "timeout");
  return anyError ? "error" : "done";
}

async function processSingleTopicPinTask(task, cfg, tabOrGetter) {
  const now = Date.now();
  const isTimedOut = task.deadlineAt && now > task.deadlineAt;
  let justApplied = false;
  const resolveTabId = async (initialUrl = "https://weibo.com/") => {
    if (typeof tabOrGetter === "function") return tabOrGetter(initialUrl);
    if (tabOrGetter) return tabOrGetter;
    const workerTab = await ensureTopicPinWorkerTab(initialUrl);
    return workerTab.id;
  };

  if (!isTimedOut && task.mode === "auto_publish" && task.createdAt && now - task.createdAt < 2000) {
    await sleepMs(2000 - (now - task.createdAt));
  }

  const updatedTopics = [];
  for (const topicItem of task.topics || []) {
    if (!["pending", "applied"].includes(topicItem.status)) {
      updatedTopics.push(topicItem);
      continue;
    }
    if (isTimedOut) {
      const prevNote = topicItem.note && topicItem.note !== "等待检测" ? ` (${topicItem.note})` : "";
      updatedTopics.push({ ...topicItem, status: "timeout", note: `等待审核超时${prevNote}` });
      topicPinLog(`#${topicItem.hashtag}# 等待超时放弃${prevNote}`, "warn");
      continue;
    }

    const hashtag = topicItem.hashtag;
    let attemptedApplyThisRound = false;
    let lastApplyFailure = "";
    let cachedInspected = null;

    // 手动申请主持人模式（pending 阶段）：优先后台静默 HTTP 申请，仅必要时兜底开标签
    if (task.mode === "manual_apply" && topicItem.status === "pending") {
      attemptedApplyThisRound = true;
      topicPinLog(`#${hashtag}# 直接进入主持人申请流程...`);
      const applyRes = await applyForHostSmart(resolveTabId, hashtag, cfg, Boolean(task.fastMode));
      if (applyRes.status === "login_required") {
        throw new Error("微博登录态失效，请先登录 weibo.com");
      }
      if (applyRes.status === "other_host") {
        topicPinLog(`#${hashtag}# 申请页检测到竞争/其他主持人，跳过`, "info");
        updatedTopics.push({ ...topicItem, status: "skipped_other_host", note: "已有竞争/其他主持人" });
        continue;
      }
      if (applyRes.status === "applied" || applyRes.status === "in_review") {
        justApplied = true;
        if (!task.autoPin) {
          topicPinLog(`#${hashtag}# 申请已提交`, "success");
          updatedTopics.push({
            ...topicItem,
            status: "applied_done",
            note: applyRes.status === "in_review" ? "已有申请审核中（不自动置顶）" : "已提交申请（不自动置顶）",
          });
        } else {
          topicPinLog(`#${hashtag}# 申请已提交，等待审核后置顶`, "info");
          updatedTopics.push({
            ...topicItem,
            status: "applied",
            note: applyRes.status === "in_review" ? "已有申请审核中，等待置顶" : "已提交申请，等待审核",
          });
        }
        continue;
      }
      if (applyRes.status === "already_host") {
        if (!task.autoPin) {
          topicPinLog(`#${hashtag}# 当前账号已是主持人`, "success");
          updatedTopics.push({ ...topicItem, status: "pinned", note: "已是主持人（仅申请）" });
          continue;
        }
        if (applyRes.inspected?.manageHref) cachedInspected = applyRes.inspected;
      } else {
        lastApplyFailure = applyRes.reason || "申请失败";
        topicPinLog(`#${hashtag}# 申请阶段未确认成功: ${lastApplyFailure}，正在复核话题权限...`, "warn");
      }
    }

    topicPinLog(`检测话题 #${hashtag}# 权限...`);
    const inspected = cachedInspected || await inspectTopicSmart(resolveTabId, hashtag, cfg.hostAccountName);
    if (inspected?.loginRequired) {
      throw new Error("微博登录态失效，请先登录 weibo.com");
    }

    if (inspected?.manageHref) {
      if (inspected.alreadyPinned) {
        topicPinLog(`#${hashtag}# 已有主持人权限且话题已有置顶，跳过`, "info");
        updatedTopics.push({ ...topicItem, status: "skipped_pinned", note: "话题已有置顶微博" });
        continue;
      }
      if (task.mode === "manual_apply" && !task.autoPin) {
        topicPinLog(`#${hashtag}# 已有主持人权限`, "success");
        updatedTopics.push({ ...topicItem, status: "pinned", note: "已有主持人权限（仅申请）" });
        continue;
      }
      const ids = extractObjectIdAndQuery(inspected.manageHref, hashtag);
      if (!ids) {
        updatedTopics.push({ ...topicItem, status: "error", note: "无法解析 object_id" });
        continue;
      }
      topicPinLog(`开始置顶到 #${hashtag}#...`);
      const pinRes = await pinPostToTopicSmart(resolveTabId, task.postUrl, ids.oid, ids.query);
      if (pinRes.loginRequired) {
        throw new Error("微博登录态失效，请先登录 weibo.com");
      }
      if (pinRes.ok) {
        const note = pinRes.alreadyPinned ? "话题已有置顶微博" : "置顶成功";
        topicPinLog(`#${hashtag}# ${note}`, "success");
        updatedTopics.push({ ...topicItem, status: pinRes.alreadyPinned ? "skipped_pinned" : "pinned", note });
      } else {
        const pinAttempts = Number(topicItem.pinAttempts || 0) + 1;
        if (pinAttempts < 2 && !isTimedOut) {
          topicPinLog(`#${hashtag}# 置顶未生效 (${pinRes.error})，下轮自动重试`, "warn");
          updatedTopics.push({
            ...topicItem,
            status: "applied",
            pinAttempts,
            note: `${pinRes.error || "置顶未生效"}（下轮重试置顶）`,
          });
        } else {
          topicPinLog(`#${hashtag}# 置顶失败: ${pinRes.error}`, "error");
          updatedTopics.push({ ...topicItem, status: "error", pinAttempts, note: pinRes.error || "置顶失败" });
        }
      }
      continue;
    }

    if (inspected?.hasOtherHost) {
      topicPinLog(`#${hashtag}# 已有其他主持人，跳过`, "info");
      updatedTopics.push({ ...topicItem, status: "skipped_other_host", note: "已有其他主持人" });
      continue;
    }

    if (attemptedApplyThisRound && lastApplyFailure) {
      if (inspected?.canApply) {
        if (!task.autoPin) {
          topicPinLog(`#${hashtag}# 申请未成功: ${lastApplyFailure}`, "warn");
          updatedTopics.push({ ...topicItem, status: "error", note: lastApplyFailure });
        } else {
          topicPinLog(`#${hashtag}# 申请未成功 (${lastApplyFailure})，将保留在置顶队列中重试/复检`, "warn");
          updatedTopics.push({ ...topicItem, status: "pending", note: `${lastApplyFailure}（下轮重试）` });
        }
      } else if (!task.autoPin) {
        if (inspected?.hostStatus === "self") {
          topicPinLog(`#${hashtag}# 当前账号已是主持人`, "success");
          updatedTopics.push({ ...topicItem, status: "pinned", note: "已是主持人（仅申请）" });
        } else if (lastApplyFailure === "未找到申请主持人入口") {
          topicPinLog(`#${hashtag}# ${lastApplyFailure}`, "warn");
          updatedTopics.push({ ...topicItem, status: "error", note: lastApplyFailure });
        } else {
          topicPinLog(`#${hashtag}# 未再检测到申请入口，可能已提交审核`, "info");
          updatedTopics.push({ ...topicItem, status: "applied_done", note: "未检测到申请入口（可能已提交审核中）" });
        }
      } else {
        topicPinLog(`#${hashtag}# 暂未检测到管理/申请入口，继续等待权限生效并置顶`, "info");
        updatedTopics.push({ ...topicItem, status: "applied", note: "未检测到申请入口，等待审核后置顶" });
      }
      continue;
    }

    if (inspected?.canApply && topicItem.status === "pending") {
      topicPinLog(`#${hashtag}# 提交主持人申请...`);
      const applyRes = await applyForHostSmart(resolveTabId, hashtag, cfg, Boolean(task.fastMode), inspected);
      if (applyRes.status === "login_required") {
        throw new Error("微博登录态失效，请先登录 weibo.com");
      }
      if (applyRes.status === "other_host") {
        updatedTopics.push({ ...topicItem, status: "skipped_other_host", note: "申请页检测到竞争/其他主持人" });
      } else if (applyRes.status === "already_host") {
        updatedTopics.push({ ...topicItem, status: "pending", note: "已拥有主持人，下轮复检置顶" });
      } else if (applyRes.status === "applied" || applyRes.status === "in_review") {
        justApplied = true;
        if (task.mode === "manual_apply" && !task.autoPin) {
          topicPinLog(`#${hashtag}# 申请已提交`, "success");
          updatedTopics.push({ ...topicItem, status: "applied_done", note: "已提交申请（不自动置顶）" });
        } else {
          topicPinLog(`#${hashtag}# 申请已提交，等待审核后置顶`, "info");
          updatedTopics.push({ ...topicItem, status: "applied", note: "已提交申请，等待审核" });
        }
      } else {
        topicPinLog(`#${hashtag}# 申请未成功: ${applyRes.reason || "未知原因"}，待下轮重试`, "warn");
        updatedTopics.push({ ...topicItem, status: "pending", note: applyRes.reason || "申请未成功，待重试" });
      }
      continue;
    }

    // Still waiting for review or system entry
    topicPinLog(`#${hashtag}# 暂未检测到管理/申请入口，下轮继续复检`, "info");
    updatedTopics.push({
      ...topicItem,
      note: topicItem.status === "applied" ? "审核中，等待权限生效" : "暂未检测到入口，继续等待",
    });
  }

  const nextTask = { ...task, topics: updatedTopics };
  const nextStatus = summarizeTaskStatus(nextTask);
  let nextCheckAt = null;
  if (nextStatus === "waiting_review") {
    const waitSec = justApplied ? cfg.minWaitSec : cfg.pollIntervalSec;
    nextCheckAt = Date.now() + waitSec * 1000;
  }

  await updateTopicPinTask(task.id, {
    status: nextStatus,
    topics: updatedTopics,
    nextCheckAt,
    error: "",
  });

  return nextCheckAt;
}

async function processTopicPinQueue() {
  if (topicPinRunningPromise) return topicPinRunningPromise;
  topicPinRunningPromise = (async () => {
    try {
      const cfg = await getTopicPinConfig();
      const tasks = await getTopicPinTasks();
      const now = Date.now();
      const runnable = tasks.filter((t) =>
        t.status === "pending" || (t.status === "waiting_review" && (!t.nextCheckAt || t.nextCheckAt <= now + 2000))
      );
      if (runnable.length === 0) {
        const nextWait = tasks
          .filter((t) => t.status === "waiting_review" && t.nextCheckAt)
          .map((t) => t.nextCheckAt)
          .sort((a, b) => a - b)[0];
        if (nextWait && chrome.alarms) {
          await chrome.alarms.create(TOPIC_PIN_ALARM_TICK, { when: Math.max(Date.now() + 5000, nextWait) });
        }
        return;
      }

      let earliestNextCheck = null;
      await withTopicPinBrowserLock(async () => {
        let lazyTab = null;
        const getLazyWorkerTabId = async (initialUrl = "https://weibo.com/") => {
          if (!lazyTab?.id) {
            lazyTab = await ensureTopicPinWorkerTab(initialUrl);
          }
          return lazyTab.id;
        };
        for (const task of runnable) {
          await updateTopicPinTask(task.id, { status: "running", error: "" });
          try {
            const nextAt = await processSingleTopicPinTask(task, cfg, getLazyWorkerTabId);
            if (nextAt && (!earliestNextCheck || nextAt < earliestNextCheck)) {
              earliestNextCheck = nextAt;
            }
          } catch (err) {
            topicPinLog(`任务失败: ${err.message || err}`, "error");
            await updateTopicPinTask(task.id, { status: "error", error: err.message || String(err) });
          }
        }
      });

      // Check if any other waiting_review tasks need an alarm
      const afterTasks = await getTopicPinTasks();
      const futureChecks = afterTasks
        .filter((t) => t.status === "waiting_review" && t.nextCheckAt)
        .map((t) => t.nextCheckAt);
      if (earliestNextCheck) futureChecks.push(earliestNextCheck);
      if (futureChecks.length > 0 && chrome.alarms) {
        const soonest = Math.min(...futureChecks);
        await chrome.alarms.create(TOPIC_PIN_ALARM_TICK, { when: Math.max(Date.now() + 5000, soonest) });
      }
    } finally {
      topicPinRunningPromise = null;
    }
  })();
  return topicPinRunningPromise;
}

async function enqueueTopicPinTask({ mode, postUrl, text = "", hashtags = [], isVote = false, fastMode = false, autoPin = true }) {
  const cfg = await getTopicPinConfig();
  const filtered = filterPostForTopicPin({ text, hashtags, isVote }, cfg);
  if (!filtered.shouldProcess && mode !== "manual_apply") {
    const skippedTask = {
      id: `tpin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      mode,
      status: "skipped",
      postUrl,
      text: String(text || "").slice(0, 140),
      topics: [],
      error: filtered.reason,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await withTopicPinMutation(async () => {
      const tasks = await getTopicPinTasks();
      await saveTopicPinTasks([skippedTask, ...tasks]);
    });
    topicPinLog(`跳过微博 (${filtered.reason}): ${postUrl}`, "info");
    return skippedTask;
  }

  const topicsList = filtered.topics.length > 0 ? filtered.topics : hashtags.map(normalizeWeiboTopic).filter(Boolean);
  const newTask = {
    id: `tpin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    mode,
    status: "pending",
    postUrl,
    text: String(text || "").slice(0, 140),
    fastMode: Boolean(fastMode),
    autoPin: Boolean(autoPin),
    topics: topicsList.map((h) => ({ hashtag: h, status: "pending", note: "等待检测" })),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deadlineAt: Date.now() + cfg.maxWaitSec * 1000,
    nextCheckAt: null,
    error: "",
  };

  await withTopicPinMutation(async () => {
    const tasks = await getTopicPinTasks();
    await saveTopicPinTasks([newTask, ...tasks]);
  });

  processTopicPinQueue().catch((err) => topicPinLog(`队列调度异常: ${err.message}`, "error"));
  return newTask;
}

async function maybeEnqueueAutoPinForPublishedPost({ postUrl, content, account }) {
  const cfg = await getTopicPinConfig();
  if (!cfg.autoPinOnPublish) return null;
  if (!postUrl || String(postUrl).includes("mock_dryrun_")) return null;
  const hashtags = extractHashtagsFromText(content);
  if (hashtags.length === 0) return null;
  topicPinLog(`发博成功 [${account || "默认"}]，自动加入话题置顶队列 (${hashtags.map((h) => `#${h}#`).join(" ")})`);
  return enqueueTopicPinTask({
    mode: "auto_publish",
    postUrl,
    text: content,
    hashtags,
    isVote: false,
    autoPin: true,
  });
}

async function handleManualTopicPin(url) {
  const parsed = parseWeiboPostUrl(url);
  const post = await resolvePostInfoSmart(parsed.canonicalUrl);
  return enqueueTopicPinTask({
    mode: "manual_pin",
    postUrl: post.url,
    text: post.text,
    hashtags: post.hashtags,
    isVote: post.isVote,
    autoPin: true,
  });
}

async function handleManualApplyHost({ input, fastMode = false, autoPin = false }) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("请输入话题名称或微博链接");
  const isUrl = /weibo\.com\/|weibo\.cn\//i.test(raw);
  if (!isUrl) {
    const topic = normalizeWeiboTopic(raw);
    if (!topic) throw new Error("话题名称不能为空");
    return enqueueTopicPinTask({
      mode: "manual_apply",
      postUrl: "",
      text: `#${topic}#`,
      hashtags: [topic],
      fastMode,
      autoPin: false,
    });
  }

  const parsed = parseWeiboPostUrl(raw);
  const post = await resolvePostInfoSmart(parsed.canonicalUrl);
  const topics = (post.hashtags || []).slice(0, 2);
  if (topics.length === 0) {
    throw new Error("该微博未包含任何 #话题# 标签，无法申请主持人");
  }
  return enqueueTopicPinTask({
    mode: "manual_apply",
    postUrl: post.url,
    text: post.text,
    hashtags: topics,
    isVote: post.isVote,
    fastMode,
    autoPin,
  });
}

async function checkWeiboMonitorOnce({ manual = false } = {}) {
  if (topicMonitorRunningPromise) return topicMonitorRunningPromise;

  const runPromise = (async () => {
    const cfg = await getTopicPinConfig();
    if (!cfg.monitorUid) {
      await saveTopicMonitorStatus({ lastRunAt: Date.now(), ok: false, reason: "未配置监控 UID" }).catch(() => {});
      return { ok: false, reason: "未配置监控 UID" };
    }

    let stoppedBySchedule = false;
    if (!manual) {
      const gate = shouldMonitorRunNow(cfg, Date.now());
      if (!gate.allowed) {
        if (gate.expired && cfg.autoMonitorEnabled) {
          topicPinLog(`[计划] ${gate.reason}，自动停止主页巡检`, "info");
          stoppedBySchedule = true;
          await saveTopicPinConfig({ ...cfg, autoMonitorEnabled: false, monitorStartedAt: 0 });
          await saveTopicMonitorStatus({ lastRunAt: Date.now(), ok: true, skippedBySchedule: true, stoppedBySchedule: true, reason: gate.reason }).catch(() => {});
          return { ok: true, stoppedBySchedule: true, reason: gate.reason };
        }
        if (!cfg.autoMonitorEnabled && !cfg.schedule?.enabled) {
          return { ok: true, skippedBySchedule: true, reason: "巡检未开启" };
        }
        if (cfg.autoMonitorEnabled && cfg.schedule?.enabled && cfg.schedule?.mode === "window") {
          topicPinLog(`[计划] ${gate.reason}，自动暂停主页巡检`, "info");
          await saveTopicPinConfig({ ...cfg, autoMonitorEnabled: false, monitorStartedAt: 0 });
        } else {
          await syncTopicMonitorAlarm(cfg);
        }
        await saveTopicMonitorStatus({ lastRunAt: Date.now(), ok: true, skippedBySchedule: true, reason: gate.reason }).catch(() => {});
        return { ok: true, skippedBySchedule: true, reason: gate.reason };
      }
      if (!cfg.autoMonitorEnabled && !(cfg.schedule?.enabled && cfg.schedule?.mode === "window")) {
        return { ok: true, skippedBySchedule: true, reason: "巡检未开启" };
      }
      if (!cfg.autoMonitorEnabled && cfg.schedule?.enabled && cfg.schedule?.mode === "window") {
        topicPinLog(`[计划] 进入运行窗口 ${cfg.schedule.start}–${cfg.schedule.end}，自动开启主页巡检`, "info");
        await saveTopicPinConfig({ ...cfg, autoMonitorEnabled: true, monitorStartedAt: Date.now() });
      } else {
        await syncTopicMonitorAlarm(cfg);
      }
    }

    try {
      let res = typeof fetch === "function" ? await fetchLatestWeiboPostViaHttp(cfg.monitorUid) : null;
      if (!res || res.needTabFallback) {
        res = await withTopicPinBrowserLock(async () => {
          const workerTab = await ensureTopicPinWorkerTab("https://weibo.com/");
          await navigateTabAndWait(workerTab.id, `https://weibo.com/u/${cfg.monitorUid}`, 20000);
          await sleepMs(600);

          return runInMainWorld(workerTab.id, async (uid) => {
          const isLoginUrl = (u) => /passport\.weibo\.com|newlogin|login\.sina\.com|retcode=6102/i.test(String(u || ""));
          if (isLoginUrl(location.href)) {
            return { ok: false, loginRequired: true, error: "微博登录态失效，请先在当前浏览器登录 weibo.com" };
          }
          const xsrf = (document.cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("XSRF-TOKEN=")) || "").split("=")[1] || "";
          const headers = { Accept: "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" };
          if (xsrf) headers["X-XSRF-TOKEN"] = decodeURIComponent(xsrf);

          const parseJsonResp = async (url) => {
            try {
              const r = await fetch(url, { credentials: "include", headers });
              if (isLoginUrl(r.url)) return { loginRequired: true };
              const text = await r.text();
              let json = null;
              try { json = JSON.parse(text); } catch {}
              return { httpOk: r.ok, status: r.status, url: r.url, json, text: text.slice(0, 180) };
            } catch (e) {
              return { httpOk: false, status: 0, error: e.message };
            }
          };

          const toPost = (item) => {
            if (!item || typeof item !== "object") return null;
            const id = String(item.id || item.idstr || "").trim();
            if (!id) return null;
            const mblogid = String(item.mblogid || "").trim();
            const textRaw = item.text_raw || item.text || "";
            const text = String(textRaw).replace(/<[^>]+>/g, "");
            return {
              post: {
                id,
                mblogid,
                url: mblogid ? `https://weibo.com/${uid}/${mblogid}` : `https://weibo.com/detail/${id}`,
                text,
                isVote: false,
              },
              postRaw: {
                is_vote: item.is_vote,
                vote: item.vote,
                vote_id: item.vote_id,
                title: item.title,
                page_info: item.page_info,
                url_struct: item.url_struct,
                text_raw: textRaw,
                text: item.text,
                raw_text: item.raw_text,
              },
            };
          };

          // 1. 优先主页 mymblog 接口
          const myRes = await parseJsonResp(`https://weibo.com/ajax/statuses/mymblog?uid=${encodeURIComponent(uid)}&page=1&feature=0`);
          if (myRes.loginRequired || myRes.json?.ok === -100 || isLoginUrl(myRes.json?.url)) {
            return { ok: false, loginRequired: true, error: "微博登录态失效，请先在当前浏览器登录 weibo.com" };
          }
          const myList = Array.isArray(myRes.json?.data?.list) ? myRes.json.data.list : [];
          const myFirst = myList.find((it) => !it.isTop && (it.id || it.idstr)) || myList.find((it) => it.id || it.idstr);
          if (myFirst) {
            return { ok: true, source: "mymblog", ...toPost(myFirst) };
          }

          // 2. 兜底 feed timeline 接口
          const feedRes = await parseJsonResp(`https://weibo.com/ajax/feed/friendstimeline?list_id=10001${encodeURIComponent(uid)}&refresh=4&since_id=0&count=15`);
          if (feedRes.loginRequired || feedRes.json?.ok === -100) {
            return { ok: false, loginRequired: true, error: "微博登录态失效，请先在当前浏览器登录 weibo.com" };
          }
          const feedList = feedRes.json?.statuses || feedRes.json?.data?.statuses || feedRes.json?.data?.list || [];
          const feedMatch = (Array.isArray(feedList) ? feedList : []).find((it) => {
            const owner = String(it?.user?.id || it?.user?.idstr || "");
            return (!owner || owner === String(uid)) && !it.isTop && (it.id || it.idstr);
          });
          if (feedMatch) {
            return { ok: true, source: "timeline", ...toPost(feedMatch) };
          }

          // 3. DOM 兜底（排除置顶卡片）
          const anchors = Array.from(document.querySelectorAll(`a[href*="/${uid}/"]`));
          for (const a of anchors) {
            const m = String(a.getAttribute("href") || a.href || "").match(new RegExp(`/${uid}/([A-Za-z0-9]+)`));
            if (!m) continue;
            const card = a.closest("article, [mid], [data-mid], [class*='Feed_wrap'], .card-wrap");
            const cardText = String(card?.innerText || "");
            if (cardText.includes("置顶") && anchors.length > 1) continue;
            const mid = card?.getAttribute?.("mid") || card?.getAttribute?.("data-mid") || m[1];
            const cleanCardText = cardText.replace(/\s+/g, " ").trim();
            return {
              ok: true,
              source: "dom",
              post: {
                id: String(mid),
                mblogid: m[1],
                url: `https://weibo.com/${uid}/${m[1]}`,
                text: cleanCardText,
                isVote: Boolean(card?.querySelector("a[href*='vote.weibo.com'], [class*='vote'], [class*='Vote']")),
              },
              postRaw: { text_raw: cleanCardText },
            };
          }

          const detail = myRes.error || (myRes.status && myRes.status !== 200 ? `HTTP ${myRes.status}` : "未获取到最新微博");
          return { ok: false, error: detail };
        }, [cfg.monitorUid]);
        });
      }

      if (!res?.ok || !res.post || !res.post.id) {
        const reason = res?.error || "未获取到最新微博";
        topicPinLog(`主页巡检失败: ${reason}`, res?.loginRequired ? "error" : "warn");
        await saveTopicMonitorStatus({ lastRunAt: Date.now(), ok: false, newPost: false, reason }).catch(() => {});
        return { ok: false, loginRequired: Boolean(res?.loginRequired), reason };
      }

      const resolvedIsVote = Boolean(res.post.isVote) || isVotePostPayload(res.postRaw || null, res.post.text);

      const { topicPinLastPostId } = await chrome.storage.local.get(["topicPinLastPostId"]);
      if (topicPinLastPostId === res.post.id) {
        await saveTopicMonitorStatus({
          lastRunAt: Date.now(),
          ok: true,
          newPost: false,
          postId: res.post.id,
          postUrl: res.post.url,
          reason: "",
        }).catch(() => {});
        return { ok: true, newPost: false, postId: res.post.id };
      }

      await chrome.storage.local.set({ topicPinLastPostId: res.post.id });
      const hashtags = extractHashtagsFromText(res.post.text);
      topicPinLog(`主页巡检发现新微博 (${res.post.url})，话题: ${hashtags.length ? hashtags.map((h) => `#${h}#`).join(" ") : "无"}`, "info");
      await saveTopicMonitorStatus({
        lastRunAt: Date.now(),
        ok: true,
        newPost: true,
        postId: res.post.id,
        postUrl: res.post.url,
        reason: "",
      }).catch(() => {});
      await enqueueTopicPinTask({
        mode: "auto_monitor",
        postUrl: res.post.url,
        text: res.post.text,
        hashtags,
        isVote: resolvedIsVote,
        autoPin: true,
      });
      return { ok: true, newPost: true, postId: res.post.id };
    } catch (err) {
      const reason = err?.message || String(err);
      topicPinLog(`主页巡检异常: ${reason}`, "error");
      await saveTopicMonitorStatus({ lastRunAt: Date.now(), ok: false, newPost: false, reason }).catch(() => {});
      return { ok: false, reason };
    } finally {
      if (!manual && !stoppedBySchedule) {
        const latestCfg = await getTopicPinConfig().catch(() => cfg);
        if (shouldMonitorAlarmBeArmed(latestCfg)) {
          const existing = await getChromeAlarm(TOPIC_PIN_ALARM_MONITOR);
          if (!existing) await syncTopicMonitorAlarm(latestCfg).catch(() => {});
        }
      }
    }
  })();

  topicMonitorRunningPromise = runPromise;
  try {
    return await runPromise;
  } finally {
    if (topicMonitorRunningPromise === runPromise) {
      topicMonitorRunningPromise = null;
    }
  }
}
