/**
 * service_worker.js - 稳健直通版后台调度引擎 (Manifest V3)
 * 彻底解决：
 * 1. "Could not establish connection. Receiving end does not exist"
 * 2. "Cannot access contents of the page" (针对 Tab Wrangler / Chrome 内存节省程序导致的 discarded/unloaded 休眠标签页自动唤醒重载，以及 CAS 登录重定向精确识别)
 */

if (typeof importScripts === "function") {
  importScripts("topic_pinner.js");
}

let state = {
  isRunning: false,
  stage: "准备就绪",
  percentage: 0,
  logs: [],
  lastSummary: null,
};

let activeJob = null;
let pipelineReservation = null;

const stateReady = chrome.storage.local.get(["pipelineState"]).then((res) => {
  if (res.pipelineState) {
    state = { ...state, ...res.pipelineState, isRunning: false };
    if (res.pipelineState.isRunning) state.stage = "上次任务已中断，请核对发布回执";
  }
}).catch((error) => console.error("恢复流水线状态失败:", error));

// 仅内存态：标记当前确实在执行提交的待核对记录，防止运行期间被人工补录/解除。
// Service Worker 重启后自动清空，此时流水线已中断，记录转为可人工核对的待确认状态。
const activePendingSubmissionIds = new Set();

let scheduleMutationQueue = Promise.resolve();
function withScheduleMutation(operation) {
  const result = scheduleMutationQueue.then(operation);
  scheduleMutationQueue = result.catch((error) => console.warn("定时队列操作失败:", error.message));
  return result;
}

async function updateScheduledTask(taskId, updates) {
  return withScheduleMutation(async () => {
    const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
    const updated = scheduledTasks.map((task) => task.id === taskId ? { ...task, ...updates } : task);
    await chrome.storage.local.set({ scheduledTasks: updated });
  });
}

// 初始化防盗链请求头修改规则 (docs.qq.com 防盗链 & 扩展后台直连微博 API Referer/Origin 对齐)
function initRefererRules() {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return;
  const rules = [
    {
      id: 1001,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Referer", operation: "set", value: "https://docs.qq.com/" }
        ]
      },
      condition: {
        urlFilter: "docs.qq.com",
        resourceTypes: ["xmlhttprequest", "image", "other", "sub_frame"]
      }
    }
  ];

  const extId = chrome?.runtime?.id;
  if (extId) {
    const weiboSites = [
      { idBase: 1002, originIdBase: 1005, urlFilter: "||weibo.com/", excludedRequestDomains: ["s.weibo.com", "m.s.weibo.com"], referer: "https://weibo.com/", origin: "https://weibo.com", prio: 1 },
      { idBase: 1003, originIdBase: 1006, urlFilter: "||s.weibo.com/", excludedRequestDomains: ["m.s.weibo.com"], referer: "https://s.weibo.com/", origin: "https://s.weibo.com", prio: 2 },
      { idBase: 1004, originIdBase: 1007, urlFilter: "||m.s.weibo.com/", excludedRequestDomains: undefined, referer: "https://m.s.weibo.com/", origin: "https://m.s.weibo.com", prio: 3 }
    ];
    for (const site of weiboSites) {
      const baseCond = {
        urlFilter: site.urlFilter,
        initiatorDomains: [extId],
        resourceTypes: ["xmlhttprequest"],
        ...(site.excludedRequestDomains ? { excludedRequestDomains: site.excludedRequestDomains } : {})
      };
      rules.push({
        id: site.idBase,
        priority: site.prio,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "Referer", operation: "set", value: site.referer }] },
        condition: baseCond
      });
      rules.push({
        id: site.originIdBase,
        priority: site.prio + 3,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "set", value: site.origin }] },
        condition: { ...baseCond, requestMethods: ["post"] }
      });
    }
  }

  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1001, 1002, 1003, 1004, 1005, 1006, 1007],
    addRules: rules
  }).catch((e) => console.warn("DeclarativeNetRequest init:", e));
}
initRefererRules();
if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(initRefererRules);
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(initRefererRules);

function syncState() {
  chrome.storage.local.set({ pipelineState: state }).catch((error) => console.error("保存流水线状态失败:", error));
}

function appendLog(detail, level = "info") {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const entry = { time, detail, level };
  state.logs.push(entry);
  if (state.logs.length > 150) state.logs.shift();
  syncState();

  chrome.runtime.sendMessage({
    action: "PIPELINE_LOG",
    payload: entry,
  }).catch(() => {});
}

function updateProgress(stage, percentage) {
  state.stage = stage;
  state.percentage = percentage;
  syncState();

  chrome.runtime.sendMessage({
    action: "PIPELINE_PROGRESS",
    payload: { stage, percentage, isRunning: state.isRunning },
  }).catch(() => {});
}

function isProtectedBrowserUrl(url) {
  if (!url) return true;
  const u = String(url).trim().toLowerCase();
  return (
    u.startsWith("chrome:") ||
    u.startsWith("edge:") ||
    u.startsWith("about:") ||
    u.startsWith("chrome-extension:") ||
    u.startsWith("chrome-error:") ||
    u.startsWith("devtools:") ||
    u.startsWith("view-source:")
  );
}

// ─────────────────────────────────────────────────────────────
// 等待标签页真正加载完毕（主动唤醒 discarded 休眠页 + 400ms 轮询双保险）
// ─────────────────────────────────────────────────────────────
function isMissingTabError(error) {
  return /No tab with id/i.test(String(error?.message || error || ""));
}

async function waitForTabLoaded(tabId, maxWaitMs = 12000, expectNav = false) {
  const startTime = Date.now();

  // 若刚刚发起了 update/reload 导航，先短暂停顿等待浏览器广播 loading 状态，杜绝误读旧页面的 complete 状态！
  if (expectNav) {
    await new Promise((r) => setTimeout(r, 450));
  }

  try {
    const initialTab = await chrome.tabs.get(tabId);
    if (initialTab && (initialTab.discarded || initialTab.status === "unloaded")) {
      appendLog(`检测到标签页 [${initialTab.title || initialTab.url || tabId}] 处于休眠状态，正在后台唤醒重载...`, "info");
      await chrome.tabs.reload(tabId).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    } else if (
      !expectNav &&
      initialTab &&
      initialTab.status === "complete" &&
      !initialTab.discarded &&
      !initialTab.pendingUrl &&
      initialTab.url &&
      !isProtectedBrowserUrl(initialTab.url)
    ) {
      return initialTab;
    }
  } catch (error) {
    if (isMissingTabError(error)) throw new Error(`标签页 [${tabId}] 已关闭或不存在，无法继续注入`);
  }

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) {
        if (tab.discarded || tab.status === "unloaded") {
          await chrome.tabs.reload(tabId).catch(() => {});
        } else if (
          tab.status === "complete" &&
          tab.url &&
          !isProtectedBrowserUrl(tab.url)
        ) {
          // 二次确认：停顿 200ms 再次核对仍为 complete，确保主 Frame 0 没有发生瞬时二次重定向
          await new Promise((r) => setTimeout(r, 200));
          const verifyTab = await chrome.tabs.get(tabId).catch(() => null);
          if (verifyTab && verifyTab.status === "complete" && !verifyTab.discarded && !verifyTab.pendingUrl && !isProtectedBrowserUrl(verifyTab.url) && verifyTab.url === tab.url) {
            return verifyTab;
          }
        }
      }
    } catch (error) {
      if (isMissingTabError(error)) throw new Error(`标签页 [${tabId}] 已关闭或不存在，无法继续注入`);
      break;
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  throw new Error(`标签页 [${tabId}] 加载超时，尚未进入可注入的就绪状态`);
}

// ─────────────────────────────────────────────────────────────
// 原生直通执行封装 (支持自动唤醒 discarded 标签页 + 注入前稳态防 Frame 0 移除保护)
// ─────────────────────────────────────────────────────────────
async function executeInTabDirect(tabId, func, args = [], world = "MAIN", reloadUrl = "", allowRetry = true, isCancelled = null, timeoutMs = 120000) {
  async function tryInjectOnce(targetWorld) {
    if (isCancelled && isCancelled()) throw new Error("流水线已手动取消，未注入发布操作");
    let injectionResults = null;
    let timerId = null;
    let cancelTimerId = null;
    try {
      const execPromise = chrome.scripting.executeScript({
        target: { tabId },
        world: targetWorld,
        func: func,
        args: args,
      });
      const injectStart = Date.now();
      const racers = [execPromise];
      if (timeoutMs > 0) {
        racers.push(
          new Promise((_, reject) => {
            timerId = setTimeout(() => {
              if (timeoutMs <= 1000 || Date.now() - injectStart >= timeoutMs - 50) {
                reject(new Error(`页面脚本执行超时 (${Math.round(timeoutMs / 1000)}秒)`));
              }
            }, timeoutMs);
          })
        );
      }
      if (allowRetry && typeof isCancelled === "function") {
        racers.push(
          new Promise((_, reject) => {
            cancelTimerId = setInterval(() => {
              if (isCancelled()) {
                reject(new Error("流水线已手动取消，未注入发布操作"));
              }
            }, 300);
          })
        );
      }
      injectionResults = racers.length > 1 ? await Promise.race(racers) : await execPromise;
    } catch (e) {
      throw new Error(`executeScript 注入异常: ${e.message || String(e)}`);
    } finally {
      if (timerId) clearTimeout(timerId);
      if (cancelTimerId) clearInterval(cancelTimerId);
    }

    if (!injectionResults || !injectionResults[0]) {
      throw new Error("注入执行未返回结果");
    }

    const first = injectionResults[0];
    if (first.error) {
      throw new Error(`页面执行报错: ${first.error.message || JSON.stringify(first.error)}`);
    }

    if (first.result === undefined || first.result === null) {
      let diagTab = null;
      try {
        diagTab = await chrome.tabs.get(tabId);
      } catch (_) {}
      const curUrl = String(diagTab?.url || "").toLowerCase();
      const isLoginRedirect =
        curUrl.includes("cas.erp.sina.com.cn") ||
        curUrl.includes("passport.weibo.com") ||
        curUrl.includes("login.sina.com.cn") ||
        curUrl.includes("login.php");
      if (isLoginRedirect) {
        throw new Error(
          `发稿中台已自动跳转至登录页（登录态可能已过期或触发SSO重定向）[${diagTab.url}]，执行已中断`
        );
      }
      const diagMsg = diagTab
        ? `[当前URL: ${diagTab.url || "空"}, 标题: ${diagTab.title || "无"}, 状态: ${diagTab.status}, 休眠: ${diagTab.discarded}]`
        : `[tabId: ${tabId}]`;
      throw new Error(`页面执行函数返回了空结果 (undefined/null)，发稿中台页面可能处于刷新跳转或未挂载态 ${diagMsg}`);
    }

    return first.result;
  }

  // 1. 注入前检查标签页是否休眠、空白或正处于 loading 导航切换态（绝对避免撞在 Frame 0 销毁瞬间注入！）
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    if (isMissingTabError(error)) throw new Error(`标签页 [${tabId}] 已关闭或不存在，无法继续注入`);
    throw error;
  }
  if (!tab) {
    throw new Error(`目标标签页 [${tabId}] 不存在或已被关闭`);
  }

  if (tab.discarded || tab.status === "unloaded" || !tab.url || isProtectedBrowserUrl(tab.url)) {
    appendLog(`正在唤醒并加载目标页面...`, "info");
    if (reloadUrl && reloadUrl.startsWith("http")) {
      await chrome.tabs.update(tabId, { url: reloadUrl }).catch(() => {});
      tab = await waitForTabLoaded(tabId, 12000, true);
    } else {
      await chrome.tabs.reload(tabId).catch(() => {});
      tab = await waitForTabLoaded(tabId, 12000, true);
    }
    await new Promise((r) => setTimeout(r, 1000));
  } else if (tab.status === "loading") {
    tab = await waitForTabLoaded(tabId, 10000, false);
    await new Promise((r) => setTimeout(r, 500));
  }

  tab = await chrome.tabs.get(tabId);
  if (!tab || tab.status !== "complete" || tab.discarded || tab.pendingUrl || isProtectedBrowserUrl(tab.url)) {
    throw new Error(`目标标签页 [${tabId}] 尚未就绪，已阻断注入`);
  }

  try {
    return await tryInjectOnce(world);
  } catch (firstErr) {
    // 注入报错不能证明页面函数未产生副作用，非幂等操作绝不重放。
    if (!allowRetry) throw firstErr;
    const errMsg = String(firstErr?.message || firstErr || "");

    // 3. 若报 Cannot access contents of the page，说明该 Tab 处于假死/错误页/未就绪状态，执行静默刷新自愈 (绝不强行抢占用户前台焦点)
    if (errMsg.includes("Cannot access") || errMsg.includes("permission") || errMsg.includes("Frame")) {
      appendLog(`检测到目标标签页未就绪，正在静默刷新重试...`, "warn");
      const targetUrl = reloadUrl || tab.url;
      if (targetUrl && targetUrl.startsWith("http")) {
        await chrome.tabs.update(tabId, { url: targetUrl }).catch(() => {});
      } else {
        await chrome.tabs.reload(tabId).catch(() => {});
      }
      await waitForTabLoaded(tabId, 12000);
      await new Promise((r) => setTimeout(r, 1500));

      try {
        return await tryInjectOnce(world);
      } catch (retryErr) {
        const diagTab = await chrome.tabs.get(tabId).catch(() => null);
        const diagInfo = diagTab
          ? `[当前URL: ${diagTab.url || "空"}, 标题: ${diagTab.title || "无"}, 状态: ${diagTab.status}, 休眠: ${diagTab.discarded}]`
          : `[tabId: ${tabId}]`;
        throw new Error(
          `无法访问目标网页内容 ${diagInfo}。请检查浏览器中该标签页是否显示“无法访问此网站”（代理拦截了内网域名）或跳转到了登录页。原始信息: ${retryErr.message}`
        );
      }
    }

    throw firstErr;
  }
}

