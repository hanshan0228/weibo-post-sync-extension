/**
 * hotsearch_writer.js - 微博热搜截图/通知识别 -> 腾讯文档自动写入引擎 (Chrome MV3)
 * 整合自 weibo-hotsearch-writer：支持视觉大模型识别（主模型 + 兜底模型）、
 * 纯文字热搜通知直解析、B列话题查重与截断标题智能择优、以及腾讯文档原生写入。
 */

const DEFAULT_HOTSEARCH_CONFIG = {
  docUrl: "https://docs.qq.com/sheet/DTkd5dHl0VHdIYk9y",
  sheetId: "lqs80s",
  businessDefault: false,
  timeoutMs: 25000,
  primary: {
    name: "Google Gemini 官方",
    apiBase: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "",
    model: "gemini-3.6-flash",
  },
  fallback: {
    enabled: true,
    name: "阿里云百炼 DashScope",
    apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "",
    model: "qwen3-vl-plus",
  },
};

const HOTSEARCH_PROMPT = `你是极其严谨的微博截图字符级 OCR 解析器。精准提取图片上真实字符，严禁语义脑补、纠错或扩写，只输出一个 JSON 对象（不要输出任何其他文字、不要代码围栏）。

图片分类：
(1) 手机端话题详情页（顶部搜索框、大标题、主持人、榜单角标）
(2) 主持人热搜通知（"亲爱的@新浪热点，您主持的#话题#已经成功登上微博热搜！..."）
(3) 微博数据中心/热搜看板页（顶部#话题#大标题，下方数据总览、主持人、话题分类、热搜记录卡片）

字段提取规则：
1. topic: 话题词（必须带 # 号）。
   - 第(1)类优先取【顶部搜索框】内带 # 号的文本为绝对基准；原图每一个字符是什么就原样输出，国家/机构单字简称（如"葡足协"）严禁擅自展开！若搜索框无内容再取大标题/博文话题。
   - 第(3)类看板页以页面上方带 # 号的完整大标题为准，字母汉字100%精准逐字输出。
2. board_type: 榜单类型。
   - 优先取"XX榜最高位置"中的垂直榜名（如"体育"、"文娱"、"科技"等）；
   - 次选"话题分类"（如"话题分类 社会"→"社会"）；
   - 第(1)类出现"社会TOP30"或"文娱榜第40位"等榜单角标时取榜名（如"社会"、"文娱"）。无则 null。注意"娱乐"与"文娱"原样保留。
3. host: 主持人账号名（"主持人：X"取 X，通知截图取"@"后的账号），无则 null。
4. list_type: "实时上升"标签→"实时"；"热搜"角标/热搜记录卡片→"热搜"；两者都有→"实时"；无则 null。
5. has_rising: 布尔，仅当图片中明确出现完整的"实时上升"榜单标签时为 true。导航栏的"实时"、"实时微博"及正文中普通的"实时"均不算；不得推测标签存在。
6. has_hotsearch: 布尔，是否出现"热搜"角标或热搜记录/榜位卡片。
7. notice: 布尔，是否为第(2)类主持人通知；若为通知，notice_topic 填通知内话题，notice_host 填主持人名。

无法识别的字段输出 null，绝对禁止编造。`;

const HOTSEARCH_BOARD_TYPE_KEYWORDS = [
  ["体育", "体育"],
  ["文娱", "文娱"],
  ["娱乐", "娱乐"],
  ["社会", "社会"],
  ["科技", "科技"],
  ["生活", "生活"],
  ["ACG", "ACG"],
];

