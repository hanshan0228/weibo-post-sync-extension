const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function setupGlobals(fetchImpl) {
  global.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
  };
  if (fetchImpl) {
    global.fetch = fetchImpl;
  }
}

setupGlobals();

const hw = require(path.join(__dirname, "..", "background", "hotsearch_writer.js"));

test("默认配置预填用户的 Gemini 主模型、阿里云百炼兜底模型与目标腾讯文档", () => {
  const cfg = hw.normalizeHotsearchConfig();
  assert.equal(cfg.primary.name, "Google Gemini 官方");
  assert.equal(cfg.primary.model, "gemini-3.6-flash");
  assert.equal(cfg.primary.apiKey, "");
  assert.equal(cfg.fallback.enabled, true);
  assert.equal(cfg.fallback.model, "qwen3-vl-plus");
  assert.equal(cfg.docUrl, "https://docs.qq.com/sheet/DTkd5dHl0VHdIYk9y");
  assert.equal(cfg.sheetId, "lqs80s");
});

test("支持自定义模型与表格配置覆盖默认值", () => {
  const cfg = hw.normalizeHotsearchConfig({
    docUrl: "https://docs.qq.com/sheet/CUSTOM123?tab=xyz999",
    sheetId: "xyz999",
    primary: {
      name: "自定义中转",
      apiBase: "https://example.com/v1/",
      apiKey: "sk-custom-123",
      model: "gpt-4o",
    },
    fallback: {
      enabled: false,
      name: "备用",
      apiBase: "",
      apiKey: "",
      model: "",
    },
  });
  assert.equal(cfg.primary.apiBase, "https://example.com/v1");
  assert.equal(cfg.primary.apiKey, "sk-custom-123");
  assert.equal(cfg.primary.model, "gpt-4o");
  assert.equal(cfg.fallback.enabled, false);
  assert.equal(cfg.sheetId, "xyz999");
});

test("buildHotsearchRow 规则层正确映射实时上升、垂直榜单与主持人通知", () => {
  const fixedDate = new Date("2026-11-20T12:00:00+08:00");

  const rising = hw.buildHotsearchRow(
    { topic: "测试话题", host: "新浪热点", board_type: null, has_rising: true, has_hotsearch: false },
    { business: false, now: fixedDate }
  );
  assert.deepEqual(rising.row, ["11月20日", "#测试话题#", "新浪热点", "", "", "", "", "热点", "实时"]);

  const board = hw.buildHotsearchRow(
    { topic: "#电影首映#", host: "", board_type: "文娱TOP30", has_rising: false, has_hotsearch: true },
    { business: true, now: fixedDate }
  );
  assert.deepEqual(board.row, ["11月20日", "#电影首映#", "", "文娱", "", "", "", "商业", "热搜"]);

  const notice = hw.buildHotsearchRow(
    { notice: true, notice_topic: "#通知话题#", notice_host: "新浪新闻" },
    { business: false, now: fixedDate }
  );
  assert.deepEqual(notice.row, ["11月20日", "#通知话题#", "新浪新闻", "主榜", "", "", "", "热点", "热搜"]);

  assert.throws(
    () => hw.buildHotsearchRow({ topic: "#冲突#", board_type: "体育", has_rising: true, has_hotsearch: false }),
    /冲突/
  );
  assert.throws(
    () => hw.buildHotsearchRow({ topic: "#无标签#", board_type: null, has_rising: false, has_hotsearch: false }),
    /跳过/
  );
});

test("parseHotsearchText 正确解析主持人通知与普通话题文本", () => {
  const fixedDate = new Date("2026-11-20T12:00:00+08:00");
  const res = hw.parseHotsearchText(
    "亲爱的@新浪热点，您主持的#周末好去处#已经成功登上微博热搜！",
    { business: false, now: fixedDate }
  );
  assert.deepEqual(res.row, ["11月20日", "#周末好去处#", "新浪热点", "主榜", "", "", "", "热点", "热搜"]);

  const res2 = hw.parseHotsearchText("#城市漫步# 实时上升", { business: true, now: fixedDate });
  assert.deepEqual(res2.row, ["11月20日", "#城市漫步#", "", "", "", "", "", "商业", "实时"]);
});