// ─────────────────────────────────────────────────────────────
// 直通函数 1：云文档待发内容提取 (直接注入到腾讯文档/钉钉页面运行)
// ─────────────────────────────────────────────────────────────
function directExtractDocTasks(targetSheetId, linkColLetter, filterAccount, strictRead = false) {
  try {
    const app = window.SpreadsheetApp;
    const wb = app && app.workbook;
    const tools = app && app.e2eTools;
    const list = (wb && wb.worksheetManager && wb.worksheetManager.sheetList) || [];

    if (wb && tools && list.length) {
      let target = null;
      if (targetSheetId) {
        target = list.find((s) => s.getSheetId && s.getSheetId() === targetSheetId);
        if (!target) return { ok: false, error: `未找到指定子表 [${targetSheetId}]，已阻断扫描` };
      }
      if (!target) {
        target = list.find((s) => s.getIsInitialized && s.getIsInitialized()) || list[0];
      }

      if (target) {
        const sid = target.getSheetId();
        const rowCount = target.getRowCount();
        const colCount = target.getColCount();

        let headerRow = 1;
        let accountCol = -1;
        let contentCol = -1;
        let linkCol = -1;
        let timeCol = -1;
        let materialCol = -1;

        const _BRIEF_EXCLUDE = [
          "brief", "bf", "方向", "要求", "说明", "分类", "标签",
          "类型", "分组", "大纲", "指南", "提示", "建议", "备注"
        ];

        const normHeader = (t) => String(t || "").replace(/[\s　()（）:：/\\_-]+/g, "").trim().toLowerCase();

        // 账号列打分器 (100% 对齐原系统 tencent_sheet_browser.py:1396-1416)
        const scoreAccountHeader = (raw) => {
          const norm = normHeader(raw);
          if (!norm) return -10000;
          if (["账号类型", "账号类别", "账号属性", "类型", "类别"].includes(norm)) return -10000;
          if (["账号", "账号名", "账号名称", "账号显示", "发布账号", "媒体账号", "账户名", "账户名称"].includes(norm)) return 100;
          if (["名称", "作者", "用户", "博主"].includes(norm)) return 30;
          if (["账号名称", "账号名", "发布账号", "媒体账号", "账户名"].some((k) => norm.startsWith(k) || norm.endsWith(k))) return 60;
          if (norm.includes("账号") || norm.includes("账户")) return 40;
          return -10000;
        };

        // 智能多阶段表头探测评分体系 (支持多表头行与复杂说明列防误判)
        let bestHeaderScore = -1;

        for (let r = 0; r < Math.min(20, rowCount); r++) {
          const rowHeaders = {};
          for (let c = 0; c < Math.min(40, colCount); c++) {
            const cell = target.getCellDataAtPosition(r, c);
            if (!cell) continue;
            let val = "";
            try {
              val = (tools.getCellEditValue(wb, r, c, sid, cell) || "").toString().trim();
            } catch (_) {}
            if (val) rowHeaders[c] = val;
          }

          // 阶段 1：精确全字匹配正文文案列（最高优先级，绝不误判文案BF等需求列）
          let cCol = Object.keys(rowHeaders).find((c) => {
            const n = normHeader(rowHeaders[c]);
            return ["文案", "正文", "微博正文", "微博文案", "文本文案", "博文文案", "博文正文", "博文内容", "发布内容"].includes(n);
          });

          // 阶段 2：模糊包含"文案"或"正文"，但严格排除 brief / bf / 方向 / 要求等辅助词
          if (cCol === undefined) {
            cCol = Object.keys(rowHeaders).find((c) => {
              const n = normHeader(rowHeaders[c]);
              return (n.includes("文案") || n.includes("正文")) && !_BRIEF_EXCLUDE.some((b) => n.includes(b));
            });
          }

          // 阶段 3：模糊包含"内容"或"文本"，排除辅助词
          if (cCol === undefined) {
            cCol = Object.keys(rowHeaders).find((c) => {
              const n = normHeader(rowHeaders[c]);
              return (n.includes("内容") || n.includes("文本")) && !_BRIEF_EXCLUDE.some((b) => n.includes(b));
            });
          }

          // 评估账号列最高得分 (排除"账号类型"一票否决词)
          let bestAcctCol = -1;
          let maxAcctScore = -10000;
          for (const c of Object.keys(rowHeaders)) {
            if (cCol !== undefined && parseInt(c, 10) === parseInt(cCol, 10)) continue;
            const score = scoreAccountHeader(rowHeaders[c]);
            if (score > maxAcctScore) {
              maxAcctScore = score;
              bestAcctCol = parseInt(c, 10);
            }
          }

          // 评估链接/回写列。素材链接、参考链接不能压过真正的回写列。
          const scoreLinkHeader = (raw) => {
            const n = normHeader(raw);
            if (!n) return -10000;
            if (["素材", "配图", "物料", "图片", "参考"].some((word) => n.includes(word))) return -10000;
            if (["微博链接", "博文链接", "回写", "回执"].some((word) => n.includes(word))) return 100;
            if (["链接", "网址", "url"].some((word) => n === word || n.endsWith(word))) return 70;
            if (["原文链接", "跳转链接"].includes(n)) return 50;
            if (n.includes("链接") || n.includes("url")) return 40;
            return -10000;
          };
          let lCol;
          let bestLinkScore = -10000;
          for (const c of Object.keys(rowHeaders)) {
            const score = scoreLinkHeader(rowHeaders[c]);
            if (score > bestLinkScore) {
              bestLinkScore = score;
              lCol = c;
            }
          }
          if (bestLinkScore <= 0) lCol = undefined;

          // 评估物料/素材列
          let mCol = Object.keys(rowHeaders).find((c) => {
            const n = normHeader(rowHeaders[c]);
            return ["素材", "物料", "图片", "配图", "media", "image"].some((k) => n.includes(k));
          });

          // 评估时间列
          let tCol = Object.keys(rowHeaders).find((c) => {
            const n = normHeader(rowHeaders[c]);
            return ["时间", "发布时间", "排期", "日期", "时刻"].some((k) => n.includes(k));
          });

          let rowScore = 0;
          if (cCol !== undefined) rowScore += 50;
          if (maxAcctScore > 0) rowScore += 40;
          if (lCol !== undefined) rowScore += 20;
          if (mCol !== undefined) rowScore += 15;
          if (tCol !== undefined) rowScore += 10;

          if (rowScore > bestHeaderScore) {
            bestHeaderScore = rowScore;
            headerRow = r + 1;
            contentCol = cCol !== undefined ? parseInt(cCol, 10) : -1;
            accountCol = bestAcctCol !== -1 && maxAcctScore > 0 ? bestAcctCol : -1;
            linkCol = lCol !== undefined ? parseInt(lCol, 10) : -1;
            materialCol = mCol !== undefined ? parseInt(mCol, 10) : -1;
            timeCol = tCol !== undefined ? parseInt(tCol, 10) : -1;
          }
        }

        if (linkCol === -1) {
          const letter = String(linkColLetter || "E").trim().toUpperCase();
          if (!/^[A-Z]+$/.test(letter)) return { ok: false, error: "回写列必须为有效列字母" };
          linkCol = Array.from(letter).reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        }
        if (contentCol === -1) {
          return { ok: false, error: "未识别到正文/文案列，已阻断扫描，避免把其他列当成博文发布" };
        }
        // 账号列缺失时不要落到正文列上，否则整段文案会被当成账号名。
        if (accountCol === -1 && contentCol !== 1) accountCol = 1;

        const colLetter = (c) => {
          let letters = "";
          for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) {
            letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
          }
          return letters;
        };
        const tasks = [];
        let carriedAccount = "";

        // 提取单元格中的图片/物料 URL 辅助函数 (全面覆盖 docimg、=IMAGE公式、多层属性与附件)
        const extractImagesFromCell = (cData, cVal) => {
          const found = [];
          if (!cData && !cVal) return found;

          const grabUrlsFromText = (raw) => {
            if (!raw || typeof raw !== "string") return;
            // 1. 规范的 http/https 图片直链
            const urls = raw.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
            for (let u of urls) {
              const clean = u.replace(/["'<>)\];,]+$/, "");
              if (
                clean.includes("docimg") ||
                clean.includes("docs.qq.com/image") ||
                clean.includes("qpic.cn") ||
                clean.includes("myqcloud.com") ||
                clean.includes("sinaimg.cn") ||
                clean.includes("alidocs.dingtalk.com") ||
                /\.(?:png|jpe?g|webp|gif|bmp)(?:\?[^\s"'<>\\]*)?$/i.test(clean)
              ) {
                if (!found.includes(clean)) found.push(clean);
              }
            }
            // 2. 匹配无协议头的 docimg 链接 (如 docimg5.docs.qq.com/image/...)
            const docimgMatches = raw.match(/(?:https?:\/\/)?(docimg\d*\.docs\.qq\.com\/image\/[^\s"'<>\\]+)/g) || [];
            for (let dm of docimgMatches) {
              let full = dm.replace(/["'<>)\];,]+$/, "");
              if (!full.startsWith("http")) full = "https://" + full;
              if (!found.includes(full)) found.push(full);
            }
          };

          // A. 文本与公式值扫描 (包含 =IMAGE("...") 等函数)
          grabUrlsFromText(cVal);

          // B. 单元格对象内部属性全扫描 (防御 JSON.stringify 异常)
          if (cData && typeof cData === "object") {
            try {
              const candidates = [
                cData.v, cData.val, cData.text, cData.formula, cData.f,
                cData.userEnterValue, cData.displayValue
              ];
              for (const cd of candidates) {
                if (typeof cd === "string") grabUrlsFromText(cd);
              }
              const flat = JSON.stringify(cData);
              grabUrlsFromText(flat);
            } catch (_) {}

            // C. 单元格超链接属性
            if (cData.getCellHyperlinksInfo) {
              try {
                const hl = cData.getCellHyperlinksInfo();
                if (hl && Array.isArray(hl.hyperlinksInfo)) {
                  for (const item of hl.hyperlinksInfo) {
                    const u = item.hyperlink?.url;
                    if (u) grabUrlsFromText(u);
                  }
                }
              } catch (_) {}
            }
          }

          return found;
        };

        for (let r = headerRow; r < rowCount; r++) {
          let acctVal = "";
          if (accountCol !== -1) {
            const acctCell = target.getCellDataAtPosition(r, accountCol);
            try {
              acctVal = (tools.getCellEditValue(wb, r, accountCol, sid, acctCell) || "").toString().trim();
            } catch (error) { if (strictRead) throw error; }
          }
          if (acctVal) carriedAccount = acctVal;
          else acctVal = carriedAccount;

          const contentCell = target.getCellDataAtPosition(r, contentCol);
          let contentVal = "";
          try {
            contentVal = (tools.getCellEditValue(wb, r, contentCol, sid, contentCell) || "").toString().trim();
          } catch (error) { if (strictRead) throw error; }
          if (!contentVal) continue;

          const linkCell = target.getCellDataAtPosition(r, linkCol);
          let linkVal = "";
          try {
            linkVal = (tools.getCellEditValue(wb, r, linkCol, sid, linkCell) || "").toString().trim();
          } catch (error) { if (strictRead) throw error; }
          if (!linkVal && linkCell && linkCell.getCellHyperlinksInfo) {
            try {
              const hl = linkCell.getCellHyperlinksInfo();
              if (hl && hl.hyperlinksInfo && hl.hyperlinksInfo[0]) {
                linkVal = hl.hyperlinksInfo[0].hyperlink?.url || "";
              }
            } catch (error) { if (strictRead) throw error; }
          }
          if (linkVal) continue;

          let timeVal = "";
          if (timeCol !== -1) {
            const tCell = target.getCellDataAtPosition(r, timeCol);
            try {
              timeVal = (tools.getCellEditValue(wb, r, timeCol, sid, tCell) || "").toString().trim();
            } catch (_) {}
          }

          if (filterAccount) {
            if (!acctVal || (!acctVal.includes(filterAccount) && !filterAccount.includes(acctVal))) continue;
          }

          // 提取该行的配图与物料 (多图与全行探测支持)
          const rowImages = [];
          if (materialCol !== -1) {
            const matCell = target.getCellDataAtPosition(r, materialCol);
            let matVal = "";
            try {
              matVal = (tools.getCellEditValue(wb, r, materialCol, sid, matCell) || "").toString().trim();
            } catch (_) {}
            const imgs = extractImagesFromCell(matCell, matVal);
            for (const img of imgs) {
              if (!rowImages.includes(img)) rowImages.push(img);
            }
          }

          // 弹性全行探测：扫描整行除内容/链接/账号/时间列外的其他单元格，收集整行配图 (不提前 break，支持多图)
          const maxScan = Math.min(colCount, 35);
          for (let c = 0; c < maxScan; c++) {
            if (c === contentCol || c === linkCol || c === accountCol || c === timeCol || c === materialCol) continue;
            const otherCell = target.getCellDataAtPosition(r, c);
            if (!otherCell) continue;
            let otherVal = "";
            try {
              otherVal = (tools.getCellEditValue(wb, r, c, sid, otherCell) || "").toString().trim();
            } catch (_) {}
            const imgs = extractImagesFromCell(otherCell, otherVal);
            for (const img of imgs) {
              if (!rowImages.includes(img)) rowImages.push(img);
            }
          }

          tasks.push({
            row: r + 1,
            account: acctVal,
            content: contentVal,
            time: timeVal,
            targetCell: `${colLetter(linkCol)}${r + 1}`,
            targetSheetId: sid,
            writeSnapshot: { sheetId: sid, row: r + 1, contentCol, accountCol, linkCol, headerRow, content: contentVal, account: acctVal, link: "" },
            link: "",
            imgUrls: rowImages,
            materialCol: materialCol !== -1 ? colLetter(materialCol) : "",
          });
        }

        return {
          ok: true,
          provider: "SpreadsheetApp",
          sheetName: target.getSheetName ? target.getSheetName() : sid,
          tasks,
        };
      }
    }

    // 页面 DOM 的行号和分列都不可靠，猜出来会发错文案或写错单元格。
    if (targetSheetId) return { ok: false, error: `无法验证指定子表 [${targetSheetId}]，请等待表格运行时加载` };
    return { ok: false, error: "腾讯文档表格运行时尚未就绪，已阻断页面文本猜测，请等表格加载完成后再扫描" };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ─────────────────────────────────────────────────────────────
// 直通函数 2：微博发稿中台发博操作 (100% 对齐 5000 端口 server.py 与 post.js)
// ─────────────────────────────────────────────────────────────
async function directCheckWeiboPlatformReady() {
  try {
    const currentHref = String(window.location.href || "");
    const lowerHref = currentHref.toLowerCase();
    const bodyText = String(document.body?.innerText || "");
    if (
      lowerHref.includes("cas.erp.sina.com.cn") ||
      lowerHref.includes("passport.weibo.com") ||
      lowerHref.includes("login.sina.com.cn") ||
      lowerHref.includes("login.php") ||
      bodyText.includes("统一登录") ||
      bodyText.includes("暂无权限")
    ) {
      return {
        ok: false,
        needLogin: true,
        url: currentHref,
        error: `发稿中台当前未登录或处于登录跳转页 [${window.location.hostname}]，请先在该标签页完成登录！`,
      };
    }
    const textarea =
      document.querySelector('textarea[placeholder*="微博内容"]') ||
      document.querySelector('textarea[placeholder*="新鲜事"]') ||
      document.querySelector('.n-input textarea') ||
      document.querySelector('textarea');
    const selectorNodes = Array.from(document.querySelectorAll('.account_selector_checkbox'));
    const accountNodes = selectorNodes.length > 0
      ? selectorNodes
      : Array.from(document.querySelectorAll('.n-checkbox__label'));
    const hasAccountCheckboxes = accountNodes.length > 0;
    const isNonAccountOption = (name) => !name || name.length < 2 || name.length > 32
      || /^(全选|全不选|反选|取消|确认|确定|发布|保存并发布|定时发布|仅看已选)$/.test(name)
      || /(?:仅蓝v|仅视频|同时评论|评论给原微博|仅自己可见)/i.test(name);
    const accounts = Array.from(new Set(
      accountNodes
        .map((el) => String(el.textContent || "").trim())
        .filter((name) => !isNonAccountOption(name))
    ));
    return {
      ok: true,
      ready: !!(textarea && hasAccountCheckboxes),
      url: currentHref,
      accounts,
    };
  } catch (e) {
    return { ok: false, ready: false, error: String(e.message || e) };
  }
}

async function directPostToWeiboPlatform(task, isDryRun) {
  let submitted = false;
  try {
    // 0. 检查当前页面是否处于登录页或无权限页
    const currentHref = String(window.location.href || "");
    const bodyText = String(document.body?.innerText || "");
    if (
      currentHref.includes("cas.erp.sina.com.cn") ||
      currentHref.includes("passport.weibo.com") ||
      currentHref.includes("login.sina.com.cn") ||
      bodyText.includes("统一登录") ||
      bodyText.includes("暂无权限")
    ) {
      return {
        ok: false,
        error: `发稿中台当前未登录或处于登录跳转页 [${window.location.hostname}]，请先在该标签页完成登录！`,
      };
    }

    // 0.4 前置清理：若页面停留着上一次发布成功的“复制链接”弹窗或二次确认弹窗，温和关闭但不破坏 Vue Teleport 容器
    try {
      const activeModals = Array.from(document.querySelectorAll('.n-dialog, .n-modal, [role="dialog"]')).filter(isVisible);
      if (activeModals.length > 0) {
        for (const m of activeModals) {
          const closeBtn = m.querySelector('.n-dialog__close, .n-base-close, .n-modal-close, [aria-label="close"], [aria-label="Close"]');
          if (!closeBtn) return { ok: false, submitted: false, error: "页面存在未关闭的弹窗，请先手动取消或关闭后重试" };
          closeBtn.click();
        }
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (_) {}

    // 等待发博页核心组件 (textarea + 账号复选框) 渲染就绪（最多等待 10 秒）
    let textarea = null;
    for (let retry = 0; retry < 20; retry++) {
      textarea =
        document.querySelector('textarea[placeholder*="微博内容"]') ||
        document.querySelector('textarea[placeholder*="新鲜事"]') ||
        document.querySelector('.n-input textarea') ||
        document.querySelector('textarea');
      const hasCheckboxes = document.querySelectorAll('.n-checkbox, input[type="checkbox"]').length > 0;
      if (textarea && hasCheckboxes) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!textarea) {
      return {
        ok: false,
        error: `未找到发稿中台的内容输入框 (当前页面: ${document.title || window.location.href})，请确认已登录并具有发博权限`,
      };
    }

    const rawAccountList = Array.isArray(task.accounts) && task.accounts.length > 0
      ? task.accounts
      : (task.account ? [task.account] : []);
    const targetAccounts = rawAccountList
      .flatMap((a) => String(a || "").split(/[、，,]+/))
      .map((a) => a.trim())
      .filter(Boolean);
    const targetAccount = targetAccounts[0] || "";
    const content = (task.content || "").trim();
    if (!content) return { ok: false, submitted: false, error: "发博内容为空" };

    const norm = (s) =>
      String(s || "")
        .replace(/\s+/g, "")
        .trim()
        .toLowerCase()
        .replace(/[^0-9a-z一-鿿]/g, "");

    const stripParens = (str) => String(str || "").replace(/[（(].*?[）)]/g, "").trim();
    const targetSpecs = targetAccounts.map((raw) => {
      const clean = stripParens(raw);
      return {
        raw,
        clean,
        norm: norm(raw),
        baseNorm: norm(clean),
      };
    }).filter((s) => s.norm || s.baseNorm);
    const targetNormSet = new Set();
    for (const s of targetSpecs) {
      if (s.norm) targetNormSet.add(s.norm);
      if (s.baseNorm) targetNormSet.add(s.baseNorm);
    }

    const isVisible = (node) => {
      if (!node) return false;
      try {
        const style = window.getComputedStyle(node);
        if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return (rect.width > 0 && rect.height > 0) || node.getClientRects().length > 0 || !!(node.offsetWidth || node.offsetHeight);
      } catch (_) {
        return true;
      }
    };

    const isBoxChecked = (el) => {
      const root = el.closest?.('.n-checkbox, [role="checkbox"], label') || el;
      const input = root.querySelector?.('input[type="checkbox"]');
      if (input) return !!input.checked;
      return (
        root.classList?.contains("n-checkbox--checked") ||
        root.classList?.contains("is-checked") ||
        root.getAttribute?.("aria-checked") === "true"
      );
    };

    // 1. 先清理当前页面已勾选的非目标账号复选框（严格仅清除账号列表项，不影响“同时评论”等配置）
    const clearOtherCheckedAccounts = async () => {
      const checkedBoxes = Array.from(document.querySelectorAll(
        '.account_selector_checkbox.n-checkbox--checked, .account_selector_checkbox[aria-checked="true"], .n-checkbox.n-checkbox--checked, .n-checkbox.is-checked, [role="checkbox"][aria-checked="true"]'
      ));
      const outermostChecked = checkedBoxes.filter((cb) => !checkedBoxes.some((other) => other !== cb && typeof other.contains === "function" && other.contains(cb)));
      let clickedAny = false;
      if (targetNormSet.size > 0) {
        for (const cb of outermostChecked) {
          if (!isVisible(cb)) continue;
          const txt = (cb.innerText || cb.textContent || "").trim();
          const lines = txt.split(/\n/).map((line) => line.trim()).filter(Boolean);
          if (lines.length !== 1) continue;
          const checkedNorm = norm(lines[0]);
          if (!checkedNorm || targetNormSet.has(checkedNorm)) continue;
          if (/评论|仅蓝v|仅视频|^全选$|仅自己可见/i.test(lines[0])) continue;
          cb.click();
          clickedAny = true;
        }
      }
      if (clickedAny) await new Promise((r) => setTimeout(r, 150));
    };
    await clearOtherCheckedAccounts();

    // 2. 账号定位与安全勾选系统 (支持单号及多号群发、跨分类Tab勾选与异步渲染等待)
    let accountMatched = targetSpecs.length === 0;

    function findAccountInCurrentDom(spec) {
      if (!spec) return null;
      const candidateNodes = Array.from(
        document.querySelectorAll(
          '.n-checkbox__label, .account_selector_checkbox, .account_selector_item, label, [role="checkbox"]'
        )
      );

      const matches = (expected) => {
        if (!expected) return [];
        const roots = new Set();
        for (const node of candidateNodes) {
          if (!isVisible(node)) continue;
          const rawTxt = String(node.innerText || node.textContent || "").trim();
          const firstLine = rawTxt.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
          if (norm(rawTxt) !== expected && norm(firstLine) !== expected) continue;
          const canonical = node.closest('.n-checkbox, [role="checkbox"], .account_selector_checkbox') || node.closest('label') || node;
          roots.add(canonical);
        }
        return Array.from(roots);
      };
      const exact = matches(spec.norm);
      if (exact.length) return exact.find((el) => !isBoxChecked(el)) || exact[0];
      const base = spec.baseNorm && spec.baseNorm !== spec.norm ? matches(spec.baseNorm) : [];
      return base.length ? (base.find((el) => !isBoxChecked(el)) || base[0]) : null;
    }

    async function ensureChecked(el) {
      if (!el) return false;
      el.scrollIntoView?.({ block: "center", behavior: "instant" });
      await new Promise((r) => setTimeout(r, 80));

      if (!isBoxChecked(el)) {
        el.click();
        await new Promise((r) => setTimeout(r, 120));
      }
      if (!isBoxChecked(el)) {
        const inner = el.querySelector?.('input[type="checkbox"], .n-checkbox-box, .n-checkbox__label') || el;
        inner.click?.();
        await new Promise((r) => setTimeout(r, 120));
      }
      return isBoxChecked(el);
    }

    if (targetSpecs.length > 0) {
      // 前置等待：确保中台账号列表已完成异步挂载（防止刚刷新/重定向后误报“可见账号示例: 未加载”）
      for (let waitAcc = 0; waitAcc < 20; waitAcc++) {
        if (document.querySelectorAll('.account_selector_checkbox, .n-checkbox__label').length > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      const checkedSet = new Set();
      const tryCheckPendingInCurrentDom = async () => {
        let hitAny = false;
        for (const spec of targetSpecs) {
          if (checkedSet.has(spec.raw)) continue;
          const found = findAccountInCurrentDom(spec);
          if (found && await ensureChecked(found)) {
            checkedSet.add(spec.raw);
            hitAny = true;
          }
        }
        return hitAny;
      };

      // 第一阶段：先探测当前已激活的分类 Tab (0次切换，即时命中)
      const seenAccountLabels = new Set();
      const collectVisibleLabels = () => {
        for (const n of document.querySelectorAll('.n-checkbox__label')) {
          if (!isVisible(n)) continue;
          const lbl = (n.innerText || n.textContent || "").trim();
          if (lbl) seenAccountLabels.add(lbl);
        }
      };
      collectVisibleLabels();
      await tryCheckPendingInCurrentDom();

      // 第二阶段：若仍有未勾选账号，依次遍历所有可用分类 Tab（热点、军事、垂类、填充、游戏）
      const scannedTabNames = [];
      if (checkedSet.size < targetSpecs.length) {
        const tabNodes = Array.from(
          document.querySelectorAll('.n-tabs-tab[data-name], .n-tabs-tab, [role="tab"]')
        ).filter((el) => {
          const name = String(el.getAttribute("data-name") || el.innerText || el.textContent || "").trim();
          return name && !el.classList.contains("ai_match_tab_item") && !name.includes("hot") && !name.includes("time");
        });

        for (const tabBtn of tabNodes) {
          if (checkedSet.size >= targetSpecs.length) break;
          const tName = String(tabBtn.getAttribute("data-name") || tabBtn.innerText || tabBtn.textContent || "").trim();
          if (tName) scannedTabNames.push(tName);
          tabBtn.scrollIntoView?.({ block: "nearest", behavior: "instant" });
          const clickTarget = tabBtn.querySelector?.(".n-tabs-tab__label") || tabBtn;
          try {
            clickTarget.dispatchEvent?.(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
            clickTarget.dispatchEvent?.(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
          } catch (_) {}
          clickTarget.click?.();
          if (clickTarget !== tabBtn) tabBtn.click?.();

          // 弹性等待 Naive UI 异步挂载该分类下的所有账号 (最多轮询 12 次，每 100ms 探测一次)
          for (let poll = 0; poll < 12; poll++) {
            await new Promise((r) => setTimeout(r, 100));
            const anyPending = targetSpecs.some((s) => !checkedSet.has(s.raw) && findAccountInCurrentDom(s));
            if (anyPending) break;
          }

          collectVisibleLabels();
          const checkedHere = await tryCheckPendingInCurrentDom();
          if (checkedHere) {
            await clearOtherCheckedAccounts();
          }
        }
      }

      // 第三阶段：兜底重试核心分类 Tab ("热点", "垂类", "军事", "填充", "游戏")
      if (checkedSet.size < targetSpecs.length) {
        const primaryCatNames = ["热点", "垂类", "军事", "填充", "游戏"];
        for (const catName of primaryCatNames) {
          if (checkedSet.size >= targetSpecs.length) break;
          const allTabs = Array.from(document.querySelectorAll('.n-tabs-tab'));
          const targetTab = allTabs.find((t) => {
            const tText = (t.getAttribute("data-name") || t.innerText || t.textContent || "").trim();
            return tText.includes(catName);
          });
          if (targetTab) {
            const clickTarget = targetTab.querySelector?.(".n-tabs-tab__label") || targetTab;
            clickTarget.click?.();
            if (clickTarget !== targetTab) targetTab.click?.();
            for (let poll = 0; poll < 10; poll++) {
              await new Promise((r) => setTimeout(r, 100));
              const anyPending = targetSpecs.some((s) => !checkedSet.has(s.raw) && findAccountInCurrentDom(s));
              if (anyPending) break;
            }
            collectVisibleLabels();
            const checkedHere = await tryCheckPendingInCurrentDom();
            if (checkedHere) {
              await clearOtherCheckedAccounts();
            }
          }
        }
      }

      // 第四阶段：若中台提供了账号搜索框，逐个尝试对未命中的账号过滤后匹配
      if (checkedSet.size < targetSpecs.length) {
        const searchInputs = Array.from(document.querySelectorAll('input[placeholder*="搜索"], input[placeholder*="账号"]')).filter(isVisible);
        for (const sInp of searchInputs) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          const setVal = (v) => {
            if (setter) setter.call(sInp, v);
            else sInp.value = v;
            sInp.dispatchEvent(new Event("input", { bubbles: true }));
            sInp.dispatchEvent(new Event("change", { bubbles: true }));
          };
          const prevVal = sInp.value || "";
          for (const spec of targetSpecs) {
            if (checkedSet.has(spec.raw)) continue;
            setVal(spec.clean || spec.raw);
            for (let poll = 0; poll < 8; poll++) {
              await new Promise((r) => setTimeout(r, 120));
              if (findAccountInCurrentDom(spec)) break;
            }
            const found = findAccountInCurrentDom(spec);
            if (found && await ensureChecked(found)) {
              checkedSet.add(spec.raw);
            }
          }
          setVal(prevVal);
          await new Promise((r) => setTimeout(r, 100));
          if (checkedSet.size >= targetSpecs.length) break;
        }
      }

      const missingSpecs = targetSpecs.filter((s) => !checkedSet.has(s.raw));
      accountMatched = missingSpecs.length === 0;

      if (!accountMatched) {
        collectVisibleLabels();
        const allVisibleLabels = Array.from(seenAccountLabels);
        const availableAccounts = allVisibleLabels
          .slice(0, 20)
          .join("、");
        const tabDiag = scannedTabNames.length ? `；已扫描分类Tab(${scannedTabNames.length}): ${scannedTabNames.slice(0, 12).join("、")}` : "";
        const missingLabel = missingSpecs.map((s) => s.raw).join("、");

        return {
          ok: false,
          submitted: false,
          error: `未在发稿中台各分类下找到目标账号 [${missingLabel}]（当前可见账号共${allVisibleLabels.length}个，示例: ${availableAccounts || "未加载"}${tabDiag}），已阻断发送以防发错账号`,
        };
      }

      // 切 Tab 后可能暴露出该分类下原本已勾选的其他账号，再清一次后做最终安全核验
      await clearOtherCheckedAccounts();

      const extraChecked = [];
      const checkedNow = document.querySelectorAll(
        '.account_selector_checkbox.n-checkbox--checked, .account_selector_checkbox[aria-checked="true"], .n-checkbox.n-checkbox--checked, .n-checkbox.is-checked, [role="checkbox"][aria-checked="true"]'
      );
      for (const node of checkedNow) {
        if (!isVisible(node)) continue;
        const label = String(node.innerText || node.textContent || "").trim();
        const lines = label.split(/\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length !== 1) continue;
        const checkedNorm = norm(lines[0]);
        if (!checkedNorm || targetNormSet.has(checkedNorm)) continue;
        if (/评论|仅蓝v|仅视频|^全选$|仅自己可见/i.test(lines[0])) continue;
        extraChecked.push(lines[0]);
      }
      if (extraChecked.length) {
        return {
          ok: false,
          submitted: false,
          error: `检测到除目标账号外仍勾选了 [${extraChecked.slice(0, 5).join("、")}]，已阻断以防多号误发`,
        };
      }
    }

    // 3. 重新确认并填充正文内容（切换 Tab 后重新获取最新 textarea 引用）
    textarea =
      document.querySelector('textarea[placeholder*="微博内容"]') ||
      document.querySelector('textarea[placeholder*="新鲜事"]') ||
      document.querySelector('.n-input textarea') ||
      textarea;

    textarea.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(textarea, content);
    } else {
      textarea.value = content;
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));

    const repostUrl = String(task.repostUrl || "").trim();
    if (repostUrl) {
      const repostInput =
        document.querySelector('input[placeholder*="转发链接"]') ||
        document.querySelector('textarea[placeholder*="转发链接"]');
      if (!repostInput) {
        return { ok: false, submitted: false, error: `未找到发稿页的转发链接输入框，已阻断以免发成原创 (${repostUrl})` };
      }
      repostInput.focus?.();
      const valueProto = repostInput.tagName === "TEXTAREA" ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const valueSetter = valueProto && Object.getOwnPropertyDescriptor(valueProto.prototype, "value")?.set;
      if (valueSetter) valueSetter.call(repostInput, repostUrl);
      else repostInput.value = repostUrl;
      repostInput.dispatchEvent(new Event("input", { bubbles: true }));
      repostInput.dispatchEvent(new Event("change", { bubbles: true }));
      if (String(repostInput.value || "").trim() !== repostUrl) {
        return { ok: false, submitted: false, error: "转发链接未能写入输入框，已阻断发布" };
      }
      if (task.commentOriginal) {
        const commentBox = Array.from(document.querySelectorAll('.n-checkbox, label, [role="checkbox"]'))
          .find((el) => /同时评论|评论原微博|评论给原微博/.test(String(el.innerText || el.textContent || "")));
        if (!commentBox) {
          return { ok: false, submitted: false, error: "未找到“同时评论原微博”选项，已阻断发布" };
        }
        if (!isBoxChecked(commentBox)) {
          commentBox.click?.();
          await new Promise((r) => setTimeout(r, 120));
        }
        if (!isBoxChecked(commentBox)) {
          return { ok: false, submitted: false, error: "未能勾选“同时评论原微博”，已阻断发布" };
        }
      }
    }

    // 3.5 上传配图物料 (完全对齐 5000 端口 server.py:4930-4989 注入与弹性轮询校验)
    let uploadedImageCount = 0;
    if (task.imagesData && task.imagesData.length > 0) {
      try {
        const files = [];
        for (let idx = 0; idx < Math.min(task.imagesData.length, 9); idx++) {
          const item = task.imagesData[idx];
          if (!item || !item.dataUrl) continue;
          const arr = item.dataUrl.split(",");
          const mime = arr[0].match(/:(.*?);/)?.[1] || item.mime || "";
          if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) {
            throw new Error(`配图数据类型无效 (${mime || "未知"})，仅允许图片文件`);
          }
          const bstr = atob(arr[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
          }
          files.push(new File([u8arr], item.filename || `material_${idx + 1}.png`, { type: mime }));
        }

        if (files.length > 0) {
          // 清理此前残留的缩略图 (如草稿遗留图片)
          try {
            const container = document.querySelector('.n-upload, .weibo-editor-upload, [class*="upload"], .weibo_editor');
            if (container) {
              const delBtns = container.querySelectorAll('.n-upload-file-info__action, [class*="delete"], [class*="remove"], [title*="删除"]');
              for (const btn of delBtns) {
                btn.click?.();
                await new Promise((r) => setTimeout(r, 60));
              }
            }
          } catch (_) {}

          let fileInput =
            document.querySelector('input[type="file"][accept*="image"]') ||
            document.querySelector('.n-upload input[type="file"]') ||
            document.querySelector('input[type="file"]');

          if (!fileInput) {
            const icon = document.querySelector(
              '.n-upload-trigger, .n-upload, [class*="upload-trigger"], [class*="img"], [title*="图片"], label[for*="img"]'
            );
            if (icon) {
              icon.click();
              await new Promise((r) => setTimeout(r, 400));
            }
            fileInput =
              document.querySelector('input[type="file"][accept*="image"]') ||
              document.querySelector('.n-upload input[type="file"]') ||
              document.querySelector('input[type="file"]');
          }

          if (fileInput) {
            fileInput.multiple = true;
            const dt = new DataTransfer();
            for (const file of files) {
              dt.items.add(file);
            }
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            fileInput.dispatchEvent(new Event("change", { bubbles: true, cancelable: true, composed: true }));

            // 弹性小步长轮询等待缩略图渲染完成（对齐 server.py:4954-4984）
            const expectedCount = files.length;
            let uploadErrorMsg = "";
            for (let waitI = 0; waitI < 60; waitI++) {
              await new Promise((r) => setTimeout(r, 250));
              try {
                const container =
                  document.querySelector('.n-upload, .weibo-editor-upload, [class*="upload"], .weibo_editor') ||
                  document.body;
                const errorEls = container.querySelectorAll(
                  '.n-upload-file-info--error, .n-upload-file-info--rejected, .is-error, [class*="upload"][class*="error"]'
                );
                const hasErrorEl = Array.from(errorEls).some((el) => {
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                });
                const fileItems = container.querySelectorAll('.n-upload-file-info');
                const imgs = fileItems.length ? fileItems : container.querySelectorAll('img');
                let count = 0;
                for (const img of imgs) {
                  const cls = String(img.className || "").toLowerCase();
                  const src = String(img.src || "").toLowerCase();
                  const statusAttr = String(img.getAttribute?.("data-status") || "").toLowerCase();
                  if (
                    cls.includes("error") ||
                    cls.includes("rejected") ||
                    cls.includes("fail") ||
                    statusAttr === "error" ||
                    statusAttr === "rejected"
                  ) {
                    uploadErrorMsg = "检测到配图上传失败或被拒绝状态，已阻断发布";
                    break;
                  }
                  if (
                    cls.includes("avatar") ||
                    cls.includes("logo") ||
                    cls.includes("icon") ||
                    cls.includes("loading") ||
                    src.includes("avatar")
                  )
                    continue;
                  const r = img.getBoundingClientRect();
                  if (r.width >= 35 && r.height >= 35) count += 1;
                }
                if (hasErrorEl && !uploadErrorMsg) {
                  uploadErrorMsg = "检测到配图上传失败状态项，已阻断发布";
                }
                if (uploadErrorMsg) break;

                const loadingEls = container.querySelectorAll(
                  '.n-upload-file-info--loading, [class*="loading"], .is-loading, .n-progress'
                );
                const hasLoading = Array.from(loadingEls).some((el) => {
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                });
                if (count >= expectedCount && !hasLoading) {
                  uploadedImageCount = count;
                  break;
                }
              } catch (_) {}
            }
            if (uploadErrorMsg) {
              throw new Error(uploadErrorMsg);
            }
          }
        }
      } catch (imgErr) {
        return { ok: false, submitted: false, error: `配图装配失败，未提交发布: ${imgErr.message || imgErr}` };
      }
      if (uploadedImageCount < Math.min(task.imagesData.length, 9)) {
        return { ok: false, submitted: false, error: "配图上传未完成，已阻断漏图发布" };
      }
    }
    if (task.imgUrls && task.imgUrls.length && (!task.imagesData || task.imagesData.length < Math.min(task.imgUrls.length, 9))) {
      return { ok: false, submitted: false, error: "配图下载不完整，已阻断漏图发布" };
    }

    // 3.5 投票活动装配 (对齐原系统 poll_options)
    let pollAttached = false;
    if (task.poll && Array.isArray(task.poll.options) && task.poll.options.filter(Boolean).length >= 2) {
      try {
        const toolbarBtns = Array.from(document.querySelectorAll('button, .n-button, [role="button"], span, div, i'));
        for (const b of toolbarBtns) {
          const t = (b.innerText || b.textContent || b.title || b.getAttribute("aria-label") || "").trim();
          if (t === "投票" || t.includes("发起投票") || b.classList.contains("icon-vote")) {
            b.click();
            await new Promise((r) => setTimeout(r, 350));
            pollAttached = true;
            break;
          }
        }
        if (pollAttached) {
          const pollInputs = Array.from(document.querySelectorAll('input[placeholder*="选项"], input[placeholder*="投票"], .vote-input, .poll-input'));
          const validOpts = task.poll.options.filter(Boolean);
          for (let oIdx = 0; oIdx < validOpts.length; oIdx++) {
            if (pollInputs[oIdx]) {
              pollInputs[oIdx].value = String(validOpts[oIdx]).trim();
              pollInputs[oIdx].dispatchEvent(new Event("input", { bubbles: true }));
              pollInputs[oIdx].dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
        }
      } catch (pollErr) {
        console.warn("投票组件装配异常:", pollErr);
      }
    }

    // 4. 安全演练判断 (Dry-Run Gate)
    if (isDryRun) {
      let banner = document.getElementById("__dryrun_banner__");
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "__dryrun_banner__";
        banner.style.cssText =
          "position:fixed;top:20px;right:20px;z-index:999999;padding:12px 20px;background:#ECFDF5;color:#065F46;border:1.5px solid #10B981;border-radius:8px;font-size:14px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,0.2);";
        document.body.appendChild(banner);
      }
      const acctLabel = targetAccounts.length > 1
        ? `${targetAccounts[0]} 等 ${targetAccounts.length} 个账号`
        : (targetAccount || "当前选中");
      banner.innerText = `🛡️【安全演练】账号 [${acctLabel}] 已勾选，正文已填入${repostUrl ? "，转发链接已填入" : ""}${uploadedImageCount > 0 ? `，配图 (${uploadedImageCount}张) 已装配预览` : ""}${pollAttached ? "，投票已挂载" : ""}，安全阻断未实际点击发布！`;
      setTimeout(() => banner.remove(), 5000);

      const nowTs = Date.now();
      const mockUrl = `https://weibo.com/detail/mock_dryrun_${nowTs}`;
      const postUrlsByAccount = {};
      targetAccounts.forEach((acct, idx) => {
        postUrlsByAccount[acct] = `https://weibo.com/detail/mock_dryrun_${nowTs}_${idx + 1}`;
      });
      return { ok: true, postUrl: mockUrl, postUrlsByAccount, dryRun: true, accountMatched, imageCount: uploadedImageCount, pollAttached };
    }

    // 5. 真实发布模式（对齐 server.py 两阶段确认 + 剪贴板拦截提取）
    window.__clipCaptured = "";

    // 5.0 精准博文直链解析器：严格限定为真实已发博文 URL，彻底杜绝匹配到用户主页 (/u/)、ajax 或系统杂乱链接！
    const extractWeiboPostUrl = (rawText) => {
      if (!rawText) return "";
      const lines = String(rawText).split(/\r?\n/);
      for (const line of lines) {
        // 1. 经典个人博文直链：https://weibo.com/<UID>/<MID> (UID 为 5 位以上纯数字，MID 为字母数字)
        const m1 = line.match(/https?:\/\/(?:www\.)?weibo\.com\/([0-9]{5,})\/([A-Za-z0-9]+)/i);
        if (m1) {
          return `https://weibo.com/${m1[1]}/${m1[2]}`;
        }

        // 2. 详情页直链：https://weibo.com/detail/<MID>
        const m2 = line.match(/https?:\/\/(?:www\.)?weibo\.com\/detail\/([0-9A-Za-z]+)/i);
        if (m2) {
          return `https://weibo.com/detail/${m2[1]}`;
        }

        // 3. 移动端直链：https://m.weibo.cn/status/<MID> 或 /detail/<MID>
        const m3 = line.match(/https?:\/\/m\.weibo\.cn\/(?:status|detail)\/([0-9A-Za-z]+)/i);
        if (m3) {
          return `https://m.weibo.cn/status/${m3[1]}`;
        }
      }
      return "";
    };

    const previousUrls = new Set(Array.from(document.querySelectorAll('a[href], input, .publish_model_link'))
      .map((el) => extractWeiboPostUrl(el.href || el.value || el.innerText || el.textContent || "")).filter(Boolean));
    window.__weiboSyncSubmission = { account: targetAccount, accounts: targetAccounts, content, startedAt: Date.now(), submitted: false,
      previousUrls: Array.from(previousUrls) };
    try {
      if (typeof sessionStorage !== "undefined") sessionStorage.removeItem("__weiboSyncSubmission");
    } catch (_) {}
    let originalClipboardWrite = null;
    let clipboardHook = null;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        originalClipboardWrite = navigator.clipboard.writeText;
        const origWrite = originalClipboardWrite.bind(navigator.clipboard);
        const hooked = async (text) => {
          const t = String(text || "").trim();
          window.__clipCaptured = t;
          try {
            return await origWrite(text);
          } catch (_) {}
        };
        clipboardHook = hooked;
        navigator.clipboard.writeText = hooked;
      }
    } catch (_) {}

    const onCopyCapture = (e) => {
      try {
        const clipData = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
        const sel = (window.getSelection ? window.getSelection().toString() : "") || "";
        const t = (clipData || sel || "").trim();
        if (t) {
          window.__clipCaptured = t;
        }
      } catch (_) {}
    };
    document.addEventListener("copy", onCopyCapture, true);

    try {
      // 5.1 确保发布类型模式处于“立即发布”（严格仅检索顶部的单选框/标签页，绝不误检索底部的提交按钮与常规 button！）
      try {
        const modeCandidates = Array.from(
          document.querySelectorAll('.n-radio, [role="radio"], [role="tab"], .n-tabs-tab')
        ).filter((el) => !el.closest(".post_footer, footer, .weibo-editor-footer"));

        for (const mb of modeCandidates) {
          const t = (mb.innerText || mb.textContent || "").trim();
          if (t === "立即发布") {
            const isSelected =
              mb.classList.contains("n-radio--checked") ||
              mb.classList.contains("is-active") ||
              mb.getAttribute("aria-checked") === "true";
            if (!isSelected) {
              mb.click();
              await new Promise((r) => setTimeout(r, 150));
            }
            break;
          }
        }
      } catch (_) {}

      // 5.2 精确查找主提交按钮：优先定位底部的【保存并发布】提交按钮（对齐 server.py，绝不误点模式选择或保存草稿！）
      let publishBtn = null;
      const allButtons = Array.from(document.querySelectorAll('button, .n-button, [role="button"]')).filter(isVisible);

      // 第一优先级：精确匹配 "保存并发布"
      for (const el of allButtons) {
        const txt = (el.innerText || el.textContent || "").trim();
        if (txt === "保存并发布") {
          publishBtn = el;
          break;
        }
      }

      // 第二优先级：包含 "保存并发布" 且不是纯保存草稿
      if (!publishBtn) {
        for (const el of allButtons) {
          const txt = (el.innerText || el.textContent || "").trim();
          if (txt.includes("保存并发布")) {
            publishBtn = el;
            break;
          }
        }
      }

      // 第三优先级：主操作区底部的提交按钮（排除顶部的模式单选框）
      if (!publishBtn) {
        for (const el of allButtons) {
          const txt = (el.innerText || el.textContent || "").trim();
          if (txt === "立即发布" && (el.classList.contains("n-button--primary") || el.closest(".post_footer, footer, .n-space"))) {
            publishBtn = el;
            break;
          }
        }
      }

      if (!publishBtn) {
        return { ok: false, submitted: false, error: "未在发稿页定位到【保存并发布】提交按钮" };
      }

      // 页内指纹级防重复发布锁：60秒内同一页面绝不二次点击发布相同正文！
      // 只在真正点击前写入。按钮不可用或用户已停止时不能占锁，否则合法重试会被误拦。
      const postFingerprint = `${targetAccounts.join(",") || targetAccount}::${content}`;
      window.__weiboPostedFingerprints = window.__weiboPostedFingerprints || {};
      if (window.__weiboPostedFingerprints[postFingerprint] && Date.now() - window.__weiboPostedFingerprints[postFingerprint] < 60000) {
        return { ok: false, submitted: false, error: "已拦截重复提交：60秒内该页面已对该博文执行过发布动作，已自动阻断二次点击" };
      }

      publishBtn.scrollIntoView?.({ block: "center" });
      await new Promise((r) => setTimeout(r, 150));
      if (publishBtn.disabled || publishBtn.getAttribute("aria-disabled") === "true") {
        return { ok: false, submitted: false, error: "发布按钮不可用，未执行提交" };
      }
      if (task.__syncJobId && window.__weiboSyncCancelledJobs?.[task.__syncJobId]) {
        return { ok: false, submitted: false, error: "用户已停止任务，未执行提交" };
      }
      submitted = true;
      window.__weiboSyncSubmission.submitted = true;
      window.__weiboPostedFingerprints[postFingerprint] = Date.now();
      try {
        if (typeof sessionStorage !== "undefined") {
          sessionStorage.setItem("__weiboSyncSubmission", JSON.stringify(window.__weiboSyncSubmission));
        }
        const submitPayload = JSON.stringify({
          submitToken: task.__submitToken || "",
          syncJobId: task.__syncJobId || "",
          account: targetAccount,
          content: content,
          ts: Date.now(),
        });
        if (typeof sessionStorage !== "undefined") {
          sessionStorage.setItem("__weiboSyncLastSubmit", submitPayload);
        }
        if (typeof localStorage !== "undefined") {
          localStorage.setItem("__weiboSyncLastSubmit", submitPayload);
        }
      } catch (_) {}
      publishBtn.click();

      // 5.3 智能等待确认弹窗并提取回执链接（支持单号及多号批量提取，基础 35 秒，若按钮仍在 loading 最多延至 55 秒）
      const copyKeywords = ["复制全部昵称/链接", "复制全部昵称链接", "复制全部链接", "复制全部账号/链接", "复制全部", "复制链接"];
      const intermediateConfirmKeywords = ["确认发布", "继续发布", "仍要发布", "确认", "继续", "确定"];

      const parseMultiLinkEntriesFromText = (rawText) => {
        const entries = [];
        if (!rawText) return entries;
        const text = String(rawText);
        // 中台“复制全部链接”可能输出多行，也可能把多个账号挤在同一行，统一按 URL 位置切分昵称片段
        const urlRe = /https?:\/\/[^\s"'<>]+/g;
        let match;
        let cursor = 0;
        while ((match = urlRe.exec(text)) !== null) {
          const url = extractWeiboPostUrl(match[0]);
          const prefix = text.slice(cursor, match.index);
          cursor = match.index + match[0].length;
          if (!url || previousUrls.has(url)) continue;
          const segments = prefix.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          let nick = segments.length ? segments[segments.length - 1] : "";
          if (!nick) {
            const prevLineIdx = text.slice(0, match.index).trimEnd().split(/\r?\n/);
            const prevLine = prevLineIdx.length > 1 ? prevLineIdx[prevLineIdx.length - 2] : "";
            nick = /^https?:\/\//i.test(prevLine.trim()) ? "" : prevLine.trim();
          }
          nick = nick.replace(/[:：\s、,，]+$/g, "").trim();
          entries.push({ nick, normNick: norm(nick), url });
        }
        return entries;
      };

      const collectEntriesFromResultModals = () => {
        const entries = [];
        const seen = new Set();
        const pushEntry = (nick, url) => {
          if (!url || previousUrls.has(url)) return;
          const cleanNick = String(nick || "").replace(/[:：\s]+$/g, "").trim();
          const key = `${norm(cleanNick)}::${url}`;
          if (seen.has(key) || (!cleanNick && entries.some((entry) => entry.url === url))) return;
          seen.add(key);
          entries.push({ nick: cleanNick, normNick: norm(cleanNick), url });
        };

        // A. 结构化弹窗项：.publish_model_item / .weibo-link-item
        const items = Array.from(document.querySelectorAll('.publish_model_item, .weibo-link-item'));
        for (const item of items) {
          const nickEl = item.querySelector('.publish_model_nickname, .nickname');
          const rawNick = nickEl ? (nickEl.innerText || nickEl.textContent || "") : "";
          const linkEl = item.querySelector('.publish_model_link, a.link, .link-wrapper a, a[href], input, .link');
          const rawLink = linkEl ? (linkEl.getAttribute?.("href") || linkEl.href || linkEl.value || linkEl.innerText || linkEl.textContent || "") : (item.innerText || item.textContent || "");
          const url = extractWeiboPostUrl(rawLink);
          pushEntry(rawNick, url);
        }

        // B. 剪贴板捕获文本（多行“昵称: 链接”或“昵称\n链接”）
        if (window.__clipCaptured) {
          for (const e of parseMultiLinkEntriesFromText(window.__clipCaptured)) {
            pushEntry(e.nick, e.url);
          }
        }

        // C. 兜底零散链接节点
        const linkCandidates = Array.from(document.querySelectorAll('.publish_model_link, .publish_model a[href], .publish_model input, .weibo-links-dialog a.link, .weibo-link-item a.link, .n-dialog a[href], .n-dialog input, [role="dialog"] a[href], [role="dialog"] input'));
        for (const el of linkCandidates) {
          const raw = el.getAttribute?.("href") || el.href || el.value || el.innerText || el.textContent || "";
          const url = extractWeiboPostUrl(raw);
          pushEntry("", url);
        }
        return entries;
      };

      const mapEntriesToTargets = (entries) => {
        const byAcct = {};
        const usedUrls = new Set();
        for (const spec of targetSpecs) {
          const matches = entries.filter((e) => e.normNick && (e.normNick === spec.norm || (spec.baseNorm && e.normNick === spec.baseNorm)));
          const match = matches.length === 1 && !usedUrls.has(matches[0].url) &&
            new Set(entries.filter((entry) => entry.url === matches[0].url && entry.normNick).map((entry) => entry.normNick)).size === 1 ? matches[0] : null;
          if (match) {
            byAcct[spec.raw] = match.url;
            usedUrls.add(match.url);
          }
        }
        if (targetSpecs.length === 1 && !byAcct[targetSpecs[0].raw] && entries.length === 1 && !entries[0].normNick) {
          byAcct[targetSpecs[0].raw] = entries[0].url;
        }
        return byAcct;
      };

      let extractedUrl = "";
      let extractedEntries = [];
      let postUrlsByAccount = {};
      let lastPlatformNotice = "";
      let maxPostPolls = 70;
      let multiSettlePolls = 0;
      let lastEntriesCount = 0;
      const isMultiTarget = targetSpecs.length > 1;

      for (let poll = 0; poll < maxPostPolls; poll++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const noticeEl = Array.from(document.querySelectorAll('.n-message, .n-alert, [role="alert"]')).find(isVisible);
          const noticeTxt = noticeEl ? (noticeEl.innerText || noticeEl.textContent || "").trim() : "";
          if (noticeTxt) lastPlatformNotice = noticeTxt.slice(0, 120);
        } catch (_) {}

        // 若尚未拿到全部目标链接，主动尝试点击弹窗中的“复制全部链接”按钮以触发剪贴板多行数据
        const allCopyBtns = Array.from(
          document.querySelectorAll('.publish_model button, .publish_model .n-button, .n-dialog button, .n-dialog .n-button, [role="dialog"] button, [role="dialog"] [role="button"]')
        );
        for (const btn of allCopyBtns) {
          const bTxt = (btn.innerText || btn.textContent || "").trim();
          if (copyKeywords.includes(bTxt) && isVisible(btn)) {
            try {
              btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
              btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
            } catch (_) {}
            btn.click();
            await new Promise((r) => setTimeout(r, 200));
            break;
          }
        }

        const currentEntries = collectEntriesFromResultModals();
        if (currentEntries.length > 0) {
          extractedEntries = currentEntries;
          postUrlsByAccount = mapEntriesToTargets(currentEntries);
          extractedUrl = currentEntries[0].url;
          if (!isMultiTarget) break;
          const matchedAll = Object.keys(postUrlsByAccount).length >= targetSpecs.length;
          if (matchedAll) break;
          const stillLoading = !!document.querySelector('.publish_model_loading, .post_footer_btn.n-button--loading, .n-button--loading, .n-base-loading');
          if (!stillLoading) {
            if (currentEntries.length === lastEntriesCount) {
              multiSettlePolls++;
              if (multiSettlePolls >= 2) break;
            } else {
              multiSettlePolls = 0;
            }
          }
          lastEntriesCount = currentEntries.length;
        }

        // 4. 检查当前弹窗文本与中间风险确认按钮
        const isResultState = () => {
          const html = (document.body && document.body.innerHTML) || "";
          const text = (document.body && document.body.innerText) || "";
          return (
            html.includes("publish_model") ||
            text.includes("复制全部链接") ||
            text.includes("复制全部账号/链接") ||
            text.includes("复制链接") ||
            (text.includes("发布成功") && text.includes("weibo.com"))
          );
        };
        const resultPresent = isResultState();

        const modals = Array.from(
          document.querySelectorAll('.publish_model, .n-dialog, .n-modal, [role="dialog"], .modal, div[class*="dialog"]')
        );

        for (const modal of modals) {
          const modalText = modal.innerText || modal.textContent || "";
          const modalVisible = isVisible(modal);
          if (modalVisible && !extractedUrl) {
            const modalUrl = /发布成功|复制/.test(modalText) ? extractWeiboPostUrl(modalText) : "";
            if (modalUrl && !previousUrls.has(modalUrl)) {
              const parsedModalEntries = parseMultiLinkEntriesFromText(modalText);
              if (parsedModalEntries.length > 0) {
                extractedEntries = parsedModalEntries;
                postUrlsByAccount = mapEntriesToTargets(parsedModalEntries);
                extractedUrl = parsedModalEntries[0].url;
              } else {
                extractedUrl = modalUrl;
              }
              if (!isMultiTarget || Object.keys(postUrlsByAccount).length >= targetSpecs.length) break;
            }
          }

          if (!resultPresent && !modalText.includes("复制") &&
              !(task.__syncJobId && window.__weiboSyncCancelledJobs?.[task.__syncJobId])) {
            const modalBtns = Array.from(modal.querySelectorAll('button, .n-button, [role="button"]')).filter(isVisible);
            for (const btn of modalBtns) {
              const bTxt = (btn.innerText || btn.textContent || "").trim();
              if (intermediateConfirmKeywords.some((kw) => bTxt === kw)) {
                btn.click();
                await new Promise((r) => setTimeout(r, 400));
                break;
              }
            }
          }
        }

        if (extractedUrl && !isMultiTarget) break;

        if (poll >= maxPostPolls - 5 && maxPostPolls < 110 && document.querySelector('.publish_model_loading, .post_footer_btn.n-button--loading, .n-button--loading, .n-base-loading')) {
          maxPostPolls = Math.min(maxPostPolls + 10, 110);
        }
      }

      if (!isMultiTarget && targetSpecs.length === 1 && extractedEntries.some((entry) => entry.normNick) && !postUrlsByAccount[targetSpecs[0].raw]) {
        extractedUrl = "";
      }
      if (!extractedUrl) {
        return {
          ok: false,
          submitted: true,
          error: `已触发发布动作，但在 35 秒内未捕获到回执微博链接${lastPlatformNotice ? `（页面提示：${lastPlatformNotice}）` : ""}，请检查发稿中台弹窗提示（如频繁发送风控或敏感词提示）`,
        };
      }

      // 关键修复：成功提取链接后，立即主动关闭“发布成功/复制链接”弹窗，避免下一条任务被弹窗遮罩阻断！
      try {
        const resultModals = Array.from(document.querySelectorAll('.n-dialog, .n-modal, [role="dialog"], .n-modal-container'));
        for (const m of resultModals) {
          const closeBtns = Array.from(m.querySelectorAll('.n-dialog__close, .n-base-close, .n-modal-close, button, .n-button, [aria-label="close"]'));
          for (const btn of closeBtns) {
            const bTxt = (btn.innerText || btn.textContent || "").trim();
            if (["关闭", "取消", "知道了", "确定", "完成"].includes(bTxt) || btn.classList.contains("n-dialog__close") || btn.classList.contains("n-base-close")) {
              btn.click?.();
              break;
            }
          }
        }
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
      } catch (_) {}

      return {
        ok: true,
        postUrl: extractedUrl,
        postUrlsByAccount,
        postEntries: extractedEntries,
        dryRun: false,
        submitted: true,
        accountMatched,
        imageCount: uploadedImageCount,
      };
    } finally {
      document.removeEventListener("copy", onCopyCapture, true);
      if (originalClipboardWrite && navigator.clipboard.writeText === clipboardHook) {
        navigator.clipboard.writeText = originalClipboardWrite;
      }
    }
  } catch (e) {
    return { ok: false, submitted, error: String(e.message || e) };
  }
}

// ─────────────────────────────────────────────────────────────
// 直通函数 2B：微博主站首页 (weibo.com) 原生投票发布引擎 (100% 对齐 server.py:7716-8179 & 9052-9184)
// ─────────────────────────────────────────────────────────────
async function directPostPollToWeiboHome(task, isDryRun) {
  try {
    const href = String(window.location.href || "").toLowerCase();
    const bodyTxt = String((document.body && document.body.innerText) || "");
    if (
      href.includes("passport.weibo.com") ||
      href.includes("login.php") ||
      href.includes("visitor/visitor") ||
      bodyTxt.includes("扫码登录") ||
      bodyTxt.includes("立即登录")
    ) {
      return {
        ok: false,
        needLogin: true,
        error: "微博主站当前未登录，请在新弹出的微博首页完成扫码/登录后重试！",
      };
    }

    const content = (task.content || "").trim();
    const poll = task.poll || {};
    const pollTitle = (poll.title || "参与投票").trim();
    const pollOptions = Array.isArray(poll.options) ? poll.options.map((o) => String(o || "").trim()).filter(Boolean) : [];
    if (!content) return { ok: false, error: "投票发博正文为空" };
    if (pollOptions.length < 2) return { ok: false, error: "投票选项不足 2 个，无法创建投票" };

    const isVisible = (el) => {
      if (!el) return false;
      try {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      } catch (_) {
        return true;
      }
    };

    const textOf = (el) => ((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();

    const fireMouse = (el) => {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      if (typeof PointerEvent === "function") el.dispatchEvent(new PointerEvent("pointerdown", init));
      el.dispatchEvent(new MouseEvent("mousedown", init));
      if (typeof PointerEvent === "function") el.dispatchEvent(new PointerEvent("pointerup", init));
      el.dispatchEvent(new MouseEvent("mouseup", init));
      el.dispatchEvent(new MouseEvent("click", init));
    };

    const setNativeValue = (el, val) => {
      el.focus();
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };

    // 1. 定位微博首页发布框（最多等待 10 秒）
    const editorSelectors = [
      'textarea[placeholder*="有什么新鲜事想分享给大家"]',
      'textarea[placeholder*="新鲜事"]',
      'textarea._input_1rzr8_8',
      '[contenteditable="true"][role="textbox"]',
      '[node-type="publishTextArea"]',
    ];
    const findEditor = () => {
      for (const sel of editorSelectors) {
        const list = Array.from(document.querySelectorAll(sel)).filter(isVisible);
        if (list.length > 0) return list[0];
      }
      return null;
    };

    let editor = null;
    for (let i = 0; i < 20; i++) {
      editor = findEditor();
      if (editor) break;
      // 若处于折叠状态，尝试点击“发微博/写微博”按钮展开
      const btns = Array.from(document.querySelectorAll('button, [role="button"], a')).filter(isVisible);
      for (const b of btns) {
        const t = textOf(b);
        if (t === "发微博" || t === "写微博") {
          fireMouse(b);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!editor) {
      return { ok: false, error: "未能在微博首页找到发布输入框，请确认当前账号处于正常首页态" };
    }

    // 2. 填入正文内容
    setNativeValue(editor, content);
    await new Promise((r) => setTimeout(r, 400));

    // 3. 点击“更多” -> “投票”打开投票设置弹窗 (100% 对齐 server.py:7772-7898)
    const findVisiblePollModal = () => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .woo-modal-main, .woo-dialog-main, .n-modal'));
      return dialogs.find((d) => isVisible(d) && (textOf(d).includes("投票") || textOf(d).includes("截止时间"))) || null;
    };

    const clickScopedPollEntry = () => {
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], span, div, li, a'));
      for (const node of nodes) {
        if (!isVisible(node) || textOf(node) !== "投票") continue;
        let ownerMenu = null;
        let parent = node.parentElement;
        for (let depth = 0; parent && depth < 8; depth++, parent = parent.parentElement) {
          const txt = textOf(parent);
          if (txt.includes("头条文章") && txt.includes("投票") && txt.includes("直播")) {
            ownerMenu = parent;
            break;
          }
        }
        if (!ownerMenu) continue;
        fireMouse(node);
        return true;
      }
      return false;
    };

    const clickMoreEntry = () => {
      const toolbarHints = ["表情", "图片", "视频", "话题", "公开", "发送"];
      const inToolbar = (el) => {
        let parent = el.parentElement;
        for (let depth = 0; parent && depth < 10; depth++, parent = parent.parentElement) {
          const txt = textOf(parent);
          if (toolbarHints.filter((h) => txt.includes(h)).length >= 3) return true;
        }
        return false;
      };
      const nodes = Array.from(document.querySelectorAll('.woo-pop-ctrl, button, [role="button"], span, div, li, a'));
      for (const node of nodes) {
        if (!isVisible(node) || textOf(node) !== "更多") continue;
        if (!inToolbar(node)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.y > 450) continue;
        const target = node.querySelector("svg") || node.closest(".woo-pop-ctrl") || node;
        fireMouse(target);
        return true;
      }
      return false;
    };

    let pollModal = findVisiblePollModal();
    if (!pollModal) {
      if (!clickScopedPollEntry()) {
        clickMoreEntry();
        for (let w = 0; w < 15; w++) {
          await new Promise((r) => setTimeout(r, 200));
          if (clickScopedPollEntry()) break;
        }
      }
      for (let w = 0; w < 20; w++) {
        await new Promise((r) => setTimeout(r, 250));
        pollModal = findVisiblePollModal();
        if (pollModal) break;
      }
    }

    if (!pollModal) {
      return { ok: false, error: "未能在微博首页发博工具栏中打开【投票】弹窗" };
    }

    // 4. 填入投票标题与选项 (对齐 server.py:7992-8105)
    // 智能推导防兜底：若标题为空或泛指“参与投票”，立即从正文中截取问句作为真实标题
    let finalTitle = pollTitle;
    if (!finalTitle || finalTitle === "参与投票" || finalTitle.includes("微博投票")) {
      const qMatch = content.match(/([^。！？!?\n#]+[？?])/);
      if (qMatch && qMatch[1]) {
        finalTitle = qMatch[1].trim();
      }
    }

    let titleInput = pollModal.querySelector(
      'input[placeholder*="填写标题"], textarea[placeholder*="填写标题"], input[placeholder*="标题"], textarea[placeholder*="标题"], input[placeholder*="问题"], textarea[placeholder*="问题"]'
    );
    if (!titleInput) {
      // 兜底：选出弹窗内第一个可见的、非日期且非选项的输入框
      const allTextInputs = Array.from(pollModal.querySelectorAll('input, textarea')).filter((el) => {
        if (!isVisible(el)) return false;
        const ph = (el.getAttribute("placeholder") || "").trim();
        const tp = (el.getAttribute("type") || "").toLowerCase();
        if (["date", "time", "datetime-local", "hidden", "radio", "checkbox", "file"].includes(tp)) return false;
        return !ph.includes("选项") && !ph.includes("日期") && !ph.includes("时间");
      });
      if (allTextInputs.length > 0) titleInput = allTextInputs[0];
    }

    if (!titleInput) {
      return { ok: false, error: "投票弹窗已打开，但未找到投票标题输入框" };
    }

    setNativeValue(titleInput, finalTitle);
    titleInput.dispatchEvent(new Event("blur", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    // 辅助函数：精准寻找弹窗最内层的目标按钮/标签，绝不误中弹窗外层大容器 div！
    const findInnerClickable = (root, keyword, exact = false) => {
      const candidates = Array.from(root.querySelectorAll('button, [role="button"], a, span, div, label')).filter((el) => {
        if (!isVisible(el)) return false;
        const t = textOf(el);
        if (!t || t.length > 20) return false; // 过滤掉整块大容器
        return exact ? t === keyword : t.includes(keyword);
      });
      candidates.sort((a, b) => {
        const tagRank = (n) => (n.tagName === "BUTTON" ? 0 : (n.children.length === 0 ? 1 : 2));
        return tagRank(a) - tagRank(b) || textOf(a).length - textOf(b).length;
      });
      return candidates[0] || null;
    };

    // 确保选项模式为“文字”
    const textTab = findInnerClickable(pollModal, "文字", true);
    if (textTab) {
      fireMouse(textTab);
      await new Promise((r) => setTimeout(r, 200));
    }

    const getVisibleOptionInputs = () => {
      const candidates = Array.from(pollModal.querySelectorAll('input, textarea, .n-input__input-el')).filter((inp) => {
        if (!isVisible(inp) || inp === titleInput) return false;
        if (inp.readOnly === true || inp.disabled === true || inp.hasAttribute?.("readonly")) return false;
        const ph = (inp.getAttribute("placeholder") || "").trim();
        const aria = (inp.getAttribute("aria-label") || "").trim();
        const tp = (inp.getAttribute("type") || "").toLowerCase();
        const probe = `${ph} ${aria}`;
        if (["date", "time", "datetime-local", "hidden", "radio", "checkbox", "file"].includes(tp)) return false;
        if (probe.includes("标题") || probe.includes("日期") || probe.includes("时间") || probe.includes("请选择")) return false;
        return true;
      });
      const strict = candidates.filter((inp) => {
        const ph = (inp.getAttribute("placeholder") || "").trim();
        const aria = (inp.getAttribute("aria-label") || "").trim();
        const maxLen = inp.getAttribute("maxlength") || "";
        const probe = `${ph} ${aria}`;
        return maxLen === "24" || probe.includes("选项") || probe.toLowerCase().includes("option");
      });
      if (strict.length > 0) return strict;
      return candidates.filter((inp) => {
        const ph = (inp.getAttribute("placeholder") || "").trim();
        return !ph || ph.includes("请输入");
      });
    };

    const wantedCount = Math.min(Math.max(pollOptions.length, 2), 20);
    for (let addAttempt = 0; addAttempt < 18; addAttempt++) {
      const currentInputs = getVisibleOptionInputs();
      if (currentInputs.length >= wantedCount) break;

      const addBtn = findInnerClickable(pollModal, "添加选项", false);
      if (!addBtn) break;

      addBtn.scrollIntoView?.({ block: "center" });
      fireMouse(addBtn);

      // 等待新输入框渲染出来 (最多等 1.2 秒)
      for (let waitAdd = 0; waitAdd < 6; waitAdd++) {
        await new Promise((r) => setTimeout(r, 200));
        if (getVisibleOptionInputs().length > currentInputs.length) break;
      }
    }

    const optionInputs = getVisibleOptionInputs();
    if (optionInputs.length === 0) {
      return { ok: false, error: "未能在投票弹窗中找到任何投票选项输入框" };
    }

    if (optionInputs.length < pollOptions.length) {
      return { ok: false, error: `投票选项装配不完整：需要 ${pollOptions.length} 项，当前仅 ${optionInputs.length} 个输入框` };
    }
    const fillCount = pollOptions.length;
    for (let idx = 0; idx < fillCount; idx++) {
      setNativeValue(optionInputs[idx], pollOptions[idx]);
      await new Promise((r) => setTimeout(r, 120));
    }

    // 4.5 设置投票截止时间（默认 30 天 -> "一个月"，对齐 server.py:15533-15755 多通道触发 + 全局查找 + 键盘兜底）
    const pollDays = Number(task.poll?.days || 30);
    const deadlineLabels =
      pollDays >= 28 ? ["一个月", "30天"]
      : pollDays >= 7 ? ["七天", "7天", "一周"]
      : pollDays >= 3 ? ["三天", "3天"]
      : ["一天", "1天"];

    const findDeadlineTrigger = () => {
      const ms = pollModal.querySelector(".multiselect__tags, .multiselect__select, .multiselect");
      if (ms && isVisible(ms)) return ms;
      const curDayKeys = ["一天", "1天", "三天", "3天", "七天", "7天", "一个月", "30天"];
      const candidates = Array.from(pollModal.querySelectorAll('button, [role="button"], [role="combobox"], div, span')).filter((el) => {
        if (!isVisible(el)) return false;
        if (el.closest?.(".multiselect__content-wrapper, .multiselect__content, [role='listbox']")) return false;
        const t = textOf(el);
        return curDayKeys.includes(t);
      });
      candidates.sort((a, b) => a.children.length - b.children.length);
      return candidates[0] || null;
    };

    const isDeadlineConfirmed = () => {
      const singles = Array.from(document.querySelectorAll(".multiselect__single"));
      if (singles.some((node) => isVisible(node) && deadlineLabels.some((lbl) => textOf(node) === lbl || textOf(node).includes(lbl)))) {
        return true;
      }
      const triggerNow = findDeadlineTrigger();
      if (triggerNow) {
        const t = textOf(triggerNow);
        if (deadlineLabels.some((lbl) => t === lbl || t.includes(lbl))) return true;
      }
      return false;
    };

    let deadlineWarning = "";
    const deadlineTrigger = findDeadlineTrigger();
    if (deadlineTrigger && !isDeadlineConfirmed()) {
      const openTrigger = () => {
        deadlineTrigger.scrollIntoView?.({ block: "center" });
        deadlineTrigger.focus?.();
        const msRoot = deadlineTrigger.closest?.(".multiselect") || deadlineTrigger;
        msRoot.focus?.();
        fireMouse(deadlineTrigger);
        deadlineTrigger.click?.();
      };

      openTrigger();

      // 轮询等待下拉项在 pollModal 或 document.body 浮层中展开（最多等 1.5 秒）
      let picked = false;
      for (let waitOpt = 0; waitOpt < 6 && !picked; waitOpt++) {
        await new Promise((r) => setTimeout(r, 250));
        const optNodes = Array.from(
          document.querySelectorAll('.multiselect__option, .multiselect__element [role="option"], .multiselect__content li, [role="option"], .woo-pop-item-main')
        );
        let targetOpt = optNodes.find((node) => {
          if (!isVisible(node)) return false;
          const t = textOf(node);
          return deadlineLabels.some((lbl) => t === lbl || t.includes(lbl));
        });

        // 兜底：若非标准 multiselect 类名，在弹窗或全局浮层找叶子文本节点
        if (!targetOpt) {
          const leafCandidates = Array.from(document.querySelectorAll('li, div, span, a, button')).filter((node) => {
            if (!isVisible(node) || node === deadlineTrigger || deadlineTrigger.contains?.(node)) return false;
            const t = textOf(node);
            if (!t || t.length > 10) return false;
            return deadlineLabels.some((lbl) => t === lbl);
          });
          leafCandidates.sort((a, b) => a.children.length - b.children.length);
          targetOpt = leafCandidates[0] || null;
        }

        if (targetOpt) {
          targetOpt.scrollIntoView?.({ block: "center" });
          const rect = targetOpt.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const pointEl = (typeof document.elementFromPoint === "function" ? document.elementFromPoint(cx, cy) : null) || targetOpt;
          const clickTarget = pointEl.closest?.('.multiselect__option, .multiselect__element, li, [role="option"]') || targetOpt;
          fireMouse(clickTarget);
          clickTarget.click?.();
          picked = true;
        }
      }

      for (let waitConfirm = 0; waitConfirm < 8; waitConfirm++) {
        await new Promise((r) => setTimeout(r, 150));
        if (isDeadlineConfirmed()) break;
      }

      // 键盘导航兜底（针对仅响应 ArrowDown + Enter 的 Vue-Multiselect 实例）
      if (!isDeadlineConfirmed()) {
        openTrigger();
        await new Promise((r) => setTimeout(r, 250));
        const kbTarget = pollModal.querySelector(".multiselect__input, .multiselect") || deadlineTrigger;
        kbTarget.focus?.();
        const keyInit = (key) => ({ key, code: key, keyCode: key === "Enter" ? 13 : 40, which: key === "Enter" ? 13 : 40, bubbles: true, cancelable: true });
        const steps = pollDays >= 28 ? 3 : pollDays >= 7 ? 2 : 1;
        for (let s = 0; s < steps; s++) {
          kbTarget.dispatchEvent(new KeyboardEvent("keydown", keyInit("ArrowDown")));
          await new Promise((r) => setTimeout(r, 100));
        }
        kbTarget.dispatchEvent(new KeyboardEvent("keydown", keyInit("Enter")));
        await new Promise((r) => setTimeout(r, 300));
      }

      if (!isDeadlineConfirmed()) {
        deadlineWarning = `未能自动将截止时间切换为【${deadlineLabels[0]}】，请人工核对`;
      }
    }

    // 5. 点击“完成”生成投票卡片并关闭弹窗
    const doneBtn = findInnerClickable(pollModal, "完成", true) || findInnerClickable(pollModal, "确定", true);
    if (!doneBtn) {
      return { ok: false, error: "未在投票弹窗中找到【完成】按钮" };
    }
    fireMouse(doneBtn);

    let modalClosed = false;
    for (let w = 0; w < 20; w++) {
      await new Promise((r) => setTimeout(r, 250));
      if (!findVisiblePollModal()) {
        modalClosed = true;
        break;
      }
    }

    if (!modalClosed) {
      return { ok: false, error: "点击【完成】后投票弹窗未正常关闭，请检查标题或选项是否超出字数限制" };
    }

    // 6. 投票卡片装配完毕 (停在发布页等待人工核对后手动发布，不向页面插入悬浮提示横幅，也不自动发送)
    const hasImages = Array.isArray(task.imgUrls) && task.imgUrls.length > 0;
    const staleBanner = document.getElementById("__poll_prepared_banner__");
    if (staleBanner) staleBanner.remove();

    // 绝不查找【发送】按钮，绝不点击发送！保留页面让用户手动发布！
    return {
      ok: true,
      postUrl: "",
      preparedOnly: true,
      dryRun: isDryRun,
      pollAttached: true,
      manualImagesRequired: hasImages,
      imageCount: hasImages ? task.imgUrls.length : 0,
      deadlineWarning,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ─────────────────────────────────────────────────────────────
// 直通函数 3：云文档单元格链接回写 (直接注入到腾讯文档/钉钉页面运行)
// ─────────────────────────────────────────────────────────────
async function directWriteCellToDoc(cellAddr, linkValue, targetSheetId, snapshot) {
  try {
    if (!cellAddr || !linkValue) return { ok: false, error: "缺少回写单元格或链接" };

    const normAddr = String(cellAddr).trim().toUpperCase();
    if (!/^[A-Z]+[1-9][0-9]*$/.test(normAddr)) return { ok: false, error: "无效的回写单元格地址" };
    linkValue = String(linkValue).trim();
    const colMatch = normAddr.match(/^[A-Z]+/);
    const rowMatch = normAddr.match(/[0-9]+$/);
    const targetRow1 = rowMatch ? parseInt(rowMatch[0], 10) : 0;
    const targetRow0 = targetRow1 - 1;
    let targetCol0 = -1;
    if (colMatch) {
      const letters = colMatch[0];
      let colNum = 0;
      for (let i = 0; i < letters.length; i++) {
        colNum = colNum * 26 + (letters.charCodeAt(i) - 64);
      }
      targetCol0 = colNum - 1;
    }

    // ── Tier 1: 腾讯文档原生协同运行时 (SpreadsheetApp.behaviorApi) ──
    const app = window.SpreadsheetApp;
    const wb = app && app.workbook;
    const tools = app && app.e2eTools;
    const list = (wb && wb.worksheetManager && wb.worksheetManager.sheetList) || [];

    if (targetSheetId && !list.some((s) => s.getSheetId && s.getSheetId() === targetSheetId)) {
      return { ok: false, error: `未找到指定回写子表 [${targetSheetId}]，已阻断写入` };
    }
    if (!Number.isSafeInteger(targetRow0) || !Number.isSafeInteger(targetCol0)) {
      return { ok: false, error: "单元格地址超出支持范围" };
    }
    if (wb && tools && list.length && targetRow0 >= 0 && targetCol0 >= 0) {
      let targetSheet = null;
      if (targetSheetId) {
        targetSheet = list.find((s) => s.getSheetId && s.getSheetId() === targetSheetId);
      }
      if (!targetSheet) {
        targetSheet = list.find((s) => s.getIsInitialized && s.getIsInitialized()) || list[0];
      }

      if (targetSheet && app.behaviorApi && app.behaviorApi.cellApi) {
        const sid = targetSheet.getSheetId();
        // 快照必须来自扫描时的同一子表和行；旧回执缺少列信息时只能人工核对补写。
        if (!snapshot || !snapshot.sheetId || snapshot.sheetId !== sid ||
            snapshot.row !== targetRow1 || snapshot.linkCol !== targetCol0 ||
            !Number.isInteger(snapshot.contentCol) || snapshot.contentCol < 0 ||
            !Number.isInteger(snapshot.accountCol) || snapshot.accountCol < 0 ||
            !Number.isInteger(snapshot.headerRow) || snapshot.headerRow < 1 || snapshot.headerRow >= targetRow1 ||
            new Set([snapshot.contentCol, snapshot.accountCol, snapshot.linkCol]).size !== 3 ||
            typeof snapshot.content !== "string" || !snapshot.content.trim() ||
            typeof snapshot.account !== "string" || !snapshot.account.trim() || snapshot.link !== "") {
          return { ok: false, error: "缺少完整的文档行快照，已阻断自动写回；请核对回执后手动补写，勿重新发布" };
        }
        const readCell = (row, col) => {
          const cell = targetSheet.getCellDataAtPosition(row, col);
          const text = String(tools.getCellEditValue(wb, row, col, sid, cell) ?? "").trim();
          return { cell, text };
        };
        let pre;
        try {
          const content = readCell(targetRow0, snapshot.contentCol).text;
          let account = "";
          for (let r = targetRow0; r >= snapshot.headerRow; r--) {
            account = readCell(r, snapshot.accountCol).text;
            if (account) break;
          }
          pre = readCell(targetRow0, targetCol0);
          const hrefs = pre.cell && pre.cell.getCellHyperlinksInfo
            ? (pre.cell.getCellHyperlinksInfo()?.hyperlinksInfo || []).map((item) => String(item?.hyperlink?.url || "").trim()).filter(Boolean)
            : [];
          if (content !== snapshot.content.trim() || account !== snapshot.account.trim()) {
            return { ok: false, error: "文档行正文或账号与任务快照不一致，已阻断写回；请核对回执后手动补写，勿重新发布" };
          }
          if (hrefs.some((href) => href !== linkValue) || (pre.text && pre.text !== linkValue && !hrefs.includes(linkValue))) {
            return { ok: false, error: "回写单元格已有不同内容或链接，已阻断覆盖；请人工核对回执" };
          }
          if (pre.text === linkValue || hrefs.includes(linkValue)) {
            return { ok: true, provider: "SpreadsheetApp.behaviorApi", cell: cellAddr, verified: linkValue, idempotent: true };
          }
        } catch (readErr) {
          return { ok: false, error: `读取文档行快照失败，已阻断写回: ${readErr.message || readErr}` };
        }

        const uuid = (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
              const rnd = (Math.random() * 16) | 0;
              return (ch === "x" ? rnd : (rnd & 0x3) | 0x8).toString(16);
            });

        const isUrl = /^https?:\/\//i.test(linkValue);
        const payload = {
          sheetId: sid,
          rowIndex: targetRow0,
          colIndex: targetCol0,
          text: linkValue,
          isTextChanged: true,
          userEnterValue: linkValue,
          isChanged: true,
          needSecondParseArr: [],
          selectedRangeSnapshot: [
            {
              sheetId: sid,
              startRowIndex: targetRow0,
              startColIndex: targetCol0,
              endRowIndex: targetRow0,
              endColIndex: targetCol0,
            },
          ],
          activePositionSnapshot: {
            sheetId: sid,
            rowIndex: targetRow0,
            colIndex: targetCol0,
          },
        };

        if (isUrl) {
          payload.richString = {
            r: [
              {
                rPr: {
                  egRPrElt: [
                    {
                      b: false,
                      i: false,
                      strike: false,
                      color: {
                        rgb: "FF175CEB",
                        key: "{-#175ceb---}",
                        rgba: { red: 23, green: 92, blue: 235, alpha: 1 },
                      },
                      sz: 10,
                      u: 1,
                    },
                  ],
                },
                t: linkValue,
                type: 1,
                hyperlink: {
                  url: linkValue,
                  type: 1,
                  displayType: 1,
                  linkId: uuid,
                },
              },
            ],
          };
          payload.isRichStringChanged = true;
        }

        try {
          await app.behaviorApi.cellApi.setSingleValue(payload);
        } catch (writeErr) {
          return { ok: false, error: `原生单元格写回失败: ${writeErr.message || writeErr}` };
        }

        // 协同表格经常先落盘、后刷新内存。只读一次会把已经写上的链接判失败。
        let verifiedVal = "";
        for (let attempt = 0; attempt < 12; attempt++) {
          await new Promise((r) => setTimeout(r, attempt === 0 ? 350 : 550));
          const verifiedCell = targetSheet.getCellDataAtPosition(targetRow0, targetCol0);
          verifiedVal = "";
          try {
            verifiedVal = (tools.getCellEditValue(wb, targetRow0, targetCol0, sid, verifiedCell) || "").toString().trim();
          } catch (_) {}

          if (verifiedVal !== linkValue && verifiedCell) {
            const altText = String(verifiedCell.formattedValue || verifiedCell.text || verifiedCell.m || "").trim();
            if (altText === linkValue) verifiedVal = altText;
          }

          if (verifiedVal !== linkValue && verifiedCell && verifiedCell.getCellHyperlinksInfo) {
            try {
              const hyperlinks = verifiedCell.getCellHyperlinksInfo();
              const href = hyperlinks?.hyperlinksInfo?.[0]?.hyperlink?.url || "";
              if (String(href).trim() === linkValue) verifiedVal = linkValue;
            } catch (_) {}
          }

          if (verifiedVal === linkValue) {
            return {
              ok: true,
              provider: "SpreadsheetApp.behaviorApi",
              cell: cellAddr,
              verified: verifiedVal,
            };
          }
        }
        if (targetSheetId) {
          return {
            ok: false,
            error: `指定子表的原生写回未通过校验（${cellAddr} 读回: "${verifiedVal || "空"}"），已阻断跨表 DOM 兜底`,
          };
        }
      }
    }

    if (targetSheetId) return { ok: false, error: "指定子表的原生写回未通过校验，已阻断跨表 DOM 兜底" };
    return { ok: false, error: "未能通过表格运行时确认写回，已阻断公式栏盲写以免覆盖当前选中单元格" };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ─────────────────────────────────────────────────────────────
// 对齐 weibo-poster：从 publish_model 的 HTML 取链接，再点复制。不看元素是否可见，也不离开当前页。
async function directCopyPublishPageResult() {
  const extractFirstPublishResultUrl = (text) => {
    const decoded = String(text || "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"");
    const matched = decoded.match(/https?:\/\/(?:www\.)?(?:weibo\.com|m\.weibo\.cn|weibo\.cn|t\.cn)\/[^\s"<]+/i);
    return matched ? matched[0].replace(/[.,;)]+$/g, "") : "";
  };
  const urlsFromPublishModel = () => {
    const htmlText = document.documentElement ? document.documentElement.outerHTML : "";
    const modalMatches = [...htmlText.matchAll(/class="[^"]*\bpublish_model\b[^"]*"/g)];
    const scoped = modalMatches.length ? htmlText.slice(modalMatches[modalMatches.length - 1].index) : "";
    const source = scoped || htmlText;
    const found = [];
    const itemPattern = /class="[^"]*\bpublish_model_item\b[^"]*"(?<body>[\s\S]*?)(?=<div[^>]+class="[^"]*\bpublish_model_item\b|$)/g;
    for (const match of source.matchAll(itemPattern)) {
      const body = match.groups?.body || "";
      const linkMatch = body.match(/class="[^"]*\bpublish_model_link\b[^"]*"[^>]*>(?<link>[\s\S]*?)<\/div>/);
      const linkText = String(linkMatch?.groups?.link || body).replace(/<[^>]+>/g, "");
      let url = extractFirstPublishResultUrl(linkText);
      if (!url) {
        const hrefMatch = body.match(/href="(?<href>https?:\/\/[^"]+)"/i);
        if (hrefMatch) url = extractFirstPublishResultUrl(hrefMatch.groups?.href || "");
      }
      if (url) found.push(url);
    }
    if (!found.length) {
      for (const node of document.querySelectorAll(".publish_model_link, .publish_model a[href], .publish_model input, .weibo-links-dialog a.link, .weibo-link-item a.link, .n-dialog a[href], .n-modal a[href], [role='dialog'] a[href]")) {
        const url = extractFirstPublishResultUrl(node.getAttribute?.("href") || node.value || node.textContent || "");
        if (url) found.push(url);
      }
    }
    return found;
  };
  if (!window.__weiboResultCopyHooked) {
    window.__clipCaptured = window.__clipCaptured || "";
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async (text) => {
          window.__clipCaptured = String(text || "");
          try { return await origWrite(text); } catch (_) {}
        };
      }
    } catch (_) {}
    document.addEventListener("copy", (event) => {
      try {
        const clipData = (event.clipboardData && event.clipboardData.getData("text/plain")) || "";
        const selected = window.getSelection ? window.getSelection().toString() : "";
        const text = clipData || selected;
        if (text) window.__clipCaptured = text;
      } catch (_) {}
    }, true);
    window.__weiboResultCopyHooked = true;
  }
  const copyKeywords = ["复制全部昵称/链接", "复制全部昵称链接", "复制全部链接", "复制全部账号/链接", "复制全部", "复制链接"];
  const clickByText = (keywords, dialogOnly) => {
    const nodes = document.querySelectorAll("button, [role='button'], .n-button, .publish_model span, .n-dialog span");
    for (const keyword of keywords) {
      for (const node of nodes) {
        if (dialogOnly && !node.closest(".publish_model, .n-dialog, .n-modal, [role='dialog']")) continue;
        const text = (node.innerText || node.textContent || "").replace(/\s+/g, "");
        if (text !== keyword && !(text.length <= 20 && text.includes(keyword))) continue;
        try {
          node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        } catch (_) {}
        node.click();
        return true;
      }
    }
    return false;
  };
  for (let attempt = 0; attempt < 40; attempt++) {
    const modelUrls = urlsFromPublishModel();
    if (modelUrls.length) return { ok: true, postUrl: modelUrls[0], source: "publish_model" };
    const copiedAlready = extractFirstPublishResultUrl(window.__clipCaptured);
    if (copiedAlready) return { ok: true, postUrl: copiedAlready, source: "剪贴板" };
    clickByText(copyKeywords, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const copied = extractFirstPublishResultUrl(window.__clipCaptured);
    if (copied) return { ok: true, postUrl: copied, source: "复制按钮" };
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const html = (document.body && document.body.innerHTML) || "";
  const editorMarkers = ["保存并发布", "确认发布", "weibo_editor", "post_footer_btn", "n-input-word-count"];
  const stillEditor = !html.includes("publish_model") && editorMarkers.filter((marker) => html.includes(marker)).length >= 2;
  if (stillEditor) {
    const msgEl = document.querySelector(".n-message, .n-dialog, .n-alert, [role='alert']");
    const msg = msgEl ? (msgEl.innerText || msgEl.textContent || "").trim() : "";
    return { ok: false, error: msg ? `发布被平台提示拦截：${msg}` : "发布后仍停在编辑页，没有进入结果页" };
  }
  return { ok: false, error: "已点击发布，但结果页的 publish_model 里没有链接" };
}

// 直通函数 4：发博后回执链接智能找回 (多通道：剪贴板 / 弹窗DOM / #/wb-list 微博列表)
// ─────────────────────────────────────────────────────────────
async function directRecoverPublishedWeiboUrl(targetAccount, targetContent) {
  try {
    const extractWeiboPostUrl = (rawText, excludedText = "", allowShortUrl = true) => {
      if (!rawText) return "";
      const lines = String(rawText).split(/\r?\n/);
      const excludedUrls = new Set((String(excludedText).match(/https?:\/\/(?:www\.)?(?:weibo\.com|m\.weibo\.cn|t\.cn)\/[^\s"'<>]+/ig) || []).map((url) => url.replace(/[),，。]+$/, "")));
      let shortUrlFallback = "";
      for (const line of lines) {
        // 1. 经典个人博文直链：https://weibo.com/<UID>/<MID>
        const m1 = line.match(/https?:\/\/(?:www\.)?weibo\.com\/([0-9]{5,})\/([A-Za-z0-9]+)/i);
        if (m1 && !Array.from(excludedUrls).some((url) => url.includes(`/${m1[1]}/${m1[2]}`))) {
          return `https://weibo.com/${m1[1]}/${m1[2]}`;
        }
        // 2. 详情页直链：https://weibo.com/detail/<MID>
        const m2 = line.match(/https?:\/\/(?:www\.)?weibo\.com\/detail\/([0-9A-Za-z]+)/i);
        if (m2 && !Array.from(excludedUrls).some((url) => url.includes(`/detail/${m2[1]}`))) {
          return `https://weibo.com/detail/${m2[1]}`;
        }
        // 3. 移动端直链：https://m.weibo.cn/status/<MID>
        const m3 = line.match(/https?:\/\/m\.weibo\.cn\/(?:status|detail)\/([0-9A-Za-z]+)/i);
        if (m3 && !Array.from(excludedUrls).some((url) => url.includes(`/${m3[1]}`))) {
          return `https://m.weibo.cn/status/${m3[1]}`;
        }
        // 4. 微博短链兜底（如列表正文末尾附带的 http://t.cn/AXYuhH3q，排除原正文自带短链）
        if (allowShortUrl && !shortUrlFallback) {
          const shortMatches = line.match(/https?:\/\/t\.cn\/[A-Za-z0-9]+/ig) || [];
          for (const sm of shortMatches) {
            if (!excludedText || !String(excludedText).includes(sm)) {
              shortUrlFallback = sm;
              break;
            }
          }
        }
      }
      return shortUrlFallback;
    };

    // 1. 安装剪贴板拦截
    window.__clipCaptured = window.__clipCaptured || "";
    try {
      if (navigator.clipboard && navigator.clipboard.writeText && !navigator.clipboard.__hookedRecover) {
        const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async (t) => {
          window.__clipCaptured = String(t || "").trim();
          try {
            return await origWrite(t);
          } catch (_) {}
        };
        navigator.clipboard.__hookedRecover = true;
      }
    } catch (_) {}

    const onCopy = (e) => {
      try {
        const t = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
        if (t) window.__clipCaptured = t.trim();
      } catch (_) {}
    };
    document.addEventListener("copy", onCopy, true);

    try {
      const normalize = (text) => String(text || "").replace(/\s+/g, "").toLowerCase();
      const account = normalize(targetAccount);
      const content = normalize(targetContent);
      if (!content) return { ok: false, error: "缺少目标正文，无法核对回执归属" };
      let submission = window.__weiboSyncSubmission;
      if (!submission && typeof sessionStorage !== "undefined") {
        try {
          const rawSub = sessionStorage.getItem("__weiboSyncSubmission");
          if (rawSub) submission = JSON.parse(rawSub);
        } catch (_) {}
      }
      const sameSubmission = submission && submission.submitted &&
        [submission.account, ...(Array.isArray(submission.accounts) ? submission.accounts : [])].some((value) => normalize(value) === account) &&
        normalize(submission.content) === content;
      const previousUrls = new Set(submission?.previousUrls || []);
      if (sameSubmission && (!Array.isArray(submission.accounts) || submission.accounts.length <= 1) && normalize(submission.account) === account && window.__clipCaptured) {
        const u = extractWeiboPostUrl(window.__clipCaptured, targetContent);
        if (u && !previousUrls.has(u)) return { ok: true, postUrl: u, source: "本次提交剪贴板捕获" };
      }
      window.__clipCaptured = "";
      if (!sameSubmission || !account || !Number.isFinite(submission.startedAt)) {
        return { ok: false, error: "缺少本次提交上下文，无法安全判断列表回执归属" };
      }

      // 列表回执必须同时满足账号、正文、提交时间和旧链接排除条件。
      let lastRowCount = 0;
      let topRowSample = "";
      let diagHasAccountCol = false;
      let diagContentHits = 0;
      let diagAccountHits = 0;
      let diagTimeHits = 0;
      let diagRowStatus = "";
      const extractUrlFromWeiboLinksDialog = (requireNamed = false) => {
        const dialogs = Array.from(document.querySelectorAll('.weibo-links-dialog, .n-dialog, .n-modal, [role="dialog"]'));
        for (const dialog of dialogs) {
          const items = Array.from(dialog.querySelectorAll('.weibo-link-item, .publish_model_item'));
          if (!items.length) continue;
          const entries = [];
          for (const item of items) {
            const nickEl = item.querySelector('.nickname, .publish_model_nickname');
            const rawNick = String(nickEl ? (nickEl.innerText || nickEl.textContent || "") : "").replace(/[:：\s]+$/g, "");
            const normNick = normalize(rawNick);
            const linkEl = item.querySelector('a.link, .link-wrapper a, .publish_model_link, a[href], .link');
            const rawLink = linkEl ? (linkEl.getAttribute?.("href") || linkEl.href || linkEl.innerText || linkEl.textContent || "") : (item.innerText || item.textContent || "");
            const url = extractWeiboPostUrl(rawLink, targetContent, false) || extractWeiboPostUrl(rawLink, targetContent);
            if (url && !previousUrls.has(url)) {
              entries.push({ normNick, url, item });
            }
          }
          if (!entries.length) continue;
          let matched = null;
          if (account) {
            const exact = entries.filter((e) => e.normNick === account);
            matched = exact.length === 1 ? exact[0] : (!requireNamed && entries.length === 1 && !entries[0].normNick && (!submission.accounts || submission.accounts.length <= 1) ? entries[0] : null);
          } else if (entries.length === 1) {
            matched = entries[0];
          }
          if (matched) {
            try {
              dialog.querySelector('.n-dialog__close, .n-base-close, [aria-label="close"]')?.click?.();
            } catch (_) {}
            return matched.url;
          }
        }
        return "";
      };
      const contentMatchesCell = (rawCellText) => {
        const normCell = normalize(rawCellText);
        if (!normCell) return false;
        if (normCell === content) return true;
        // 剥离中台微博列表自动附加在正文末尾的博文短链/直链（如 "正文 http://t.cn/AXYuhH3q"）
        const strippedTrailingUrl = String(rawCellText || "")
          .replace(/(?:\s+https?:\/\/(?:t\.cn\/[A-Za-z0-9]+|(?:www\.)?weibo\.com\/\S+|m\.weibo\.cn\/\S+))+\s*$/i, "")
          .trim();
        const normStripped = normalize(strippedTrailingUrl);
        if (normStripped && normStripped === content) return true;
        const candidateForEllipsis = strippedTrailingUrl || String(rawCellText || "").trim();
        if (/(?:\.\.\.|…)$/.test(candidateForEllipsis)) {
          const prefixNorm = normalize(candidateForEllipsis.replace(/(?:\.\.\.|…)+$/, ""));
          if (prefixNorm.length >= 12 && content.startsWith(prefixNorm)) return true;
        }
        return false;
      };
      for (let poll = 0; poll < 15; poll++) {
        const headerCells = Array.from(document.querySelectorAll('thead th, thead .n-data-table-th, [role="columnheader"]'));
        const hasAccountColumn = headerCells.some((h) => /(?:发布账号|微博账号|微博名称|账号名称|发布账户|博主)/.test(String(h.innerText || h.textContent || "")));
        diagHasAccountCol = hasAccountColumn;
        const rows = Array.from(document.querySelectorAll('.n-data-table-tr, tr, .n-list-item, [role="row"]'))
          .filter((r) => !r.closest('thead'));
        lastRowCount = rows.length;
        if (rows.length > 0 && !topRowSample) {
          topRowSample = String(rows[0].innerText || rows[0].textContent || "").replace(/\s+/g, " ").trim().slice(0, 90);
        }

        if (rows.length > 0) {
          diagContentHits = 0;
          diagAccountHits = 0;
          diagTimeHits = 0;
          for (let rIdx = 0; rIdx < rows.length; rIdx++) {
            const row = rows[rIdx];
            const cells = Array.from(row.querySelectorAll('td, [role="cell"], .n-data-table-td'));
            const rawCellTexts = cells.map((cell) => String(cell.getAttribute?.("title") || cell.innerText || cell.textContent || ""));
            const cellTexts = rawCellTexts.map((t) => normalize(t));
            const accountHit = cellTexts.some((ct) => ct === account);
            const contentHit = rawCellTexts.some((raw) => contentMatchesCell(raw));
            if (contentHit) diagContentHits++;
            if (accountHit) diagAccountHits++;
            if (!contentHit) continue;
            if (hasAccountColumn && !accountHit) continue;
            const timeNode = row.querySelector('time[datetime], [data-publish-timestamp]');
            let rawTime = timeNode?.getAttribute?.("datetime") || timeNode?.getAttribute?.("data-publish-timestamp") || "";
            if (!rawTime) {
              for (const cell of cells) {
                const m = String(cell.innerText || cell.textContent || "").match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?/);
                if (m) {
                  rawTime = m[0];
                  break;
                }
              }
            }
            const publishedAt = /^\d{10,13}$/.test(rawTime || "")
              ? Number(rawTime) * (String(rawTime).length === 10 ? 1000 : 1) : Date.parse(rawTime || "");
            const minutePrecision = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}$/.test(String(rawTime).trim());
            // 同一分钟只能证明落在该分钟内，不能证明晚于提交时刻。
            if (!Number.isFinite(publishedAt) || publishedAt < submission.startedAt - (minutePrecision ? 0 : 1000) || publishedAt > Date.now() + 10000) continue;
            diagTimeHits++;

            // 1. 优先查找直链超链接
            const aLink = row.querySelector('a[href*="weibo.com"], a[href*="m.weibo.cn"]');
            if (hasAccountColumn && aLink && aLink.href) {
              const u = extractWeiboPostUrl(aLink.href, targetContent);
              if (u && !previousUrls.has(u)) return { ok: true, postUrl: u, source: "已核对账号正文与发布时间的列表链接" };
            }

            // 2. 检查行内 HTML 中是否有直链（先仅查完整直链，不抢跑 t.cn 短链）
            const rowHtml = row.innerHTML || "";
            const htmlFullUrl = extractWeiboPostUrl(rowHtml, targetContent, false);
            if (hasAccountColumn && htmlFullUrl && !previousUrls.has(htmlFullUrl)) return { ok: true, postUrl: htmlFullUrl, source: "微博列表行HTML" };

            // 3. 点击操作列的“获取链接”弹窗或“复制链接”按钮
            const btns = Array.from(row.querySelectorAll('button, .n-button, a, span, [role="button"]'));
            for (const btn of btns) {
              const bText = (btn.innerText || btn.textContent || "").trim();
              if (bText === "获取链接" || bText.includes("获取链接")) {
                const alreadyOpenUrl = extractUrlFromWeiboLinksDialog(!hasAccountColumn);
                if (alreadyOpenUrl) return { ok: true, postUrl: alreadyOpenUrl, source: "微博列表获取链接弹窗" };
                try {
                  btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
                  btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
                } catch (_) {}
                btn.click();
                for (let waitDlg = 0; waitDlg < 12; waitDlg++) {
                  await new Promise((r) => setTimeout(r, 250));
                  const dlgUrl = extractUrlFromWeiboLinksDialog(!hasAccountColumn);
                  if (dlgUrl) return { ok: true, postUrl: dlgUrl, source: "微博列表获取链接弹窗" };
                }
              } else if (hasAccountColumn && ["复制链接", "复制微博链接"].includes(bText)) {
                try {
                  btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
                  btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
                } catch (_) {}
                btn.click();
                await new Promise((r) => setTimeout(r, 250));
                if (window.__clipCaptured) {
                  const u = extractWeiboPostUrl(window.__clipCaptured, targetContent);
                  if (u && !previousUrls.has(u)) return { ok: true, postUrl: u, source: "微博列表操作列" };
                }
              }
            }
            const statusCell = rawCellTexts.find((t) => /^(?:发布中|待发布|待审核|发布成功|部分发布成功|发布失败)$/.test(String(t || "").trim()));
            if (statusCell) diagRowStatus = String(statusCell).trim();

            if (!hasAccountColumn) continue;
            // 4. 兜底查找 t.cn 短链（超链接 / HTML / 行内文本）
            const shortAnchor = row.querySelector('a[href*="t.cn/"]');
            if (shortAnchor && shortAnchor.href) {
              const u = extractWeiboPostUrl(shortAnchor.href, targetContent);
              if (u && !previousUrls.has(u)) return { ok: true, postUrl: u, source: "微博列表短链" };
            }
            const htmlAnyUrl = extractWeiboPostUrl(rowHtml, targetContent);
            if (htmlAnyUrl && !previousUrls.has(htmlAnyUrl)) return { ok: true, postUrl: htmlAnyUrl, source: "微博列表行HTML" };
            const rowText = row.innerText || row.textContent || "";
            const inlineUrl = extractWeiboPostUrl(rowText, targetContent);
            if (inlineUrl && !previousUrls.has(inlineUrl)) {
              return { ok: true, postUrl: inlineUrl, source: "微博列表行文本" };
            }
          }
        }
        await new Promise((r) => setTimeout(r, 400));
      }

      return {
        ok: false,
        error: `未能在中台当前视图中提取到已发博文链接(rows=${lastRowCount}, hasAcctCol=${diagHasAccountCol}, contentHits=${diagContentHits}, acctHits=${diagAccountHits}, timeHits=${diagTimeHits}${diagRowStatus ? `, 状态=${diagRowStatus}` : ""}${topRowSample ? `, 首行=${topRowSample}` : ""})`,
      };
    } finally {
      document.removeEventListener("copy", onCopy, true);
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// 后台标签页会被 Chrome 降速。调试器只挂在插件自己打开的那个标签上，用来保持页面继续跑，做完就卸掉。
async function holdBackgroundTabAwake(tabId) {
  if (!tabId || !chrome.debugger) return false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    return true;
  } catch (_) {
    return false;
  }
}

async function releaseBackgroundTab(tabId) {
  if (!tabId || !chrome.debugger) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

// Chrome 要求窗口至少有 50% 落在可见屏幕内，放到 3600,3600 会被直接拒绝。
function silentRunnerBounds(mainWin, attempt) {
  const width = 960;
  const height = 720;
  const baseLeft = Number.isFinite(mainWin?.left) ? mainWin.left : 0;
  const baseTop = Number.isFinite(mainWin?.top) ? mainWin.top : 0;
  const hostW = Number.isFinite(mainWin?.width) && mainWin.width >= 200 ? mainWin.width : 1280;
  const hostH = Number.isFinite(mainWin?.height) && mainWin.height >= 200 ? mainWin.height : 800;
  if (attempt > 0) {
    return {
      left: Math.round(baseLeft),
      top: Math.round(baseTop),
      width: Math.min(width, Math.max(400, Math.round(hostW))),
      height: Math.min(height, Math.max(300, Math.round(hostH))),
    };
  }
  return {
    left: Math.round(baseLeft + Math.max(0, hostW - Math.ceil(width * 0.6))),
    top: Math.round(baseTop + Math.max(0, hostH - Math.ceil(height * 0.6))),
    width,
    height,
  };
}

// ─────────────────────────────────────────────────────────────
// 静默独立运行窗口。不抢主窗口焦点；坐标必须留在可见屏幕内。
// ─────────────────────────────────────────────────────────────
async function createSilentRunnerWindow(platformUrl) {
  let mainWin = null;
  try {
    mainWin = await chrome.windows.getCurrent();
  } catch (_) {}

  let win = null;
  for (let attempt = 0; attempt < 2 && !win; attempt++) {
    const bounds = silentRunnerBounds(mainWin, attempt);
    try {
      win = await chrome.windows.create({
        url: platformUrl,
        type: "popup",
        focused: false,
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      });
    } catch (error) {
      if (!/bounds|visible screen/i.test(String(error?.message || error)) || attempt === 1) throw error;
    }
  }

  // 如果某些操作系统抢走了焦点，立即恢复主窗口焦点
  if (mainWin && mainWin.id) {
    try {
      await chrome.windows.update(mainWin.id, { focused: true });
    } catch (_) {}
  }

  let tab = null;
  if (win.tabs && win.tabs.length > 0) {
    tab = win.tabs[0];
  } else {
    const tabs = await chrome.tabs.query({ windowId: win.id });
    tab = tabs[0];
  }

  return { window: win, tab };
}

// ─────────────────────────────────────────────────────────────
// 辅助定位与加载 (按真实域名 Hostname 精确匹配，防止误命中 CAS 登录 query 参数或休眠页)
// ─────────────────────────────────────────────────────────────
function parseTabSheetId(docUrl) {
  try {
    const url = new URL(docUrl);
    return url.searchParams.get("tab") || null;
  } catch (_) {
    return null;
  }
}

function isDingTalkDocUrl(docUrl) {
  try {
    const host = new URL(String(docUrl || "").trim()).hostname.toLowerCase();
    return host === "alidocs.dingtalk.com" || host.endsWith(".alidocs.dingtalk.com");
  } catch (_) {
    return false;
  }
}

function colNumToLetters(n) {
  let num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return "A";
  let out = "";
  while (num > 0) {
    const rem = (num - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    num = Math.floor((num - 1) / 26);
  }
  return out;
}

function parseCellAddrCoords(cellAddr) {
  const clean = String(cellAddr || "").trim().toUpperCase();
  const match = clean.match(/^([A-Z]+)([1-9][0-9]*)$/);
  if (!match) return null;
  const colLetters = match[1];
  const rowNum = parseInt(match[2], 10);
  let colNum = 0;
  for (let i = 0; i < colLetters.length; i++) {
    colNum = colNum * 26 + (colLetters.charCodeAt(i) - 64);
  }
  return { rowNum, colNum, normAddr: clean };
}

function normalizeDingTalkHeader(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/[：:()（）【】[\]_\-./]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeDingTalkImageUrl(url) {
  let val = String(url || "").trim();
  if (!val) return "";
  if (val.startsWith("//")) val = `https:${val}`;
  else if (val.startsWith("/")) val = `https://alidocs.dingtalk.com${val}`;
  if (!/^https?:\/\//i.test(val)) return "";
  return val;
}

function normalizeDingTalkTime(raw) {
  const s = String(raw === null || raw === undefined ? "" : raw).trim();
  if (!s) return "";
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return s;
  const value = Number(s);
  if (!Number.isFinite(value)) return s;

  // 0 <= value < 1：Excel/钉钉纯时间序列号（如 0.736111111111111 -> 17:40:00）
  if (value >= 0 && value < 1) {
    const totalSeconds = Math.round(value * 86400) % 86400;
    const hours = Math.floor(totalSeconds / 3600);
    const rem = totalSeconds % 3600;
    const minutes = Math.floor(rem / 60);
    const seconds = rem % 60;
    const pad = (x) => String(x).padStart(2, "0");
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  // 20000 < value < 80000：Excel 含日期时间序列号
  if (value > 20000 && value < 80000) {
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (Number.isFinite(d.getTime())) {
      const pad = (x) => String(x).padStart(2, "0");
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }
  }
  return s;
}

function extractDingTalkAslText(node) {
  const texts = [];
  const links = [];
  const images = [];

  function walk(item) {
    if (typeof item === "string") {
      if (item) texts.push(item);
      return;
    }
    if (Array.isArray(item)) {
      const isElementTuple =
        item.length >= 2 &&
        typeof item[0] === "string" &&
        item[1] &&
        typeof item[1] === "object" &&
        !Array.isArray(item[1]);
      if (isElementTuple) {
        const attrs = item[1];
        const value = attrs.value;
        const src = attrs.src || attrs.url;
        if (typeof value === "string" && /^https?:\/\//i.test(value)) links.push(value);
        if (typeof src === "string" && src) images.push(src);
      }
      for (let i = isElementTuple ? 2 : 0; i < item.length; i++) walk(item[i]);
      return;
    }
    if (item && typeof item === "object") {
      if (item.type === "path" && typeof item.value === "string") {
        links.push(item.value);
      }
      for (const val of Object.values(item)) walk(val);
    }
  }

  walk(node);
  return {
    text: texts.join("").trim(),
    links,
    images,
  };
}

function extractDingTalkCellPayload(cell) {
  if (!cell || typeof cell !== "object") {
    return { text: String(cell || "").trim(), link: "", images: [] };
  }
  const value = cell.value;
  const linkObj = cell.link;
  const linkValue = linkObj && typeof linkObj === "object" ? String(linkObj.value || "").trim() : "";

  if (typeof value === "string") {
    return { text: value.trim(), link: linkValue, images: [] };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { text: String(value), link: linkValue, images: [] };
  }
  if (value && typeof value === "object") {
    if (value.type === "asl") {
      const { text, links, images } = extractDingTalkAslText(value.data);
      const normImgs = images.map(normalizeDingTalkImageUrl).filter(Boolean);
      return {
        text,
        link: linkValue || (links[0] || ""),
        images: normImgs,
      };
    }
    if (value.type === "image") {
      const imgUrl = normalizeDingTalkImageUrl(value.url || value.src || "");
      return {
        text: "",
        link: linkValue,
        images: imgUrl ? [imgUrl] : [],
      };
    }
  }
  return { text: String(value || "").trim(), link: linkValue, images: [] };
}

function parseDingTalkDocumentPayload(payload, options = {}) {
  let root = payload;
  if (root && typeof root.text === "string" && !(root.data && root.data.documentContent)) {
    root = JSON.parse(root.text);
  }
  const data = (root && root.data) || {};
  const docContent = data.documentContent || {};
  const checkpoint = docContent.checkpoint || {};
  let contentText = checkpoint.content;
  if (typeof contentText !== "string" || !contentText.trim()) {
    const deltas = docContent.deltas || {};
    const snapshot = deltas && typeof deltas === "object" ? deltas.snapshot : null;
    if (typeof snapshot === "string") contentText = snapshot;
    else if (snapshot && typeof snapshot === "object") contentText = JSON.stringify(snapshot);
  }
  if (typeof contentText !== "string" || !contentText.trim()) {
    return { ok: false, error: "钉钉文档返回数据为空，请确认已登录并具有该表格的查看权限" };
  }

  const workbook = JSON.parse(contentText);
  const workbookContent = workbook.content || {};
  const sheetMetas = Array.isArray(workbook.sheetsMeta) ? workbook.sheetsMeta : [];
  const targetSheetId = String(options.targetSheetId || "").trim();
  const explicitLinkCol = String(options.linkColLetter || "").trim().toUpperCase();
  const filterAccount = String(options.filterAccount || "").trim();
  const maxRows = Number(options.maxRows || 500);

  function buildMatrix(rawRows) {
    const matrix = [];
    const imageMap = new Map();
    const rowNumbers = [];
    for (const rowEntry of rawRows || []) {
      if (!Array.isArray(rowEntry) || rowEntry.length < 3) continue;
      const rowNum = Number(rowEntry[0]) + 1;
      const cells = Array.isArray(rowEntry[2]) ? rowEntry[2] : [];
      const rowValues = new Map();
      let maxCol = 0;
      for (const cellEntry of cells) {
        if (!Array.isArray(cellEntry) || cellEntry.length < 2) continue;
        const colNum = Number(cellEntry[0]) + 1;
        if (!Number.isFinite(colNum) || colNum <= 0) continue;
        const parsed = extractDingTalkCellPayload(cellEntry[1] || {});
        rowValues.set(colNum, (parsed.text || parsed.link || "").trim());
        if (parsed.images && parsed.images.length) {
          imageMap.set(`${rowNum}:${colNum}`, parsed.images);
        }
        if (colNum > maxCol) maxCol = colNum;
      }
      if (rowValues.size === 0) continue;
      const row = new Array(maxCol).fill("");
      for (const [colNum, val] of rowValues.entries()) {
        row[colNum - 1] = val;
      }
      matrix.push(row);
      rowNumbers.push(rowNum);
    }
    return { matrix, imageMap, rowNumbers };
  }

  function findHeaderRow(matrix) {
    let bestIdx = 0;
    let bestScore = -1;
    const limit = Math.min(matrix.length, 25);
    const kws = ["账号", "账号名", "账号名称", "正文", "内容", "文案", "链接", "时间", "日期", "素材", "图片", "account", "content", "link"];
    for (let r = 0; r < limit; r++) {
      const norms = matrix[r].map(normalizeDingTalkHeader).filter(Boolean);
      let score = 0;
      for (const n of norms) {
        if (kws.some((k) => n.includes(k))) score += 10;
      }
      if (norms.some((n) => ["账号", "账号名", "账号名称", "发布账号", "媒体账号"].some((k) => n.includes(k)))) score += 25;
      if (norms.some((n) => ["正文", "内容", "文案", "content", "copy", "text"].some((k) => n.includes(k)))) score += 25;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = r;
      }
    }
    return bestIdx;
  }

  function matchColumn(headers, keywords, excluded = []) {
    const norms = headers.map(normalizeDingTalkHeader);
    const usable = (text) => text && !excluded.some((word) => text.includes(word));
    for (let i = 0; i < norms.length; i++) {
      if (usable(norms[i]) && keywords.some((k) => norms[i] === k)) return i;
    }
    for (let i = 0; i < norms.length; i++) {
      if (usable(norms[i]) && keywords.some((k) => norms[i].includes(k))) return i;
    }
    return -1;
  }

  function inferLinkColumn(matrix, headerIdx, headers, takenSet) {
    const sampleRows = matrix.slice(headerIdx + 1, Math.min(matrix.length, headerIdx + 8));
    if (!sampleRows.length) return -1;
    let bestIdx = -1;
    let bestHits = 0;
    const maxW = sampleRows.reduce((m, r) => Math.max(m, r.length), 0);
    const skipNames = new Set(["平台", "团队", "账号", "账号名", "账号名称", "发布时间", "时间", "日期", "文案", "正文", "内容", "素材"]);
    for (let c = 0; c < maxW; c++) {
      if (takenSet.has(c)) continue;
      const hn = normalizeDingTalkHeader(headers[c] || "");
      if (skipNames.has(hn)) continue;
      let hits = 0;
      for (const row of sampleRows) {
        const v = String(row[c] || "").trim().toLowerCase();
        if (v.startsWith("http://") || v.startsWith("https://") || v.includes("weibo.com/")) hits++;
      }
      if (hits > bestHits) {
        bestHits = hits;
        bestIdx = c;
      }
    }
    return bestHits >= 2 ? bestIdx : -1;
  }

  function buildCandidate(sheetId, meta) {
    const sheetContent = workbookContent[sheetId] || {};
    const rawRows = sheetContent.rows || [];
    const { matrix, imageMap, rowNumbers } = buildMatrix(rawRows);
    if (!matrix.length) return null;

    const headerIdx = findHeaderRow(matrix);
    const headers = matrix[headerIdx] || [];
    const accountCol = matchColumn(headers, ["account", "账号", "账号名", "账号名称", "发布账号", "媒体账号"], ["账号类型", "账号类别", "账号属性"]);
    const contentCol = matchColumn(headers, ["content", "正文", "内容", "文案", "copy", "text"], ["brief", "bf", "方向", "要求", "说明", "备注", "分类"]);
    let linkCol = matchColumn(headers, ["link", "链接", "url", "网址", "回写", "回执", "微博链接", "博文链接"], ["素材", "配图", "物料", "图片", "参考"]);
    const timeCol = matchColumn(headers, ["time", "时间", "日期", "发布时间", "排期"]);
    const materialCol = matchColumn(headers, ["素材", "物料", "图片", "配图", "image", "photo", "media"]);

    if (linkCol === -1 && accountCol === 2 && contentCol === 4 && headers.length >= 7) {
      linkCol = 6;
    }
    if (linkCol === -1) {
      const taken = new Set([accountCol, contentCol, timeCol, materialCol].filter((x) => x !== -1));
      linkCol = inferLinkColumn(matrix, headerIdx, headers, taken);
    }
    if (linkCol === -1 && /^[A-Z]+$/.test(explicitLinkCol)) {
      linkCol = Array.from(explicitLinkCol).reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    }
    if (accountCol === -1 || contentCol === -1 || linkCol === -1) return null;

    const tasks = [];
    let currentAccount = "";
    for (let i = headerIdx + 1; i < matrix.length; i++) {
      const rowNum = rowNumbers[i] || i + 1;
      const row = matrix[i] || [];
      const acctVal = String(row[accountCol] || "").trim();
      if (acctVal) currentAccount = acctVal;
      if (!currentAccount) continue;

      const contentVal = String(row[contentCol] || "").trim();
      const linkVal = String(row[linkCol] || "").trim();
      if (!contentVal || linkVal) continue;
      if (filterAccount && !currentAccount.includes(filterAccount) && !filterAccount.includes(currentAccount)) {
        continue;
      }

      const timeVal = timeCol !== -1 ? normalizeDingTalkTime(row[timeCol]) : "";
      const rowImages = [];
      if (materialCol !== -1) {
        for (const img of imageMap.get(`${rowNum}:${materialCol + 1}`) || []) {
          if (!rowImages.includes(img)) rowImages.push(img);
        }
      }
      const maxColScan = Math.max(row.length, headers.length, 20);
      for (let c = 0; c < maxColScan; c++) {
        if (c === accountCol || c === contentCol || c === linkCol || c === timeCol || c === materialCol) continue;
        for (const img of imageMap.get(`${rowNum}:${c + 1}`) || []) {
          if (!rowImages.includes(img)) rowImages.push(img);
        }
      }

      tasks.push({
        row: rowNum,
        account: currentAccount,
        content: contentVal,
        time: timeVal,
        targetCell: `${colNumToLetters(linkCol + 1)}${rowNum}`,
        targetSheetId: sheetId,
        link: "",
        imgUrls: rowImages,
        materialCol: materialCol !== -1 ? colNumToLetters(materialCol + 1) : "",
        provider: "DingTalk",
      });
      if (tasks.length >= maxRows) break;
    }

    const titleNorm = normalizeDingTalkHeader((meta && (meta.title || meta.name)) || "");
    const headerNorms = headers.map(normalizeDingTalkHeader);
    let score = tasks.length;
    if (titleNorm.includes("运营文案")) score += 220;
    if (titleNorm.includes("资源包")) score += 40;
    if (titleNorm.includes("媒介")) score -= 220;
    if (headerNorms.includes("平台")) score += 60;
    if (headerNorms.includes("团队")) score += 30;
    if (headerNorms.includes("账号") || headerNorms.includes("账号名称")) score += 80;
    if (headerNorms.includes("文案") || headerNorms.includes("内容") || headerNorms.includes("正文")) score += 80;
    if (headerNorms.includes("素材")) score += 40;
    if (headerNorms.some((n) => n.includes("brief"))) score -= 40;
    if (headerNorms.some((n) => n.startsWith("http") || n.includes("weibocom"))) score -= 120;

    return {
      sheetId,
      sheetName: (meta && (meta.title || meta.name)) || sheetId,
      tasks,
      score,
    };
  }

  const candidateIds = [];
  const metaById = new Map();
  for (const m of sheetMetas) {
    const sid = String((m && m.id) || "").trim();
    if (sid && !candidateIds.includes(sid)) candidateIds.push(sid);
    if (sid) metaById.set(sid, m);
  }
  for (const key of Object.keys(workbookContent)) {
    const sid = String(key || "").trim();
    if (sid && !candidateIds.includes(sid)) candidateIds.push(sid);
  }

  if (targetSheetId) {
    const exactId = candidateIds.find((id) => {
      const meta = metaById.get(id);
      return id === targetSheetId || (meta && (meta.title === targetSheetId || meta.name === targetSheetId));
    });
    if (!exactId) {
      return { ok: false, error: `未找到指定钉钉子表 [${targetSheetId}]，已阻断扫描` };
    }
    const picked = buildCandidate(exactId, metaById.get(exactId));
    if (!picked) {
      return { ok: false, error: `指定钉钉子表 [${targetSheetId}] 没有可识别的账号/文案/链接列，已阻断扫描` };
    }
    return {
      ok: true,
      provider: "DingTalk",
      sheetName: picked.sheetName,
      sheetId: picked.sheetId,
      tasks: picked.tasks,
    };
  }

  let best = null;
  for (const sid of candidateIds) {
    const cand = buildCandidate(sid, metaById.get(sid));
    if (!cand) continue;
    if (!best || cand.score > best.score) best = cand;
  }

  if (!best) {
    return { ok: false, error: "钉钉表格未检测到包含「账号/文案/链接」的有效工作表" };
  }
  return {
    ok: true,
    provider: "DingTalk",
    sheetName: best.sheetName,
    sheetId: best.sheetId,
    tasks: best.tasks,
  };
}

function dingTalkCellWriteMatches(actual, expected) {
  const left = String(actual || "").replace(/ /g, " ").trim();
  const right = String(expected || "").replace(/ /g, " ").trim();
  return Boolean(right) && left === right;
}

function shouldCommitDingTalkNameBox(inp, targetAddr) {
  if (!inp || !inp.foundInp || !inp.focused) return false;
  return String(inp.val || "").trim().toUpperCase() === String(targetAddr || "").trim().toUpperCase();
}

function readDingTalkCellFromPayload(payload, targetSheetId, rowNum, colNum) {
  let root = payload;
  if (root && typeof root.text === "string" && !(root.data && root.data.documentContent)) {
    root = JSON.parse(root.text);
  }
  const docContent = root?.data?.documentContent || {};
  const checkpoint = docContent.checkpoint || {};
  let contentText = checkpoint.content;
  if (typeof contentText !== "string" || !contentText.trim()) {
    const snapshot = docContent.deltas?.snapshot;
    if (typeof snapshot === "string") contentText = snapshot;
    else if (snapshot && typeof snapshot === "object") contentText = JSON.stringify(snapshot);
  }
  if (typeof contentText !== "string" || !contentText.trim()) return "";
  const workbook = JSON.parse(contentText);
  const workbookContent = workbook.content || {};
  if (targetSheetId && !workbookContent[targetSheetId]) return "";
  const sheetIds = targetSheetId ? [targetSheetId] : Object.keys(workbookContent);
  for (const sid of sheetIds) {
    const rawRows = workbookContent[sid]?.rows || [];
    for (const rowEntry of rawRows) {
      if (!Array.isArray(rowEntry) || Number(rowEntry[0]) + 1 !== rowNum) continue;
      for (const cellEntry of rowEntry[2] || []) {
        if (!Array.isArray(cellEntry) || Number(cellEntry[0]) + 1 !== colNum) continue;
        const parsed = extractDingTalkCellPayload(cellEntry[1] || {});
        return (parsed.text || parsed.link || "").trim();
      }
    }
  }
  return "";
}

async function fetchDingTalkDocumentPayloadInTab(tabId, timeoutMs = 15000, options = {}) {
  const apiUrl = "https://alidocs.dingtalk.com/api/document/data";
  const body = {
    pageMode: 2,
    orgGrayKeys: ["enable_notable_frontend"],
    enableSlice: true,
    anchor: { needSheetSkeleton: true },
  };

  const maxAttempts = Number.isFinite(options?.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : 15;
  let lastDiag = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options?.signal?.aborted) {
      throw new Error("钉钉文档拉取已中止");
    }
    const allowFallback = attempt >= 3;
    let timerId = null;
    const injectStart = Date.now();
    const execPromise = chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: async (url, reqBody, allowTopFallback) => {
        const href = String(window.location.href || "");
        const isSheetFrame = href.includes("/spreadsheetv2/") || href.includes("/sheet");
        if (!isSheetFrame && !allowTopFallback) {
          const iframes = Array.from(document.querySelectorAll("iframe"))
            .map((el) => el.src || el.getAttribute("src") || "")
            .filter(Boolean);
          return { isSheetFrame: false, skipped: true, href, iframes };
        }
        try {
          const parsedHref = new URL(href);
          const docKey = parsedHref.searchParams.get("docKey") || parsedHref.searchParams.get("docId") || "";
          const pathMatch = parsedHref.pathname.match(/\/spreadsheetv2\/([^/]+)/);
          const dentryKey = parsedHref.searchParams.get("dentryKey") || (pathMatch ? pathMatch[1] : "");

          // 从页面已发出的资源记录里提取钉钉自身请求 /api/document/data 的完整 URL（含 query）
          const perfUrls = (typeof performance !== "undefined" && performance.getEntriesByType)
            ? performance.getEntriesByType("resource")
                .map((e) => String(e?.name || ""))
                .filter((n) => n.includes("/api/document/data"))
            : [];

          const candidateRequests = [];
          for (const pu of perfUrls) {
            candidateRequests.push({ url: pu, extraHeaders: true, includeKeysInBody: false });
          }
          if (docKey) {
            candidateRequests.push({ url: `${url}?docKey=${encodeURIComponent(docKey)}`, extraHeaders: true, includeKeysInBody: false });
          }
          candidateRequests.push({ url, extraHeaders: true, includeKeysInBody: false });
          candidateRequests.push({ url, extraHeaders: true, includeKeysInBody: true });

          let lastStatus = 0;
          let lastText = "";
          for (const cand of candidateRequests) {
            const headers = {
              accept: "application/json, text/plain, */*",
              "content-type": "application/json",
            };
            if (cand.extraHeaders) {
              if (docKey) headers["a-doc-key"] = docKey;
              if (dentryKey) headers["a-dentry-key"] = dentryKey;
            }
            const payloadObj = cand.includeKeysInBody
              ? { ...reqBody, ...(docKey ? { docKey } : {}), ...(dentryKey ? { dentryKey } : {}) }
              : reqBody;
            const resp = await fetch(cand.url, {
              method: "POST",
              credentials: "include",
              headers,
              body: JSON.stringify(payloadObj),
            });
            lastStatus = resp.status;
            const text = await resp.text();
            lastText = text;
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch (_) {}
            const hasContent = Boolean(
              parsed?.data?.documentContent?.checkpoint?.content ||
              parsed?.data?.documentContent?.deltas?.snapshot
            );
            if (hasContent) {
              return {
                isSheetFrame,
                href,
                status: resp.status,
                hasContent: true,
                snippet: "",
                payload: parsed,
              };
            }
          }
          return {
            isSheetFrame,
            href,
            status: lastStatus,
            hasContent: false,
            snippet: `docKey=${docKey || "none"} dentry=${dentryKey || "none"} perf=${perfUrls.length} ${lastText.slice(0, 140)}`,
            payload: null,
          };
        } catch (err) {
          return { isSheetFrame, href, error: err?.message || String(err) };
        }
      },
      args: [apiUrl, body, allowFallback],
    });
    const frameResults = await (timeoutMs > 0
      ? Promise.race([
          execPromise,
          new Promise((_, reject) => {
            timerId = setTimeout(() => {
              if (timeoutMs <= 1000 || Date.now() - injectStart >= timeoutMs - 50) {
                reject(new Error(`钉钉文档接口拉取超时 (${Math.round(timeoutMs / 1000)}秒)`));
              }
            }, timeoutMs);
          }),
        ])
      : execPromise
    )
      .catch((err) => [{ result: { error: `executeScript failed: ${err?.message || String(err)}` } }])
      .finally(() => {
        if (timerId) clearTimeout(timerId);
      });

    const results = (frameResults || []).map((r) => r?.result).filter(Boolean);
    lastDiag = results;
    const sheetHit = results.find((r) => r.isSheetFrame && r.hasContent);
    if (sheetHit) return sheetHit.payload;

    const anyHit = results.find((r) => r.hasContent);
    if (anyHit) return anyHit.payload;

    await new Promise((r) => setTimeout(r, 400));
  }

  const diagSummary = lastDiag
    .map((r) => {
      if (r.error) return `[err:${r.error}]`;
      const extra = r.iframes?.length ? ` iframes=${r.iframes.join(",")}` : "";
      const snip = r.snippet ? ` resp=${r.snippet}` : "";
      return `[${r.href || "?"} status=${r.status ?? "skip"}${extra}${snip}]`;
    })
    .join(" | ");
  throw new Error(`未能在钉钉文档标签页中读取到表格数据 (${diagSummary || "无frame返回"})`);
}

async function scanDingTalkDocTab(tabId, options = {}) {
  const payload = await fetchDingTalkDocumentPayloadInTab(tabId);
  return parseDingTalkDocumentPayload(payload, options);
}

async function sendCdpKeyEnter(tabId) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    unmodifiedText: "\r",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

async function sendCdpCtrlA(tabId) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 2,
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
}

async function sendCdpCtrlC(tabId) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 2,
    key: "c",
    code: "KeyC",
    windowsVirtualKeyCode: 67,
    nativeVirtualKeyCode: 67,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    key: "c",
    code: "KeyC",
    windowsVirtualKeyCode: 67,
    nativeVirtualKeyCode: 67,
  });
}

async function armDingTalkCopyCapture(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: () => {
      const href = String(window.location.href || "");
      if (!href.includes("/spreadsheetv2/") && !href.includes("/sheet")) return null;
      window.__dingtalkClipCaptured = "";
      if (!window.__dingtalkCopyHooked) {
        window.__dingtalkCopyHooked = true;
        document.addEventListener("copy", (e) => {
          try {
            const origSet = e.clipboardData?.setData?.bind(e.clipboardData);
            if (origSet) {
              e.clipboardData.setData = function (type, val) {
                const lowerType = String(type || "").toLowerCase();
                if (lowerType === "text/plain" && val) {
                  window.__dingtalkClipCaptured = String(val);
                } else if (lowerType === "text/html" && val && !window.__dingtalkClipCaptured) {
                  const stripped = String(val).replace(/<[^>]+>/g, " ").trim();
                  if (stripped && !stripped.startsWith("{")) {
                    window.__dingtalkClipCaptured = stripped;
                  }
                }
                return origSet(type, val);
              };
            }
          } catch (_) {}
        }, true);
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
          navigator.clipboard.writeText = async function (txt) {
            if (txt) window.__dingtalkClipCaptured = String(txt);
            return origWrite(txt);
          };
        }
        if (navigator.clipboard && typeof navigator.clipboard.write === "function") {
          const origWriteItems = navigator.clipboard.write.bind(navigator.clipboard);
          navigator.clipboard.write = async function (items) {
            try {
              for (const item of items || []) {
                if (item?.types?.includes("text/plain")) {
                  const blob = await item.getType("text/plain");
                  const txt = await blob.text();
                  if (txt) window.__dingtalkClipCaptured = String(txt);
                }
              }
            } catch (_) {}
            return origWriteItems(items);
          };
        }
      }
      return true;
    },
  }).catch(() => []);
}

async function readDingTalkCopyCapture(tabId) {
  const frameResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: async () => {
      const href = String(window.location.href || "");
      if (!href.includes("/spreadsheetv2/") && !href.includes("/sheet")) return null;
      const captured = String(window.__dingtalkClipCaptured || "").trim();
      if (captured && !/^\{"cid":/.test(captured)) return captured;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
          const txt = await Promise.race([
            navigator.clipboard.readText(),
            new Promise((resolve) => setTimeout(() => resolve(""), 2000)),
          ]);
          if (txt && txt.trim()) return txt.trim();
        }
      } catch (_) {}
      return "";
    },
  }).catch(() => []);
  return (frameResults || []).map((r) => r?.result).find((v) => typeof v === "string" && v.trim()) || "";
}

async function ensureDingTalkNameBoxInput(tabId, targetAddr) {
  const frameResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: (addr) => {
      const href = String(window.location.href || "");
      if (!href.includes("/spreadsheetv2/") && !href.includes("/sheet")) return null;
      const inp = document.querySelector('input[data-testid="SelectionEditContainer"]');
      const active = document.activeElement;
      const activeTag = active ? `${active.tagName}.${String(active.getAttribute?.("data-testid") || active.className || "").slice(0, 24)}` : "none";
      if (!inp) {
        const divBox = document.querySelector('div.sc-dcJsrY, [data-role="namebox"], [class*="namebox" i]');
        if (divBox) divBox.click();
        return { foundInp: false, activeTag, val: "", focused: false };
      }
      inp.focus();
      if (addr && (inp.value || "").trim().toUpperCase() !== addr) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(inp, addr);
        else inp.value = addr;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { foundInp: true, activeTag, val: String(inp.value || "").trim(), focused: document.activeElement === inp };
    },
    args: [targetAddr || ""],
  }).catch(() => []);
  return (frameResults || []).map((r) => r?.result).find(Boolean) || { foundInp: false, activeTag: "no-frame", val: "" };
}

async function inspectDingTalkSheetState(tabId) {
  const frameResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: () => {
      const href = String(window.location.href || "");
      if (!href.includes("/spreadsheetv2/") && !href.includes("/sheet")) return null;

      let currentAddr = "";
      const testIdInp = document.querySelector('input[data-testid="SelectionEditContainer"]');
      if (testIdInp && /^[A-Z]+\d+$/i.test((testIdInp.value || "").trim())) {
        currentAddr = testIdInp.value.trim().toUpperCase();
      } else {
        const selectors = ['div.sc-dcJsrY', '[data-role="namebox"]', '[class*="namebox"]', '[class*="NameBox"]', '[class*="name-box"]'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          const txt = (el?.innerText || el?.textContent || "").trim().toUpperCase();
          if (/^[A-Z]+\d+$/.test(txt)) {
            currentAddr = txt;
            break;
          }
        }
      }

      // 尝试从钉钉顶部公式栏读回当前选中单元格内容（仅匹配真实可编辑输入节点，避开“公式”菜单按钮）
      let formulaValue = "";
      const formulaNodes = Array.from(document.querySelectorAll(
        '[class*="formula" i] [contenteditable="true"], [class*="formula" i] textarea, [class*="formula" i] input, [data-testid*="formula" i][contenteditable="true"], [data-testid*="formula" i] textarea, [data-testid*="formula" i] input'
      ));
      for (const node of formulaNodes) {
        if (node.getAttribute?.("data-testid") === "SelectionEditContainer") continue;
        const txt = String(node.value !== undefined ? node.value : (node.innerText || node.textContent || "")).trim();
        if (txt && txt !== "公式" && txt.toLowerCase() !== "fx") {
          formulaValue = txt;
          break;
        }
      }

      // 读取当前激活的子表 Tab 名称（用于防跨子表误写校验）
      let activeSheetTitle = "";
      const activeTabSelectors = [
        '[role="tab"][aria-selected="true"]',
        '[class*="sheet-tab"][class*="active"]',
        '[class*="SheetTab"][class*="active"]',
        '[class*="tab-item"][class*="active"]',
      ];
      for (const sel of activeTabSelectors) {
        const tabEl = document.querySelector(sel);
        const txt = String(tabEl?.innerText || tabEl?.textContent || "").trim();
        if (txt) {
          activeSheetTitle = txt;
          break;
        }
      }

      return { isSheetFrame: true, currentAddr, formulaValue, formulaReadable: formulaNodes.length === 1, activeSheetTitle };
    },
  }).catch(() => []);
  return (frameResults || []).map((r) => r?.result).find(Boolean) || null;
}

async function sendCdpClick(tabId, x, y) {
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    throw new Error(`CDP点击坐标无效: x=${String(x)}, y=${String(y)}`);
  }
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
}

async function getDingTalkNameBoxCoords(tabId) {
  const frameResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: () => {
      const href = String(window.location.href || "");
      const isTop = window.self === window.top;
      if (isTop) {
        const iframes = Array.from(document.querySelectorAll("iframe"));
        const sheetIframe = iframes.find((f) => String(f.src || f.getAttribute("src") || "").includes("/spreadsheetv2/"));
        if (sheetIframe) {
          const r = sheetIframe.getBoundingClientRect();
          return { kind: "topOffset", left: r.left, top: r.top };
        }
        return { kind: "topOffset", left: 0, top: 0 };
      }
      if (!href.includes("/spreadsheetv2/") && !href.includes("/sheet")) return null;

      const pickTarget = () => {
        const testIdInp = document.querySelector('input[data-testid="SelectionEditContainer"]');
        if (testIdInp && testIdInp.offsetParent !== null) return testIdInp;

        const selectors = [
          'div.sc-dcJsrY',
          '[data-role="namebox"]',
          '[data-testid*="namebox" i]',
          '[class*="namebox" i]',
          '[class*="name-box" i]',
          'input[type="text"]',
        ];
        for (const sel of selectors) {
          for (const el of document.querySelectorAll(sel)) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (sel === 'input[type="text"]' && rect.top > 180) continue;
            const txt = String(el.value !== undefined ? el.value : (el.innerText || el.textContent || "")).trim();
            if (/^[A-Z]+\d+(?::[A-Z]+\d+)?$/i.test(txt) || sel !== 'input[type="text"]') {
              return el;
            }
          }
        }
        const candidates = Array.from(document.querySelectorAll("div, span, input"))
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.top > 0 && rect.top < 180 && rect.left < 280 && rect.width > 20 && rect.width < 180 && rect.height >= 14 && rect.height <= 45;
          })
          .filter((el) => {
            const txt = String(el.value !== undefined ? el.value : (el.innerText || el.textContent || "")).trim();
            return /^[A-Z]+\d+(?::[A-Z]+\d+)?$/i.test(txt);
          });
        return candidates[0] || null;
      };

      const target = pickTarget();
      if (!target) {
        const nearTopLeft = Array.from(document.querySelectorAll("div, span, input"))
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.top > 0 && rect.top < 160 && rect.left < 240 && rect.width > 15 && rect.height > 12;
          })
          .slice(0, 8)
          .map((el) => `${el.tagName}.${String(el.className || "").slice(0, 24)}=${String(el.value || el.innerText || "").trim().slice(0, 20)}`);
        return { kind: "sheet", found: false, diag: nearTopLeft.join(";") };
      }

      const rect = target.getBoundingClientRect();
      let frameOffsetX = 0;
      let frameOffsetY = 0;
      let hasFrameOffset = false;
      try {
        let win = window;
        while (win && win !== win.top && win.frameElement) {
          const fr = win.frameElement.getBoundingClientRect();
          frameOffsetX += fr.left;
          frameOffsetY += fr.top;
          hasFrameOffset = true;
          win = win.parent;
        }
      } catch (_) {
        hasFrameOffset = false;
      }
      target.focus?.();
      target.click?.();
      return {
        kind: "sheet",
        found: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        frameOffsetX,
        frameOffsetY,
        hasFrameOffset,
        tag: target.tagName,
        text: String(target.value !== undefined ? target.value : (target.innerText || target.textContent || "")).trim(),
      };
    },
  }).catch(() => []);

  const results = (frameResults || []).map((r) => r?.result).filter(Boolean);
  const offset = results.find((r) => r.kind === "topOffset") || { left: 0, top: 0 };
  const sheet = results.find((r) => r.kind === "sheet");
  if (!sheet || !sheet.found) {
    return { found: false, diag: sheet?.diag || "no-sheet-frame" };
  }
  const baseLeft = sheet.hasFrameOffset ? Number(sheet.frameOffsetX || 0) : Number(offset.left || 0);
  const baseTop = sheet.hasFrameOffset ? Number(sheet.frameOffsetY || 0) : Number(offset.top || 0);
  const finalX = Math.round(baseLeft + Number(sheet.x));
  const finalY = Math.round(baseTop + Number(sheet.y));
  if (!Number.isFinite(finalX) || !Number.isFinite(finalY)) {
    return { found: false, diag: `invalid-coords(${offset.left},${offset.top},${sheet.x},${sheet.y})` };
  }
  return {
    found: true,
    x: finalX,
    y: finalY,
    diag: `${sheet.tag}:${sheet.text}`,
  };
}

async function dingTalkPointerAllowed(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.active) return false;
    if (tab.windowId == null || !chrome.windows || typeof chrome.windows.get !== "function") return false;
    const win = await chrome.windows.get(tab.windowId);
    return Boolean(win && win.focused === false);
  } catch (_) {
    return false;
  }
}

function validateDingTalkWriteSnapshot(payload, targetSheetId, coords, snapshot, linkValue, activeSheetTitle) {
  try {
    if (!targetSheetId || !snapshot?.account || !snapshot?.content || !activeSheetTitle) throw new Error("缺少子表、账号、正文或当前子表信息");
    if ((snapshot.sheetId && String(snapshot.sheetId) !== targetSheetId) || (snapshot.row && Number(snapshot.row) !== coords.rowNum)) throw new Error("任务快照子表或行号不一致");
    const root = typeof payload?.text === "string" && !payload?.data?.documentContent ? JSON.parse(payload.text) : payload;
    const doc = root?.data?.documentContent;
    const raw = doc?.checkpoint?.content || doc?.deltas?.snapshot;
    const workbook = typeof raw === "string" ? JSON.parse(raw) : structuredClone(raw);
    const meta = (workbook?.sheetsMeta || []).filter((m) => String(m?.id || "") === targetSheetId);
    const title = String(activeSheetTitle).trim();
    if (meta.length !== 1 || !meta[0].title || String(meta[0].title).trim() !== title ||
        workbook.sheetsMeta.filter((m) => String(m?.title || "").trim() === title).length !== 1) throw new Error("无法确认当前子表与目标子表一致");
    const rows = workbook?.content?.[targetSheetId]?.rows;
    if (!Array.isArray(rows)) throw new Error("无法读取目标子表");
    const matches = rows.filter((r) => Array.isArray(r) && Number(r[0]) + 1 === coords.rowNum);
    if (matches.length !== 1 || !Array.isArray(matches[0][2])) throw new Error("无法确认目标行");
    const cells = matches[0][2].filter((c) => Array.isArray(c) && Number(c[0]) + 1 === coords.colNum);
    if (cells.length > 1) throw new Error("目标单元格不唯一");
    if (cells.length && (!cells[0][1] || typeof cells[0][1] !== "object" || cells[0][1].formula != null || cells[0][1].value === undefined)) throw new Error("目标单元格内容无法验证");
    let existingValue = "";
    if (cells.length) {
      const value = cells[0][1].value;
      if (value !== null && typeof value !== "string" && typeof value !== "number" && !(typeof value === "object" && value.type === "asl" && Array.isArray(value.data))) throw new Error("目标单元格内容无法验证");
      const parsed = extractDingTalkCellPayload(cells[0][1]);
      if (parsed.link && !dingTalkCellWriteMatches(parsed.link, linkValue)) throw new Error("目标单元格已有不同链接，禁止覆盖");
      const actual = String(parsed.text || parsed.link || "").trim();
      if (parsed.images?.length || (!actual && typeof value === "object")) throw new Error("目标单元格内容无法验证");
      if (actual && !dingTalkCellWriteMatches(actual, linkValue)) throw new Error("目标单元格已有不同内容，禁止覆盖");
      existingValue = actual;
      if (actual) matches[0][2] = matches[0][2].filter((c) => c !== cells[0]);
    }
    const parsed = parseDingTalkDocumentPayload({ data: { documentContent: { checkpoint: { content: JSON.stringify(workbook) } } } }, { targetSheetId, linkColLetter: coords.normAddr.replace(/\d+$/, ""), maxRows: Number.MAX_SAFE_INTEGER });
    const task = parsed.ok && parsed.tasks.find((t) => t.targetCell === coords.normAddr);
    if (!task || task.account !== String(snapshot.account).trim() || task.content !== String(snapshot.content).trim()) throw new Error("目标行账号或正文与任务快照不一致");
    return existingValue ? { ok: true, idempotent: true, value: existingValue } : { ok: true };
  } catch (err) {
    return { ok: false, error: `钉钉写前校验失败：${err?.message || String(err)}` };
  }
}

async function writeDingTalkCellInTab(tabId, cellAddr, linkValue, targetSheetId, options = {}) {
  const coords = parseCellAddrCoords(cellAddr);
  if (!coords) return { ok: false, error: "无效的钉钉单元格地址" };
  const cleanValue = String(linkValue || "").trim();
  if (!cleanValue) return { ok: false, error: "缺少写入链接" };
  const isAborted = () => Boolean(options?.signal?.aborted);

  // ── 通道 1：CDP 真实鼠标 + 真实键盘引擎 (100% 对齐原系统 Playwright 操作，绕过 Canvas 合成事件拦截) ──
  const canUseDebugger = typeof chrome !== "undefined" && chrome.debugger && typeof chrome.debugger.attach === "function";
  if (!canUseDebugger) return { ok: false, error: "钉钉写回无法验证当前子表和单元格，已阻断写入" };
  if (canUseDebugger) {
    let initialState = await inspectDingTalkSheetState(tabId);
    if (!initialState) {
      await new Promise((r) => setTimeout(r, 800));
      initialState = await inspectDingTalkSheetState(tabId);
    }
    if (!initialState) {
      return { ok: false, error: "钉钉表格编辑帧尚未就绪，请确认文档已加载完成并具备编辑权限" };
    }

    if (isAborted()) return { ok: false, error: "钉钉写回已超时中止" };

    let attached = false;
    try {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch (attachErr) {
        if (/already attached/i.test(String(attachErr?.message || attachErr))) {
          await chrome.debugger.detach({ tabId }).catch(() => {});
          await chrome.debugger.attach({ tabId }, "1.3");
        } else {
          throw attachErr;
        }
      }
      attached = true;
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
      await chrome.debugger.sendCommand({ tabId }, "Browser.grantPermissions", {
        origin: "https://alidocs.dingtalk.com",
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      }).catch(() => {});

      let lastNavDiag = "";
      const navigateToTarget = async () => {
        const pointerAllowed = await dingTalkPointerAllowed(tabId);
        for (let attempt = 0; attempt < 3; attempt++) {
          if (isAborted()) return false;
          const st = await inspectDingTalkSheetState(tabId);
          if (st?.currentAddr === coords.normAddr) return true;
          let box = { found: false, diag: "skip-pointer" };
          if (pointerAllowed) {
            box = await getDingTalkNameBoxCoords(tabId);
            if (box.found) {
              await sendCdpClick(tabId, box.x, box.y);
              await new Promise((r) => setTimeout(r, 250));
            }
          }
          const inpBefore = await ensureDingTalkNameBoxInput(tabId, coords.normAddr);
          lastNavDiag = `cur=${st?.currentAddr || "none"} box=${box.found ? `${box.x},${box.y}(${box.diag})` : box.diag} inp=${inpBefore.foundInp ? "1" : "0"}(${inpBefore.val}) focused=${inpBefore.focused ? "1" : "0"} active=${inpBefore.activeTag}`;
          if (!inpBefore.foundInp || !inpBefore.focused) continue;
          await sendCdpCtrlA(tabId);
          await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: coords.normAddr });
          await new Promise((r) => setTimeout(r, 120));
          const inpAfter = await ensureDingTalkNameBoxInput(tabId, coords.normAddr);
          lastNavDiag = `cur=${st?.currentAddr || "none"} box=${box.found ? `${box.x},${box.y}(${box.diag})` : box.diag} inp=${inpBefore.foundInp ? "1" : "0"}->${inpAfter.foundInp ? "1" : "0"}(${inpAfter.val}) focused=${inpAfter.focused ? "1" : "0"} active=${inpAfter.activeTag}`;
          if (!shouldCommitDingTalkNameBox(inpAfter, coords.normAddr)) continue;
          await sendCdpKeyEnter(tabId);
          for (let w = 0; w < 12; w++) {
            await new Promise((r) => setTimeout(r, 200));
            const cur = await inspectDingTalkSheetState(tabId);
            if (cur?.currentAddr === coords.normAddr) return true;
          }
        }
        return false;
      };

      const navigated = await navigateToTarget();
      if (!navigated) {
        return { ok: false, error: `钉钉表格名称框未能定位到单元格 ${coords.normAddr} (${lastNavDiag})` };
      }

      const payload = await fetchDingTalkDocumentPayloadInTab(tabId, 8000, { signal: options?.signal, maxAttempts: 2 });
      const cellBeforeState = await inspectDingTalkSheetState(tabId);
      if (isAborted()) return { ok: false, error: "钉钉写回已超时中止" };
      if (cellBeforeState?.currentAddr !== coords.normAddr || !cellBeforeState.formulaReadable) {
        return { ok: false, error: "无法确认目标单元格或读取公式栏，已阻断写回" };
      }
      const guard = validateDingTalkWriteSnapshot(payload, targetSheetId, coords, options.snapshot, cleanValue, cellBeforeState.activeSheetTitle);
      if (!guard.ok) return guard;
      const beforeVal = String(cellBeforeState.formulaValue || "").trim();
      if (beforeVal && !dingTalkCellWriteMatches(beforeVal, cleanValue)) {
        return { ok: false, error: `钉钉单元格 ${coords.normAddr} 已有不同内容，已阻断覆盖写入` };
      }
      if (guard.idempotent && dingTalkCellWriteMatches(beforeVal, cleanValue)) {
        return { ok: true, cell: coords.normAddr, value: beforeVal, idempotent: true };
      }
      if (guard.idempotent || beforeVal) return { ok: false, error: "钉钉单元格接口与公式栏不一致，已阻断写回" };

      // 先离开名称框再输入链接。否则链接会接在 G209 后面，回车跳到错误单元格。
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: () => {
          const href = String(window.location.href || "");
          if (!href.includes("/spreadsheetv2/") && !href.includes("/sheet")) return;
          const inp = document.querySelector('input[data-testid="SelectionEditContainer"]');
          if (inp) inp.blur();
          const canvas = document.querySelector("canvas");
          if (canvas) {
            if (!canvas.hasAttribute("tabindex")) canvas.setAttribute("tabindex", "-1");
            canvas.focus?.();
          }
        },
      }).catch(() => {});
      if (isAborted()) return { ok: false, error: "钉钉写回已超时中止" };
      await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: cleanValue });
      await new Promise((r) => setTimeout(r, 250));
      await sendCdpKeyEnter(tabId);
      await new Promise((r) => setTimeout(r, 600));

      // 回读验证。公式栏和接口快照都会比真正落盘晚，不能只采样一次。
      await navigateToTarget();
      let afterState = null;
      let copiedVal = "";
      for (let verifyAttempt = 0; verifyAttempt < 8; verifyAttempt++) {
        if (isAborted()) return { ok: false, error: "钉钉写回已超时中止" };
        if (verifyAttempt > 0) await new Promise((r) => setTimeout(r, 700));
        afterState = await inspectDingTalkSheetState(tabId);
        if (dingTalkCellWriteMatches(afterState?.formulaValue, cleanValue)) {
          return { ok: true, cell: coords.normAddr, value: String(afterState.formulaValue).trim() };
        }

        if (verifyAttempt === 0 || verifyAttempt === 3) {
          await armDingTalkCopyCapture(tabId);
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: "MAIN",
            func: () => {
              const href = String(window.location.href || "");
              if (!href.includes("/spreadsheetv2/") && !href.includes("/sheet")) return;
              const inp = document.querySelector('input[data-testid="SelectionEditContainer"]');
              if (inp && document.activeElement === inp) inp.blur();
              const canvas = document.querySelector("canvas");
              if (canvas) {
                if (!canvas.hasAttribute("tabindex")) canvas.setAttribute("tabindex", "-1");
                canvas.focus?.();
              }
            },
          }).catch(() => {});
          await new Promise((r) => setTimeout(r, 120));
          await sendCdpCtrlC(tabId);
          await new Promise((r) => setTimeout(r, 400));
          copiedVal = await readDingTalkCopyCapture(tabId);
          if (dingTalkCellWriteMatches(copiedVal, cleanValue)) {
            return { ok: true, cell: coords.normAddr, value: String(copiedVal).trim() };
          }
        }

        try {
          const payload = await fetchDingTalkDocumentPayloadInTab(tabId, 8000, { signal: options?.signal, maxAttempts: 2 });
          const actual = readDingTalkCellFromPayload(payload, targetSheetId, coords.rowNum, coords.colNum);
          if (dingTalkCellWriteMatches(actual, cleanValue)) {
            return { ok: true, cell: coords.normAddr, value: actual };
          }
        } catch (_) {}
      }
      return {
        ok: false,
        error: `钉钉单元格 ${coords.normAddr} 写入后回读校验未生效 (formula=${afterState?.formulaValue || "空"}, copy=${copiedVal || "空"})`,
      };
    } catch (err) {
      return { ok: false, error: `钉钉写回异常: ${err?.message || String(err)}` };
    } finally {
      if (attached) {
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
        await chrome.debugger.detach({ tabId }).catch(() => {});
      }
    }
  }

  // ── 通道 2：无 debugger 权限时的兜底注入通道（含单元测试兼容） ──
  const frameResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: async (targetAddr, val) => {
      const href = String(window.location.href || "");
      const isSheetFrame = href.includes("/spreadsheetv2/");
      if (!isSheetFrame) return null;

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const readCurrentAddr = () => {
        const inp = document.querySelector('input[data-testid="SelectionEditContainer"]');
        if (inp && /^[A-Z]+\d+$/i.test((inp.value || "").trim())) return inp.value.trim().toUpperCase();
        const nameBox = document.querySelector('div.sc-dcJsrY, [data-role="namebox"], [class*="namebox"], [class*="NameBox"]');
        const txt = (nameBox?.innerText || nameBox?.textContent || "").trim().toUpperCase();
        return /^[A-Z]+\d+$/.test(txt) ? txt : "";
      };

      const focusNameBox = async () => {
        const active = document.activeElement;
        if (active && active.tagName === "INPUT" && (active.getAttribute("data-testid") === "SelectionEditContainer" || /^[A-Z]+\d+$/i.test((active.value || "").trim()))) {
          return true;
        }
        const selectors = ['div.sc-dcJsrY', '[data-role="namebox"]', '[class*="namebox"]', '[class*="NameBox"]', '[class*="name-box"]'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && /^[A-Z]+\d+$/i.test((el.innerText || el.textContent || "").trim())) {
            el.click();
            await sleep(250);
            return true;
          }
        }
        return false;
      };

      // 1. 定位目标单元格
      let navigated = readCurrentAddr() === targetAddr;
      for (let attempt = 0; attempt < 3 && !navigated; attempt++) {
        await focusNameBox();
        const inp = document.querySelector('input[data-testid="SelectionEditContainer"]') ||
          Array.from(document.querySelectorAll('input[type="text"]')).find((n) => n.offsetParent !== null);
        if (inp) {
          inp.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(inp, targetAddr);
          else inp.value = targetAddr;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        }
        for (let w = 0; w < 12; w++) {
          await sleep(200);
          if (readCurrentAddr() === targetAddr) {
            navigated = true;
            break;
          }
        }
      }
      if (!navigated) {
        return { ok: false, error: `钉钉表格名称框未能定位到单元格 ${targetAddr}` };
      }

      // 2. 尝试通过公式栏 / 选区编辑器写入并回车提交
      const formulaEditors = Array.from(document.querySelectorAll(
        'textarea, [contenteditable="true"], input[class*="formula"], input[class*="Formula"], div[class*="formula"] [contenteditable="true"]'
      )).filter((el) => el.getAttribute("data-testid") !== "SelectionEditContainer" && el.offsetParent !== null);

      let written = false;
      const editor = formulaEditors[0] || document.activeElement;
      if (editor && editor.getAttribute?.("data-testid") !== "SelectionEditContainer") {
        editor.focus?.();
        if (editor.tagName === "INPUT" || editor.tagName === "TEXTAREA") {
          const proto = editor.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(editor, val);
          else editor.value = val;
          editor.dispatchEvent(new Event("input", { bubbles: true }));
          editor.dispatchEvent(new Event("change", { bubbles: true }));
          written = true;
        } else if (editor.isContentEditable) {
          editor.innerText = val;
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: val, inputType: "insertText" }));
          written = true;
        }
      }

      // 兜底：向当前选区派发 paste 事件
      if (!written) {
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", val);
          const pasteEvt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
          (document.activeElement || document.body).dispatchEvent(pasteEvt);
          written = true;
        } catch (_) {}
      }

      await sleep(250);
      const submitTarget = editor || document.activeElement || document.body;
      submitTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      submitTarget.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      await sleep(800);
      return { ok: true, navigated: true, written };
    },
    args: [coords.normAddr, cleanValue],
  }).catch(() => []);

  const hit = (frameResults || []).map((r) => r?.result).find(Boolean);
  if (!hit) {
    // 非 spreadsheetv2（简单 HTML 表格）回退
    return await executeInTabDirect(tabId, directWriteCellToDoc, [coords.normAddr, cleanValue, targetSheetId], "MAIN", "", false);
  }
  if (!hit.ok) return hit;

  // 3. 通过 api/document/data 回读验证目标单元格是否写入成功
  for (let verifyAttempt = 0; verifyAttempt < 4; verifyAttempt++) {
    try {
      const payload = await fetchDingTalkDocumentPayloadInTab(tabId);
      const actual = readDingTalkCellFromPayload(payload, targetSheetId, coords.rowNum, coords.colNum);
      if (dingTalkCellWriteMatches(actual, cleanValue)) {
        return { ok: true, cell: coords.normAddr, value: actual };
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 600));
  }
  return { ok: false, error: `钉钉单元格 ${coords.normAddr} 写入后回读校验未生效` };
}