const HOTSEARCH_NOTICE_PATTERNS = [
  /您主持的\s*[#＃]([^#＃\s]+)[#＃]\s*.*?(?:登上|进入|冲上|上).{0,6}热搜/,
  /[#＃]([^#＃\s]+)[#＃].{0,20}(?:登上|进入|冲上|上).{0,6}热搜/,
  /主持人身份将被收回|话题管理规范/,
];

const HOTSEARCH_MAX_HISTORY = 50;
let hotsearchWriteQueue = Promise.resolve();

class HotsearchSkipError extends Error {
  constructor(message) {
    super(message);
    this.name = "HotsearchSkipError";
    this.isSkip = true;
  }
}

function hotsearchLog(msg, level = "info") {
  const line = `[热搜写入] ${msg}`;
  if (typeof appendLog === "function") {
    appendLog(line, level);
  } else {
    console.log(line);
  }
}

function withHotsearchWriteLock(operation) {
  const result = hotsearchWriteQueue.then(operation);
  hotsearchWriteQueue = result.catch((err) => {
    console.warn("热搜写入队列异常:", err?.message || err);
  });
  return result;
}

function cloneDefaultHotsearchConfig() {
  return {
    ...DEFAULT_HOTSEARCH_CONFIG,
    primary: { ...DEFAULT_HOTSEARCH_CONFIG.primary },
    fallback: { ...DEFAULT_HOTSEARCH_CONFIG.fallback },
  };
}

function extractSheetIdFromUrl(docUrl) {
  const raw = String(docUrl || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return String(u.searchParams.get("tab") || "").trim();
  } catch (_) {
    const m = raw.match(/[?&]tab=([^&#]+)/i);
    return m ? decodeURIComponent(m[1]).trim() : "";
  }
}

function normalizeHotsearchConfig(raw = {}) {
  const def = cloneDefaultHotsearchConfig();
  const src = raw && typeof raw === "object" ? raw : {};
  const pSrc = src.primary && typeof src.primary === "object" ? src.primary : {};
  const fSrc = src.fallback && typeof src.fallback === "object" ? src.fallback : {};

  const docUrl = typeof src.docUrl === "string" && src.docUrl.trim() ? src.docUrl.trim() : def.docUrl;
  const sheetId = typeof src.sheetId === "string"
    ? src.sheetId.trim()
    : (extractSheetIdFromUrl(docUrl) || def.sheetId);

  const timeoutNum = Number(src.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutNum) && timeoutNum >= 5000 && timeoutNum <= 120000
    ? Math.round(timeoutNum)
    : def.timeoutMs;

  return {
    docUrl,
    sheetId,
    businessDefault: Boolean(src.businessDefault),
    timeoutMs,
    primary: {
      name: typeof pSrc.name === "string" ? pSrc.name.trim() : def.primary.name,
      apiBase: typeof pSrc.apiBase === "string" ? pSrc.apiBase.trim().replace(/\/+$/, "") : def.primary.apiBase,
      apiKey: typeof pSrc.apiKey === "string" ? pSrc.apiKey.trim() : def.primary.apiKey,
      model: typeof pSrc.model === "string" ? pSrc.model.trim() : def.primary.model,
    },
    fallback: {
      enabled: fSrc.enabled !== undefined ? Boolean(fSrc.enabled) : def.fallback.enabled,
      name: typeof fSrc.name === "string" ? fSrc.name.trim() : def.fallback.name,
      apiBase: typeof fSrc.apiBase === "string" ? fSrc.apiBase.trim().replace(/\/+$/, "") : def.fallback.apiBase,
      apiKey: typeof fSrc.apiKey === "string" ? fSrc.apiKey.trim() : def.fallback.apiKey,
      model: typeof fSrc.model === "string" ? fSrc.model.trim() : def.fallback.model,
    },
  };
}

async function getHotsearchConfig() {
  const { hotsearchConfig } = await chrome.storage.local.get(["hotsearchConfig"]);
  if (!hotsearchConfig || typeof hotsearchConfig !== "object") {
    return cloneDefaultHotsearchConfig();
  }
  return normalizeHotsearchConfig(hotsearchConfig);
}

async function saveHotsearchConfig(rawConfig) {
  const normalized = normalizeHotsearchConfig(rawConfig);
  await chrome.storage.local.set({ hotsearchConfig: normalized });
  return normalized;
}

async function resetHotsearchConfig() {
  const def = cloneDefaultHotsearchConfig();
  await chrome.storage.local.set({ hotsearchConfig: def });
  return def;
}

async function getHotsearchHistory() {
  const { hotsearchHistory = [] } = await chrome.storage.local.get(["hotsearchHistory"]);
  return Array.isArray(hotsearchHistory) ? hotsearchHistory : [];
}

async function appendHotsearchHistory(item) {
  return withHotsearchWriteLock(async () => {
    const history = await getHotsearchHistory();
    const next = [item, ...history.filter((h) => h && h.id !== item.id)].slice(0, HOTSEARCH_MAX_HISTORY);
    await chrome.storage.local.set({ hotsearchHistory: next });
    return next;
  });
}

async function clearHotsearchHistory() {
  await chrome.storage.local.set({ hotsearchHistory: [] });
  return [];
}

function formatHotsearchToday(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function normalizeHotsearchTopic(topic) {
  if (typeof topic !== "string" || !topic.trim()) {
    throw new HotsearchSkipError("话题词为空");
  }
  let t = topic.trim().replace(/\s+/g, "");
  if (!t.startsWith("#")) t = `#${t}`;
  if (!t.endsWith("#")) t = `${t}#`;
  return t;
}

function normalizeHotsearchHost(host) {
  return typeof host === "string" && host.trim() ? host.trim() : "";
}

function hasKnownBoardKeyword(boardType) {
  if (typeof boardType !== "string" || !boardType.trim()) return false;
  return HOTSEARCH_BOARD_TYPE_KEYWORDS.some(([kw]) => boardType.includes(kw));
}

function normalizeHotsearchBoardType(boardType) {
  if (typeof boardType !== "string" || !boardType.trim()) return "";
  const t = boardType.trim();
  for (const [kw, std] of HOTSEARCH_BOARD_TYPE_KEYWORDS) {
    if (t.includes(kw)) return std;
  }
  return t;
}

function normalizeHotsearchListType(raw) {
  if (raw && raw.has_rising) return "实时";
  if (raw && raw.has_hotsearch) return "热搜";
  if (raw && hasKnownBoardKeyword(raw.board_type)) return "热搜";
  throw new HotsearchSkipError("既无『实时上升』也无『热搜』标签，跳过");
}

function buildHotsearchRow(raw, options = {}) {
  if (!raw || typeof raw !== "object") {
    throw new HotsearchSkipError("识别结果为空");
  }
  const business = Boolean(options.business);
  const now = options.now ? new Date(options.now) : new Date();
  const topicType = business ? "商业" : "热点";
  const today = formatHotsearchToday(now);

  if (raw.notice) {
    const topic = normalizeHotsearchTopic(raw.notice_topic || raw.topic);
    const host = normalizeHotsearchHost(raw.notice_host || raw.host);
    return {
      row: [today, topic, host, "主榜", "", "", "", topicType, "热搜"],
      notice: true,
    };
  }

  const topic = normalizeHotsearchTopic(raw.topic);
  if (raw.has_rising && hasKnownBoardKeyword(raw.board_type)) {
    throw new HotsearchSkipError("识别结果冲突：同时出现实时上升和明确榜单，请核对图片后重试");
  }

  const boardType = raw.has_rising ? "" : normalizeHotsearchBoardType(raw.board_type);
  const listType = normalizeHotsearchListType(raw);

  return {
    row: [
      today,
      topic,
      normalizeHotsearchHost(raw.host),
      boardType,
      "",
      "",
      "",
      topicType,
      listType,
    ],
    notice: false,
  };
}

function parseHotsearchText(text, options = {}) {
  const cleaned = String(text || "").trim();
  if (!cleaned) {
    throw new HotsearchSkipError("文字为空");
  }
  const business = Boolean(options.business);
  const now = options.now ? new Date(options.now) : new Date();
  const topicType = business ? "商业" : "热点";
  const today = formatHotsearchToday(now);

  const isNotice = HOTSEARCH_NOTICE_PATTERNS.some((re) => re.test(cleaned));
  const topicMatch = cleaned.match(/[#＃]([^#＃\s]+)[#＃]/);
  const topic = topicMatch ? `#${topicMatch[1]}#` : null;

  if (isNotice) {
    if (!topic) {
      throw new HotsearchSkipError("通知文字中未找到 #话题#");
    }
    const hostMatch = cleaned.match(/@([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5·_]{0,19})/);
    const host = hostMatch ? hostMatch[1].trim() : "";
    return {
      row: [today, topic, host, "主榜", "", "", "", topicType, "热搜"],
      notice: true,
    };
  }

  if (topic) {
    return {
      row: [
        today,
        topic,
        "",
        "",
        "",
        "",
        "",
        topicType,
        cleaned.includes("实时上升") ? "实时" : "热搜",
      ],
      notice: false,
    };
  }

  throw new HotsearchSkipError("文字中未找到 #话题#，无法识别");
}

function extractJsonFromModelOutput(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("模型返回内容为空");

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const objMatch = candidate.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      throw new Error(`模型输出中未找到 JSON: ${raw.slice(0, 200)}`);
    }
    return JSON.parse(objMatch[0]);
  }
}

function cleanHotsearchStem(topic) {
  return String(topic || "")
    .trim()
    .replace(/^[#＃\s]+|[#＃\s]+$/g, "")
    .replace(/\s+/g, "");
}

function isTruncatedHotsearchStem(stem) {
  const m = String(stem || "").match(/^(.*?)(?:\.{2,}|…+)$/);
  if (m) {
    return { truncated: true, prefix: m[1].replace(/[.…\s]+$/g, "") };
  }
  return { truncated: false, prefix: String(stem || "") };
}

function findMatchingHotsearchTopicRow(rowsWithTopics, incomingTopic) {
  const topic = String(incomingTopic || "").trim();
  if (!topic || !Array.isArray(rowsWithTopics)) return null;

  for (const item of rowsWithTopics) {
    if (item && item.topic === topic) {
      return { row: item.row, matchedTopic: item.topic };
    }
  }

  const stem = cleanHotsearchStem(topic);
  if (!stem) return null;
  const incomingInfo = isTruncatedHotsearchStem(stem);

  for (const item of rowsWithTopics) {
    if (!item || !item.topic) continue;
    const cStem = cleanHotsearchStem(item.topic);
    if (!cStem) continue;
    if (cStem === stem) {
      return { row: item.row, matchedTopic: item.topic };
    }
    const cInfo = isTruncatedHotsearchStem(cStem);
    if (incomingInfo.truncated && incomingInfo.prefix.length >= 6) {
      const minLen = Math.min(incomingInfo.prefix.length, cInfo.prefix.length);
      if (
        cStem.startsWith(incomingInfo.prefix) ||
        (cInfo.truncated && cInfo.prefix.startsWith(incomingInfo.prefix.slice(0, minLen)))
      ) {
        return { row: item.row, matchedTopic: item.topic };
      }
    } else if (cInfo.truncated && cInfo.prefix.length >= 6) {
      if (stem.startsWith(cInfo.prefix)) {
        return { row: item.row, matchedTopic: item.topic };
      }
    }
  }
  return null;
}

async function callVisionEndpoint(endpoint, imageDataUrl, timeoutMs = 25000) {
  const apiBase = String(endpoint?.apiBase || "").trim().replace(/\/+$/, "");
  const apiKey = String(endpoint?.apiKey || "").trim();
  const model = String(endpoint?.model || "").trim();

  if (!apiBase) throw new Error("未配置视觉模型 API Base 地址");
  if (!apiKey) throw new Error(`未配置 ${endpoint?.name || "视觉模型"} API Key`);
  if (!model) throw new Error("未配置视觉模型名称");

  const url = `${apiBase}/chat/completions`;
  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: HOTSEARCH_PROMPT },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    temperature: 0,
  };

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 260)}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error(`接口返回非 JSON: ${text.slice(0, 200)}`);
    }
    const content = data?.choices?.[0]?.message?.content;
    const contentStr = Array.isArray(content)
      ? content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("\n")
      : String(content || "");
    if (!contentStr.trim()) {
      throw new Error("模型返回 content 为空");
    }
    return extractJsonFromModelOutput(contentStr);
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`模型请求超时 (${Math.round(timeoutMs / 1000)}s)`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function recognizeHotsearchImage(imageDataUrl, config) {
  const cfg = normalizeHotsearchConfig(config);
  const timeoutMs = cfg.timeoutMs || 25000;
  try {
    const raw = await callVisionEndpoint(cfg.primary, imageDataUrl, timeoutMs);
    return {
      raw,
      providerName: cfg.primary.name || "主模型",
      model: cfg.primary.model,
      usedFallback: false,
    };
  } catch (primaryErr) {
    const fb = cfg.fallback;
    if (!fb || !fb.enabled || !fb.apiBase || !fb.apiKey || !fb.model) {
      throw primaryErr;
    }
    hotsearchLog(`主模型 [${cfg.primary.model}] 识别失败 (${primaryErr.message})，自动切换兜底模型 [${fb.model}]`, "warn");
    try {
      const raw = await callVisionEndpoint(fb, imageDataUrl, timeoutMs);
      return {
        raw,
        providerName: fb.name || "兜底模型",
        model: fb.model,
        usedFallback: true,
        primaryError: primaryErr.message,
      };
    } catch (fbErr) {
      throw new Error(`主模型失败: ${primaryErr.message}；兜底模型失败: ${fbErr.message}`);
    }
  }
}

async function fetchHotsearchModels(endpoint) {
  const apiBase = String(endpoint?.apiBase || "").trim().replace(/\/+$/, "");
  const apiKey = String(endpoint?.apiKey || "").trim();
  if (!apiBase) throw new Error("请先填写 API 请求地址");
  if (!apiKey) throw new Error("请先填写 API Key");

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 12000) : null;
  try {
    const resp = await fetch(`${apiBase}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller ? controller.signal : undefined,
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error(data?.error?.message || `HTTP ${resp.status}`);
    }
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
    const ids = list
      .map((item) => String(item?.id || item?.name || "").replace(/^models\//, "").trim())
      .filter(Boolean);
    return Array.from(new Set(ids)).sort();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 注入到腾讯文档页面 MAIN world 的整行写入函数（自包含，不依赖外部闭包）。
 */
async function directWriteHotsearchRowToDoc(targetSheetId, rowData) {
  try {
    if (!Array.isArray(rowData) || rowData.length < 2) {
      return { ok: false, error: "待写入行数据格式无效" };
    }
    const normalizedRow = Array.from({ length: 9 }, (_, i) => String(rowData[i] ?? ""));

    const app = window.SpreadsheetApp;
    const wb = app && app.workbook;
    const tools = app && app.e2eTools;
    const list = (wb && wb.worksheetManager && wb.worksheetManager.sheetList) || [];

    if (!wb || !tools || !list.length) {
      return { ok: false, error: "腾讯文档运行时尚未就绪，请等待表格加载完成" };
    }

    let targetSheet = null;
    if (targetSheetId) {
      targetSheet = list.find((s) => s.getSheetId && s.getSheetId() === targetSheetId);
      if (!targetSheet) {
        return { ok: false, error: `未找到指定子表 [${targetSheetId}]，已阻断写入` };
      }
    } else {
      targetSheet = list.find((s) => s.getIsInitialized && s.getIsInitialized()) || list[0];
    }

    if (!targetSheet || !app.behaviorApi || !app.behaviorApi.cellApi) {
      return { ok: false, error: "腾讯文档编辑接口尚未就绪，请刷新表格后重试" };
    }

    const isReadOnly = Boolean(
      (typeof wb.isReadOnly === "function" && wb.isReadOnly()) ||
      (typeof wb.getIsReadOnly === "function" && wb.getIsReadOnly()) ||
      (typeof targetSheet.isReadOnly === "function" && targetSheet.isReadOnly()) ||
      wb.readOnly === true ||
      app.readOnly === true
    );
    if (isReadOnly) {
      return { ok: false, error: "当前腾讯文档处于只读/无编辑权限状态，已阻断写入" };
    }

    const sid = targetSheet.getSheetId();
    const sheetName = targetSheet.getSheetName ? targetSheet.getSheetName() : sid;
    const rowCount = typeof targetSheet.getRowCount === "function" ? targetSheet.getRowCount() : 5000;

    const readCellText = (r, c) => {
      const cell = targetSheet.getCellDataAtPosition(r, c);
      if (!cell) return "";
      try {
        return String(tools.getCellEditValue(wb, r, c, sid, cell) ?? "").trim();
      } catch (_) {
        return String(cell.formattedValue || cell.text || cell.m || "").trim();
      }
    };

    const isColValueMatched = (r, c, expected) => {
      const exp = String(expected || "").trim();
      const editVal = readCellText(r, c);
      if (editVal === exp) return true;
      const cell = targetSheet.getCellDataAtPosition(r, c);
      const dispVal = cell ? String(cell.formattedValue || cell.m || cell.text || "").trim() : "";
      if (dispVal === exp) return true;
      // 腾讯文档把 "11月20日" 自动解析为日期后，getCellEditValue 会返回 "2026/11/20"
      if (c === 0 && exp) {
        const md = exp.match(/^(\d{1,2})月(\d{1,2})日$/);
        if (md) {
          const m = Number(md[1]);
          const d = Number(md[2]);
          const dateRe = new RegExp(`^\\d{4}[/-]0?${m}[/-]0?${d}$`);
          if (dateRe.test(editVal) || dateRe.test(dispVal)) return true;
        }
      }
      return false;
    };

    const cleanStem = (topic) =>
      String(topic || "").trim().replace(/^[#＃\s]+|[#＃\s]+$/g, "").replace(/\s+/g, "");
    const isTruncated = (stem) => {
      const m = String(stem || "").match(/^(.*?)(?:\.{2,}|…+)$/);
      return m ? { truncated: true, prefix: m[1].replace(/[.…\s]+$/g, "") } : { truncated: false, prefix: String(stem || "") };
    };

    // 扫描 A 列和 B 列：记录话题查重映射与第一个空行
    const bColEntries = [];
    let firstEmptyRow0 = -1;
    let lastNonEmptyRow0 = -1;
    let consecutiveEmpty = 0;

    for (let r = 0; r < rowCount; r++) {
      const aVal = readCellText(r, 0);
      const bVal = readCellText(r, 1);
      if (aVal || bVal) {
        lastNonEmptyRow0 = r;
        consecutiveEmpty = 0;
        if (bVal && r > 0) {
          bColEntries.push({ row0: r, topic: bVal });
        }
      } else {
        if (r > 0 && firstEmptyRow0 === -1) {
          firstEmptyRow0 = r;
        }
        consecutiveEmpty += 1;
        // 若表尾已连续 60 行为空，停止扫描
        if (r > 20 && consecutiveEmpty >= 60) {
          break;
        }
      }
    }

    const incomingTopic = normalizedRow[1];
    const incomingStem = cleanStem(incomingTopic);
    const incomingInfo = isTruncated(incomingStem);

    let matched = null;
    for (const entry of bColEntries) {
      if (entry.topic === incomingTopic) {
        matched = entry;
        break;
      }
    }
    if (!matched && incomingStem) {
      for (const entry of bColEntries) {
        const cStem = cleanStem(entry.topic);
        if (!cStem) continue;
        if (cStem === incomingStem) {
          matched = entry;
          break;
        }
        const cInfo = isTruncated(cStem);
        if (incomingInfo.truncated && incomingInfo.prefix.length >= 6) {
          const minLen = Math.min(incomingInfo.prefix.length, cInfo.prefix.length);
          if (cStem.startsWith(incomingInfo.prefix) || (cInfo.truncated && cInfo.prefix.startsWith(incomingInfo.prefix.slice(0, minLen)))) {
            matched = entry;
            break;
          }
        } else if (cInfo.truncated && cInfo.prefix.length >= 6 && incomingStem.startsWith(cInfo.prefix)) {
          matched = entry;
          break;
        }
      }
    }

    let isUpdate = false;
    let targetRow0;
    let colsToWrite;

    if (matched) {
      isUpdate = true;
      targetRow0 = matched.row0;
      const cInfo = isTruncated(cleanStem(matched.topic));
      if (incomingInfo.truncated && !cInfo.truncated) {
        normalizedRow[1] = matched.topic;
      }
      // 更新已有行时仅覆盖业务字段 A,B,C,D,H,I，保留人工填写的 E/F/G 榜位与阅读量
      colsToWrite = [0, 1, 2, 3, 7, 8];
    } else {
      isUpdate = false;
      targetRow0 = firstEmptyRow0 !== -1 ? firstEmptyRow0 : lastNonEmptyRow0 + 1;
      colsToWrite = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    }

    // ── Tier 1: 通过 NameBox 定位到 A{row} 并触发 TSV 粘贴（100% 触发腾讯文档下拉选项胶囊与列样式） ──
    let pasteSkipReason = "";
    const tryTsvPaste = async () => {
      if (typeof document === "undefined" || typeof DataTransfer === "undefined" || typeof ClipboardEvent === "undefined") {
        pasteSkipReason = "no-dom";
        return false;
      }
      const nameBox =
        document.querySelector("#formula-name-box") ||
        document.querySelector(".formula-cell-position input") ||
        document.querySelector(".formula-cell-position") ||
        document.querySelector('input[class*="name-box"]') ||
        document.querySelector('input[class*="nameBox"]') ||
        document.querySelector('[class*="name-box"] input') ||
        document.querySelector('[class*="nameBox"] input');
      if (!nameBox) {
        pasteSkipReason = "no-namebox";
        return false;
      }

      const targetAddr = `A${targetRow0 + 1}`;
      try {
        nameBox.focus();
        if ("value" in nameBox) {
          nameBox.value = targetAddr;
          nameBox.dispatchEvent(new Event("input", { bubbles: true }));
          nameBox.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          nameBox.textContent = targetAddr;
        }
        nameBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        nameBox.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      } catch (_) {
        pasteSkipReason = "namebox-focus-err";
        return false;
      }

      await new Promise((r) => setTimeout(r, 180));
      const curAddr = String(("value" in nameBox ? nameBox.value : nameBox.textContent) || "").trim().toUpperCase();
      if (curAddr !== targetAddr) {
        pasteSkipReason = `namebox-mismatch:${curAddr}!=${targetAddr}`;
        return false;
      }

      // 若为更新已有行，保留原 E/F/G 列人工数据，避免 TSV 粘贴空串覆盖
      const tsvCells = normalizedRow.map((v, idx) => {
        if (isUpdate && idx >= 4 && idx <= 6) {
          return readCellText(targetRow0, idx);
        }
        return v;
      });
      const tsvText = tsvCells.join("\t");

      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", tsvText);
        const pasteEvt = new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        });
        const targetEl = document.activeElement || document.body || document;
        targetEl.dispatchEvent(pasteEvt);
      } catch (_) {
        pasteSkipReason = "paste-dispatch-err";
        return false;
      }

      const checkCols = [0, 1, 2, 3, 7, 8].filter((c) => normalizedRow[c]);
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 300 : 350));
        if (checkCols.every((c) => isColValueMatched(targetRow0, c, normalizedRow[c]))) {
          return true;
        }
      }
      pasteSkipReason = "paste-unverified";
      return false;
    };

    if (await tryTsvPaste()) {
      return {
        ok: true,
        row: targetRow0 + 1,
        isUpdate,
        topic: normalizedRow[1],
        sheetName,
        provider: "ClipboardPaste",
      };
    }

    // ── Tier 2: 逐列 setSingleValue 写入（下拉胶囊列 2,3,7,8 不写 richString，避免破坏选项渲染） ──
    const refRow0 = lastNonEmptyRow0 > 0 && lastNonEmptyRow0 !== targetRow0
      ? lastNonEmptyRow0
      : (targetRow0 > 1 ? targetRow0 - 1 : 1);

    const extractRPr = (r, c) => {
      try {
        const cell = targetSheet.getCellDataAtPosition(r, c);
        if (!cell) return null;
        const rs = (typeof cell.getRichString === "function" ? cell.getRichString() : null) || cell.richString || cell.richText;
        const rPr = rs && Array.isArray(rs.r) && rs.r[0] && rs.r[0].rPr ? rs.r[0].rPr : null;
        return rPr ? JSON.parse(JSON.stringify(rPr)) : null;
      } catch (_) {
        return null;
      }
    };

    const findDropdownExtendedValue = (cell, val) => {
      try {
        const dv = cell && cell.dataValidation;
        if (!dv || !val) return "";
        const visited = new Set();
        const search = (node, depth) => {
          if (!node || typeof node !== "object" || depth > 5 || visited.has(node)) return null;
          visited.add(node);
          if (Array.isArray(node)) {
            for (const item of node) {
              const found = search(item, depth + 1);
              if (found) return found;
            }
            return null;
          }
          const label = node.value ?? node.label ?? node.text ?? node.name ?? node.title;
          const id = node.id ?? node.optionId ?? node.key;
          if (String(label ?? "").trim() === val && id !== undefined && id !== null) {
            const fg = node.fontColor || node.textColor || node.color || "#FFFFFF";
            const bg = node.bgColor || node.backgroundColor || node.fillColor || node.background || "";
            if (bg) {
              return JSON.stringify([[String(id), val, String(fg), String(bg)]]);
            }
          }
          for (const k of Object.keys(node)) {
            const found = search(node[k], depth + 1);
            if (found) return found;
          }
          return null;
        };
        return search(dv, 0) || "";
      } catch (_) {
        return "";
      }
    };

    const buildCellPayload = (colIdx, val) => {
      const targetCell = targetSheet.getCellDataAtPosition(targetRow0, colIdx);
      const refCell = refRow0 !== targetRow0 ? targetSheet.getCellDataAtPosition(refRow0, colIdx) : null;
      const payload = {
        sheetId: sid,
        rowIndex: targetRow0,
        colIndex: colIdx,
        text: val,
        isTextChanged: true,
        userEnterValue: val,
        isChanged: true,
        selectedRangeSnapshot: [
          {
            sheetId: sid,
            startRowIndex: targetRow0,
            startColIndex: colIdx,
            endRowIndex: targetRow0,
            endColIndex: colIdx,
          },
        ],
        activePositionSnapshot: {
          sheetId: sid,
          rowIndex: targetRow0,
          colIndex: colIdx,
        },
      };
      // 若该列为腾讯文档下拉选项胶囊 (dvType=4)，匹配选项 ID 与配色写入 extendedValue
      const extVal = findDropdownExtendedValue(targetCell, val) || findDropdownExtendedValue(refCell, val);
      if (extVal) {
        payload.extendedValue = extVal;
        payload.isExtendedValueChanged = true;
      } else if (colIdx <= 1 && val) {
        // 仅对日期/话题词列 (0, 1) 继承 rPr；下拉选项列不注入 richString，防止覆盖下拉胶囊
        const rPr = extractRPr(targetRow0, colIdx) || (refRow0 !== targetRow0 ? extractRPr(refRow0, colIdx) : null);
        if (rPr) {
          payload.richString = {
            r: [{ rPr, t: val, type: 1 }],
          };
          payload.isRichStringChanged = true;
        }
      }
      return payload;
    };

    const writtenCols = [];
    for (const colIdx of colsToWrite) {
      const val = normalizedRow[colIdx];
      // 新行 E/F/G 空列跳过；其他列若当前值已完全一致则跳过重复写入
      if (!val && colIdx >= 4 && colIdx <= 6 && !isUpdate) continue;
      if (isColValueMatched(targetRow0, colIdx, val)) {
        if (val) writtenCols.push(colIdx);
        continue;
      }

      let cellWritten = false;
      for (let cellAttempt = 0; cellAttempt < 3; cellAttempt++) {
        const payload = buildCellPayload(colIdx, val);
        const writeRes = await app.behaviorApi.cellApi.setSingleValue(payload);
        if (writeRes === false || (writeRes && typeof writeRes === "object" && (writeRes.ok === false || writeRes.success === false))) {
          return { ok: false, error: `写入第 ${targetRow0 + 1} 行第 ${colIdx + 1} 列被拒绝: ${writeRes?.error || writeRes?.message || "请检查编辑权限"}` };
        }
        // 给腾讯文档编辑器事务队列留出落盘间隔，防止连续调用丢弃后续列
        await new Promise((r) => setTimeout(r, 90));
        if (isColValueMatched(targetRow0, colIdx, val)) {
          cellWritten = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 160));
      }
      if (!cellWritten && !isColValueMatched(targetRow0, colIdx, val)) {
        // 暂记待最终统一复核
      }
      if (val) writtenCols.push(colIdx);
    }

    // 核验整行关键字段全部落盘（A, B, C, D, H, I 中所有非空列）
    const checkCols = [0, 1, 2, 3, 7, 8].filter((c) => normalizedRow[c]);
    let missingCols = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 250 : 400));
      missingCols = checkCols.filter((c) => !isColValueMatched(targetRow0, c, normalizedRow[c]));
      if (missingCols.length === 0) {
        // 等待腾讯文档云端保存完成，防止最后一列 (I列 热搜) 尚未同步到服务端就被关闭后台标签页
        if (typeof document !== "undefined" && document.querySelector) {
          const saveWaitStart = Date.now();
          while (Date.now() - saveWaitStart < 4000) {
            const statusEl = document.querySelector('[class*="save-status"], [class*="sync-status"], [data-testid*="save-status"]');
            const statusText = String(statusEl?.textContent || "").trim();
            if (!statusText || !/正在保存|保存中|同步中/.test(statusText)) break;
            await new Promise((r) => setTimeout(r, 250));
          }
          await new Promise((r) => setTimeout(r, 1200));
        }
        const rolledBack = checkCols.filter((c) => !isColValueMatched(targetRow0, c, normalizedRow[c]));
        if (rolledBack.length === 0) {
          return {
            ok: true,
            row: targetRow0 + 1,
            isUpdate,
            topic: normalizedRow[1],
            sheetName,
            provider: "setSingleValue",
          };
        }
        missingCols = rolledBack;
        break;
      }
    }

    const colNames = ["A(日期)", "B(话题词)", "C(主持人)", "D(榜单类型)", "E", "F", "G", "H(话题类型)", "I(类型)"];
    const missingDesc = missingCols.map((c) => `${colNames[c]}期望"${normalizedRow[c]}"实际"${readCellText(targetRow0, c) || "空"}"`).join("；");
    return {
      ok: false,
      error: `第 ${targetRow0 + 1} 行部分列未写入成功: ${missingDesc}`,
    };
  } catch (err) {
    return { ok: false, error: `写入腾讯文档异常: ${err?.message || String(err)}` };
  }
}

const HOTSEARCH_RECENT_TTL_MS = 120 * 1000;
const recentHotsearchWrites = new Map();

let hotsearchBatchState = {
  isRunning: false,
  batchId: "",
  total: 0,
  completed: 0,
  written: 0,
  skipped: 0,
  error: 0,
  pendingItems: [],
};

function computeHotsearchFingerprint(str) {
  const s = String(str || "");
  let h = 2166136261;
  const step = s.length > 4096 ? Math.floor(s.length / 2048) : 1;
  for (let i = 0; i < s.length; i += step) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${s.length}_${(h >>> 0).toString(16)}`;
}

function getRecentHotsearchWrite(key) {
  const now = Date.now();
  for (const [k, v] of recentHotsearchWrites.entries()) {
    if (now - v.ts > HOTSEARCH_RECENT_TTL_MS) recentHotsearchWrites.delete(k);
  }
  const hit = recentHotsearchWrites.get(key);
  return hit && now - hit.ts <= HOTSEARCH_RECENT_TTL_MS ? hit.record : null;
}

function putRecentHotsearchWrite(key, record) {
  recentHotsearchWrites.set(key, { ts: Date.now(), record });
}

function getHotsearchBatchState() {
  return {
    ...hotsearchBatchState,
    pendingItems: [...hotsearchBatchState.pendingItems],
  };
}

function broadcastHotsearchProgress(record = null) {
  if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
    chrome.runtime.sendMessage({
      action: "HOTSEARCH_BATCH_PROGRESS",
      batchState: getHotsearchBatchState(),
      record,
    }).catch(() => {});
  }
}

async function testHotsearchEndpoint(endpoint) {
  const apiBase = String(endpoint?.apiBase || "").trim().replace(/\/+$/, "");
  const apiKey = String(endpoint?.apiKey || "").trim();
  const model = String(endpoint?.model || "").trim();
  if (!apiBase) throw new Error("请先填写 API 请求地址");
  if (!apiKey) throw new Error("请先填写 API Key");
  if (!model) throw new Error("请先填写模型名称");

  const startedAt = Date.now();
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 10000) : null;
  try {
    const resp = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
        temperature: 0,
      }),
      signal: controller ? controller.signal : undefined,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 180)}`);
    }
    return {
      ok: true,
      model,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("连接超时 (10s)");
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeHotsearchRowToDoc(docUrl, sheetId, rowData) {
  const cleanUrl = String(docUrl || "").trim();
  if (!cleanUrl.startsWith("http")) {
    throw new Error("请先配置有效的腾讯文档链接");
  }
  const effectiveSheetId = String(sheetId || "").trim() || extractSheetIdFromUrl(cleanUrl);

  let tempTabId = null;
  let docTab = null;
  let wasCreated = false;

  try {
    docTab = await findOrCreateTab(cleanUrl.split("?")[0], cleanUrl, false, () => {
      wasCreated = true;
    });
    if (wasCreated) {
      tempTabId = docTab.id;
      await waitForTabLoaded(docTab.id, 15000, true);
      await new Promise((r) => setTimeout(r, 450));
    } else {
      await waitForTabLoaded(docTab.id, 10000);
      await new Promise((r) => setTimeout(r, 150));
    }

    const awake = await holdBackgroundTabAwake(docTab.id);
    try {
      let writeRes = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        writeRes = await executeInTabDirect(
          docTab.id,
          directWriteHotsearchRowToDoc,
          [effectiveSheetId, rowData],
          "MAIN",
          cleanUrl,
          false
        );
        const errText = String(writeRes?.error || "");
        if (writeRes?.ok || (!errText.includes("尚未就绪") && !errText.includes("未找到指定子表"))) {
          break;
        }
        if (attempt < 11) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      if (!writeRes?.ok) {
        throw new Error(writeRes?.error || "写入腾讯文档失败");
      }
      return writeRes;
    } finally {
      if (awake) await releaseBackgroundTab(docTab.id);
    }
  } finally {
    if (tempTabId) {
      await chrome.tabs.remove(tempTabId).catch(() => {});
    }
  }
}

async function processHotsearchImageTask(payload = {}) {
  const { id, fileName = "截图.png", imageDataUrl, previewDataUrl = "", business, autoWrite = true } = payload;
  if (!imageDataUrl) {
    throw new Error("缺少图片数据");
  }
  const cfg = await getHotsearchConfig();
  const useBusiness = business !== undefined ? Boolean(business) : cfg.businessDefault;
  const startedAt = Date.now();
  const itemId = id || `hs_${startedAt}_${Math.random().toString(36).slice(2, 7)}`;

  const cacheKey = `img:${computeHotsearchFingerprint(imageDataUrl)}:biz=${useBusiness}:doc=${cfg.docUrl}:${cfg.sheetId}`;
  if (autoWrite) {
    const cached = getRecentHotsearchWrite(cacheKey);
    if (cached) {
      const dupRecord = { ...cached, id: itemId, duplicate: true, createdAt: Date.now(), elapsedMs: 0 };
      await appendHotsearchHistory(dupRecord);
      hotsearchLog(`${fileName} 120s内重复提交，已复用第 ${dupRecord.rowNum} 行结果`, "info");
      return { ok: true, duplicate: true, record: dupRecord };
    }
  }

  try {
    const rec = await recognizeHotsearchImage(imageDataUrl, cfg);
    const { row, notice } = buildHotsearchRow(rec.raw, { business: useBusiness });

    if (!autoWrite) {
      const reviewRecord = {
        id: itemId,
        kind: "image",
        fileName,
        previewDataUrl: previewDataUrl || "",
        status: "review",
        rowNum: null,
        isUpdate: false,
        sheetName: cfg.sheetId || "",
        row,
        topic: row[1],
        host: row[2],
        boardType: row[3],
        topicType: row[7],
        listType: row[8],
        notice,
        providerName: rec.providerName,
        model: rec.model,
        usedFallback: rec.usedFallback,
        elapsedMs: Date.now() - startedAt,
        createdAt: Date.now(),
        error: "",
      };
      await appendHotsearchHistory(reviewRecord);
      return { ok: true, review: true, record: reviewRecord };
    }

    const writeRes = await withHotsearchWriteLock(() =>
      writeHotsearchRowToDoc(cfg.docUrl, cfg.sheetId, row)
    );

    const record = {
      id: itemId,
      kind: "image",
      fileName,
      previewDataUrl: previewDataUrl || "",
      status: writeRes.isUpdate ? "updated" : "written",
      rowNum: writeRes.row,
      isUpdate: Boolean(writeRes.isUpdate),
      sheetName: writeRes.sheetName || cfg.sheetId || "",
      row,
      topic: row[1],
      host: row[2],
      boardType: row[3],
      topicType: row[7],
      listType: row[8],
      notice,
      providerName: rec.providerName,
      model: rec.model,
      usedFallback: rec.usedFallback,
      elapsedMs: Date.now() - startedAt,
      createdAt: Date.now(),
      error: "",
    };
    putRecentHotsearchWrite(cacheKey, record);
    await appendHotsearchHistory(record);
    hotsearchLog(
      `${writeRes.isUpdate ? "更新" : "新增"}第 ${writeRes.row} 行: ${row[1]} (${row[7]}/${row[8]}) [${rec.model}]`,
      "success"
    );
    return { ok: true, record };
  } catch (err) {
    const isSkip = Boolean(err?.isSkip || err?.name === "HotsearchSkipError");
    const record = {
      id: itemId,
      kind: "image",
      fileName,
      previewDataUrl: previewDataUrl || "",
      status: isSkip ? "skipped" : "error",
      rowNum: null,
      isUpdate: false,
      row: null,
      topic: "",
      elapsedMs: Date.now() - startedAt,
      createdAt: Date.now(),
      error: err?.message || String(err),
    };
    await appendHotsearchHistory(record);
    hotsearchLog(`${fileName} ${isSkip ? "已跳过" : "处理失败"}: ${record.error}`, isSkip ? "info" : "error");
    return { ok: isSkip, skipped: isSkip, record, error: record.error };
  }
}

async function writeHotsearchPreparedRowTask(payload = {}) {
  const { id, row, fileName = "人工确认", previewDataUrl = "", model = "", providerName = "", usedFallback = false } = payload;
  if (!Array.isArray(row) || row.length < 2) {
    throw new Error("缺少待写入行数据");
  }
  const cfg = await getHotsearchConfig();
  const startedAt = Date.now();
  const itemId = id || `hs_${startedAt}_${Math.random().toString(36).slice(2, 7)}`;
  const normalized = Array.from({ length: 9 }, (_, i) => String(row[i] ?? "").trim());
  normalized[1] = normalizeHotsearchTopic(normalized[1]);

  const writeRes = await withHotsearchWriteLock(() =>
    writeHotsearchRowToDoc(cfg.docUrl, cfg.sheetId, normalized)
  );
  const record = {
    id: itemId,
    kind: "image",
    fileName,
    previewDataUrl,
    status: writeRes.isUpdate ? "updated" : "written",
    rowNum: writeRes.row,
    isUpdate: Boolean(writeRes.isUpdate),
    sheetName: writeRes.sheetName || cfg.sheetId || "",
    row: normalized,
    topic: normalized[1],
    host: normalized[2],
    boardType: normalized[3],
    topicType: normalized[7] || "热点",
    listType: normalized[8] || "热搜",
    providerName,
    model,
    usedFallback,
    elapsedMs: Date.now() - startedAt,
    createdAt: Date.now(),
    error: "",
  };
  await appendHotsearchHistory(record);
  hotsearchLog(`确认写入第 ${writeRes.row} 行: ${normalized[1]} (${normalized[7]}/${normalized[8]})`, "success");
  return { ok: true, record };
}

async function processHotsearchTextTask(payload = {}) {
  const { id, text = "", business } = payload;
  const cfg = await getHotsearchConfig();
  const useBusiness = business !== undefined ? Boolean(business) : cfg.businessDefault;
  const startedAt = Date.now();
  const itemId = id || `hs_txt_${startedAt}_${Math.random().toString(36).slice(2, 7)}`;

  const cacheKey = `txt:${computeHotsearchFingerprint(text.trim())}:biz=${useBusiness}:doc=${cfg.docUrl}:${cfg.sheetId}`;
  const cached = getRecentHotsearchWrite(cacheKey);
  if (cached) {
    const dupRecord = { ...cached, id: itemId, duplicate: true, createdAt: Date.now(), elapsedMs: 0 };
    await appendHotsearchHistory(dupRecord);
    hotsearchLog(`文字通知 120s 内重复提交，已复用第 ${dupRecord.rowNum} 行结果`, "info");
    return { ok: true, duplicate: true, record: dupRecord };
  }

  try {
    const { row, notice } = parseHotsearchText(text, { business: useBusiness });
    const writeRes = await withHotsearchWriteLock(() =>
      writeHotsearchRowToDoc(cfg.docUrl, cfg.sheetId, row)
    );
    const record = {
      id: itemId,
      kind: "text",
      fileName: text.trim().slice(0, 40),
      sourceText: text.trim(),
      status: writeRes.isUpdate ? "updated" : "written",
      rowNum: writeRes.row,
      isUpdate: Boolean(writeRes.isUpdate),
      sheetName: writeRes.sheetName || cfg.sheetId || "",
      row,
      topic: row[1],
      host: row[2],
      boardType: row[3],
      topicType: row[7],
      listType: row[8],
      notice,
      providerName: "规则直解析",
      model: "本地正则",
      usedFallback: false,
      elapsedMs: Date.now() - startedAt,
      createdAt: Date.now(),
      error: "",
    };
    putRecentHotsearchWrite(cacheKey, record);
    await appendHotsearchHistory(record);
    hotsearchLog(
      `文字直解析${writeRes.isUpdate ? "更新" : "新增"}第 ${writeRes.row} 行: ${row[1]} (${row[7]}/${row[8]})`,
      "success"
    );
    return { ok: true, record };
  } catch (err) {
    const isSkip = Boolean(err?.isSkip || err?.name === "HotsearchSkipError");
    const record = {
      id: itemId,
      kind: "text",
      fileName: text.trim().slice(0, 40) || "纯文字",
      sourceText: text.trim(),
      status: isSkip ? "skipped" : "error",
      rowNum: null,
      isUpdate: false,
      row: null,
      topic: "",
      elapsedMs: Date.now() - startedAt,
      createdAt: Date.now(),
      error: err?.message || String(err),
    };
    await appendHotsearchHistory(record);
    hotsearchLog(`文字解析${isSkip ? "已跳过" : "失败"}: ${record.error}`, isSkip ? "info" : "error");
    return { ok: isSkip, skipped: isSkip, record, error: record.error };
  }
}

async function processHotsearchBatchTask(payload = {}) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const text = String(payload.text || "").trim();
  const business = Boolean(payload.business);
  const autoWrite = payload.autoWrite !== undefined ? Boolean(payload.autoWrite) : true;

  const total = items.length + (text ? 1 : 0);
  if (total === 0) {
    return { ok: false, error: "没有可处理的图片或文字" };
  }

  const batchId = `hs_batch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  hotsearchBatchState = {
    isRunning: true,
    batchId,
    total,
    completed: 0,
    written: 0,
    skipped: 0,
    error: 0,
    pendingItems: items.map((it) => ({
      id: it.id,
      kind: "image",
      fileName: it.fileName || "截图.jpg",
      previewDataUrl: it.previewDataUrl || "",
      status: "pending",
      topic: it.fileName || "识别中...",
      createdAt: Date.now(),
    })),
  };
  broadcastHotsearchProgress();

  // 后台异步执行整批任务，弹窗关闭也不会中断
  (async () => {
    const markDone = (itemId, resRecord) => {
      hotsearchBatchState.completed += 1;
      hotsearchBatchState.pendingItems = hotsearchBatchState.pendingItems.filter((p) => p.id !== itemId);
      const st = resRecord?.status;
      if (st === "written" || st === "updated" || st === "review") hotsearchBatchState.written += 1;
      else if (st === "skipped") hotsearchBatchState.skipped += 1;
      else hotsearchBatchState.error += 1;
      broadcastHotsearchProgress(resRecord || null);
    };

    const jobs = [];
    if (items.length) {
      const concurrency = Math.min(3, items.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < items.length) {
          const cur = items[cursor++];
          try {
            const res = await processHotsearchImageTask({ ...cur, business, autoWrite });
            markDone(cur.id, res?.record);
          } catch (err) {
            markDone(cur.id, {
              id: cur.id,
              kind: "image",
              fileName: cur.fileName,
              status: "error",
              error: err?.message || String(err),
              createdAt: Date.now(),
            });
          }
        }
      };
      jobs.push(...Array.from({ length: concurrency }, () => worker()));
    }
    if (text) {
      const txtId = `hs_txt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      jobs.push(
        processHotsearchTextTask({ id: txtId, text, business })
          .then((res) => markDone(txtId, res?.record))
          .catch((err) => markDone(txtId, { id: txtId, kind: "text", status: "error", error: err?.message || String(err) }))
      );
    }

    await Promise.all(jobs);
    hotsearchBatchState.isRunning = false;
    broadcastHotsearchProgress();
  })();

  return { ok: true, batchId, total };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_HOTSEARCH_CONFIG,
    HOTSEARCH_PROMPT,
    HotsearchSkipError,
    normalizeHotsearchConfig,
    extractSheetIdFromUrl,
    formatHotsearchToday,
    normalizeHotsearchTopic,
    normalizeHotsearchBoardType,
    normalizeHotsearchListType,
    buildHotsearchRow,
    parseHotsearchText,
    extractJsonFromModelOutput,
    cleanHotsearchStem,
    isTruncatedHotsearchStem,
    findMatchingHotsearchTopicRow,
    callVisionEndpoint,
    recognizeHotsearchImage,
    fetchHotsearchModels,
    testHotsearchEndpoint,
    computeHotsearchFingerprint,
    directWriteHotsearchRowToDoc,
  };
}