test("recognizeHotsearchImage 主模型失败时自动切换兜底模型", async () => {
  const calls = [];
  setupGlobals(async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, model: body.model });
    if (body.model === "gemini-3.6-flash") {
      return { ok: false, status: 503, text: async () => "upstream unavailable" };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: '```json\n{"topic":"#兜底成功#","board_type":"社会","host":"新浪热点","has_rising":false,"has_hotsearch":true,"notice":false}\n```',
              },
            },
          ],
        }),
    };
  });

  const result = await hw.recognizeHotsearchImage("data:image/jpeg;base64,AAAA", {
    primary: {
      name: "Google Gemini 官方",
      apiBase: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "mock-primary-key",
      model: "gemini-3.6-flash",
    },
    fallback: {
      enabled: true,
      name: "阿里云百炼 DashScope",
      apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "mock-fallback-key",
      model: "qwen3-vl-plus",
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "gemini-3.6-flash");
  assert.equal(calls[1].model, "qwen3-vl-plus");
  assert.equal(result.usedFallback, true);
  assert.equal(result.raw.topic, "#兜底成功#");
});

test("directWriteHotsearchRowToDoc 支持新增空行、同话题更新及只读保护", async () => {
  const cells = new Map([
    ["0:0", "日期"],
    ["0:1", "话题词"],
    ["1:0", "11月19日"],
    ["1:1", "#这是一个很长的完整话题截断测试...#"],
    ["1:4", "第3名"],
  ]);

  const refStyle = { sz: 11, ff: "微软雅黑" };
  const richPayloads = [];
  let dropCol7Once = true;

  const mockSheet = {
    getSheetId: () => "lqs80s",
    getSheetName: () => "2026",
    getRowCount: () => 20,
    getIsInitialized: () => true,
    isReadOnly: () => false,
    getCellDataAtPosition: (r, c) => {
      const v = cells.get(`${r}:${c}`);
      if (v === undefined) return null;
      return r === 1 && c === 1 ? { text: v, richString: { r: [{ rPr: refStyle, t: v, type: 1 }] } } : { text: v };
    },
  };

  global.window = {
    SpreadsheetApp: {
      workbook: {
        isReadOnly: () => false,
        worksheetManager: { sheetList: [mockSheet] },
      },
      e2eTools: {
        getCellEditValue: (_wb, _r, _c, _sid, cell) => (cell ? cell.text : ""),
      },
      behaviorApi: {
        cellApi: {
          setSingleValue: async (payload) => {
            richPayloads.push(payload);
            if (payload.rowIndex === 2 && payload.colIndex === 7 && dropCol7Once) {
              dropCol7Once = false;
              return { ok: true };
            }
            cells.set(`${payload.rowIndex}:${payload.colIndex}`, payload.text);
            return { ok: true };
          },
        },
      },
    },
  };

  // 1. 新增行写入第 3 行（索引 2）：第 8 列首次丢弃应自动重试成功；B列继承 rPr，下拉列不注入 richString
  const addRes = await hw.directWriteHotsearchRowToDoc("lqs80s", [
    "11月20日", "#全新热搜#", "新浪热点", "社会", "", "", "", "商业", "热搜",
  ]);
  assert.equal(addRes.ok, true);
  assert.equal(addRes.isUpdate, false);
  assert.equal(addRes.row, 3);
  assert.equal(cells.get("2:1"), "#全新热搜#");
  assert.equal(cells.get("2:7"), "商业");
  assert.equal(cells.get("2:8"), "热搜");
  const col1Payload = richPayloads.find((p) => p.rowIndex === 2 && p.colIndex === 1);
  const col7Payload = richPayloads.find((p) => p.rowIndex === 2 && p.colIndex === 7);
  assert.deepEqual(col1Payload.richString.r[0].rPr, refStyle);
  assert.equal(col7Payload.richString, undefined);

  // 2. 截断话题被完整话题更新到第 2 行（索引 1），并保留第 5 列（E列）人工数据
  const updRes = await hw.directWriteHotsearchRowToDoc("lqs80s", [
    "11月20日", "#这是一个很长的完整话题截断测试完整版#", "新浪热点", "文娱", "", "", "", "热点", "热搜",
  ]);
  assert.equal(updRes.ok, true);
  assert.equal(updRes.isUpdate, true);
  assert.equal(updRes.row, 2);
  assert.equal(cells.get("1:1"), "#这是一个很长的完整话题截断测试完整版#");
  assert.equal(cells.get("1:4"), "第3名");

  // 3. 只读状态阻断写入
  mockSheet.isReadOnly = () => true;
  const roRes = await hw.directWriteHotsearchRowToDoc("lqs80s", [
    "11月20日", "#只读测试#", "", "", "", "", "", "热点", "热搜",
  ]);
  assert.equal(roRes.ok, false);
  assert.match(roRes.error, /只读/);

  delete global.window;
});