async function findOrCreateTab(urlMatch, createUrl, shouldActivate = false, onCreate = null) {
  const cleanMatch = String(urlMatch || "").trim();
  const cleanCreate = String(createUrl || "").trim();

  if (!cleanCreate || !cleanCreate.startsWith("http")) {
    throw new Error(`无效的目标地址 [${cleanCreate || "空"}]，必须是合法的 http/https 链接`);
  }

  let targetHost = "";
  let targetPathPrefix = "";
  let targetHash = "";
  try {
    const parsedCreate = new URL(cleanCreate);
    targetHost = parsedCreate.hostname.toLowerCase();
    targetPathPrefix = parsedCreate.pathname;
    targetHash = parsedCreate.hash || "";
  } catch (_) {}

  const tabs = await chrome.tabs.query({});
  if (cleanMatch) {
    for (const t of tabs) {
      if (!t.url || isProtectedBrowserUrl(t.url)) continue;
      try {
        const u = new URL(t.url);
        const host = u.hostname.toLowerCase();
        // 必须真实域名匹配，绝不因为 ?service=xxx 参数误匹配到 cas.erp.sina.com.cn 登录页
        if (targetHost && host !== targetHost) continue;
        if (targetHost && host === targetHost && u.pathname === targetPathPrefix) {
          // 如果目标要求 #/post 发博页，但当前标签页停留在 #/wb-list（微博列表）等其他 hash 路由，主动切回 #/post
          const needHashRedirect = targetHash === "#/post" && (!u.hash.startsWith("#/post") || u.hash.includes("taskId="));
          if (needHashRedirect) {
            appendLog(`检测到中台标签页当前位于 [${t.title || u.hash || "列表页"}]，正在自动跳转至 #/post 发博页...`, "info");
            await chrome.tabs.update(t.id, { url: cleanCreate }).catch(() => {});
            await new Promise((r) => setTimeout(r, 600));
          } else if (t.discarded || t.status === "unloaded") {
            await chrome.tabs.reload(t.id).catch(() => {});
          } else if (shouldActivate && !t.active) {
            await chrome.tabs.update(t.id, { active: true }).catch(() => {});
          }
          return t;
        }
      } catch (_) {
        continue;
      }
    }
  }

  const createdTab = await chrome.tabs.create({ url: cleanCreate, active: shouldActivate });
  if (typeof onCreate === "function" && createdTab) {
    try { onCreate(createdTab); } catch (_) {}
  }
  return createdTab;
}

// ─────────────────────────────────────────────────────────────
// 跨域配图物料下载辅助 (由后台 ServiceWorker 统一抓取转 Base64，突破网页端 CORS 限制)
// ─────────────────────────────────────────────────────────────
function looksLikeImageBytes(bytes) {
  return Boolean(sniffImageMime(bytes));
}

function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 3) return "";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return "";
}

async function fetchImageAsBase64(imageUrl) {
  try {
    const cleanUrl = String(imageUrl || "").trim().replace(/&amp;/g, "&");
    if (!cleanUrl || !cleanUrl.startsWith("http")) return null;

    const resp = await fetch(cleanUrl, {
      method: "GET",
      credentials: "include",
    });

    if (!resp.ok) {
      console.warn(`[ImageFetch] HTTP ${resp.status} for ${cleanUrl}`);
      return null;
    }

    const blob = await resp.blob();
    const buffer = await blob.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) return null;
    const bytes = new Uint8Array(buffer);
    const mime = sniffImageMime(bytes);
    if (!mime) {
      console.warn(`[ImageFetch] Rejected non-image bytes for ${cleanUrl}`);
      return null;
    }
    let binary = "";
    const len = bytes.byteLength;
    const chunk = 8192;
    for (let i = 0; i < len; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)));
    }
    const base64 = btoa(binary);
    const ext = mime.includes("jpeg") ? "jpg" : mime.includes("gif") ? "gif" : mime.includes("webp") ? "webp" : "png";

    return {
      url: cleanUrl,
      mime: mime,
      dataUrl: `data:${mime};base64,${base64}`,
      filename: `mat_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`,
    };
  } catch (err) {
    console.warn(`[ImageFetch] Failed to fetch image ${imageUrl}:`, err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 云文档原生环境配图提取器 (直接在 docs.qq.com 页面上下文中下载，天然携带 Referer 与 Cookie，100% 避免 403 鉴权拦截)
// ─────────────────────────────────────────────────────────────
async function downloadImagesViaDocTab(tabId, docUrl, imageUrls) {
  if (!imageUrls || !imageUrls.length) return [];
  try {
    const items = await executeInTabDirect(
      tabId,
      async (urls) => {
        const out = [];
        for (let idx = 0; idx < urls.length; idx++) {
          const u = urls[idx];
          if (!u) continue;
          let dataUrl = "";
          let mime = "image/png";

          // 方法 1: 在文档域内原生 fetch，携带文档自身 Cookie 与 Referer
          try {
            const resp = await fetch(u, { credentials: "include" });
            if (resp.ok) {
              const rawCt = String(resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
              if (!rawCt || /^image\/[a-z0-9.+-]+$/i.test(rawCt)) {
                mime = rawCt || "image/png";
                const buf = await resp.arrayBuffer();
                if (buf && buf.byteLength > 0) {
                  const bytes = new Uint8Array(buf);
                  const sniffed = (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) ? "image/png"
                    : (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ? "image/jpeg"
                    : (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) ? "image/gif"
                    : (bytes[0] === 0x42 && bytes[1] === 0x4d) ? "image/bmp"
                    : (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) ? "image/webp"
                    : "";
                  if (sniffed) {
                    mime = sniffed;
                    let binary = "";
                    const len = bytes.byteLength;
                    const chunk = 8192;
                    for (let j = 0; j < len; j += chunk) {
                      binary += String.fromCharCode.apply(null, bytes.subarray(j, Math.min(j + chunk, len)));
                    }
                    dataUrl = `data:${mime};base64,${btoa(binary)}`;
                  }
                }
              }
            }
          } catch (_) {}

          // 方法 2: 兜底通过 Image 标签 + Canvas 导出 Base64
          if (!dataUrl) {
            try {
              dataUrl = await new Promise((resolve) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => {
                  try {
                    const canvas = document.createElement("canvas");
                    canvas.width = img.naturalWidth || img.width;
                    canvas.height = img.naturalHeight || img.height;
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(img, 0, 0);
                    resolve(canvas.toDataURL("image/png"));
                  } catch (_) {
                    resolve("");
                  }
                };
                img.onerror = () => resolve("");
                img.src = u;
                setTimeout(() => resolve(""), 5000);
              });
            } catch (_) {}
          }

          if (dataUrl) {
            const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
            out.push({
              url: u,
              mime: mime,
              dataUrl: dataUrl,
              filename: `material_${Date.now()}_${idx + 1}.${ext}`,
            });
          }
        }
        return out;
      },
      [imageUrls],
      "MAIN",
      docUrl
    );
    return Array.isArray(items) ? items : [];
  } catch (err) {
    console.warn("downloadImagesViaDocTab failed:", err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 业务调度流程 (支持多文档卡槽联动扫描与发布)
// ─────────────────────────────────────────────────────────────
async function verifyCurrentDocumentTasks(docTab, batchItems, resolveAccountName) {
  const pending = batchItems.filter((item) => item.taskDocUrl && item.task.targetCell && item.task.targetCell !== "-");
  if (!pending.length) return;
  if (!docTab?.id) throw new Error("无法打开云文档复核任务，未提交发布");
  await waitForTabLoaded(docTab.id, 15000);
  for (const item of pending) {
    const match = /^([A-Z]+)([1-9]\d*)$/i.exec(String(item.task.targetCell));
    if (!match || Number(match[2]) !== Number(item.task.row)) throw new Error("文档任务坐标无效，未提交发布");
    const options = { targetSheetId: item.taskSheetId, linkColLetter: match[1].toUpperCase(), filterAccount: "" };
    const result = isDingTalkDocUrl(item.taskDocUrl)
      ? await scanDingTalkDocTab(docTab.id, options)
      : await executeInTabDirect(docTab.id, directExtractDocTasks,
          [item.taskSheetId, options.linkColLetter, "", true], "MAIN", item.taskDocUrl);
    if (!result?.ok || !Array.isArray(result.tasks)) throw new Error("无法读取云文档当前内容，未提交发布");
    const current = result.tasks.find((row) => Number(row.row) === Number(item.task.row) &&
      String(row.targetCell).toUpperCase() === String(item.task.targetCell).toUpperCase() &&
      String(row.targetSheetId || "") === String(item.taskSheetId || ""));
    const currentImages = Array.isArray(current?.imgUrls) ? current.imgUrls.slice(0, 9) : [];
    const taskImages = Array.isArray(item.task.imgUrls) ? item.task.imgUrls.slice(0, 9) : [];
    if (!current || current.content !== item.task.content || resolveAccountName(current.account) !== item.resolvedAccount ||
        currentImages.length !== taskImages.length || currentImages.some((url, index) => url !== taskImages[index])) {
      throw new Error(`文档第 ${item.task.row} 行的正文、账号或链接状态已变化，请重新扫描；未提交发布`);
    }
    if (!isDingTalkDocUrl(item.taskDocUrl) && (!current.writeSnapshot || !String(current.writeSnapshot.account || "").trim() ||
        !Number.isInteger(current.writeSnapshot.accountCol) || current.writeSnapshot.accountCol < 0)) {
      throw new Error("无法获取文档写回快照，未提交发布");
    }
    if (current.writeSnapshot) item.task.writeSnapshot = current.writeSnapshot;
  }
}

async function scanDocTasks(config) {
  // 支持多文档数组 (config.docs) 或单文档 (config.docUrl)
  const docList = Array.isArray(config.docs) && config.docs.length > 0
    ? config.docs.filter((d) => d && d.url && d.url.trim().startsWith("http"))
    : (config.docUrl && config.docUrl.trim().startsWith("http")
        ? [{ id: "doc_1", name: "文档 1", url: config.docUrl.trim(), linkCol: config.linkCol || "E" }]
        : []);

  if (docList.length === 0) {
    throw new Error("请先提供至少一个有效的云文档链接");
  }

  appendLog(`正在准备扫描 ${docList.length} 个文档卡槽...`, "info");
  const allTasks = [];
  const scanErrors = [];

  for (let idx = 0; idx < docList.length; idx++) {
    const docItem = docList[idx];
    const dUrl = docItem.url.trim();
    const dName = docItem.name || `文档 ${idx + 1}`;
    const dLinkCol = (docItem.linkCol || config.linkCol || "E").toUpperCase();
    const targetSheetId = parseTabSheetId(dUrl);

    appendLog(`[${idx + 1}/${docList.length}] 正在连接并扫描 ${dName}...`, "info");

    try {
      let docTab = await findOrCreateTab(dUrl.split("?")[0], dUrl, false);
      try {
        await waitForTabLoaded(docTab.id, 10000);
      } catch (loadError) {
        if (!/加载超时|已关闭或不存在/.test(String(loadError?.message || loadError))) throw loadError;
        appendLog(`${dName} 的文档标签页未能就绪，正在新开页面重试`, "warn");
        docTab = await chrome.tabs.create({ url: dUrl, active: false });
        await waitForTabLoaded(docTab.id, 15000, true);
      }
      await new Promise((r) => setTimeout(r, 600));

      const res = isDingTalkDocUrl(dUrl)
        ? await scanDingTalkDocTab(docTab.id, {
            targetSheetId,
            linkColLetter: dLinkCol,
            filterAccount: config.filterAccount || "",
          })
        : await executeInTabDirect(
            docTab.id,
            directExtractDocTasks,
            [targetSheetId, dLinkCol, config.filterAccount || ""],
            "MAIN",
            dUrl
          );

      if (res && res.ok && Array.isArray(res.tasks)) {
        const taggedTasks = res.tasks.map((t) =>
          Object.assign({}, t, {
            docId: docItem.id || `doc_${idx + 1}`,
            docName: dName,
            docUrl: dUrl,
            docIndex: idx + 1,
            targetSheetId: t.targetSheetId || targetSheetId,
          })
        );
        allTasks.push(...taggedTasks);
        appendLog(`✓ ${dName} 扫描完成：发现 ${taggedTasks.length} 条待发任务`, taggedTasks.length ? "success" : "info");
      } else {
        scanErrors.push(`${dName}: ${res?.error || "解析未成功"}`);
        appendLog(`⚠ ${dName} 扫描结果: ${res?.error || "未发现待发任务"}`, "warn");
      }
    } catch (err) {
      scanErrors.push(`${dName}: ${err.message}`);
      appendLog(`✗ ${dName} 连接或解析失败: ${err.message}`, "error");
    }
  }
  if (scanErrors.length === docList.length) throw new Error(`所有文档扫描失败：${scanErrors.join("；")}`);

  appendLog(`全部文档扫描完成！累计汇总 ${allTasks.length} 条待发布任务`, allTasks.length ? "success" : "warn");
  return allTasks;
}

async function startPipeline(config, reservation = null) {
  await stateReady;
  if (state.isRunning || (pipelineReservation && pipelineReservation !== reservation)) {
    throw new Error("已有流水线正在执行中，请勿重复启动");
  }
  if (config.selectedTasks && !Array.isArray(config.selectedTasks)) throw new Error("待发任务格式无效");

  const job = { aborted: false, id: `job_${Date.now()}_${Math.random().toString(36).slice(2)}`, tabId: null };
  activeJob = job;
  state.isRunning = true;
  state.logs = [];

  const dryRun = config.dryRun !== false;
  const isSilent = config.silentMode !== false; // 默认开启静默无感发博引擎
  appendLog(`🚀 开始执行流水线 [模式: ${dryRun ? "安全演练" : "真实发布"} | ${isSilent ? "静默免打扰" : "前台可见"}]`, "info");
  updateProgress("准备文档环境...", 10);

  let runnerWin = null;
  let weiboTab = null;
  let heldAwakeTabId = null;
  const createdSilentWeiboTabIds = new Set();
  let contentLockKey = "";
  let contentLockKeys = [];
  let contentLockOwned = false;
  let contentSubmitted = false;
  const keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch((error) => console.warn("流水线保活失败:", error));
  }, 20000);

  async function syncAwakeTab(tabId) {
    if (!tabId) return;
    if (heldAwakeTabId && heldAwakeTabId !== tabId) {
      await releaseBackgroundTab(heldAwakeTabId).catch(() => {});
      heldAwakeTabId = null;
    }
    if (heldAwakeTabId === tabId) return;
    if (await holdBackgroundTabAwake(tabId)) {
      heldAwakeTabId = tabId;
    }
  }

  try {
    let tasks = config.selectedTasks || [];
    if (!tasks || tasks.length === 0) {
      tasks = await scanDocTasks(config);
    }

    if (tasks.length === 0) {
      updateProgress("无待发内容", 100);
      appendLog("没有需要发布的任务", "warn");
      return { total: 0, published: 0 };
    }

    // 准备执行环境 (投票任务严格禁止静默！100% 对齐原系统拉起前台可见微博主站首页 weibo.com)
    const platformUrl = "https://ai-publish-platform.weibo.com/#/post";
    const weiboHomeUrl = "https://weibo.com/";
    const hasAnyPoll = tasks.some((t) => t && t.poll && Array.isArray(t.poll.options) && t.poll.options.length >= 2);
    const firstIsPoll = !!(tasks[0] && tasks[0].poll && Array.isArray(tasks[0].poll.options) && tasks[0].poll.options.length >= 2);
    const initialUrl = firstIsPoll ? weiboHomeUrl : platformUrl;

    // 只要包含投票任务，强制禁用静默离屏窗口，拉起可见前台微博首页供肉眼直观确认！
    const effectiveSilent = hasAnyPoll ? false : isSilent;
    if (hasAnyPoll && isSilent) {
      appendLog("检测到投票任务：已自动退出静默模式，切换为【前台可见拉起微博首页】操作（对齐原系统规范）", "info");
    }

    updateProgress(effectiveSilent ? "连接后台发稿标签页..." : (firstIsPoll ? "拉起微博首页 (可见自动化)..." : "连接微博发稿中台..."), 30);

    if (effectiveSilent) {
      weiboTab = await findOrCreateTab(
        firstIsPoll ? "weibo.com" : "ai-publish-platform.weibo.com",
        initialUrl,
        false,
        (tab) => { if (tab?.id) createdSilentWeiboTabIds.add(tab.id); }
      );
      appendLog("已使用当前浏览器里的后台标签页发博，不另开窗口", "info");
    } else {
      weiboTab = await findOrCreateTab(firstIsPoll ? "weibo.com" : "ai-publish-platform.weibo.com", initialUrl, true);
      await chrome.tabs.update(weiboTab.id, { url: initialUrl, active: true }).catch(() => {});
      if (weiboTab.windowId) {
        await chrome.windows.update(weiboTab.windowId, { focused: true }).catch(() => {});
      }
    }

    if (weiboTab) {
    try {
      await waitForTabLoaded(weiboTab.id, 15000, true);
    } catch (loadError) {
      if (!/加载超时|已关闭或不存在/.test(String(loadError?.message || loadError))) throw loadError;
      appendLog("发博页首次加载失败，正在关闭残留页并重开一次", "warn");
      if (runnerWin?.id) {
        await chrome.windows.remove(runnerWin.id).catch(() => {});
        runnerWin = null;
      }
      if (effectiveSilent) {
        weiboTab = await chrome.tabs.create({ url: initialUrl, active: false });
        if (weiboTab?.id) createdSilentWeiboTabIds.add(weiboTab.id);
      } else {
        weiboTab = await chrome.tabs.create({ url: initialUrl, active: true });
      }
      job.tabId = weiboTab.id;
      if (effectiveSilent) await syncAwakeTab(weiboTab.id);
      await waitForTabLoaded(weiboTab.id, 15000, true);
    }
    if (effectiveSilent && weiboTab?.id) await syncAwakeTab(weiboTab.id);
    await new Promise((r) => setTimeout(r, 1500));
    }

    // 检查是否被重定向到了统一登录页
    const currentWeiboTab = weiboTab ? await chrome.tabs.get(weiboTab.id).catch(() => null) : null;
    if (currentWeiboTab && currentWeiboTab.url) {
      const wUrl = currentWeiboTab.url.toLowerCase();
      if (wUrl.includes("cas.erp.sina.com.cn") || wUrl.includes("passport.weibo.com") || wUrl.includes("login.sina.com.cn") || wUrl.includes("login.php")) {
        if (runnerWin && runnerWin.id) {
          await chrome.windows.update(runnerWin.id, {
            focused: true,
            left: 150,
            top: 100,
            width: 1050,
            height: 750,
          }).catch(() => {});
          runnerWin = null;
        } else {
          if (weiboTab?.id) createdSilentWeiboTabIds.delete(weiboTab.id);
          await chrome.tabs.update(weiboTab.id, { active: true }).catch(() => {});
        }
        throw new Error(
          `微博账号当前未登录（已跳转至登录页），已为您弹出登录窗口，请先扫码/登录后再点发布！`
        );
      }
    }

    let successCount = 0;
    let publishedCount = 0;
    let rehearsedCount = 0;
    let preparedCount = 0;
    let writtenBackCount = 0;
    const total = tasks.length;

    async function ensureWeiboTab(targetUrl, forceNew = false) {
      if (!forceNew) {
        try {
          const existing = weiboTab?.id ? await chrome.tabs.get(weiboTab.id) : null;
          if (existing && !existing.discarded && existing.status !== "unloaded") return existing;
          if (existing) {
            await chrome.tabs.reload(weiboTab.id).catch(() => {});
            return await waitForTabLoaded(weiboTab.id, 15000, true);
          }
        } catch (error) {
          if (!isMissingTabError(error) && !/已关闭或不存在/.test(String(error?.message || error))) throw error;
        }
      }
      appendLog("发博标签页已关闭，正在重新打开后继续。本次尚未提交发布", "warn");
      if (runnerWin?.id) {
        await chrome.windows.remove(runnerWin.id).catch(() => {});
        runnerWin = null;
      }
      if (effectiveSilent) {
        weiboTab = await chrome.tabs.create({ url: targetUrl, active: false });
        if (weiboTab?.id) createdSilentWeiboTabIds.add(weiboTab.id);
        await syncAwakeTab(weiboTab.id);
      } else {
        weiboTab = await chrome.tabs.create({ url: targetUrl, active: true });
      }
      job.tabId = weiboTab.id;
      return await waitForTabLoaded(weiboTab.id, 15000, true);
    }

    const { accountAliases = {}, disabledAccounts = [] } = await chrome.storage.local.get(["accountAliases", "disabledAccounts"]);
    const { publishLedger: initialLedger = [], __unwrittenReceipts__: initialUnwritten = [] } = await chrome.storage.local.get(["publishLedger", "__unwrittenReceipts__"]);

    const stripAcctSuffix = (val) => String(val || "").replace(/[（(].*?[）)]/g, "").replace(/-(?:投票|直发|转评|转发)$/u, "").trim();
    const compactAcct = (val) => String(val || "").replace(/\s+/g, "").toLowerCase();
    const disabledAccountSet = new Set(
      (Array.isArray(disabledAccounts) ? disabledAccounts : [])
        .map((n) => compactAcct(n))
        .filter(Boolean)
    );
    const isAccountDisabled = (acct) => {
      const c = compactAcct(acct);
      const stripped = compactAcct(stripAcctSuffix(acct));
      return Boolean((c && disabledAccountSet.has(c)) || (stripped && disabledAccountSet.has(stripped)));
    };
    const resolveAccountName = (rawAccount) => {
      const rawAcct = String(rawAccount || "").trim();
      let resolved = rawAcct;
      const lookupAccountAlias = (candidate) => {
        if (!candidate || !accountAliases || typeof accountAliases !== "object") return "";
        if (accountAliases[candidate]) return accountAliases[candidate];
        const candCompact = compactAcct(candidate);
        for (const [k, v] of Object.entries(accountAliases)) {
          if (compactAcct(k) === candCompact) return v;
        }
        return "";
      };
      const cleanedAcct = stripAcctSuffix(rawAcct);
      const aliasHit = lookupAccountAlias(rawAcct) || (cleanedAcct ? lookupAccountAlias(cleanedAcct) : "");
      if (aliasHit) {
        resolved = aliasHit;
      } else if (cleanedAcct && cleanedAcct !== rawAcct) {
        resolved = cleanedAcct;
      }
      return resolved;
    };

    const sameImgUrls = (a, b) => {
      const arrA = Array.isArray(a) ? a.slice(0, 9) : [];
      const arrB = Array.isArray(b) ? b.slice(0, 9) : [];
      if (arrA.length !== arrB.length) return false;
      return arrA.every((u, idx) => u === arrB[idx]);
    };

    for (let i = 0; i < total; i++) {
      contentLockKey = "";
      contentLockKeys = [];
      contentLockOwned = false;
      contentSubmitted = false;
      if (job.aborted) throw new Error("流水线已手动取消");

      const task = { ...tasks[i] };
      const taskDryRun = config.useTaskDryRun ? task.dryRun !== false : dryRun;
      if (typeof task.content !== "string" || !task.content.trim()) throw new Error("待发任务正文为空或格式无效");

      const taskDocName = task.docName || "云文档";
      const taskDocUrl = (task.docUrl || config.docUrl || "").trim();
      const taskSheetId = task.targetSheetId || parseTabSheetId(taskDocUrl);
      const isPoll = !!(task.poll && Array.isArray(task.poll.options) && task.poll.options.length >= 2);
      const resolvedAccount = resolveAccountName(task.account);
      if (isAccountDisabled(resolvedAccount) || isAccountDisabled(task.account)) {
        throw new Error(`账号 [${resolvedAccount || task.account}] 已在系统设置中移除/停用，已拦截发布与文档写回`);
      }

      const { publishLedger: existingLedger = initialLedger, __unwrittenReceipts__ = initialUnwritten } = await chrome.storage.local.get(["publishLedger", "__unwrittenReceipts__"]);
      const allReceipts = [...existingLedger, ...__unwrittenReceipts__];
      const findReceipt = (t, tDocUrl, tSheetId, rAcct) => (!taskDryRun && !(t.poll && Array.isArray(t.poll.options) && t.poll.options.length >= 2) && tDocUrl && t.targetCell && t.targetCell !== "-")
        ? allReceipts.find((item) => item.mode === "真实发布" && item.docUrl === tDocUrl &&
          item.targetCell === t.targetCell && item.targetSheetId === tSheetId &&
          item.resolvedAccount === rAcct && item.fullContent === t.content && item.postUrl)
        : null;

      const hasPendingSubmission = (account, content) => allReceipts.some((item) => item.submittedWithoutReceipt &&
        item.resolvedAccount === account && String(item.fullContent || "").trim() === String(content || "").trim());
      const pendingSubmission = !taskDryRun && hasPendingSubmission(resolvedAccount, task.content);
      if (pendingSubmission) throw new Error(`账号 [${resolvedAccount}] 已提交但缺少回执，请人工核对，禁止自动重发`);
      const previousReceipt = findReceipt(task, taskDocUrl, taskSheetId, resolvedAccount);
      if (!task.writeSnapshot && previousReceipt?.writeSnapshot) task.writeSnapshot = previousReceipt.writeSnapshot;

      // 合并连续的同文案、同配图、同类型非投票多账号任务，一次勾选群发，彻底对齐原系统速度
      const batchItems = [{
        index: i,
        task,
        resolvedAccount,
        taskDocName,
        taskDocUrl,
        taskSheetId,
        taskDryRun,
        previousReceipt,
      }];
      if (!isPoll && !previousReceipt && resolvedAccount) {
        const batchAccounts = new Set([resolvedAccount]);
        for (let j = i + 1; j < total && batchItems.length < 15; j++) {
          const nextTask = { ...tasks[j] };
          const nextDryRun = config.useTaskDryRun ? nextTask.dryRun !== false : dryRun;
          const nextIsPoll = !!(nextTask.poll && Array.isArray(nextTask.poll.options) && nextTask.poll.options.length >= 2);
          if (nextIsPoll || nextDryRun !== taskDryRun) break;
          if (typeof nextTask.content !== "string" || nextTask.content.trim() !== task.content.trim()) break;
          if (String(nextTask.repostUrl || "").trim() !== String(task.repostUrl || "").trim()) break;
          if (!!nextTask.commentOriginal !== !!task.commentOriginal) break;
          if (!sameImgUrls(nextTask.imgUrls, task.imgUrls)) break;
          const nextDocUrl = (nextTask.docUrl || config.docUrl || "").trim();
          const nextSheetId = nextTask.targetSheetId || parseTabSheetId(nextDocUrl);
          if (nextDocUrl !== taskDocUrl || nextSheetId !== taskSheetId) break;
          const nextResolved = resolveAccountName(nextTask.account);
          if (!nextResolved || isAccountDisabled(nextResolved) || isAccountDisabled(nextTask.account) || batchAccounts.has(nextResolved)) break;
          const nextReceipt = findReceipt(nextTask, nextDocUrl, nextSheetId, nextResolved);
          const nextPending = !nextDryRun && hasPendingSubmission(nextResolved, nextTask.content);
          if (nextReceipt || nextPending) break;
          batchAccounts.add(nextResolved);
          batchItems.push({
            index: j,
            task: nextTask,
            resolvedAccount: nextResolved,
            taskDocName: nextTask.docName || "云文档",
            taskDocUrl: nextDocUrl,
            taskSheetId: nextSheetId,
            taskDryRun: nextDryRun,
            previousReceipt: null,
          });
        }
      }

      const isBatchMulti = batchItems.length > 1;
      const pct = Math.round(30 + ((i + batchItems.length) / total) * 65);

      updateProgress(
        isBatchMulti
          ? `群发 [${i + 1}-${i + batchItems.length}/${total}] ${taskDocName}: ${batchItems.length} 个账号`
          : `发布 [${i + 1}/${total}] ${taskDocName} · 行 ${task.row}: ${task.account || "默认账号"}`,
        pct - 5
      );
      appendLog(
        isBatchMulti
          ? `[${i + 1}-${i + batchItems.length}/${total}] 合并群发 (${batchItems.length}个账号: ${batchItems.map((b) => b.resolvedAccount).join("、")}): "${task.content.substring(0, 18)}..."`
          : `[${i + 1}/${total}] 正在发博 (${taskDocName} #行 ${task.row}): "${task.content.substring(0, 18)}..."`,
        "info"
      );

      // 准备本任务所属的云文档标签页 (绝不抢占前台)
      let currentDocTab = null;
      if (taskDocUrl) {
        try {
          currentDocTab = await findOrCreateTab(taskDocUrl.split("?")[0], taskDocUrl, false);
        } catch (_) {}
      }

      // 准备配图物料数据 (同批次仅拉取 1 次)
      if (task.imgUrls && task.imgUrls.length > 0) {
        appendLog(`正在提取 [${taskDocName}] 第 ${task.row} 行的 ${task.imgUrls.length} 张配图物料...`, "info");
        const wantedUrls = task.imgUrls.slice(0, 9);
        let imagesData = [];
        if (currentDocTab && currentDocTab.id) {
          try {
            imagesData = await downloadImagesViaDocTab(currentDocTab.id, taskDocUrl, wantedUrls);
          } catch (e) {
            console.warn("downloadImagesViaDocTab error:", e);
          }
        }
        if (job.aborted) throw new Error("流水线已手动取消，未提交本条发布");
        if (!Array.isArray(imagesData)) imagesData = [];
        const byUrl = new Map();
        for (const item of imagesData) {
          if (item && item.url && item.dataUrl) byUrl.set(item.url, item);
        }
        for (const imageUrl of wantedUrls) {
          if (byUrl.has(imageUrl)) continue;
          const item = await fetchImageAsBase64(imageUrl);
          if (item && item.dataUrl) byUrl.set(imageUrl, item);
        }
        imagesData = wantedUrls.map((imageUrl) => byUrl.get(imageUrl)).filter(Boolean);
        task.imagesData = imagesData;
        const expectedImages = wantedUrls.length;
        if (imagesData.length !== expectedImages) {
          throw new Error(`第 ${task.row} 行配图提取不完整 (${imagesData.length}/${expectedImages} 张)，已阻断发送以免丢图`);
        }
        appendLog(`第 ${task.row} 行配图就绪 (${imagesData.length}/${expectedImages} 张)`, "success");
      } else {
        task.imagesData = [];
      }

      const targetFlowUrl = isPoll ? weiboHomeUrl : platformUrl;
      const submitToken = `${job.id}_${i}_${Date.now()}`;
      const taskForPost = Object.assign({}, task, {
        account: resolvedAccount,
        accounts: isBatchMulti ? batchItems.map((b) => b.resolvedAccount) : undefined,
        __syncJobId: job.id,
        __submitToken: submitToken,
      });

      if (!taskDryRun && !previousReceipt) {
        await verifyCurrentDocumentTasks(currentDocTab, batchItems, resolveAccountName);
      }

      // 真实发博内容级全局持久化台账排他锁：同一账号 + 同一正文内容，3 分钟内物理绝对只允许真实发射一次！
      if (job.aborted) throw new Error("流水线已手动取消，未提交下一条发布");
      if (batchItems.some((b) => b.task.fromSchedule)) {
        const { schedulePaused = false } = await chrome.storage.local.get(["schedulePaused"]);
        if (schedulePaused) throw new Error("定时队列已暂停，未提交后续任务");
      }
      if (!taskDryRun && !isPoll && !previousReceipt) {
        for (const bItem of batchItems) {
          const lockKey = `post::${bItem.resolvedAccount}::${String(bItem.task.content || "").trim()}`;
          const claimed = await claimPublishTaskLock(lockKey, 3 * 60 * 1000);
          if (!claimed) {
            for (const prevKey of contentLockKeys) {
              await releasePublishTaskLock(prevKey).catch(() => {});
            }
            contentLockKeys = [];
            contentLockKey = "";
            contentLockOwned = false;
            throw new Error(`已拦截重复发博：账号 [${bItem.resolvedAccount || "默认"}] 在3分钟内已发送过相同文案，台账锁已物理阻断二次发射！`);
          }
          contentLockKeys.push(lockKey);
          contentLockKey = lockKey;
          contentLockOwned = true;
        }
      }

      if (job.aborted) throw new Error("流水线已手动取消，未提交本条发布");
      if (!previousReceipt) {
        await ensureWeiboTab(targetFlowUrl);
        if (isPoll || !isSilent) {
          await chrome.tabs.update(weiboTab.id, { active: true }).catch(() => {});
          if (weiboTab.windowId) {
            await chrome.windows.update(weiboTab.windowId, { focused: true }).catch(() => {});
          }
        }
        const curTab = await chrome.tabs.get(weiboTab.id).catch(() => null);
        const curUrl = String((curTab && curTab.url) || "").toLowerCase();
        const needRedirect = isPoll
          ? (!curUrl.includes("weibo.com") || curUrl.includes("ai-publish-platform") || curUrl.includes("visitor"))
          : (!curUrl.includes("ai-publish-platform.weibo.com/#/post") || curUrl.includes("taskId="));
        if (needRedirect) {
          appendLog(`正在就绪${isPoll ? "微博主站首页 (原生投票引擎·前台可见)" : "发稿中台"}发博页环境 [${i + 1}/${total}]...`, "info");
          await chrome.tabs.update(weiboTab.id, { url: targetFlowUrl, active: isPoll || !isSilent }).catch(() => {});
          try {
            await waitForTabLoaded(weiboTab.id, 15000, true);
          } catch (loadError) {
            if (!/加载超时|已关闭或不存在/.test(String(loadError?.message || loadError))) throw loadError;
            appendLog("发博页加载超时或标签页已失效，正在重开一次", "warn");
            await ensureWeiboTab(targetFlowUrl, true);
          }
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
      job.tabId = weiboTab && weiboTab.id ? weiboTab.id : null;
      let postRes = previousReceipt ? { ok: true, postUrl: previousReceipt.postUrl, fromRecovery: true } : null;
      let postErr = null;
      let pendingIds = [];
      const clearPendingSubmission = async () => {
        if (!pendingIds.length) return;
        await withScheduleMutation(async () => {
          const { publishLedger = [], __unwrittenReceipts__ = [] } = await chrome.storage.local.get(["publishLedger", "__unwrittenReceipts__"]);
          await chrome.storage.local.set({
            publishLedger: publishLedger.filter((item) => !pendingIds.includes(item.id)),
            __unwrittenReceipts__: __unwrittenReceipts__.filter((item) => !pendingIds.includes(item.id)),
          });
        });
        pendingIds.forEach((id) => activePendingSubmissionIds.delete(id));
        pendingIds = [];
      };
      try {
        if (previousReceipt) {
          appendLog("已找到该文档行的持久化发布回执，本次仅核对并补写链接，不重复发布", "info");
        } else if (isPoll) {
          appendLog(`[${taskDocName}] 正在通过【微博主站首页】自动化装配投票并提交: "${task.poll.title}"...`, "info");
          postRes = await executeInTabDirect(
            weiboTab.id,
            directPostPollToWeiboHome,
            [taskForPost, taskDryRun],
            "MAIN",
            weiboHomeUrl,
            false,
            () => job.aborted
          );
        } else {
          // 注入前只读稳态预检：防呆 1~2 秒延迟 SSO 重定向或 Vue 懒加载未挂载导致正式脚本上下文被销毁
          for (let probe = 0; probe < 6; probe++) {
            if (job.aborted) throw new Error("流水线已手动取消，未提交本条发布");
            let readyRes = null;
            try {
              readyRes = await executeInTabDirect(
                weiboTab.id,
                directCheckWeiboPlatformReady,
                [],
                "MAIN",
                platformUrl,
                true,
                () => job.aborted
              );
            } catch (probeErr) {
              const pMsg = probeErr.message || "";
              if (isMissingTabError(probeErr) || /已关闭或不存在/.test(pMsg)) {
                await ensureWeiboTab(platformUrl);
                continue;
              }
              if (pMsg.includes("登录页") || pMsg.includes("cas.erp.sina.com.cn")) {
                postRes = { ok: false, needLogin: true, error: pMsg };
                break;
              }
              if (probe === 5) throw probeErr;
            }
            if (readyRes?.needLogin) {
              postRes = { ok: false, needLogin: true, error: readyRes.error };
              break;
            }
            if (readyRes && readyRes.ready !== false) {
              if (Array.isArray(readyRes.accounts) && readyRes.accounts.length >= 2) {
                chrome.storage.local.set({ cachedPlatformAccounts: readyRes.accounts }).catch(() => {});
              }
              break;
            }
            await new Promise((r) => setTimeout(r, 800));
          }

          if (!postRes) {
            if (job.aborted) throw new Error("流水线已手动取消，未提交本条发布");
            if (!taskDryRun) {
              const pending = batchItems.map((b, index) => ({
                id: `pending_${submitToken}_${index}`, timestamp: Date.now(), docName: b.taskDocName,
                docUrl: b.taskDocUrl, row: b.task.row, targetCell: b.task.targetCell,
                targetSheetId: b.taskSheetId, account: b.task.account, resolvedAccount: b.resolvedAccount,
                fullContent: b.task.content, contentSummary: b.task.content.substring(0, 45),
                writeSnapshot: b.task.writeSnapshot, scheduleId: b.task.fromSchedule || String(b.task.id || "").startsWith("sched_") ? b.task.id : "", postUrl: "", mode: "真实发布", submittedWithoutReceipt: true,
                writeBackOk: false, writeBackError: "发布状态待确认，请人工核对，禁止自动重发",
              }));
              await withScheduleMutation(async () => {
                const { publishLedger = [], __unwrittenReceipts__ = [] } = await chrome.storage.local.get(["publishLedger", "__unwrittenReceipts__"]);
                await chrome.storage.local.set({ publishLedger: [...pending, ...publishLedger], __unwrittenReceipts__: [...pending, ...__unwrittenReceipts__] });
                pendingIds = pending.map((item) => item.id);
                pendingIds.forEach((id) => activePendingSubmissionIds.add(id));
              });
              contentSubmitted = true;
            }
            postRes = await executeInTabDirect(
              weiboTab.id,
              directPostToWeiboPlatform,
              [taskForPost, taskDryRun],
              "MAIN",
              platformUrl,
              false,
              () => job.aborted
            );
          }
        }
      } catch (err) {
        postErr = err;
        const errMsg = String(err?.message || err || "");
        if (errMsg.includes("登录页") || errMsg.includes("cas.erp.sina.com.cn")) {
          postRes = { ok: false, needLogin: true, error: errMsg };
        } else if (!postRes && !taskDryRun && !isPoll && (errMsg.includes("空结果") || errMsg.includes("Frame") || errMsg.includes("Cannot access") || errMsg.includes("超时"))) {
          try {
            let checkSubmitRes = null;
            for (let chk = 0; chk < 3; chk++) {
              await waitForTabLoaded(weiboTab.id, 12000, false).catch(() => {});
              await new Promise((r) => setTimeout(r, 600));
              checkSubmitRes = await executeInTabDirect(
                weiboTab.id,
                (expectedToken) => {
                  try {
                    const checkStore = (store) => {
                      if (!store) return false;
                      const raw = store.getItem("__weiboSyncLastSubmit");
                      if (!raw) return false;
                      const data = JSON.parse(raw);
                      return !!(data && data.submitToken === expectedToken && (Date.now() - data.ts < 90000));
                    };
                    const submitted = checkStore(typeof sessionStorage !== "undefined" ? sessionStorage : null)
                      || checkStore(typeof localStorage !== "undefined" ? localStorage : null);
                    return { submitted };
                  } catch (_) {
                    return { submitted: false };
                  }
                },
                [submitToken],
                "MAIN",
                platformUrl,
                true,
                () => job.aborted
              ).catch(() => null);
              if (checkSubmitRes && typeof checkSubmitRes.submitted === "boolean") break;
            }
            if (checkSubmitRes && checkSubmitRes.submitted) {
              appendLog("检测到发稿中台在点击发布后发生页面跳转/刷新，留在当前页复制结果链接...", "warn");
              postRes = { ok: false, submitted: true, error: errMsg };
            } else if (taskDryRun && (errMsg.includes("Frame") || errMsg.includes("未关闭的弹窗")) && (!checkSubmitRes || checkSubmitRes.submitted === false)) {
              appendLog(`检测到发稿中台${errMsg.includes("未关闭的弹窗") ? "残留弹窗" : "页面帧重建"}（确认尚未提交），正在刷新就绪并重试一次...`, "warn");
              await chrome.tabs.update(weiboTab.id, { url: platformUrl }).catch(() => {});
              await waitForTabLoaded(weiboTab.id, 12000, false).catch(() => {});
              await new Promise((r) => setTimeout(r, 1000));
              const retryReady = await executeInTabDirect(
                weiboTab.id,
                directCheckWeiboPlatformReady,
                [],
                "MAIN",
                platformUrl,
                true,
                () => job.aborted
              ).catch(() => null);
              if (retryReady?.needLogin) {
                postRes = { ok: false, needLogin: true, error: retryReady.error };
              } else {
                postRes = await executeInTabDirect(
                  weiboTab.id,
                  directPostToWeiboPlatform,
                  [taskForPost, taskDryRun],
                  "MAIN",
                  platformUrl,
                  false,
                  () => job.aborted
                );
                postErr = null;
              }
            } else if (checkSubmitRes && checkSubmitRes.submitted === false) {
              postRes = { ok: false, submitted: false, error: errMsg };
            }
          } catch (retryErr) {
            postErr = retryErr;
          }
        }
      }

      // 取消连续重载后，上一批可能残留结果弹窗；命中该保护时刷新一次发博页再重试，避免整批中断
      if (!isPoll && !previousReceipt && postRes && postRes.ok === false && postRes.submitted === false
          && /未关闭的弹窗/.test(String(postRes.error || "")) && weiboTab?.id) {
        appendLog("发稿中台残留上一次结果弹窗，正在刷新发博页后重试一次...", "warn");
        await chrome.tabs.update(weiboTab.id, { url: platformUrl }).catch(() => {});
        await waitForTabLoaded(weiboTab.id, 12000, true).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
        postRes = await executeInTabDirect(
          weiboTab.id,
          directPostToWeiboPlatform,
          [taskForPost, taskDryRun],
          "MAIN",
          platformUrl,
          false,
          () => job.aborted
        );
        postErr = null;
      }

      if (pendingIds.length && postRes?.submitted === false) {
        await clearPendingSubmission();
        contentSubmitted = false;
      }

      if (postRes && postRes.needLogin) {
        // 登录页意味着发布按钮从未被点击，预占的待确认记录可安全撤销，避免污染台账。
        if (pendingIds.length && !contentSubmitted) {
          await clearPendingSubmission();
          contentSubmitted = false;
        }
        if (runnerWin && runnerWin.id) {
          await chrome.windows.update(runnerWin.id, {
            focused: true,
            left: 150,
            top: 100,
            width: 1050,
            height: 750,
          }).catch(() => {});
          runnerWin = null; // 保留窗口让用户扫码，不在 finally 关闭
        } else if (weiboTab?.id) {
          createdSilentWeiboTabIds.delete(weiboTab.id);
          await chrome.tabs.update(weiboTab.id, { active: true }).catch(() => {});
          if (weiboTab.windowId) {
            await chrome.windows.update(weiboTab.windowId, { focused: true }).catch(() => {});
          }
        }
        throw new Error(postRes.error || "微博当前未登录，请扫码后重试！");
      }

      // 关键兜底：如果未直接拿到 postUrl，且非演练模式、非首页投票模式（发博后弹窗未捕获或页面切到 #/wb-list）
      if (postRes?.submitted === true && (!postRes.ok || !postRes.postUrl) && !taskDryRun && !isPoll && weiboTab?.id) {
        appendLog("发稿中台已响应提交，留在当前发布结果页复制链接，不跳微博列表", "info");
        let copyErrDetail = "";
        let listErrDetail = "";
        try {
          let recovered = null;
          await waitForTabLoaded(weiboTab.id, 12000, false).catch(() => {});
          for (let copyPoll = 0; copyPoll < 4 && !(recovered && recovered.ok && recovered.postUrl); copyPoll++) {
            try {
              recovered = await executeInTabDirect(
                weiboTab.id,
                directCopyPublishPageResult,
                [],
                "MAIN",
                "",
                false,
                () => job.aborted
              );
            } catch (copyErr) {
              console.warn("当前发布结果页复制链接异常:", copyErr);
              copyErrDetail = copyErr?.message || String(copyErr);
            }
            if (!(recovered && recovered.ok && recovered.postUrl)) {
              const recErr = String(recovered?.error || "");
              // 若已明确停在编辑页或被平台弹窗拦截，最多复检 1 次即转入微博列表兜底，避免空等 ~79 秒
              if (copyPoll >= 1 && (recErr.includes("停在编辑页") || recErr.includes("平台提示拦截"))) {
                copyErrDetail = recErr;
                break;
              }
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
          if (!copyErrDetail && recovered && !recovered.ok && recovered.error) {
            copyErrDetail = recovered.error;
          }

          if (!(recovered && recovered.ok && recovered.postUrl)) {
            appendLog(`当前发布页未提取到链接(${copyErrDetail || "无详情"})，转入中台【微博列表】严格核对回执...`, "warn");
            const wbListUrl = "https://ai-publish-platform.weibo.com/#/wb-list";
            await chrome.tabs.update(weiboTab.id, { url: wbListUrl }).catch(() => {});
            await waitForTabLoaded(weiboTab.id, 12000, true).catch(() => {});
            await new Promise((r) => setTimeout(r, 1500));
            for (let listPoll = 0; listPoll < 8 && !(recovered && recovered.ok && recovered.postUrl); listPoll++) {
              try {
                recovered = await executeInTabDirect(
                  weiboTab.id,
                  directRecoverPublishedWeiboUrl,
                  [resolvedAccount, task.content],
                  "MAIN",
                  wbListUrl,
                  false,
                  () => job.aborted
                );
              } catch (listErr) {
                console.warn("微博列表回执提取异常:", listErr);
                listErrDetail = listErr?.message || String(listErr);
              }
              if (!(recovered && recovered.ok && recovered.postUrl)) {
                await new Promise((r) => setTimeout(r, 1500));
              }
            }
            if (!listErrDetail && recovered && !recovered.ok && recovered.error) {
              listErrDetail = recovered.error;
            }
          }

          if (recovered && recovered.ok && recovered.postUrl) {
            postRes = {
              ok: true,
              postUrl: recovered.postUrl,
              dryRun: false,
              accountMatched: true,
              fromRecovery: true,
              recoverySource: recovered.source || "发布结果页",
            };
            appendLog(`已从【${recovered.source || "发布结果页"}】复制到链接: ${recovered.postUrl}`, "success");
          } else {
            const diagParts = [copyErrDetail && `结果页=${copyErrDetail}`, listErrDetail && `列表=${listErrDetail}`].filter(Boolean).join("；");
            postRes = {
              ok: false,
              submitted: true,
              error: `已确认提交发布，但结果页与微博列表均未取到链接${diagParts ? `（${diagParts}）` : ""}，请手动核对补写，切勿重发`,
            };
          }
        } catch (recoverErr) {
          console.warn("找回回执链接异常:", recoverErr);
        }
      }

      const postErrMsg = String(postErr?.message || "");
      const ambiguousInject = !postRes && /空结果|Frame|Cannot access/.test(postErrMsg);
      if (!taskDryRun && (ambiguousInject || (postRes && (postRes.submitted === true || postRes.ok === true)))) {
        contentSubmitted = true;
      }
      if (postRes && !postRes.ok && postRes.submitted === true && !taskDryRun && !isPoll) {
        postRes = { ...postRes, ok: true, postUrl: "" };
      }
      if (!postRes || !postRes.ok) {
        throw new Error(`[${taskDocName}] 第 ${task.row} 行发博失败: ${postRes?.error || postErr?.message || "未知异常"}`);
      }

      const normAcctKey = (val) => String(val || "").replace(/\s+/g, "").trim().toLowerCase().replace(/[^0-9a-z一-鿿]/g, "");
      const stripAcctParens = (val) => String(val || "").replace(/[（(].*?[）)]/g, "").trim();
      const postEntriesList = Array.isArray(postRes.postEntries) ? postRes.postEntries : [];
      const validWeiboUrlRe = /^https?:\/\/(?:www\.)?(?:weibo\.com|m\.weibo\.cn|weibo\.cn|t\.cn)\/\S+$/i;

      const resolveUrlForBatchItem = async (bItem) => {
        const directMapped = postRes.postUrlsByAccount && postRes.postUrlsByAccount[bItem.resolvedAccount];
        if (directMapped) return String(directMapped);
        if (!isBatchMulti) return String(postRes.postUrl || "");
        // 注入异常后后台已为「本批首账号」单独找回回执时，直接复用，避免重复走微博列表兜底
        if (postRes.fromRecovery && postRes.postUrl && bItem.resolvedAccount === resolvedAccount) {
          return String(postRes.postUrl);
        }

        const targetN = normAcctKey(bItem.resolvedAccount);
        const baseN = normAcctKey(stripAcctParens(bItem.resolvedAccount));
        const entryMatches = postEntriesList.filter((e) => e.normNick && (e.normNick === targetN || (baseN && e.normNick === baseN)));
        if (entryMatches.length === 1 && entryMatches[0].url &&
            new Set(postEntriesList.filter((entry) => entry.url === entryMatches[0].url && entry.normNick).map((entry) => entry.normNick)).size === 1) return String(entryMatches[0].url);

        if (!bItem.taskDryRun && weiboTab?.id) {
          const wbListUrl = "https://ai-publish-platform.weibo.com/#/wb-list";
          const curT = await chrome.tabs.get(weiboTab.id).catch(() => null);
          if (!String(curT?.url || "").includes("#/wb-list")) {
            await chrome.tabs.update(weiboTab.id, { url: wbListUrl }).catch(() => {});
            await waitForTabLoaded(weiboTab.id, 12000, true).catch(() => {});
            await new Promise((r) => setTimeout(r, 1200));
          }
          for (let listPoll = 0; listPoll < 5; listPoll++) {
            const recovered = await executeInTabDirect(
              weiboTab.id,
              directRecoverPublishedWeiboUrl,
              [bItem.resolvedAccount, bItem.task.content],
              "MAIN",
              wbListUrl,
              false,
              () => job.aborted
            ).catch(() => null);
            if (recovered && recovered.ok && recovered.postUrl) return String(recovered.postUrl);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        return "";
      };

      const preparedOnly = postRes.preparedOnly === true;
      const batchUrlFailures = [];
      const usedBatchUrls = new Set();
      const mappedUrls = Object.values(postRes.postUrlsByAccount || {});
      const duplicateMappedUrls = new Set(mappedUrls.filter((url, index) => mappedUrls.indexOf(url) !== index));
      for (let bIdx = 0; bIdx < batchItems.length; bIdx++) {
        const bItem = batchItems[bIdx];
        const bTask = bItem.task;
        const bResolvedAccount = bItem.resolvedAccount;
        const bDocName = bItem.taskDocName;
        const bDocUrl = bItem.taskDocUrl;
        const bSheetId = bItem.taskSheetId;
        const bDryRun = bItem.taskDryRun;

        const candidateUrl = preparedOnly ? "" : await resolveUrlForBatchItem(bItem);
        const postUrl = isBatchMulti && (usedBatchUrls.has(candidateUrl) || duplicateMappedUrls.has(candidateUrl)) ? "" : candidateUrl;
        if (postUrl) usedBatchUrls.add(postUrl);
        if (!preparedOnly && (!postUrl || (!bDryRun && !validWeiboUrlRe.test(postUrl)))) {
          // 已提交但未取得回执，持久记录并在处理其他成员后统一报错。
          batchUrlFailures.push(`${bResolvedAccount || "默认"}(第${bTask.row}行)`);
          const pending = { id: `led_${Date.now()}_${bIdx}_${Math.random().toString(36).substring(2, 6)}`,
            timestamp: Date.now(), docName: bDocName, docUrl: bDocUrl, row: bTask.row,
            targetCell: bTask.targetCell, targetSheetId: bSheetId, account: bTask.account,
            resolvedAccount: bResolvedAccount, fullContent: bTask.content, contentSummary: bTask.content.substring(0, 45),
            writeSnapshot: bTask.writeSnapshot,
            scheduleId: bTask.fromSchedule || String(bTask.id || "").startsWith("sched_") ? bTask.id : "",
            postUrl: "", mode: "真实发布", submittedWithoutReceipt: true,
            writeBackOk: false, writeBackError: "已提交但缺少回执，请人工核对，禁止自动重发" };
          if (!pendingIds[bIdx]) await withScheduleMutation(async () => {
            const { publishLedger = [], __unwrittenReceipts__ = [] } = await chrome.storage.local.get(["publishLedger", "__unwrittenReceipts__"]);
            await chrome.storage.local.set({ publishLedger: [pending, ...publishLedger], __unwrittenReceipts__: [pending, ...__unwrittenReceipts__] });
          });
          if (bTask.fromSchedule || String(bTask.id || "").startsWith("sched_")) {
            await updateScheduledTask(bTask.id, { status: "done", submittedWithoutReceipt: true, postUrl: "", writeBackOk: false, writeBackError: pending.writeBackError });
          }
          appendLog(`账号 [${bResolvedAccount || "默认"}] 已随批次提交，但未取到博文回执链接，请人工核对补写，切勿重发`, "error");
          continue;
        }
        const receipt = { status: "done", postUrl, dryRun: bDryRun, preparedOnly, error: "", writeBackOk: false, writeBackError: "", completedAt: Date.now(), writeSnapshot: bTask.writeSnapshot };
        const scheduled = !!(bTask.fromSchedule || (bTask.id && String(bTask.id).startsWith("sched_")));
        if (scheduled) await updateScheduledTask(bTask.id, receipt);

        const ledgerItem = {
          id: `led_${Date.now()}_${bIdx}_${Math.random().toString(36).substring(2, 6)}`,
          time: new Date().toLocaleString("zh-CN", { hour12: false }),
          timestamp: Date.now(),
          docName: bDocName,
          docUrl: bDocUrl,
          row: bTask.row,
          targetCell: bTask.targetCell,
          targetSheetId: bSheetId,
          account: bTask.account,
          resolvedAccount: bResolvedAccount,
          contentSummary: bTask.content.substring(0, 45),
          fullContent: bTask.content,
          writeSnapshot: bTask.writeSnapshot,
          postUrl,
          mode: bDryRun ? "安全演练" : preparedOnly ? "投票草稿" : "真实发布",
          preparedOnly,
          dryRun: bDryRun,
          trigger: bTask.fromSchedule ? "定时触发" : "即时同步",
          imageCount: postRes.imageCount || 0,
          writeBackOk: false,
        };
        // 回执必须先落盘；回写故障不能使已发博任务重新进入可发送状态。
        await withScheduleMutation(async () => {
          const { publishLedger = [], __unwrittenReceipts__ = [] } = await chrome.storage.local.get(["publishLedger", "__unwrittenReceipts__"]);
          const pendingId = pendingIds[bIdx];
          if (pendingId) activePendingSubmissionIds.delete(pendingId);
          const nextLedger = [ledgerItem, ...publishLedger.filter((item) => item.id !== pendingId)];
          const evictedUnwritten = nextLedger.slice(500).filter((item) => item.mode === "真实发布" && (item.submittedWithoutReceipt || (item.postUrl && !item.writeBackOk)));
          const unwritten = [...evictedUnwritten, ...__unwrittenReceipts__.filter((item) => item.id !== pendingId)];
          const nextUnwritten = unwritten;
          await chrome.storage.local.set({
            publishLedger: nextLedger.slice(0, 500),
            __unwrittenReceipts__: nextUnwritten,
          });
        });

        let writeBackOk = false;
        let writeBackError = "";
        if (!bDryRun && !preparedOnly && bTask.targetCell && bTask.targetCell !== "-") {
          try {
            if (currentDocTab?.id) {
              const aliveDocTab = await chrome.tabs.get(currentDocTab.id).catch(() => null);
              const targetDocBase = bDocUrl ? bDocUrl.split("?")[0].split("#")[0] : "";
              if (!aliveDocTab || (targetDocBase && aliveDocTab.url && !String(aliveDocTab.url).includes(targetDocBase))) {
                currentDocTab = null;
              }
            }
            if (!currentDocTab?.id && bDocUrl) {
              currentDocTab = await findOrCreateTab(bDocUrl.split("?")[0], bDocUrl, false);
              if (currentDocTab?.id) {
                await waitForTabLoaded(currentDocTab.id, 15000, false).catch(() => {});
              }
            }
            if (!currentDocTab?.id) throw new Error("目标云文档未连接");
            updateProgress(`回写 [${bDocName}] 单元格 ${bTask.targetCell}...`, pct);
            let writeRes;
            if (isDingTalkDocUrl(bDocUrl)) {
              appendLog("钉钉链接写回使用已打开的文档标签，不切换当前页面，也不移动鼠标", "info");
              const dingTalkSignal = { aborted: false };
              writeRes = await Promise.race([
                writeDingTalkCellInTab(currentDocTab.id, bTask.targetCell, postUrl, bSheetId, { signal: dingTalkSignal, snapshot: bTask.writeSnapshot || bTask }),
                new Promise((_, reject) => setTimeout(() => {
                  dingTalkSignal.aborted = true;
                  reject(new Error("钉钉写回超时（45秒），请手动核对单元格"));
                }, 45000)),
              ]);
            } else {
              const docAwake = await holdBackgroundTabAwake(currentDocTab.id);
              try {
                writeRes = await executeInTabDirect(currentDocTab.id, directWriteCellToDoc,
                  [bTask.targetCell, postUrl, bSheetId, bTask.writeSnapshot], "MAIN", bDocUrl, false);
              } finally {
                if (docAwake) await releaseBackgroundTab(currentDocTab.id);
              }
            }
            if (!writeRes?.ok) throw new Error(writeRes?.error || "回写未验证成功");
            writeBackOk = true;
            writtenBackCount++;
            appendLog(`单元格 ${bTask.targetCell} [${bDocName}] 链接写回成功`, "success");
          } catch (error) {
            writeBackError = error.message || String(error);
            appendLog(`博文已发布，回执已保存，但 ${bTask.targetCell} 回写失败: ${writeBackError}。请补写链接，不要重新发布`, "error");
          }
        }
        if (scheduled) {
          await updateScheduledTask(bTask.id, { writeBackOk, writeBackError });
          chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
        }
        await withScheduleMutation(async () => {
          const { publishLedger = [], __unwrittenReceipts__ = [] } = await chrome.storage.local.get(["publishLedger", "__unwrittenReceipts__"]);
          const nextLedger = publishLedger.map((item) =>
            item.id === ledgerItem.id ? { ...item, writeBackOk, writeBackError } : item);
          const nextUnwritten = writeBackOk
            ? __unwrittenReceipts__.filter((item) => !(
                item.docUrl === bDocUrl &&
                item.targetCell === bTask.targetCell &&
                item.targetSheetId === bSheetId &&
                item.resolvedAccount === bResolvedAccount &&
                item.fullContent === bTask.content
              ))
            : __unwrittenReceipts__;
          await chrome.storage.local.set({ publishLedger: nextLedger, __unwrittenReceipts__: nextUnwritten });
        });
        chrome.runtime.sendMessage({ action: "LEDGER_UPDATED" }).catch(() => {});
        chrome.runtime.sendMessage({
          action: "TASK_ITEM_COMPLETED",
          payload: { row: bTask.row, targetCell: bTask.targetCell, postUrl, docId: bTask.docId,
            docUrl: bDocUrl, targetSheetId: bSheetId, dryRun: bDryRun, preparedOnly, writeBackOk,
            manualImagesRequired: !!postRes.manualImagesRequired },
        }).catch(() => {});
        if (preparedOnly) {
          preparedCount++;
          const imgNote = postRes.manualImagesRequired
            ? `（含 ${postRes.imageCount || bTask.imgUrls?.length || 0} 张配图需人工补传）`
            : "";
          const warnNote = postRes.deadlineWarning ? ` ⚠️ ${postRes.deadlineWarning}` : "";
          appendLog(`[${bDocName}] 第 ${bTask.row} 行投票已装配${imgNote}，等待人工核对并发送，未发布或写回${warnNote}`, postRes.deadlineWarning ? "warn" : "success");
          if (i + batchItems.length < total) {
            weiboTab = await chrome.tabs.create({ url: tasks[i + batchItems.length].poll ? weiboHomeUrl : platformUrl, active: true });
            job.tabId = weiboTab.id;
          }
        } else if (bDryRun) {
          rehearsedCount++;
          appendLog(`[${bDocName}] 第 ${bTask.row} 行 (${bResolvedAccount || "默认"}) 演练完成，未发布或写回`, "success");
        } else {
          publishedCount++;
          appendLog(`[${bDocName}] 第 ${bTask.row} 行 (${bResolvedAccount || "默认"}) 已发布: ${postUrl}`, "success");
          if (typeof maybeEnqueueAutoPinForPublishedPost === "function") {
            maybeEnqueueAutoPinForPublishedPost({
              postUrl,
              content: bTask.content,
              account: bResolvedAccount || bTask.account || "",
            }).catch((err) => appendLog(`[话题置顶] 自动入队异常: ${err.message}`, "warn"));
          }
        }

        successCount++;
      }

      if (batchUrlFailures.length > 0) {
        throw new Error(`批次内账号 [${batchUrlFailures.join("、")}] 已提交但未取到有效博文回执链接，台账已保存，请人工核对补写，切勿重发`);
      }

      i += batchItems.length - 1;
      if (i + 1 < total) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    updateProgress("全部任务处理完成", 100);
    appendLog(`完成：已发布 ${publishedCount} 条，演练 ${rehearsedCount} 条，投票草稿 ${preparedCount} 条，已验证回写 ${writtenBackCount} 条`, "success");

    const summary = { total, processed: successCount, published: publishedCount, rehearsed: rehearsedCount,
      prepared: preparedCount, writtenBack: writtenBackCount, dryRun };
    state.lastSummary = summary;
    return summary;
  } catch (err) {
    if (contentLockOwned && !contentSubmitted) {
      const keysToRelease = contentLockKeys.length > 0 ? contentLockKeys : (contentLockKey ? [contentLockKey] : []);
      for (const k of keysToRelease) {
        await releasePublishTaskLock(k).catch((releaseErr) => console.warn("释放发博锁失败:", releaseErr));
      }
    }
    appendLog(`❌ 执行失败: ${err.message}`, "error");
    updateProgress(`中断: ${err.message}`, state.percentage);
    throw err;
  } finally {
    clearInterval(keepAliveTimer);
    if (heldAwakeTabId) {
      await releaseBackgroundTab(heldAwakeTabId).catch(() => {});
      heldAwakeTabId = null;
    }
    // 自动清理后台静默独立发博窗口与本次静默新建的发博标签页，确保用户浏览器洁净无残留
    if (runnerWin && runnerWin.id) {
      try {
        await chrome.windows.remove(runnerWin.id);
        appendLog("已自动关闭后台静默发博窗口", "info");
      } catch (_) {}
    }
    if (createdSilentWeiboTabIds.size > 0 && chrome.tabs && typeof chrome.tabs.remove === "function") {
      for (const tabId of createdSilentWeiboTabIds) {
        await chrome.tabs.remove(tabId).catch(() => {});
      }
      appendLog("已自动关闭本次静默新建的发博标签页", "info");
    }
    // 流水线结束后，尚存的待核对记录转为可人工补录/解除状态。
    activePendingSubmissionIds.clear();
    state.isRunning = false;
    activeJob = null;
    updateProgress(state.stage, state.percentage);
  }
}

// ─────────────────────────────────────────────────────────────
// chrome.alarms 定时触发器 (精准闹钟 + 30秒心跳巡检 + 串行互斥排队)
// ─────────────────────────────────────────────────────────────
const HEARTBEAT_ALARM_NAME = "__schedule_heartbeat__";
let isScheduleSweepRunning = false;

function ensureScheduleHeartbeat() {
  try {
    chrome.alarms.get(HEARTBEAT_ALARM_NAME, (existing) => {
      if (chrome.runtime.lastError) {
        console.warn("alarms.get error:", chrome.runtime.lastError);
      }
      if (!existing) {
        // 严格遵守 Chrome 官方 MV3 最低合法间隔 1 分钟，确保全版本 Chrome 100% 注册成功不被拒！
        chrome.alarms.create(HEARTBEAT_ALARM_NAME, { periodInMinutes: 1 });
      }
    });
  } catch (e) {
    console.warn("ensureScheduleHeartbeat error:", e);
  }
}

const SCHEDULE_DONE_TTL_MS = 12 * 60 * 60 * 1000;

function pruneExpiredDoneSchedules(tasks, now = Date.now()) {
  if (!Array.isArray(tasks) || tasks.length === 0) return { tasks: [], removed: 0 };
  let removed = 0;
  const kept = tasks.filter((task) => {
    // 已人工核实未发布并解除阻断的记录，按常规 TTL 清理，避免跨批次永久累积。
    if (task && task.status === "error" && task.resolvedAt && now - task.resolvedAt >= SCHEDULE_DONE_TTL_MS) {
      removed += 1;
      return false;
    }
    if (!task || task.status !== "done") return true;
    // 待核对或待补写的记录保留，避免自动清理后丢失人工处理入口（账本中仍有防重证据）。
    if (task.submittedWithoutReceipt || (task.postUrl && !task.writeBackOk)) return true;
    const doneAt = Number(task.completedAt || task.firingAt || task.fireAtTimestamp || task.createdAt || 0);
    if (doneAt > 0 && now - doneAt >= SCHEDULE_DONE_TTL_MS) {
      removed += 1;
      return false;
    }
    return true;
  });
  return { tasks: kept, removed };
}

async function cleanupExpiredDoneSchedules(now = Date.now()) {
  const removed = await withScheduleMutation(async () => {
    const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
    const res = pruneExpiredDoneSchedules(scheduledTasks, now);
    if (res.removed > 0) {
      await chrome.storage.local.set({ scheduledTasks: res.tasks });
    }
    return res.removed;
  });
  if (removed > 0) {
    chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
    appendLog(`定时队列自动清理：已清除 ${removed} 条超过 12 小时的已发布记录`, "info");
  }
  return removed;
}

async function rearmPendingSchedules() {
  try {
    await stateReady;
    let recoveredOrphanFiring = false;
    if (!state.isRunning && !pipelineReservation && !activeJob) {
      await withScheduleMutation(async () => {
        const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
        if (scheduledTasks.some((t) => t && t.status === "firing")) {
          const cleaned = scheduledTasks.map((t) =>
            t && t.status === "firing"
              ? { ...t, status: "error", error: "扩展已重载或上次执行中断，请核对已发博文，避免重复发布" }
              : t
          );
          await chrome.storage.local.set({ scheduledTasks: cleaned });
          recoveredOrphanFiring = true;
        }
      });
      if (recoveredOrphanFiring) {
        chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
      }
    }
    const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
    await cleanupExpiredDoneSchedules().catch(() => {});
    const pending = scheduledTasks.filter((t) => t && t.status === "pending" && Number.isFinite(t.fireAtTimestamp));
    for (const task of pending) {
      await armSchedule(task);
    }
    if (pending.some((t) => t.fireAtTimestamp <= Date.now())) {
      sweepAndRunDueSchedules("rearm").catch((error) => appendLog(`重启补扫定时任务失败: ${error.message}`, "error"));
    }
  } catch (e) {
    console.warn("rearmPendingSchedules error:", e);
  }
}

ensureScheduleHeartbeat();
chrome.runtime.onInstalled.addListener(() => {
  ensureScheduleHeartbeat();
  rearmPendingSchedules();
  if (typeof ensureTopicPinAlarms === "function") {
    ensureTopicPinAlarms({ recoverRunningTasks: true }).catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(() => {
  ensureScheduleHeartbeat();
  rearmPendingSchedules();
  if (typeof ensureTopicPinAlarms === "function") {
    ensureTopicPinAlarms({ recoverRunningTasks: true }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────
// 持久化原子发布认领锁 (100% 对齐原系统 server.py:13520 _claim_doc_publish_task)
// 即使 ServiceWorker 休眠重启或并发多闹钟到达，物理级阻断同一任务的重复发射！
// ─────────────────────────────────────────────────────────────
let publishClaimQueue = Promise.resolve();
function withPublishClaim(operation) {
  const run = publishClaimQueue.then(operation, operation);
  publishClaimQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function claimPublishTaskLock(lockKey, ttlMs = 180000) {
  if (!lockKey) return true;
  return withPublishClaim(async () => {
    const now = Date.now();
    const { __publishClaims__ = {} } = await chrome.storage.local.get(["__publishClaims__"]);
    const claims = { ...__publishClaims__ };

    for (const k of Object.keys(claims)) {
      if (now - claims[k] > 15 * 60 * 1000) {
        delete claims[k];
      }
    }

    if (claims[lockKey] && now - claims[lockKey] < ttlMs) {
      return false;
    }

    claims[lockKey] = now;
    await chrome.storage.local.set({ __publishClaims__: claims });
    return true;
  });
}

async function releasePublishTaskLock(lockKey) {
  if (!lockKey) return;
  return withPublishClaim(async () => {
    const { __publishClaims__ = {} } = await chrome.storage.local.get(["__publishClaims__"]);
    if (!Object.prototype.hasOwnProperty.call(__publishClaims__, lockKey)) return;
    const claims = { ...__publishClaims__ };
    delete claims[lockKey];
    await chrome.storage.local.set({ __publishClaims__: claims });
  });
}

async function sweepAndRunDueSchedules(triggeredAlarmName = "") {
  await stateReady;
  if (isScheduleSweepRunning) return;
  isScheduleSweepRunning = true;
  const reservation = {};
  try {
    const { schedulePaused = false } = await chrome.storage.local.get(["schedulePaused"]);
    if (schedulePaused || state.isRunning || pipelineReservation) return;
    pipelineReservation = reservation;
    const { dryRun: globalDryRun, silentMode } = await chrome.storage.local.get(["dryRun", "silentMode"]);
    const claimedBatch = await withScheduleMutation(async () => {
      const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
      const now = Date.now();
      const due = [];
      const updated = [];
      for (const task of scheduledTasks) {
        if (task.status === "firing" && ((!state.isRunning && !activeJob) || !task.firingAt || now - task.firingAt > 10 * 60 * 1000)) {
          updated.push({ ...task, status: "error", error: "上次执行已中断，请先核对已发博文，避免重复发布" });
        } else if (task.status === "pending" && Number.isFinite(task.fireAtTimestamp) && task.fireAtTimestamp <= now) {
          const claimed = await claimPublishTaskLock(`sched::${task.id}`, 10 * 60 * 1000);
          if (claimed) {
            const item = { ...task, status: "firing", firingAt: now, fromSchedule: true };
            updated.push(item);
            due.push(item);
            await chrome.alarms.clear(task.id);
          } else updated.push(task);
        } else updated.push(task);
      }
      await chrome.storage.local.set({ scheduledTasks: updated });
      return due.sort((a, b) => a.fireAtTimestamp - b.fireAtTimestamp);
    });
    if (!claimedBatch.length) return;
    chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
    appendLog(`定时调度：开始依次执行 ${claimedBatch.length} 条到期任务`, "info");
    let error = "未完成全部发布流程，请检查运行日志";
    try {
      await startPipeline({ dryRun: globalDryRun !== false, useTaskDryRun: typeof globalDryRun !== "boolean",
        silentMode: silentMode !== false, selectedTasks: claimedBatch }, reservation);
    } catch (batchError) {
      error = batchError.message;
      appendLog(`定时批次执行异常: ${error}`, "error");
    } finally {
      await finalizeScheduledBatch(claimedBatch.map((task) => task.id), error);
    }
  } finally {
    if (pipelineReservation === reservation) pipelineReservation = null;
    isScheduleSweepRunning = false;
  }
}

async function finalizeScheduledBatch(taskIds, error) {
  await withScheduleMutation(async () => {
    const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
    await chrome.storage.local.set({ scheduledTasks: scheduledTasks.map((task) =>
      taskIds.includes(task.id) && task.status === "firing" ? { ...task, status: "error", error } : task) });
  });
  chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm?.name === "topicPinTick" && typeof processTopicPinQueue === "function") {
    await processTopicPinQueue().catch((err) => appendLog(`[话题置顶] 定时推进异常: ${err.message}`, "error"));
    return;
  }
  if (alarm?.name === "topicMonitorTick" && typeof checkWeiboMonitorOnce === "function") {
    await checkWeiboMonitorOnce()
      .then((res) => {
        if (res && res.ok === false && res.reason) {
          appendLog(`[话题置顶] 巡检失败: ${res.reason}`, res.loginRequired ? "error" : "warn");
        }
      })
      .catch((err) => appendLog(`[话题置顶] 巡检异常: ${err.message}`, "error"));
    return;
  }
  ensureScheduleHeartbeat();
  if (alarm?.name === HEARTBEAT_ALARM_NAME && typeof ensureTopicPinAlarms === "function") {
    await ensureTopicPinAlarms({ recoverRunningTasks: true }).catch(() => {});
  }
  await cleanupExpiredDoneSchedules().catch(() => {});
  await sweepAndRunDueSchedules(alarm.name);
});

// ─────────────────────────────────────────────────────────────
// 微博原投票克隆提取引擎 (100% 对齐原系统 _extract_poll_payload_from_weibo_url)
// ─────────────────────────────────────────────────────────────
async function directExtractPollFromWeiboPage(ids) {
  const cleanBodyContent = (rawText) => {
    return String(rawText || "")
      .replace(/https?:\/\/t\.cn\/\S+/gi, "")
      .replace(/\s*的?微博投票\s*$/g, "")
      .trim();
  };

  // 全量搜索 API 对象，收集所有候选投票对象并选出选项最多、可信度最高的一组（杜绝3项预览截胡4项全量）
  const findPollInObj = (root) => {
    const visited = new Set();
    const stack = [root];
    const candidates = [];

    const extractOptText = (o) => {
      if (typeof o === "string") return o.trim();
      if (o && typeof o === "object") {
        const direct =
          o.option_name ||
          o.option ||
          o.text ||
          o.title ||
          o.content ||
          o.name ||
          o.desc ||
          o.label ||
          o.choice ||
          o.item ||
          o.item_title ||
          o.item_name ||
          o.vote_title ||
          o.desc_raw ||
          "";
        if (typeof direct === "string") return direct.trim();
        if (direct && typeof direct === "object") {
          return String(direct.text || direct.content || direct.title || direct.name || "").trim();
        }
      }
      return "";
    };

    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (visited.has(cur)) continue;
      visited.add(cur);

      if (!Array.isArray(cur)) {
        const strongOpts =
          cur.vote_options ||
          cur.vote_list ||
          cur.choice_list ||
          cur.option_list ||
          cur.choices ||
          cur.options;
        const weakOpts = cur.items || cur.list;
        const pairs = [
          { arr: strongOpts, isStrong: true },
          { arr: weakOpts, isStrong: false },
        ];

        for (const { arr, isStrong } of pairs) {
          if (!Array.isArray(arr) || arr.length < 2) continue;
          const parsedOpts = [];
          for (const o of arr) {
            const txt = extractOptText(o);
            if (txt && !parsedOpts.includes(txt)) parsedOpts.push(txt);
          }
          if (parsedOpts.length >= 2) {
            const hasVoteSemantics =
              isStrong ||
              Boolean(
                cur.question ||
                  cur.vote_title ||
                  cur.partic_num ||
                  cur.total_num ||
                  cur.end_time ||
                  cur.vote_id ||
                  String(cur.type || "").toLowerCase().includes("vote") ||
                  String(cur.object_type || "").toLowerCase().includes("vote")
              );
            if (!hasVoteSemantics) continue;
            const title = String(
              cur.question || cur.vote_title || cur.title || cur.subject || cur.name || cur.desc || "参与投票"
            ).trim();
            const score = (isStrong ? 100 : 0) + (cur.question || cur.vote_title ? 20 : 0) + parsedOpts.length * 10;
            candidates.push({ title, options: parsedOpts, score });
          }
        }

        for (const k of Object.keys(cur)) {
          if (cur[k] && typeof cur[k] === "object") stack.push(cur[k]);
        }
      } else {
        for (const item of cur) {
          if (item && typeof item === "object") stack.push(item);
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.options.length - a.options.length || b.score - a.score);
    return { title: candidates[0].title, options: candidates[0].options };
  };

  let capturedContent = "";
  let discoveredVoteUrl = "";
  let bestApiResult = null;

  // 通道 A: 同源 Ajax 接口拉取详情 JSON
  for (const sId of ids) {
    try {
      const resp = await fetch(`/ajax/statuses/show?id=${sId}&locale=zh-CN&isGetLongText=true`, {
        credentials: "include",
        headers: {
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && (data.text_raw || data.text || data.page_info)) {
          const rawText =
            data.longTextContent_raw ||
            data.text_raw ||
            (data.text ? data.text.replace(/<[^>]+>/g, "") : "");
          capturedContent = cleanBodyContent(rawText);

          // 提取独立 vote.weibo.com 投票页地址
          if (!discoveredVoteUrl) {
            const jsonStr = JSON.stringify(data).replace(/\\\//g, "/");
            const vMatch = jsonStr.match(/(?:https?:)?\/\/vote\.weibo\.com\/[^\s"'<>\\]+/i);
            if (vMatch) {
              discoveredVoteUrl = vMatch[0].startsWith("//") ? "https:" + vMatch[0] : vMatch[0];
            }
          }

          const poll = findPollInObj(data);
          if (poll && poll.options.length >= 2) {
            if (!bestApiResult || poll.options.length > bestApiResult.pollOptions.length) {
              bestApiResult = {
                ok: true,
                content: capturedContent,
                pollTitle: poll.title,
                pollOptions: poll.options,
                source: "同源投票接口",
                voteUrl: discoveredVoteUrl,
              };
            }
            if (bestApiResult.pollOptions.length >= 4 || !discoveredVoteUrl) {
              return bestApiResult;
            }
          }
        }
      }
    } catch (_) {}
  }

  // 通道 B: 页面等待并解析 DOM 渲染出的正文与投票卡片（含展开按钮触发 + 滚动穿透 + 最大选项容器优先）
  let bestDomResult = null;
  for (let p = 0; p < 10; p++) {
    try {
      const textEl = document.querySelector(
        '.detail_wbtext_4CRf9, .WB_text, [class*="wbtext"], .wbpro-feed-content, article'
      );
      const domContent = cleanBodyContent((textEl && (textEl.innerText || textEl.textContent || "")) || capturedContent || "");

      const voteContainers = Array.from(
        document.querySelectorAll('[class*="vote"], [class*="poll"], [class*="Vote"], [class*="Poll"], [class*="card-vote"]')
      );
      for (const vc of voteContainers) {
        // 触发可能存在的“展开/查看全部”按钮，并滚动容器暴露隐藏末尾选项
        try {
          vc.scrollIntoView?.({ block: "center" });
          if (vc.scrollHeight > vc.clientHeight) {
            vc.scrollTop = vc.scrollHeight;
          }
          const expandBtns = Array.from(vc.querySelectorAll('button, [role="button"], a, span, div'));
          for (const eb of expandBtns) {
            const et = (eb.innerText || eb.textContent || "").trim();
            if (/^(?:展开|查看更多|展开全部|全部选项)$/.test(et)) {
              eb.click?.();
            }
          }
        } catch (_) {}

        const titleEl = vc.querySelector('[class*="title"], [class*="question"], h3, h4, .title');
        const titleText = (titleEl && (titleEl.innerText || titleEl.textContent || "").trim()) || "";
        const optEls = Array.from(vc.querySelectorAll('[class*="item"], [class*="option"], li, button, [role="button"], .txt'))
          .map((el) => (el.innerText || el.textContent || "").trim())
          .filter(
            (txt) =>
              txt &&
              txt !== titleText &&
              txt.length <= 80 &&
              !/^(?:已投票|参与人数|发起投票|已结束|查看全部|展开|投票)$/.test(txt) &&
              !txt.includes("人参与") &&
              !txt.includes("已投票") &&
              !txt.includes("参与人数") &&
              !txt.includes("投给") &&
              !txt.includes("距结束") &&
              !txt.includes("已过期")
          );

        const cleanOpts = Array.from(new Set(optEls))
          .map((o) => o.replace(/\s+\d+(?:\.\d+)?%$/, "").replace(/\s+\d+票$/, "").trim())
          .filter(Boolean);

        if (cleanOpts.length >= 2) {
          if (!bestDomResult || cleanOpts.length > bestDomResult.pollOptions.length) {
            bestDomResult = {
              ok: true,
              content: domContent,
              pollTitle: titleText || "参与投票",
              pollOptions: cleanOpts,
              source: "页面投票卡片DOM",
              voteUrl: discoveredVoteUrl,
            };
          }
        }
      }

      if (!discoveredVoteUrl) {
        const htmlText = (document.body && document.body.innerHTML) || "";
        const vm = htmlText.replace(/\\\//g, "/").match(/(?:https?:)?\/\/vote\.weibo\.com\/[^\s"'<>\\]+/i);
        if (vm) {
          discoveredVoteUrl = vm[0].startsWith("//") ? "https:" + vm[0] : vm[0];
        }
      }

      if (bestDomResult && (bestDomResult.pollOptions.length >= 4 || !discoveredVoteUrl)) {
        break;
      }
      if (discoveredVoteUrl && domContent && p >= 2) break;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }

  let chosen = null;
  if (bestApiResult && bestDomResult) {
    chosen = bestDomResult.pollOptions.length > bestApiResult.pollOptions.length ? bestDomResult : bestApiResult;
  } else {
    chosen = bestApiResult || bestDomResult;
  }

  // 若目前选项 <= 3 且拿到了独立投票页 URL，返回给通道 C 顺藤摸瓜比对全量选项
  if (discoveredVoteUrl && (!chosen || chosen.pollOptions.length <= 3)) {
    return {
      ok: false,
      needVotePage: true,
      voteUrl: discoveredVoteUrl,
      content: (chosen && chosen.content) || capturedContent,
      fallbackResult: chosen,
    };
  }

  if (chosen) return chosen;

  return { ok: false, error: "未能在该微博中检测到投票活动（页面可能被跳转至登录或访客页，当前URL: " + window.location.href + "）" };
}

function directExtractVotePageOptions(existingTitle) {
  const lines = (document.body.innerText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const cleanLines = lines.filter(
    (l) =>
      l.length >= 1 &&
      l.length <= 80 &&
      !l.includes("人参与") &&
      !l.includes("已结束") &&
      !l.includes("微博投票") &&
      !l.includes("发起") &&
      !l.includes("登录") &&
      !l.includes("距结束")
  );
  let title = existingTitle && existingTitle !== "参与投票" ? existingTitle : "参与投票";
  const opts = [];
  for (let i = 0; i < cleanLines.length; i++) {
    const l = cleanLines[i].replace(/\s+\d+(?:\.\d+)?%$/, "").replace(/\s+\d+票$/, "").trim();
    if (!l) continue;
    if (title === "参与投票" && (l.includes("？") || l.includes("?"))) {
      title = l;
    } else if (l !== title && !opts.includes(l)) {
      opts.push(l);
    }
  }
  if (opts.length >= 2) {
    return { ok: true, pollTitle: title, pollOptions: opts.slice(0, 20) };
  }
  return { ok: false };
}

async function extractPollFromWeiboUrl(weiboUrl) {
  const cleanUrl = String(weiboUrl || "").trim();
  if (!cleanUrl || !cleanUrl.startsWith("http")) {
    throw new Error("请提供合法的微博详情页链接");
  }

  // 解析短 ID 并计算纯数字 MID
  const bidToMid = (bid) => {
    const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let text = String(bid || "").trim();
    if (!text) return "";
    const chunks = [];
    while (text) {
      chunks.push(text.slice(-4));
      text = text.slice(0, -4);
    }
    const midParts = [];
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[chunks.length - 1 - idx];
      let value = 0;
      for (let i = 0; i < chunk.length; i++) {
        const pos = alphabet.indexOf(chunk[i]);
        if (pos === -1) return "";
        value = value * 62 + pos;
      }
      let part = String(value);
      if (idx > 0) part = part.padStart(7, "0");
      midParts.push(part);
    }
    return midParts.join("");
  };

  let rawId = "";
  const m1 = cleanUrl.match(/weibo\.com\/[0-9]+\/([A-Za-z0-9]+)/i);
  if (m1) rawId = m1[1];
  if (!rawId) {
    const m2 = cleanUrl.match(/weibo\.com\/detail\/([0-9A-Za-z]+)/i);
    if (m2) rawId = m2[1];
  }
  if (!rawId) {
    const m3 = cleanUrl.match(/m\.weibo\.cn\/(?:status|detail)\/([0-9A-Za-z]+)/i);
    if (m3) rawId = m3[1];
  }
  if (!rawId) {
    throw new Error("未能从该微博链接中解析出有效的博文 ID");
  }

  const candidateIds = [];
  if (/^\d{6,}$/.test(rawId)) {
    candidateIds.push(rawId);
  } else {
    const mid = bidToMid(rawId);
    if (mid) candidateIds.push(mid);
    candidateIds.push(rawId);
  }

  appendLog(`正在后台静默读取原博投票信息: ${cleanUrl.substring(0, 42)}...`, "info");
  const tempTab = await chrome.tabs.create({ url: cleanUrl, active: false });

  // 1. 强守卫等待：确保页面彻底完成跳转，脱离 Sina Visitor System 与登录中间态（最长 15 秒）
  for (let w = 0; w < 30; w++) {
    const tInfo = await chrome.tabs.get(tempTab.id).catch(() => null);
    const curUrl = String((tInfo && tInfo.url) || "").toLowerCase();
    if (
      tInfo &&
      tInfo.status === "complete" &&
      (curUrl.includes("weibo.com") || curUrl.includes("weibo.cn")) &&
      !curUrl.includes("visitor") &&
      !curUrl.includes("passport") &&
      !curUrl.includes("login.php")
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1200));

  try {
    let res = await executeInTabDirect(
      tempTab.id,
      directExtractPollFromWeiboPage,
      [candidateIds],
      "MAIN",
      cleanUrl
    );

    // 通道 C: 若发现独立投票页链接，且之前未拿到或只拿到 <=3 个选项，顺藤摸瓜穿透核对全量选项！
    if (res && res.needVotePage && res.voteUrl) {
      appendLog(`发现独立投票卡片页面，正在顺藤摸瓜核对完整选项: ${res.voteUrl.substring(0, 42)}...`, "info");
      const voteTab = await chrome.tabs.create({ url: res.voteUrl, active: false });
      try {
        await waitForTabLoaded(voteTab.id, 10000);
        await new Promise((r) => setTimeout(r, 1500));
        const fallbackTitle = res.fallbackResult?.pollTitle || "";
        const voteRes = await executeInTabDirect(
          voteTab.id,
          directExtractVotePageOptions,
          [fallbackTitle],
          "MAIN",
          res.voteUrl
        );

        const fallbackCount = res.fallbackResult?.pollOptions?.length || 0;
        if (voteRes && voteRes.ok && voteRes.pollOptions.length > fallbackCount) {
          res = {
            ok: true,
            content: res.content || cleanUrl,
            pollTitle: voteRes.pollTitle,
            pollOptions: voteRes.pollOptions,
            source: "独立投票页穿透",
          };
        } else if (res.fallbackResult) {
          res = res.fallbackResult;
        }
      } catch (_) {
        if (res.fallbackResult) res = res.fallbackResult;
      } finally {
        chrome.tabs.remove(voteTab.id).catch(() => {});
      }
    }

    if (res && res.ok) {
      // 100% 对齐原系统 server.py:8585 _derive_poll_title_from_content
      const derivePollTitleFromContent = (text) => {
        let normalized = String(text || "").replace(/https?:\/\/\S+/g, "").trim();
        if (!normalized) return "";
        let qpos = -1;
        for (const mark of ["？", "?"]) {
          const idx = normalized.indexOf(mark);
          if (idx !== -1 && (qpos === -1 || idx < qpos)) qpos = idx;
        }
        if (qpos === -1) return "";
        let candidate = normalized.slice(0, qpos + 1).trim();
        candidate = candidate.replace(/^(?:#([^#\n]+)#\s*)+/, "").trim();
        for (const prefix of [
          "考考你，", "考考你：", "考考你:",
          "热知识点，", "热知识点：", "热知识点:",
          "问你一个问题，", "问你一个问题：", "问你一个问题:",
          "小调查，", "小调查：", "小调查:",
          "民意调查，", "民意调查：", "民意调查:",
        ]) {
          if (candidate.startsWith(prefix)) {
            candidate = candidate.slice(prefix.length).trim();
            break;
          }
        }
        return candidate;
      };

      let finalTitle = String(res.pollTitle || "").trim();
      const derived = derivePollTitleFromContent(res.content);
      if (derived) {
        finalTitle = derived;
      } else if (!finalTitle || finalTitle === "参与投票" || finalTitle.includes("微博投票")) {
        const firstLine = String(res.content || "").split("\n")[0].trim().replace(/^(?:#([^#\n]+)#\s*)+/, "");
        finalTitle = firstLine.slice(0, 32) || "参与投票";
      }

      return {
        content: res.content || "",
        pollTitle: finalTitle,
        pollOptions: res.pollOptions || [],
        sourceUrl: cleanUrl,
        source: res.source || "同源读取",
      };
    } else {
      throw new Error(res?.error || "解析原博投票失败");
    }
  } finally {
    chrome.tabs.remove(tempTab.id).catch(() => {});
  }
}

// 消息路由
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request.action !== "string") return false;
  if (request.action === "SET_DRY_RUN_MODE") {
    handleSetDryRunMode(request.dryRun)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (request.action === "SWEEP_DUE_SCHEDULES") {
    ensureScheduleHeartbeat();
    cleanupExpiredDoneSchedules()
      .catch(() => {})
      .finally(() => sweepAndRunDueSchedules().catch((error) => appendLog(`定时巡检失败: ${error.message}`, "error")));
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === "CLONE_WEIBO_POLL") {
    extractPollFromWeiboUrl(request.weiboUrl)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "GET_PIPELINE_STATUS") {
    stateReady.then(() => sendResponse({ ok: true, state }));
    return true;
  }

  if (request.action === "CLEAR_LOGS") {
    state.logs = [];
    syncState();
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === "SCAN_DOC_TASKS") {
    scanDocTasks(request.config || {})
      .then((tasks) => sendResponse({ ok: true, tasks }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "START_PIPELINE") {
    startPipeline(request.config || {})
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "STOP_PIPELINE") {
    if (activeJob) {
      activeJob.aborted = true;
      if (activeJob.tabId) {
        chrome.scripting.executeScript({ target: { tabId: activeJob.tabId }, world: "MAIN",
          func: (jobId) => {
            window.__weiboSyncCancelledJobs = window.__weiboSyncCancelledJobs || {};
            window.__weiboSyncCancelledJobs[jobId] = true;
            return true;
          }, args: [activeJob.id] }).catch((error) => appendLog(`页内停止信号未送达: ${error.message}`, "warn"));
      }
      updateProgress("正在停止：已提交任务仍会保存回执，后续任务将取消", state.percentage);
      appendLog("已触发停止信号...", "warn");
      sendResponse({ ok: true, message: "已发送停止指令" });
    } else {
      if (!state.isRunning && !pipelineReservation) {
        withScheduleMutation(async () => {
          const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
          if (scheduledTasks.some((t) => t && t.status === "firing")) {
            await chrome.storage.local.set({
              scheduledTasks: scheduledTasks.map((t) =>
                t && t.status === "firing"
                  ? { ...t, status: "error", error: "已手动停止孤立的发布中状态，请核对已发博文" }
                  : t
              ),
            });
            chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
          }
        }).catch(() => {});
      }
      sendResponse({ ok: true, message: "当前没有运行中的任务" });
    }
    return true;
  }

  if (request.action === "ADD_SCHEDULE_TASKS") {
    handleAddScheduleTasks(request.tasks || [])
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "FIRE_SCHEDULE_NOW") {
    handleFireScheduleNow(request.taskId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "BATCH_FIRE_SCHEDULE") {
    handleBatchFireSchedule(request.taskIds)
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "CANCEL_SCHEDULE_TASK") {
    handleCancelScheduleTask(request.taskId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "BATCH_CANCEL_SCHEDULE") {
    handleBatchCancelSchedule(request.taskIds)
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "UPDATE_SCHEDULE_TASK") {
    handleUpdateScheduleTask(request.taskId, request.updates)
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "CLEAR_ALL_SCHEDULE") {
    handleClearAllSchedule()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "CLEAR_DONE_SCHEDULE") {
    handleClearDoneSchedule()
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "BATCH_RESCHEDULE_TASKS") {
    handleBatchRescheduleTasks(request.taskIds, request.options || {})
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "FETCH_PREVIEW_IMAGE") {
    handleFetchPreviewImage(request.url, request.docUrl)
      .then((res) => sendResponse({ ok: !!res?.dataUrl, dataUrl: res?.dataUrl || "" }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "CLEAR_PUBLISH_LEDGER") {
    withScheduleMutation(async () => {
      const { publishLedger = [], __unwrittenReceipts__ = [] } = await chrome.storage.local.get(["publishLedger", "__unwrittenReceipts__"]);
      const retained = publishLedger.filter((item) => item && item.mode === "真实发布" && (item.submittedWithoutReceipt || (item.postUrl && !item.writeBackOk)));
      const merged = [...retained, ...__unwrittenReceipts__].filter((item, index, all) =>
        !item?.id || all.findIndex((other) => other?.id === item.id) === index);
      await chrome.storage.local.set({ publishLedger: [], __unwrittenReceipts__: merged });
      return retained.length;
    }).then((retained) => sendResponse({ ok: true, retained }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "MANUAL_RECEIPT_WRITE_BACK") {
    handleManualReceiptWriteBack(request.payload || request)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "RESOLVE_PENDING_SUBMISSION") {
    handleResolvePendingSubmission(request.payload || request)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "RETRY_WRITE_BACK") {
    handleRetryWriteBack(request.payload || request)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "GET_TOPIC_PIN_STATE") {
    Promise.all([
      typeof getTopicPinConfig === "function" ? getTopicPinConfig() : {},
      typeof getTopicPinTasks === "function" ? getTopicPinTasks() : [],
      typeof getTopicMonitorStatus === "function" ? getTopicMonitorStatus() : null,
    ])
      .then(([config, tasks, monitorStatus]) => sendResponse({ ok: true, config, tasks, monitorStatus }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "SAVE_TOPIC_PIN_CONFIG") {
    saveTopicPinConfig(request.config || {})
      .then((config) => sendResponse({ ok: true, config }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "MANUAL_TOPIC_PIN") {
    handleManualTopicPin(request.url)
      .then((task) => sendResponse({ ok: true, task }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "MANUAL_APPLY_HOST") {
    handleManualApplyHost(request.payload || request)
      .then((task) => sendResponse({ ok: true, task }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "RETRY_TOPIC_PIN_TASK") {
    (async () => {
      const cfg = await getTopicPinConfig();
      await withTopicPinMutation(async () => {
        const tasks = await getTopicPinTasks();
        const next = tasks.map((t) => {
          if (t.id !== request.taskId) return t;
          const resetTopics = (t.topics || []).map((tp) =>
            tp && (tp.status === "error" || tp.status === "timeout")
              ? { ...tp, status: "pending", note: "等待重试", pinAttempts: 0 }
              : tp
          );
          return {
            ...t,
            status: "pending",
            error: "",
            nextCheckAt: null,
            deadlineAt: Date.now() + cfg.maxWaitSec * 1000,
            topics: resetTopics,
            updatedAt: Date.now(),
          };
        });
        await saveTopicPinTasks(next);
      });
      processTopicPinQueue().catch(() => {});
      return { ok: true };
    })()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "RETRY_ALL_ERROR_TOPIC_PIN_TASKS") {
    (async () => {
      const cfg = await getTopicPinConfig();
      let retriedCount = 0;
      await withTopicPinMutation(async () => {
        const tasks = await getTopicPinTasks();
        const next = tasks.map((t) => {
          if (t.status !== "error") return t;
          retriedCount += 1;
          const resetTopics = (t.topics || []).map((tp) =>
            tp && (tp.status === "error" || tp.status === "timeout")
              ? { ...tp, status: "pending", note: "等待重试", pinAttempts: 0 }
              : tp
          );
          return {
            ...t,
            status: "pending",
            error: "",
            nextCheckAt: null,
            deadlineAt: Date.now() + cfg.maxWaitSec * 1000,
            topics: resetTopics,
            updatedAt: Date.now(),
          };
        });
        await saveTopicPinTasks(next);
      });
      if (retriedCount > 0) processTopicPinQueue().catch(() => {});
      return { ok: true, retriedCount };
    })()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "REMOVE_TOPIC_PIN_TASK") {
    withTopicPinMutation(async () => {
      const tasks = await getTopicPinTasks();
      await saveTopicPinTasks(tasks.filter((t) => t.id !== request.taskId));
    })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "CLEAR_DONE_TOPIC_PIN_TASKS") {
    withTopicPinMutation(async () => {
      const tasks = await getTopicPinTasks();
      await saveTopicPinTasks(tasks.filter((t) => ["pending", "running", "waiting_review"].includes(t.status)));
    })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (request.action === "RUN_TOPIC_MONITOR_NOW") {
    checkWeiboMonitorOnce({ manual: true })
      .then((res) => sendResponse({ ok: true, res }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
});

async function handleResolvePendingSubmission(payload = {}) {
  const ledgerId = String(payload.ledgerId || "").trim();
  if (!ledgerId) return { ok: false, error: "缺少账本记录编号" };
  return withScheduleMutation(async () => {
    // 校验必须落在临界区内，避免"已写库、未加内存标记"窗口期被并发解除。
    if (activePendingSubmissionIds.has(ledgerId)) {
      return { ok: false, error: "该任务正在发布中，请等待流水线结束后再核实" };
    }
    const {
      publishLedger = [],
      __unwrittenReceipts__ = [],
      scheduledTasks = [],
    } = await chrome.storage.local.get(["publishLedger", "__unwrittenReceipts__", "scheduledTasks"]);
    const entries = [...publishLedger, ...__unwrittenReceipts__].filter((item) => item && item.id === ledgerId);
    if (!entries.length) return { ok: false, error: "未找到待核对记录，请刷新账本" };
    if (entries.some((item) => !item.submittedWithoutReceipt)) {
      return { ok: false, error: "记录状态已变化，请刷新账本后重试" };
    }
    const scheduleId = String(entries.find((item) => item.scheduleId)?.scheduleId || "").trim();
    const nextScheduled = scheduledTasks.map((item) => (item && (item.id === ledgerId || (scheduleId && item.id === scheduleId)))
      ? { ...item, status: "error", submittedWithoutReceipt: false, postUrl: "", writeBackOk: false,
          writeBackError: "", error: "已人工核实未发布，阻断已解除，可重新排程", resolvedAt: Date.now() }
      : item);
    await chrome.storage.local.set({
      publishLedger: publishLedger.filter((item) => !item || item.id !== ledgerId),
      __unwrittenReceipts__: __unwrittenReceipts__.filter((item) => !item || item.id !== ledgerId),
      scheduledTasks: nextScheduled,
    });
    return { ok: true };
  });
}

function isVerifiedWeiboPostUrl(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    if (!/^https?:$/.test(url.protocol)) return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    if (host === "t.cn") return /^\/[A-Za-z0-9]+$/.test(path);
    if (host === "m.weibo.cn") return /^\/(?:status|detail)\/[A-Za-z0-9]+$/.test(path);
    if (host === "weibo.com" || host === "weibo.cn") {
      return /^\/\d+\/[A-Za-z0-9]+$/.test(path) || /^\/detail\/[A-Za-z0-9]+$/.test(path);
    }
    return false;
  } catch {
    return false;
  }
}

async function handleManualReceiptWriteBack(payload = {}) {
  const ledgerId = String(payload.ledgerId || "").trim();
  const postUrl = String(payload.postUrl || "").trim();
  if (!ledgerId) return { ok: false, error: "缺少账本记录编号" };
  if (!isVerifiedWeiboPostUrl(postUrl)) {
    return { ok: false, error: "请输入具体博文链接（账号主页不可作为回执）" };
  }
  if (activePendingSubmissionIds.has(ledgerId)) {
    return { ok: false, error: "该任务正在发布中，请等待流水线结束后再补录" };
  }
  const identity = (value) => {
    try {
      const url = new URL(value);
      return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
    } catch { return ""; }
  };
  const prepared = await withScheduleMutation(async () => {
    // 校验必须落在临界区内，避免"已写库、未加内存标记"窗口期被并发补录/解除。
    if (activePendingSubmissionIds.has(ledgerId)) {
      return { error: "该任务正在发布中，请等待流水线结束后再补录" };
    }
    const { publishLedger = [], __unwrittenReceipts__ = [], scheduledTasks = [] } = await chrome.storage.local.get(["publishLedger", "__unwrittenReceipts__", "scheduledTasks"]);
    const entries = [...publishLedger, ...__unwrittenReceipts__];
    const copies = entries.filter((item) => item && item.id === ledgerId);
    const entry = copies[0];
    if (!entry || copies.some((item) => item.mode !== "真实发布" || item.writeBackOk || (!item.submittedWithoutReceipt && !item.postUrl))) {
      return { error: "记录不存在或状态不允许人工补录" };
    }
    if (copies.some((item) => item.postUrl && identity(item.postUrl) !== identity(postUrl))) {
      return { error: "该记录已有不同链接，拒绝覆盖" };
    }
    if (entries.some((item) => item && item.id !== ledgerId && item.postUrl && identity(item.postUrl) === identity(postUrl))) {
      return { error: "该微博链接已归属于其他记录" };
    }
    if (!entry.docUrl || !entry.targetCell || entry.targetCell === "-") return { error: "记录缺少文档或回写单元格" };
    const savedUrl = copies.find((item) => item.postUrl)?.postUrl || postUrl;
    const scheduleId = String(entry.scheduleId || "").trim();
    const update = (item) => item && item.id === ledgerId ? { ...item, postUrl: savedUrl, submittedWithoutReceipt: false } : item;
    const nextScheduled = scheduleId
      ? scheduledTasks.map((item) => item && item.id === scheduleId ? { ...item, postUrl: savedUrl, submittedWithoutReceipt: false } : item)
      : scheduledTasks;
    await chrome.storage.local.set({ publishLedger: publishLedger.map(update), __unwrittenReceipts__: __unwrittenReceipts__.map(update), scheduledTasks: nextScheduled });
    return { entry: { ...entry, postUrl: savedUrl, scheduleId } };
  });
  if (prepared.error) return { ok: false, error: prepared.error };
  return handleRetryWriteBack({ ...prepared.entry, ledgerId, scheduleId: prepared.entry.scheduleId || "", strictLedgerId: true });
}

async function handleRetryWriteBack(payload = {}) {
  const docUrl = String(payload.docUrl || "").trim();
  const targetCell = String(payload.targetCell || "").trim();
  const targetSheetId = String(payload.targetSheetId || "").trim();
  const postUrl = String(payload.postUrl || "").trim();
  const scheduleId = String(payload.scheduleId || "").trim();
  const ledgerId = String(payload.ledgerId || "").trim();
  const docName = String(payload.docName || "云文档").trim();

  if (!docUrl || !docUrl.startsWith("http")) {
    return { ok: false, error: "缺少有效的云文档链接，无法补写" };
  }
  if (!targetCell || targetCell === "-") {
    return { ok: false, error: "缺少目标回写单元格坐标" };
  }
  if (!/^https?:\/\/(?:www\.)?(?:weibo\.com|m\.weibo\.cn|weibo\.cn|t\.cn)\/\S+$/i.test(postUrl)) {
    return { ok: false, error: "缺少有效的微博回执链接，已拒绝补写" };
  }

  let writeBackOk = false;
  let writeBackError = "";
  try {
    const docTab = await findOrCreateTab(docUrl.split("?")[0], docUrl, false);
    if (!docTab?.id) throw new Error("目标云文档未连接");
    await waitForTabLoaded(docTab.id, 15000, false).catch(() => {});

    let writeRes;
    if (isDingTalkDocUrl(docUrl)) {
      const stored = await chrome.storage.local.get(["scheduledTasks", "publishLedger", "__unwrittenReceipts__"]);
      const entry = [...(stored.scheduledTasks || []), ...(stored.publishLedger || []), ...(stored.__unwrittenReceipts__ || [])]
        .find((item) => item && ((scheduleId && item.id === scheduleId) || (ledgerId && item.id === ledgerId)) &&
          item.docUrl === docUrl && item.targetCell === targetCell && String(item.targetSheetId || "") === targetSheetId && item.postUrl === postUrl);
      const snapshot = entry?.writeSnapshot || (entry && { account: entry.account, content: entry.fullContent || entry.content });
      const dingTalkSignal = { aborted: false };
      writeRes = await Promise.race([
        writeDingTalkCellInTab(docTab.id, targetCell, postUrl, targetSheetId, { signal: dingTalkSignal, snapshot }),
        new Promise((_, reject) => setTimeout(() => {
          dingTalkSignal.aborted = true;
          reject(new Error("钉钉补写超时（45秒），请手动核对单元格"));
        }, 45000)),
      ]);
    } else {
      const { scheduledTasks = [], publishLedger = [], __unwrittenReceipts__ = [] } = await chrome.storage.local.get(["scheduledTasks", "publishLedger", "__unwrittenReceipts__"]);
      const entries = [...scheduledTasks, ...publishLedger, ...__unwrittenReceipts__];
      const saved = entries.find((entry) => entry &&
        ((scheduleId && entry.id === scheduleId) || (ledgerId && entry.id === ledgerId)) &&
        entry.docUrl === docUrl && entry.targetCell === targetCell &&
        String(entry.targetSheetId || "") === targetSheetId && entry.postUrl === postUrl);
      const docAwake = await holdBackgroundTabAwake(docTab.id);
      try {
        writeRes = await executeInTabDirect(docTab.id, directWriteCellToDoc,
          [targetCell, postUrl, targetSheetId, saved?.writeSnapshot], "MAIN", docUrl, false);
      } finally {
        if (docAwake) await releaseBackgroundTab(docTab.id);
      }
    }
    if (!writeRes?.ok) throw new Error(writeRes?.error || "回写未验证成功");
    writeBackOk = true;
    appendLog(`[${docName}] 单元格 ${targetCell} 补写成功: ${postUrl}`, "success");
  } catch (err) {
    writeBackError = err?.message || String(err);
    appendLog(`[${docName}] 单元格 ${targetCell} 补写失败: ${writeBackError}`, "error");
  }

  await withScheduleMutation(async () => {
    const {
      scheduledTasks = [],
      publishLedger = [],
      __unwrittenReceipts__ = [],
    } = await chrome.storage.local.get(["scheduledTasks", "publishLedger", "__unwrittenReceipts__"]);

    const matchesEntry = (entry) => {
      if (!entry) return false;
      const idHit = Boolean((scheduleId && entry.id === scheduleId) || (ledgerId && entry.id === ledgerId));
      const sameTarget = entry.postUrl === postUrl && entry.targetCell === targetCell && entry.docUrl === docUrl &&
        String(entry.targetSheetId || "") === targetSheetId;
      if (sameTarget) return (scheduleId || ledgerId) ? idHit : true;
      // 明确的记录/排程编号命中时，兼容旧记录缺少子表标识的情况。
      return idHit && entry.docUrl === docUrl && entry.targetCell === targetCell;
    };

    const nextScheduled = scheduledTasks.map((t) => (
      matchesEntry(t) ? { ...t, writeBackOk, writeBackError } : t
    ));
    const nextLedger = publishLedger.map((item) => (
      matchesEntry(item) ? { ...item, writeBackOk, writeBackError } : item
    ));
    const retainedEntry = __unwrittenReceipts__.find(matchesEntry);
    if (ledgerId && retainedEntry && !nextLedger.some((item) => item?.id === ledgerId)) {
      nextLedger.unshift({ ...retainedEntry, writeBackOk, writeBackError });
    }
    const nextUnwritten = writeBackOk
      ? __unwrittenReceipts__.filter((u) => payload.strictLedgerId
          ? !matchesEntry(u)
          : !(u && u.postUrl === postUrl && u.targetCell === targetCell &&
              u.docUrl === docUrl && String(u.targetSheetId || "") === targetSheetId))
      : __unwrittenReceipts__.map((item) => matchesEntry(item) ? { ...item, writeBackOk, writeBackError } : item);

    await chrome.storage.local.set({
      scheduledTasks: nextScheduled,
      publishLedger: nextLedger,
      __unwrittenReceipts__: nextUnwritten,
    });
  });

  chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
  chrome.runtime.sendMessage({ action: "LEDGER_UPDATED" }).catch(() => {});
  return writeBackOk ? { ok: true, targetCell } : { ok: false, error: writeBackError };
}

async function handleFetchPreviewImage(imageUrl, docUrl) {
  const cleanUrl = String(imageUrl || "").trim().replace(/&amp;/g, "&");
  if (!cleanUrl) return { dataUrl: "" };
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(cleanUrl)) {
    return { dataUrl: cleanUrl };
  }

  const direct = await fetchImageAsBase64(cleanUrl);
  if (direct && direct.dataUrl) {
    return { dataUrl: direct.dataUrl };
  }

  const cleanDocUrl = String(docUrl || "").trim();
  if (cleanDocUrl.startsWith("http")) {
    try {
      const targetUrl = new URL(cleanDocUrl);
      const targetHost = targetUrl.hostname.toLowerCase();
      const targetPath = targetUrl.pathname;
      const tabs = await chrome.tabs.query({});
      const matchedTab = tabs.find((tab) => {
        if (!tab.url || isProtectedBrowserUrl(tab.url)) return false;
        try {
          const parsed = new URL(tab.url);
          return parsed.hostname.toLowerCase() === targetHost && parsed.pathname === targetPath;
        } catch (_) {
          return false;
        }
      });
      if (matchedTab) {
        const items = await downloadImagesViaDocTab(matchedTab.id, cleanDocUrl, [cleanUrl]);
        if (items && items[0]?.dataUrl) {
          return { dataUrl: items[0].dataUrl };
        }
      }
    } catch (err) {
      console.warn("handleFetchPreviewImage doc tab fallback failed:", err);
    }
  }

  return { dataUrl: "" };
}

async function handleAddScheduleTasks(newTasks) {
  ensureScheduleHeartbeat();
  if (!Array.isArray(newTasks)) throw new Error("定时任务格式无效");
  const addedTasks = await withScheduleMutation(async () => {
    const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
    const ids = new Set(scheduledTasks.map((task) => task.id));
    const added = newTasks.map((task, index) => {
      if (!task || typeof task.content !== "string" || !task.content.trim()) throw new Error("定时任务正文不能为空");
      if (!Number.isFinite(task.fireAtTimestamp) || task.fireAtTimestamp <= 0) throw new Error("定时任务时间无效");
      const id = task.id || `sched_${Date.now()}_${index}_${Math.random().toString(36).substring(2, 8)}`;
      if (typeof id !== "string" || ids.has(id)) throw new Error("定时任务ID重复或无效");
      ids.add(id);
      return { ...task, id, status: "pending", error: "", postUrl: "", dryRun: task.dryRun !== false };
    });
    const merged = pruneExpiredDoneSchedules([...scheduledTasks, ...added]).tasks;
    // 保留全部 pending / firing / error 任务，仅当已完成 (done) 超过 300 条时按时间裁剪最老的历史记录
    const doneTasks = merged.filter((t) => t && t.status === "done");
    let finalTasks = merged;
    if (doneTasks.length > 300) {
      const keepDoneIds = new Set(
        doneTasks
          .slice()
          .sort((a, b) => Number(b.fireAtTimestamp || b.createdAt || 0) - Number(a.fireAtTimestamp || a.createdAt || 0))
          .slice(0, 300)
          .map((t) => t.id)
      );
      finalTasks = merged.filter((t) => !t || t.status !== "done" || keepDoneIds.has(t.id));
    }
    await chrome.storage.local.set({ scheduledTasks: finalTasks });
    for (const task of added) await armSchedule(task);
    return added;
  });
  chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
  if (addedTasks.some((task) => task.fireAtTimestamp <= Date.now())) {
    sweepAndRunDueSchedules().catch((error) => appendLog(`调度启动失败: ${error.message}`, "error"));
  }
  return { added: addedTasks.length };
}

async function armSchedule(task) {
  await chrome.alarms.clear(task.id);
  if (task.fireAtTimestamp <= Date.now()) return;
  await chrome.alarms.create(task.id, { when: task.fireAtTimestamp });
  const delayMs = task.fireAtTimestamp - Date.now();
  if (delayMs > 0 && delayMs <= 65000) {
    setTimeout(() => sweepAndRunDueSchedules().catch((error) =>
      appendLog(`短时排程唤醒失败: ${error.message}`, "error")), delayMs + 200);
  }
}

async function handleFireScheduleNow(taskId) {
  return handleBatchFireSchedule([taskId]);
}

async function handleCancelScheduleTask(taskId) {
  return handleBatchCancelSchedule([taskId]);
}

async function handleBatchCancelSchedule(taskIds) {
  if (!Array.isArray(taskIds) || !taskIds.length) return { canceled: 0 };
  const canceled = await withScheduleMutation(async () => {
    const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
    if (scheduledTasks.some((task) => taskIds.includes(task.id) && task.status === "firing")) {
      throw new Error("发布中的任务不能删除，请先停止并等待当前处理结束");
    }
    const remaining = scheduledTasks.filter((task) => !taskIds.includes(task.id));
    await chrome.storage.local.set({ scheduledTasks: remaining });
    for (const id of taskIds) await chrome.alarms.clear(id);
    return scheduledTasks.length - remaining.length;
  });
  chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
  return { canceled };
}

async function handleBatchFireSchedule(taskIds) {
  if (!Array.isArray(taskIds) || !taskIds.length) return { queued: 0 };
  await stateReady;
  if (state.isRunning || pipelineReservation) throw new Error("已有流水线正在执行中，请稍后再试");
  const reservation = {};
  pipelineReservation = reservation;
  try {
    const { dryRun: globalDryRun, silentMode } = await chrome.storage.local.get(["dryRun", "silentMode"]);
    const targets = await withScheduleMutation(async () => {
      const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
      const selected = scheduledTasks.filter((task) => taskIds.includes(task.id));
      if (!selected.length) throw new Error("未找到该定时任务");
      if (selected.some((task) => !["pending", "error"].includes(task.status))) {
        throw new Error("所选任务包含发布中或已完成项，不可重复发布");
      }
      const claimed = selected.map((task) => ({ ...task, status: "firing", firingAt: Date.now(), fromSchedule: true,
        dryRun: typeof globalDryRun === "boolean" ? globalDryRun : task.dryRun !== false }));
      await chrome.storage.local.set({ scheduledTasks: scheduledTasks.map((task) => claimed.find((item) => item.id === task.id) || task) });
      for (const task of claimed) await chrome.alarms.clear(task.id);
      return claimed;
    });
    chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
    const run = async () => {
      let error = "任务未完成，请核对运行日志";
      try {
        await startPipeline({ dryRun: globalDryRun !== false, useTaskDryRun: typeof globalDryRun !== "boolean",
          silentMode: silentMode !== false, selectedTasks: targets }, reservation);
      } catch (pipelineError) {
        error = pipelineError.message;
        appendLog(`立即发布异常: ${error}`, "error");
      } finally {
        try { await finalizeScheduledBatch(targets.map((task) => task.id), error); }
        finally { if (pipelineReservation === reservation) pipelineReservation = null; }
      }
    };
    run().catch((error) => console.error("保存排程执行结果失败:", error));
    return { queued: targets.length };
  } catch (error) {
    if (pipelineReservation === reservation) pipelineReservation = null;
    throw error;
  }
}

async function handleUpdateScheduleTask(taskId, updates) {
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) throw new Error("任务更新格式无效");
  const rescheduled = updates.fireAtTimestamp != null;
  if (rescheduled && (!Number.isFinite(updates.fireAtTimestamp) || updates.fireAtTimestamp <= 0)) throw new Error("定时任务时间无效");
  if ("account" in updates && typeof updates.account !== "string") throw new Error("账号格式无效");
  if ("content" in updates && (typeof updates.content !== "string" || !updates.content.trim())) throw new Error("正文不能为空");
  if ("dryRun" in updates && typeof updates.dryRun !== "boolean") throw new Error("演练模式参数无效");
  if (updates.poll && (!Array.isArray(updates.poll.options) || updates.poll.options.filter(Boolean).length < 2)) throw new Error("投票至少需要两个选项");
  const task = await withScheduleMutation(async () => {
    const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
    const current = scheduledTasks.find((item) => item.id === taskId);
    if (!current) throw new Error("未找到要修改的定时任务");
    if (current.status === "firing") throw new Error("任务正在发布中，不能编辑");
    if (current.status === "done") throw new Error("任务已完成，不能重新排程发布");
    const next = { ...current,
      ...("account" in updates ? { account: updates.account.trim() } : {}),
      ...("content" in updates ? { content: updates.content.trim() } : {}),
      ...("dryRun" in updates ? { dryRun: updates.dryRun } : {}),
      ...("poll" in updates ? { poll: updates.poll } : {}),
      ...(rescheduled ? { fireAtTimestamp: updates.fireAtTimestamp,
        fireAtTime: updates.fireAtTime || new Date(updates.fireAtTimestamp).toLocaleString(), status: "pending", error: "" } : {}) };
    await chrome.storage.local.set({ scheduledTasks: scheduledTasks.map((item) => item.id === taskId ? next : item) });
    if (rescheduled) {
      await releasePublishTaskLock(`sched::${taskId}`);
      await armSchedule(next);
    }
    return next;
  });
  chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
  if (rescheduled && task.fireAtTimestamp <= Date.now()) {
    sweepAndRunDueSchedules().catch((error) => appendLog(`调度启动失败: ${error.message}`, "error"));
  }
  return { ok: true, task };
}

async function handleClearAllSchedule() {
  await withScheduleMutation(async () => {
    const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
    if (scheduledTasks.some((task) => task.status === "firing")) throw new Error("存在发布中任务，请停止并等待处理结束后再清空");
    await chrome.storage.local.set({ scheduledTasks: [] });
    for (const task of scheduledTasks) await chrome.alarms.clear(task.id);
  });
  ensureScheduleHeartbeat();
  chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
  appendLog("已清空定时任务队列及对应闹钟", "warn");
}

async function handleClearDoneSchedule() {
  const result = await withScheduleMutation(async () => {
    const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
    let cleared = 0;
    let keptWriteBackFailed = 0;
    const remaining = [];
    for (const task of scheduledTasks) {
      if (task && task.status === "done") {
        const needsRetryWriteBack = task.submittedWithoutReceipt || (task.postUrl && !task.writeBackOk && task.dryRun === false && !task.preparedOnly
          && task.targetCell && task.targetCell !== "-" && task.docUrl);
        if (needsRetryWriteBack) {
          keptWriteBackFailed += 1;
          remaining.push(task);
        } else {
          cleared += 1;
        }
      } else {
        remaining.push(task);
      }
    }
    if (cleared > 0) {
      await chrome.storage.local.set({ scheduledTasks: remaining });
    }
    return { cleared, keptWriteBackFailed };
  });
  chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
  if (result.cleared > 0) {
    appendLog(`已清理 ${result.cleared} 条已完成定时记录${result.keptWriteBackFailed > 0 ? `（保留 ${result.keptWriteBackFailed} 条待补写文档记录）` : ""}`, "info");
  }
  return result;
}

async function handleBatchRescheduleTasks(taskIds, options = {}) {
  if (!Array.isArray(taskIds) || !taskIds.length) return { updated: 0 };
  const delayMinutes = options.delayMinutes != null ? Number(options.delayMinutes) : null;
  const fixedTs = options.fireAtTimestamp != null ? Number(options.fireAtTimestamp) : null;
  if (delayMinutes != null && (!Number.isFinite(delayMinutes) || delayMinutes <= 0)) {
    throw new Error("推迟分钟数必须为正数");
  }
  if (fixedTs != null && (!Number.isFinite(fixedTs) || fixedTs <= 0)) {
    throw new Error("指定触发时间无效");
  }
  if (delayMinutes == null && fixedTs == null) {
    throw new Error("缺少改期参数");
  }

  const updatedTasks = await withScheduleMutation(async () => {
    const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
    const selected = scheduledTasks.filter((t) => taskIds.includes(t.id));
    if (!selected.length) throw new Error("未找到要改期的定时任务");
    if (selected.some((t) => t.status === "firing")) {
      throw new Error("所选任务包含正在发布中的任务，无法改期");
    }
    const editable = selected.filter((t) => t.status === "pending" || t.status === "error");
    if (!editable.length) {
      throw new Error("所选任务均为已完成状态，无法改期");
    }

    const now = Date.now();
    const editableIds = new Set(editable.map((t) => t.id));
    const nextMap = new Map();
    const nextTasks = scheduledTasks.map((t) => {
      if (!editableIds.has(t.id)) return t;
      const baseTs = Math.max(now, Number(t.fireAtTimestamp || 0));
      const newTs = delayMinutes != null ? baseTs + delayMinutes * 60 * 1000 : fixedTs;
      const newTimeStr = options.fireAtTime || new Date(newTs).toLocaleString();
      const next = {
        ...t,
        fireAtTimestamp: newTs,
        fireAtTime: newTimeStr,
        status: "pending",
        error: "",
      };
      nextMap.set(t.id, next);
      return next;
    });

    // 认领锁必须与发布流程共用同一串行队列，避免与并发的 claim/release 互相覆盖。
    await withPublishClaim(async () => {
      const { __publishClaims__ = {} } = await chrome.storage.local.get(["__publishClaims__"]);
      const nextClaims = Object.fromEntries(
        Object.entries(__publishClaims__).filter(([key]) => !editableIds.has(key.replace(/^sched::/, "")))
      );
      await chrome.storage.local.set({ __publishClaims__: nextClaims });
    });
    await chrome.storage.local.set({ scheduledTasks: nextTasks });
    for (const next of nextMap.values()) {
      await armSchedule(next);
    }
    return Array.from(nextMap.values());
  });

  chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
  if (updatedTasks.some((t) => t.fireAtTimestamp <= Date.now())) {
    sweepAndRunDueSchedules().catch((error) => appendLog(`调度启动失败: ${error.message}`, "error"));
  }
  return { updated: updatedTasks.length };
}

async function handleSetDryRunMode(dryRun) {
  if (typeof dryRun !== "boolean") throw new Error("演练模式必须为布尔值");
  await withScheduleMutation(async () => {
    const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
    await chrome.storage.local.set({ dryRun, scheduledTasks: scheduledTasks.map((task) =>
      task.status === "pending" ? { ...task, dryRun } : task) });
  });
  chrome.runtime.sendMessage({ action: "SCHEDULE_UPDATED" }).catch(() => {});
}
