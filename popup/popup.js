/**
 * popup.js - 微博与云文档多卡槽同步与定时调度控制器
 * 支持多文档卡槽联动扫描、各表独立子表解析、精准分表回写、独立大屏模式与定时队列
 */

document.addEventListener("DOMContentLoaded", async () => {
  // ── 1. 独立大屏模式绑定 ──
  const btnOpenInTab = document.getElementById("btnOpenInTab");
  if (btnOpenInTab) {
    btnOpenInTab.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html") });
    });
  }

  // ── 2. 多 Tab 导航切换 ──
  const tabNavSync = document.getElementById("tabNavSync");
  const tabNavSchedule = document.getElementById("tabNavSchedule");
  const tabNavParser = document.getElementById("tabNavParser");
  const tabNavLedger = document.getElementById("tabNavLedger");
  const tabNavSettings = document.getElementById("tabNavSettings");

  const panelSync = document.getElementById("panelSync");
  const panelSchedule = document.getElementById("panelSchedule");
  const panelParser = document.getElementById("panelParser");
  const panelLedger = document.getElementById("panelLedger");
  const panelSettings = document.getElementById("panelSettings");
  const schedBadge = document.getElementById("schedBadge");

  const switchTab = (tabName) => {
    [tabNavSync, tabNavSchedule, tabNavParser, tabNavLedger, tabNavSettings].forEach((btn) => btn?.classList.remove("active"));
    [panelSync, panelSchedule, panelParser, panelLedger, panelSettings].forEach((p) => { if (p) p.style.display = "none"; });

    if (tabName === "sync") {
      tabNavSync?.classList.add("active");
      if (panelSync) panelSync.style.display = "block";
    } else if (tabName === "schedule") {
      tabNavSchedule?.classList.add("active");
      if (panelSchedule) panelSchedule.style.display = "block";
      refreshScheduleQueue();
    } else if (tabName === "parser") {
      tabNavParser?.classList.add("active");
      if (panelParser) panelParser.style.display = "block";
    } else if (tabName === "ledger") {
      tabNavLedger?.classList.add("active");
      if (panelLedger) panelLedger.style.display = "block";
      renderLedgerList();
    } else if (tabName === "settings") {
      tabNavSettings?.classList.add("active");
      if (panelSettings) panelSettings.style.display = "block";
      renderAliasList();
      updateSchedulePauseUI();
    }
  };

  tabNavSync?.addEventListener("click", () => switchTab("sync"));
  tabNavSchedule?.addEventListener("click", () => switchTab("schedule"));
  tabNavParser?.addEventListener("click", () => switchTab("parser"));
  tabNavLedger?.addEventListener("click", () => switchTab("ledger"));
  tabNavSettings?.addEventListener("click", () => switchTab("settings"));

  // ── 3. 折叠日志面板 ──
  const logHeaderToggle = document.getElementById("logHeaderToggle");
  const logArrow = document.getElementById("logArrow");
  const logWindow = document.getElementById("logWindow");
  const logStatusPeek = document.getElementById("logStatusPeek");
  const btnCopyLog = document.getElementById("btnCopyLog");
  const btnClearLog = document.getElementById("btnClearLog");

  logHeaderToggle.addEventListener("click", (e) => {
    if (e.target.id === "btnClearLog" || e.target.id === "btnCopyLog") return;
    logWindow.classList.toggle("collapsed");
    logArrow.classList.toggle("collapsed");
  });

  // ── 4. 核心控件绑定 ──
  const docSlotsContainer = document.getElementById("docSlotsContainer");
  const docSlotsCount = document.getElementById("docSlotsCount");
  const btnToggleDocSlots = document.getElementById("btnToggleDocSlots");
  const btnAddDocSlot = document.getElementById("btnAddDocSlot");
  const dryRunToggle = document.getElementById("dryRunToggle");
  const dryRunDesc = document.getElementById("dryRunDesc");
  const silentModeToggle = document.getElementById("silentModeToggle");
  const schedulePauseToggle = document.getElementById("schedulePauseToggle");
  const dryRunActiveBanner = document.getElementById("dryRunActiveBanner");
  const btnDisableDryRunQuick = document.getElementById("btnDisableDryRunQuick");
  const btnGoToSettingsFromParser = document.getElementById("btnGoToSettingsFromParser");
  const btnScanTasks = document.getElementById("btnScanTasks");
  const btnToggleSelectAll = document.getElementById("btnToggleSelectAll");
  const taskCountBadge = document.getElementById("taskCountBadge");
  const taskFilterBar = document.getElementById("taskFilterBar");
  const taskSearchInput = document.getElementById("taskSearchInput");
  const taskDocFilterChips = document.getElementById("taskDocFilterChips");
  const taskListContainer = document.getElementById("taskListContainer");
  const btnStart = document.getElementById("btnStart");
  const btnStartText = document.getElementById("btnStartText");
  const btnAddToSchedule = document.getElementById("btnAddToSchedule");
  const btnStop = document.getElementById("btnStop");
  const btnGlobalStop = document.getElementById("btnGlobalStop");
  const progressWrap = document.getElementById("progressWrap");
  const progressBar = document.getElementById("progressBar");
  const progressStage = document.getElementById("progressStage");
  const progressPct = document.getElementById("progressPct");

  // 定时面板控件
  const schedModeRadios = document.querySelectorAll('input[name="schedMode"]');
  const parserSchedModeRadios = document.querySelectorAll('input[name="parserSchedMode"]');
  const customTimePickerWrap = document.getElementById("customTimePickerWrap");
  const customScheduleTime = document.getElementById("customScheduleTime");
  const btnTogglePauseSched = document.getElementById("btnTogglePauseSched");
  const schedPausedBanner = document.getElementById("schedPausedBanner");
  const btnResumeSchedQuick = document.getElementById("btnResumeSchedQuick");
  const btnRefreshSched = document.getElementById("btnRefreshSched");
  const btnClearDoneSched = document.getElementById("btnClearDoneSched");
  const btnClearAllSched = document.getElementById("btnClearAllSched");
  const schedListContainer = document.getElementById("schedListContainer");
  const schedQueueCount = document.getElementById("schedQueueCount");
  const schedFilterChips = document.querySelectorAll("#schedFilterChips .filter-chip, #schedFilterChips .sched-filter-chip");
  const schedDocFilter = document.getElementById("schedDocFilter");
  const schedSearchInput = document.getElementById("schedSearchInput");
  const schedSelectAllCb = document.getElementById("schedSelectAllCb");
  const btnSchedInvertSelect = document.getElementById("btnSchedInvertSelect");
  const schedSelectedCount = document.getElementById("schedSelectedCount");
  const schedBatchActions = document.getElementById("schedBatchActions");
  const btnBatchDelay15 = document.getElementById("btnBatchDelay15");
  const btnBatchDelay30 = document.getElementById("btnBatchDelay30");
  const btnBatchFireSched = document.getElementById("btnBatchFireSched");
  const batchFireCount = document.getElementById("batchFireCount");
  const btnBatchDeleteSched = document.getElementById("btnBatchDeleteSched");
  const batchDelCount = document.getElementById("batchDelCount");

  // 入队确认弹窗控件
  const enqueueScheduleModal = document.getElementById("enqueueScheduleModal");
  const btnEnqueueModalClose = document.getElementById("btnEnqueueModalClose");
  const btnEnqueueCancel = document.getElementById("btnEnqueueCancel");
  const btnEnqueueConfirm = document.getElementById("btnEnqueueConfirm");
  const enqueueTaskCount = document.getElementById("enqueueTaskCount");
  const enqueueModeRadiosSync = document.getElementById("enqueueModeRadiosSync");
  const enqueueModeRadiosParser = document.getElementById("enqueueModeRadiosParser");
  const customStaggerToggle = document.getElementById("customStaggerToggle");
  const customStaggerMinutes = document.getElementById("customStaggerMinutes");

  // 账本面板控件
  const ledgerListContainer = document.getElementById("ledgerListContainer");
  const ledgerCountBadge = document.getElementById("ledgerCountBadge");
  const ledgerFilterChips = document.querySelectorAll("#ledgerFilterChips .filter-chip");
  const ledgerSearchInput = document.getElementById("ledgerSearchInput");
  const ledgerDocFilter = document.getElementById("ledgerDocFilter");
  const btnCopyLedgerLinks = document.getElementById("btnCopyLedgerLinks");
  const btnExportLedgerCsv = document.getElementById("btnExportLedgerCsv");
  const btnClearLedger = document.getElementById("btnClearLedger");

  // 任务解析控件
  const taskParserInput = document.getElementById("taskParserInput");
  const btnToggleParserInput = document.getElementById("btnToggleParserInput");
  const taskParserStripKeywords = document.getElementById("taskParserStripKeywords");
  const taskParserPollToggle = document.getElementById("taskParserPollQuickToggle") || document.getElementById("taskParserPollToggle");
  const parserCountBadge = document.getElementById("parserCountBadge");
  const btnParseTasks = document.getElementById("btnParseTasks");
  const btnClearParser = document.getElementById("btnClearParser");
  const parsedTasksPreviewContainer = document.getElementById("parsedTasksPreviewContainer");
  const btnParserToSchedule = document.getElementById("btnParserToSchedule");
  const btnParserRunNow = document.getElementById("btnParserRunNow");

  // 账号别名控件
  const aliasListContainer = document.getElementById("aliasListContainer");
  const aliasCountBadge = document.getElementById("aliasCountBadge");
  const btnAddAliasRow = document.getElementById("btnAddAliasRow");
  const btnResetDefaultAliases = document.getElementById("btnResetDefaultAliases");
  const quickAliasChips = document.getElementById("quickAliasChips");

  // 编辑弹窗控件
  const scheduleEditModal = document.getElementById("scheduleEditModal");
  const btnEditModalClose = document.getElementById("btnEditModalClose");
  const btnEditModalCancel = document.getElementById("btnEditModalCancel");
  const btnEditModalSave = document.getElementById("btnEditModalSave");
  const btnEditModalFireNow = document.getElementById("btnEditModalFireNow");
  const editModalTaskId = document.getElementById("editModalTaskId");
  const editModalAccount = document.getElementById("editModalAccount");
  const editModalDateTime = document.getElementById("editModalDateTime");
  const editModalContent = document.getElementById("editModalContent");
  const editModalCharCount = document.getElementById("editModalCharCount");
  const editModalImagesGroup = document.getElementById("editModalImagesGroup");
  const editModalImagesList = document.getElementById("editModalImagesList");
  const editModalPollTitle = document.getElementById("editModalPollTitle");
  const editModalPollOpt1 = document.getElementById("editModalPollOpt1");
  const editModalPollOpt2 = document.getElementById("editModalPollOpt2");
  const editModalPollOpt3 = document.getElementById("editModalPollOpt3");
  const editModalPollOpt4 = document.getElementById("editModalPollOpt4");
  const imagePreviewModal = document.getElementById("imagePreviewModal");
  const imagePreviewImg = document.getElementById("imagePreviewImg");
  const imagePreviewCounter = document.getElementById("imagePreviewCounter");
  const imagePreviewCaption = document.getElementById("imagePreviewCaption");
  const btnImagePreviewClose = document.getElementById("btnImagePreviewClose");
  const btnImagePreviewPrev = document.getElementById("btnImagePreviewPrev");
  const btnImagePreviewNext = document.getElementById("btnImagePreviewNext");

  // 状态变量
  let docSlots = [];
  let scannedTasks = [];
  let cachedScheduledTasks = [];
  let cachedPlatformAccounts = [];
  let currentSchedFilter = "pending";
  let currentSchedDoc = "all";
  let currentTaskDocFilter = "all";
  let currentLedgerFilter = "all";
  let selectedSchedIds = new Set();
  let pendingEnqueueSource = "sync";
  let pipelineRunning = false;
  let parsedTaskGroups = [];
  const previewImageCache = new Map();
  let previewState = { urls: [], index: 0, docUrl: "" };

  function updatePipelineControls(isRunning) {
    pipelineRunning = isRunning;
    btnStart.disabled = isRunning;
    btnStop.disabled = !isRunning;
    if (!isRunning) {
      btnStop.textContent = "⏹ 停止";
    }
    if (btnGlobalStop) {
      btnGlobalStop.style.display = isRunning ? "inline-flex" : "none";
      btnGlobalStop.disabled = !isRunning;
      if (!isRunning) btnGlobalStop.textContent = "⏹ 停止任务";
    }
    btnScanTasks.disabled = isRunning;
    if (btnParserRunNow) btnParserRunNow.disabled = isRunning || parsedTaskGroups.length === 0;
    if (btnParserToSchedule) btnParserToSchedule.disabled = isRunning || parsedTaskGroups.length === 0;
  }

  async function refreshPipelineControls() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: "GET_PIPELINE_STATUS" });
      if (!resp?.ok || !resp.state) throw new Error(resp?.error || "未收到运行状态");
      updatePipelineControls(!!resp.state.isRunning);
    } catch (err) {
      appendLog(`刷新流水线状态失败: ${err.message}`, "error");
    }
  }

  // ── 5. 多文档卡槽初始化与渲染 ──
  const defaultSlots = [
    { id: "slot_1", name: "文档 1 (主表)", url: "", linkCol: "E" },
    { id: "slot_2", name: "文档 2 (副表)", url: "", linkCol: "E" },
  ];

  chrome.storage.local.get(["docPresets", "docUrl", "linkCol", "dryRun", "silentMode", "cachedScannedTasks", "cachedScannedAt", "scheduledTasks", "cachedPlatformAccounts", "docSlotsCollapsed"], (stored) => {
    if (Array.isArray(stored.scheduledTasks)) {
      cachedScheduledTasks = stored.scheduledTasks;
    }
    if (Array.isArray(stored.cachedPlatformAccounts)) {
      cachedPlatformAccounts = stored.cachedPlatformAccounts.filter((n) => typeof n === "string" && n.trim());
    }
    if (Array.isArray(stored.docPresets) && stored.docPresets.length > 0) {
      docSlots = stored.docPresets;
    } else if (stored.docUrl) {
      docSlots = [
        { id: "slot_1", name: "文档 1 (主表)", url: stored.docUrl, linkCol: stored.linkCol || "E" },
        { id: "slot_2", name: "文档 2 (副表)", url: "", linkCol: "E" },
      ];
    } else {
      docSlots = defaultSlots;
    }

    dryRunToggle.checked = stored.dryRun === true;

    if (silentModeToggle) {
      silentModeToggle.checked = stored.silentMode !== false; // 默认开启静默无感发博
    }

    renderDocSlots();
    if (docSlotsContainer && btnToggleDocSlots) {
      const applyDocSlotsCollapsed = (collapsed) => {
        docSlotsContainer.style.display = collapsed ? "none" : "flex";
        btnToggleDocSlots.textContent = collapsed ? "🔽 展开" : "🔼 收起";
      };
      applyDocSlotsCollapsed(!!stored.docSlotsCollapsed);
      btnToggleDocSlots.addEventListener("click", () => {
        const nextCollapsed = docSlotsContainer.style.display !== "none";
        applyDocSlotsCollapsed(nextCollapsed);
        chrome.storage.local.set({ docSlotsCollapsed: nextCollapsed });
      });
    }
    updateDryRunUI(dryRunToggle.checked);
    updateSchedulePauseUI();

    if (taskParserStripKeywords) {
      chrome.storage.local.get(["stripKeywords"], (res) => {
        if (res && res.stripKeywords) {
          taskParserStripKeywords.value = res.stripKeywords;
        }
      });
    }

    if (Array.isArray(stored.cachedScannedTasks) && stored.cachedScannedTasks.length > 0) {
      scannedTasks = stored.cachedScannedTasks;
      renderTaskList(scannedTasks);
      if (taskCountBadge && stored.cachedScannedAt) {
        const cacheTime = new Date(stored.cachedScannedAt).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
        taskCountBadge.textContent = `共 ${scannedTasks.length} 条 (缓存 ${cacheTime})`;
        taskCountBadge.title = "来自上次扫描缓存，若云文档已更新请点击【重新扫描全部文档】";
      }
    }
  });

  // 恢复正在执行的任务进度与日志
  try {
    chrome.runtime.sendMessage({ action: "GET_PIPELINE_STATUS" }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.ok && resp.state) {
        const { isRunning, stage, percentage, logs } = resp.state;
        if (logs && logs.length > 0) {
          logWindow.innerHTML = "";
          logs.forEach((item) => renderLogItem(item.detail, item.level, item.time));
        }
        updatePipelineControls(!!isRunning);
        if (isRunning) {
          progressWrap.style.display = "block";
          progressStage.textContent = stage;
          progressPct.textContent = `${percentage}%`;
          progressBar.style.width = `${percentage}%`;
        }
      }
    });
  } catch (_) {}

  refreshScheduleQueue();

  function saveSlotsConfig() {
    chrome.storage.local.set({
      docPresets: docSlots,
      docUrl: docSlots[0] ? docSlots[0].url : "",
      linkCol: docSlots[0] ? docSlots[0].linkCol : "E",
      dryRun: dryRunToggle.checked,
      silentMode: silentModeToggle ? silentModeToggle.checked : true,
    });
    if (docSlotsCount) {
      docSlotsCount.textContent = `${docSlots.length} 个卡槽`;
    }
  }

  function parseSubSheetHint(url) {
    if (!url || typeof url !== "string") return "📌 默认首个工作表";
    const raw = url.trim();
    const tabMatch = raw.match(/[?&](?:tab|sub|sheet_id|gid)=([A-Za-z0-9_-]+)/i);
    if (tabMatch && tabMatch[1]) {
      return `🎯 抓取子表: ${tabMatch[1]}`;
    }
    const hashMatch = raw.match(/#([A-Za-z0-9_-]+)/);
    if (hashMatch && hashMatch[1] && !hashMatch[1].startsWith("/")) {
      return `🎯 子表锚点: ${hashMatch[1]}`;
    }
    return "📌 默认首个工作表";
  }

  function renderDocSlots() {
    docSlotsContainer.innerHTML = "";
    if (docSlotsCount) {
      docSlotsCount.textContent = `${docSlots.length} 个卡槽`;
    }

    docSlots.forEach((slot, index) => {
      const row = document.createElement("div");
      row.className = "doc-slot-row";
      row.dataset.id = slot.id;

      const slotBadgeClass = index === 0 ? "slot-1" : index === 1 ? "slot-2" : "slot-other";
      const defaultName = index === 0 ? "文档 1 (主表)" : index === 1 ? "文档 2 (副表)" : `文档 ${index + 1}`;
      const slotName = slot.name || defaultName;
      const posHint = parseSubSheetHint(slot.url);
      const canDelete = docSlots.length > 1;

      row.innerHTML = `
        <div class="doc-slot-top">
          <div class="doc-slot-badge-group">
            <input type="text" class="doc-slot-name-input ${slotBadgeClass}" maxlength="24" placeholder="${escapeHtml(defaultName)}" value="${escapeHtml(slotName)}" title="点击修改文档自定义名称">
            <span class="doc-slot-tag-pos" title="${escapeHtml(posHint)}">${escapeHtml(posHint)}</span>
          </div>
          <div class="doc-slot-quick-btns">
            <button type="button" class="btn-text-action btn-fill-curr" title="将浏览器当前激活标签页的云文档填入此卡槽">📍 填入当前页</button>
            <button type="button" class="btn-text-action btn-scan-single" title="仅扫描此卡槽对应的文档">🔍 仅扫此表</button>
            ${canDelete ? `<button type="button" class="btn-text-action text-danger btn-del-slot" title="移除该文档卡槽">✕</button>` : ""}
          </div>
        </div>
        <div class="doc-slot-input-wrap">
          <input type="text" class="doc-slot-url-input" placeholder="输入或粘贴腾讯文档/钉钉表格链接 (含 tab=xxx 指定子表)..." value="${escapeHtml(slot.url || "")}">
        </div>
        <div class="doc-slot-subbar">
          <span class="doc-slot-tab-hint">💡 自动智能识别表头中的账号、正文、配图与发布回执列</span>
        </div>
      `;

      // 绑定自定义文档名称输入框
      const nameInput = row.querySelector(".doc-slot-name-input");
      const syncScannedDocName = (nextName) => {
        let changed = false;
        scannedTasks.forEach((t) => {
          if (t.docId === slot.id && t.docName !== nextName) {
            t.docName = nextName;
            changed = true;
          }
        });
        if (changed) {
          chrome.storage.local.set({ cachedScannedTasks: scannedTasks });
          renderTaskList(scannedTasks);
        }
      };
      if (nameInput) {
        nameInput.addEventListener("input", (e) => {
          const val = e.target.value.trim();
          slot.name = val || defaultName;
          saveSlotsConfig();
          syncScannedDocName(slot.name);
        });
        nameInput.addEventListener("blur", (e) => {
          const val = e.target.value.trim();
          const finalName = val || defaultName;
          slot.name = finalName;
          e.target.value = finalName;
          saveSlotsConfig();
          syncScannedDocName(finalName);
        });
      }

      // 绑定输入框联动
      const urlInput = row.querySelector(".doc-slot-url-input");
      const posTag = row.querySelector(".doc-slot-tag-pos");

      urlInput.addEventListener("input", (e) => {
        slot.url = e.target.value.trim();
        posTag.textContent = parseSubSheetHint(slot.url);
        posTag.title = posTag.textContent;
        saveSlotsConfig();
      });

      // 绑定“填入当前页”
      const btnFillCurr = row.querySelector(".btn-fill-curr");
      btnFillCurr.addEventListener("click", async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.url) {
            if (tab.url.includes("docs.qq.com") || tab.url.includes("alidocs.dingtalk.com")) {
              slot.url = tab.url;
              urlInput.value = tab.url;
              posTag.textContent = parseSubSheetHint(tab.url);
              posTag.title = posTag.textContent;
              saveSlotsConfig();
              appendLog(`已成功将当前页填入 [${slot.name || defaultName}]: ${tab.title || tab.url}`, "success");
            } else {
              appendLog("当前激活标签页不是腾讯文档或钉钉表格，请先切换到云文档页面！", "warn");
            }
          }
        } catch (err) {
          appendLog(`读取当前页异常: ${err.message}`, "error");
        }
      });

      // 绑定“仅扫此表”
      const btnScanSingle = row.querySelector(".btn-scan-single");
      btnScanSingle.addEventListener("click", async () => {
        if (!slot.url || !slot.url.startsWith("http")) {
          appendLog(`请先填入 [${slot.name || defaultName}] 的有效云文档链接！`, "warn");
          return;
        }
        await executeScan([slot]);
      });

      // 绑定“删除卡槽”
      if (canDelete) {
        const btnDel = row.querySelector(".btn-del-slot");
        btnDel.addEventListener("click", () => {
          docSlots = docSlots.filter((s) => s.id !== slot.id);
          saveSlotsConfig();
          renderDocSlots();
        });
      }

      docSlotsContainer.appendChild(row);
    });
  }

  // 绑定“＋ 添加文档卡槽”
  btnAddDocSlot.addEventListener("click", () => {
    const newIdx = docSlots.length + 1;
    const newSlot = {
      id: `slot_${Date.now()}`,
      name: `文档 ${newIdx}`,
      url: "",
      linkCol: "E",
    };
    docSlots.push(newSlot);
    saveSlotsConfig();
    renderDocSlots();
    // 聚焦新建的输入框
    setTimeout(() => {
      const inputs = docSlotsContainer.querySelectorAll(".doc-slot-url-input");
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 50);
  });

  // 安全演练开关
  dryRunToggle.addEventListener("change", async () => {
    const isDryRun = dryRunToggle.checked;
    updateDryRunUI(isDryRun);
    saveSlotsConfig();
    try {
      const resp = await chrome.runtime.sendMessage({ action: "SET_DRY_RUN_MODE", dryRun: isDryRun });
      if (!resp?.ok) throw new Error(resp?.error || "同步运行模式失败");
      await refreshScheduleQueue();
    } catch (err) {
      appendLog(`运行模式同步失败: ${err.message}`, "error");
    }
  });

  if (btnDisableDryRunQuick) {
    btnDisableDryRunQuick.addEventListener("click", async () => {
      dryRunToggle.checked = false;
      updateDryRunUI(false);
      saveSlotsConfig();
      try {
        await chrome.runtime.sendMessage({ action: "SET_DRY_RUN_MODE", dryRun: false });
      } catch (_) {}
    });
  }
  btnGoToSettingsFromParser?.addEventListener("click", () => switchTab("settings"));

  if (silentModeToggle) {
    silentModeToggle.addEventListener("change", () => {
      saveSlotsConfig();
      updateDryRunUI(dryRunToggle.checked);
    });
  }

  function updateDryRunUI(isDryRun) {
    const selectedCount = getSelectedTasks().length;
    const countParen = selectedCount > 0 ? ` (${selectedCount})` : "";

    if (btnAddToSchedule) {
      btnAddToSchedule.textContent = `⏰ 定时发布${countParen}`;
    }
    if (taskCountBadge && scannedTasks.length > 0) {
      taskCountBadge.textContent = `已选 ${selectedCount} / 共 ${scannedTasks.length} 条`;
    }

    if (isDryRun) {
      if (dryRunDesc) {
        dryRunDesc.textContent = "🛠️ 演练调试已开启：仅验证文档抓取与中台装配，绝不向微博点击发送";
        dryRunDesc.style.color = "#D97706";
      }
      if (dryRunActiveBanner) dryRunActiveBanner.style.display = "flex";
      btnStartText.textContent = `🛡️ 演练执行${countParen}`;
    } else {
      if (dryRunDesc) {
        dryRunDesc.textContent = "调试专用：开启后仅验证文档抓取与中台装配，绝不向微博点击发送";
        dryRunDesc.style.color = "";
      }
      if (dryRunActiveBanner) dryRunActiveBanner.style.display = "none";
      btnStartText.textContent = `🚀 立即发布${countParen}`;
    }
  }

  // ── 6. 扫描全部文档与待发任务列表 ──
  btnScanTasks.addEventListener("click", async () => {
    const validSlots = docSlots.filter((s) => s.url && s.url.trim().startsWith("http"));
    if (validSlots.length === 0) {
      appendLog("请先在卡槽中填入至少一个云文档链接！", "error");
      return;
    }
    await executeScan(validSlots);
  });

  async function executeScan(targetSlots) {
    saveSlotsConfig();
    btnScanTasks.disabled = true;
    btnScanTasks.textContent = "扫描中...";
    appendLog(`正在连接云文档，准备联合扫描 ${targetSlots.length} 个文档卡槽...`, "info");

    try {
      const resp = await chrome.runtime.sendMessage({
        action: "SCAN_DOC_TASKS",
        config: {
          docs: targetSlots.map((s, idx) => ({
            id: s.id,
            name: s.name || `文档 ${idx + 1}`,
            url: s.url.trim(),
            linkCol: (s.linkCol || "E").trim().toUpperCase(),
          })),
        },
      });

      if (resp && resp.ok) {
        scannedTasks = resp.tasks || [];
        const compactCached = scannedTasks.slice(0, 300).map((t) => ({
          docId: t.docId,
          docIndex: t.docIndex,
          docName: t.docName,
          docUrl: t.docUrl,
          targetSheetId: t.targetSheetId,
          row: t.row,
          targetCell: t.targetCell,
          account: t.account,
          content: t.content,
          time: t.time,
          imgUrls: Array.isArray(t.imgUrls) ? t.imgUrls.slice(0, 9) : [],
          repostUrl: t.repostUrl,
          commentOriginal: t.commentOriginal,
        }));
        chrome.storage.local.set({
          cachedScannedTasks: compactCached,
          cachedScannedAt: compactCached.length > 0 ? Date.now() : 0,
        }).catch(() => {});
        if (taskCountBadge) taskCountBadge.title = "";
        renderTaskList(scannedTasks);
        appendLog(`扫描完成！共发现 ${scannedTasks.length} 条待发布任务`, scannedTasks.length ? "success" : "warn");
      } else {
        appendLog(`扫描失败: ${resp?.error || "未知异常"}`, "error");
      }
    } catch (err) {
      appendLog(`扫描通信失败: ${err.message}`, "error");
    } finally {
      btnScanTasks.disabled = pipelineRunning;
      btnScanTasks.textContent = "🔍 重新扫描全部文档";
    }
  }

  function getTaskCardId(task) {
    const identity = [task.docId || "", task.docUrl || "", task.targetSheetId || "", String(task.row ?? "")];
    return `task-card-${encodeURIComponent(JSON.stringify(identity))}`;
  }

  function getPreviewImageSrc(rawUrl) {
    const key = String(rawUrl || "").trim();
    return previewImageCache.get(key) || key;
  }

  async function resolvePreviewImageFallback(rawUrl, docUrl) {
    const key = String(rawUrl || "").trim();
    if (!key) return "";
    if (previewImageCache.has(key)) return previewImageCache.get(key);
    try {
      const resp = await chrome.runtime.sendMessage({
        action: "FETCH_PREVIEW_IMAGE",
        url: key,
        docUrl: docUrl || "",
      });
      if (resp && resp.ok && resp.dataUrl) {
        previewImageCache.set(key, resp.dataUrl);
        return resp.dataUrl;
      }
    } catch (_) {}
    return "";
  }

  function renderImagePreviewFrame() {
    if (!imagePreviewModal || !previewState.urls.length) return;
    const total = previewState.urls.length;
    const idx = ((previewState.index % total) + total) % total;
    previewState.index = idx;
    const rawUrl = previewState.urls[idx];
    const resolvedSrc = getPreviewImageSrc(rawUrl);

    if (imagePreviewCounter) imagePreviewCounter.textContent = `${idx + 1} / ${total}`;
    if (imagePreviewCaption) imagePreviewCaption.textContent = rawUrl;
    if (btnImagePreviewPrev) btnImagePreviewPrev.style.display = total > 1 ? "flex" : "none";
    if (btnImagePreviewNext) btnImagePreviewNext.style.display = total > 1 ? "flex" : "none";

    if (imagePreviewImg) {
      imagePreviewImg.dataset.rawUrl = rawUrl;
      imagePreviewImg.dataset.fallbackTried = "0";
      imagePreviewImg.src = resolvedSrc;
    }
  }

  function openImagePreview(urls, startIndex = 0, docUrl = "") {
    const list = (Array.isArray(urls) ? urls : []).filter(Boolean);
    if (!list.length || !imagePreviewModal) return;
    previewState = {
      urls: list,
      index: Math.max(0, Math.min(startIndex, list.length - 1)),
      docUrl: docUrl || "",
    };
    renderImagePreviewFrame();
    imagePreviewModal.style.display = "flex";
  }

  function closeImagePreview() {
    if (!imagePreviewModal) return;
    imagePreviewModal.style.display = "none";
    if (imagePreviewImg) imagePreviewImg.src = "";
    previewState = { urls: [], index: 0, docUrl: "" };
  }

  imagePreviewImg?.addEventListener("error", async () => {
    const rawUrl = imagePreviewImg.dataset?.rawUrl || "";
    if (!rawUrl || imagePreviewImg.dataset?.fallbackTried === "1") return;
    if (imagePreviewImg.dataset) imagePreviewImg.dataset.fallbackTried = "1";
    const dataUrl = await resolvePreviewImageFallback(rawUrl, previewState.docUrl);
    if (dataUrl && imagePreviewImg.dataset?.rawUrl === rawUrl) {
      imagePreviewImg.src = dataUrl;
    }
  });

  btnImagePreviewClose?.addEventListener("click", closeImagePreview);
  btnImagePreviewPrev?.addEventListener("click", () => {
    if (previewState.urls.length <= 1) return;
    previewState.index -= 1;
    renderImagePreviewFrame();
  });
  btnImagePreviewNext?.addEventListener("click", () => {
    if (previewState.urls.length <= 1) return;
    previewState.index += 1;
    renderImagePreviewFrame();
  });
  imagePreviewModal?.addEventListener("click", (e) => {
    if (e.target === imagePreviewModal) closeImagePreview();
  });
  document.addEventListener?.("keydown", (e) => {
    if (!imagePreviewModal || imagePreviewModal.style.display === "none") return;
    if (e.key === "Escape") closeImagePreview();
    else if (e.key === "ArrowLeft" && previewState.urls.length > 1) {
      previewState.index -= 1;
      renderImagePreviewFrame();
    } else if (e.key === "ArrowRight" && previewState.urls.length > 1) {
      previewState.index += 1;
      renderImagePreviewFrame();
    }
  });

  function bindThumbImages(container, urlsList, getDocUrl) {
    if (!container) return;
    container.querySelectorAll(".task-thumb-img, .modal-thumb-img").forEach((img) => {
      img.addEventListener("click", (e) => {
        e.stopPropagation?.();
        const taskIdx = parseInt(img.dataset?.taskIndex ?? "0", 10);
        const imgIdx = parseInt(img.dataset?.imgIndex ?? "0", 10);
        const urls = Array.isArray(urlsList) ? urlsList : (urlsList(taskIdx) || []);
        const docUrl = typeof getDocUrl === "function" ? getDocUrl(taskIdx) : getDocUrl;
        openImagePreview(urls, imgIdx, docUrl);
      });
      img.addEventListener("error", async () => {
        const rawUrl = img.dataset?.rawUrl || "";
        if (!rawUrl || img.dataset?.fallbackTried === "1") return;
        if (img.dataset) img.dataset.fallbackTried = "1";
        const taskIdx = parseInt(img.dataset?.taskIndex ?? "0", 10);
        const docUrl = typeof getDocUrl === "function" ? getDocUrl(taskIdx) : getDocUrl;
        const dataUrl = await resolvePreviewImageFallback(rawUrl, docUrl);
        if (dataUrl) {
          img.src = dataUrl;
        } else {
          img.style.display = "none";
        }
      });
    });
  }

  function renderTaskList(tasks) {
    taskListContainer.innerHTML = "";
    if (!tasks || tasks.length === 0) {
      taskListContainer.innerHTML = `<div class="empty-placeholder">没有发现未填链接的待发任务（所有行均已写回或正文为空）</div>`;
      taskCountBadge.textContent = "0 条";
      btnToggleSelectAll.style.display = "none";
      if (taskFilterBar) taskFilterBar.style.display = "none";
      if (taskDocFilterChips) taskDocFilterChips.style.display = "none";
      updateDryRunUI(dryRunToggle.checked);
      return;
    }

    taskCountBadge.textContent = `共 ${tasks.length} 条`;
    btnToggleSelectAll.style.display = "inline-block";
    if (taskFilterBar) taskFilterBar.style.display = "block";

    const distinctDocs = Array.from(new Set(tasks.map((t) => t.docName || `文档 ${t.docIndex || 1}`)));
    if (currentTaskDocFilter !== "all" && !distinctDocs.includes(currentTaskDocFilter)) {
      currentTaskDocFilter = "all";
    }
    if (taskDocFilterChips) {
      if (distinctDocs.length >= 2) {
        taskDocFilterChips.style.display = "flex";
        taskDocFilterChips.innerHTML = ["all", ...distinctDocs]
          .map((d) => `<button type="button" class="filter-chip ${currentTaskDocFilter === d ? "active" : ""}" data-doc="${escapeHtml(d)}">${d === "all" ? `全部 (${tasks.length})` : escapeHtml(d)}</button>`)
          .join("");
        taskDocFilterChips.querySelectorAll(".filter-chip").forEach((chip) => {
          chip.addEventListener("click", () => {
            currentTaskDocFilter = chip.dataset.doc || "all";
            renderTaskList(scannedTasks);
          });
        });
      } else {
        taskDocFilterChips.style.display = "none";
        taskDocFilterChips.innerHTML = "";
      }
    }

    const activeSchedKeys = new Set(
      (cachedScheduledTasks || [])
        .filter((s) => s && (s.status === "pending" || s.status === "firing") && s.docUrl && s.row != null)
        .map((s) => `${String(s.docUrl).trim()}|${String(s.targetSheetId || "")}|${String(s.row)}`)
    );

    const taskQuery = String(taskSearchInput?.value || "").trim().toLowerCase();
    let renderedTaskCount = 0;

    tasks.forEach((t, index) => {
      const docName = t.docName || `文档 ${t.docIndex || 1}`;
      if (currentTaskDocFilter !== "all" && docName !== currentTaskDocFilter) return;
      if (taskQuery) {
        const hitAcct = String(t.account || "").toLowerCase().includes(taskQuery);
        const hitContent = String(t.content || "").toLowerCase().includes(taskQuery);
        const hitDoc = String(docName).toLowerCase().includes(taskQuery);
        if (!hitAcct && !hitContent && !hitDoc) return;
      }
      renderedTaskCount += 1;

      const card = document.createElement("div");
      card.className = "task-item-card";
      card.id = getTaskCardId(t);

      const schedKey = `${String(t.docUrl || "").trim()}|${String(t.targetSheetId || "")}|${String(t.row ?? "")}`;
      const isAlreadyScheduled = Boolean(t.docUrl && t.row != null && activeSchedKeys.has(schedKey));
      const scheduledBadge = isAlreadyScheduled
        ? `<span class="sched-status-pill pending" title="该行已在定时队列等待触发，默认取消勾选以防重复排程">⏰ 已排程</span>`
        : "";

      const cellHint = t.targetCell ? ` · ${escapeHtml(t.targetCell)}` : "";
      const charCountTag = `<span class="sched-sub-meta">${String(t.content || "").length}字</span>`;
      const timeHint = t.time ? `<span class="sched-sub-meta">⏰ ${escapeHtml(t.time)}</span>` : "";
      const imgList = Array.isArray(t.imgUrls) ? t.imgUrls.filter(Boolean).slice(0, 9) : [];
      const imgHint = imgList.length > 0
        ? `<span class="sched-sub-meta" title="点击下方缩略图可放大预览">🖼️ ${imgList.length}张</span>`
        : "";
      const thumbsHtml = imgList.length > 0
        ? `<div class="task-images-row">${imgList.map((u, imgIdx) => `
            <img src="${escapeHtml(getPreviewImageSrc(u))}" class="task-thumb-img" referrerpolicy="no-referrer" data-task-index="${index}" data-img-index="${imgIdx}" data-raw-url="${escapeHtml(u)}" title="点击放大预览配图 ${imgIdx + 1}">
          `).join("")}</div>`
        : "";

      card.innerHTML = `
        <input type="checkbox" class="task-item-cb" data-task-index="${index}" ${isAlreadyScheduled ? "" : "checked"} style="margin-top: 3px;">
        <div class="sched-card-body">
          <div class="sched-card-header">
            <div class="sched-card-left-meta">
              <span class="sched-acct-name">👤 ${escapeHtml(t.account || "默认账号")}</span>
              <span class="sched-sub-meta">${escapeHtml(docName)} · 行 ${t.row}${cellHint}</span>
              ${charCountTag}
              ${imgHint}
              ${timeHint}
              ${scheduledBadge}
            </div>
          </div>
          <div class="sched-card-content" title="点击展开/收起全文">${escapeHtml(t.content)}</div>
          ${thumbsHtml}
        </div>
      `;

      taskListContainer.appendChild(card);
    });

    if (renderedTaskCount === 0) {
      taskListContainer.innerHTML = `<div class="empty-placeholder">当前搜索关键词下无匹配任务</div>`;
    }

    taskListContainer.querySelectorAll(".task-item-cb").forEach((cb) => {
      cb.addEventListener("change", () => updateDryRunUI(dryRunToggle.checked));
    });

    taskListContainer.querySelectorAll(".sched-card-header").forEach((hdr) => {
      hdr.style.cursor = "pointer";
      hdr.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("button, a, input")) return;
        const card = hdr.closest ? hdr.closest(".task-item-card") : null;
        const cb = card ? card.querySelector(".task-item-cb") : null;
        if (cb) {
          cb.checked = !cb.checked;
          updateDryRunUI(dryRunToggle.checked);
        }
      });
    });

    taskListContainer.querySelectorAll(".sched-card-content").forEach((el) => {
      el.addEventListener("click", () => el.classList.toggle("is-expanded"));
    });

    bindThumbImages(
      taskListContainer,
      (taskIdx) => (tasks[taskIdx]?.imgUrls || []).filter(Boolean).slice(0, 9),
      (taskIdx) => tasks[taskIdx]?.docUrl || ""
    );

    updateDryRunUI(dryRunToggle.checked);
  }

  function getSelectedTasks() {
    const checkedNodes = Array.from(taskListContainer.querySelectorAll(".task-item-cb:checked"));
    return checkedNodes.map((cb) => scannedTasks[Number(cb.dataset.taskIndex)]).filter(Boolean);
  }

  taskSearchInput?.addEventListener("input", () => {
    if (scannedTasks.length > 0) renderTaskList(scannedTasks);
  });

  btnToggleSelectAll.addEventListener("click", () => {
    const checkboxes = taskListContainer.querySelectorAll(".task-item-cb");
    const anyUnchecked = Array.from(checkboxes).some((cb) => !cb.checked);
    checkboxes.forEach((cb) => (cb.checked = anyUnchecked));
    updateDryRunUI(dryRunToggle.checked);
  });

  // ── 7. 定时排程选项与入队确认弹窗逻辑 ──
  schedModeRadios.forEach((r) => {
    r.addEventListener("change", (e) => {
      if (customTimePickerWrap) {
        customTimePickerWrap.style.display = e.target.value === "custom" ? "block" : "none";
      }
    });
  });

  parserSchedModeRadios.forEach((r) => {
    r.addEventListener("change", (e) => {
      if (customTimePickerWrap) {
        customTimePickerWrap.style.display = e.target.value === "custom" ? "block" : "none";
      }
    });
  });

  document.querySelectorAll(".chip[data-min]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const addMin = parseInt(chip.dataset.min, 10);
      const targetDate = new Date(Date.now() + addMin * 60 * 1000);
      customScheduleTime.value = formatDateTimeLocal(targetDate);
    });
  });

  function formatDateTimeLocal(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function closeEnqueueScheduleModal() {
    if (enqueueScheduleModal) enqueueScheduleModal.style.display = "none";
  }

  function openEnqueueScheduleModal(source) {
    pendingEnqueueSource = source;
    const count = source === "parser" ? parsedTaskGroups.length : getSelectedTasks().length;
    if (!count) {
      appendLog(source === "parser" ? "请先解析出至少一条任务！" : "请先扫描并在列表中勾选要加入定时的任务！", "warn");
      return;
    }

    if (enqueueTaskCount) enqueueTaskCount.textContent = String(count);
    if (enqueueModeRadiosSync) enqueueModeRadiosSync.style.display = source === "sync" ? "flex" : "none";
    if (enqueueModeRadiosParser) enqueueModeRadiosParser.style.display = source === "parser" ? "flex" : "none";

    // 根据当前选择的时间模式决定是否展开时间选择器，且默认预填 +15分钟 避免空值
    if (customScheduleTime && !customScheduleTime.value) {
      customScheduleTime.value = formatDateTimeLocal(new Date(Date.now() + 15 * 60 * 1000));
    }
    const activeMode = source === "sync"
      ? (document.querySelector('input[name="schedMode"]:checked')?.value || "table")
      : (document.querySelector('input[name="parserSchedMode"]:checked')?.value || "stagger");
    if (customTimePickerWrap) {
      customTimePickerWrap.style.display = activeMode === "custom" ? "block" : "none";
    }

    // 同步当前全局演练模式作为入队默认选项
    const isDryRun = !!dryRunToggle?.checked;
    const dryRadio = document.querySelector(`input[name="enqueueDryRun"][value="${isDryRun ? "true" : "false"}"]`);
    if (dryRadio) dryRadio.checked = true;

    if (enqueueScheduleModal) {
      enqueueScheduleModal.style.display = "flex";
    }
  }

  btnEnqueueModalClose?.addEventListener("click", closeEnqueueScheduleModal);
  btnEnqueueCancel?.addEventListener("click", closeEnqueueScheduleModal);

  // ── 8. 加入定时任务队列（扫表后一键直达，无需二次确认） ──
  btnAddToSchedule.addEventListener("click", async () => {
    const selected = getSelectedTasks();
    if (!selected.length) {
      appendLog("请先扫描并在列表中勾选要加入定时的任务！", "warn");
      return;
    }

    const isDryRun = !!dryRunToggle?.checked;
    const newSchedTasks = [];
    try {
      for (const item of selected) {
        let fireTimestamp = 0;
        let fireTimeStr = "";
        if (item.time) {
          const parsed = parseTableTime(item.time);
          fireTimestamp = parsed.ts;
          fireTimeStr = parsed.text;
        } else {
          fireTimestamp = Date.now() + 15 * 60 * 1000;
          fireTimeStr = new Date(fireTimestamp).toLocaleTimeString();
        }
        newSchedTasks.push(Object.assign({}, item, {
          dryRun: isDryRun,
          fireAtTimestamp: fireTimestamp,
          fireAtTime: fireTimeStr,
        }));
      }
    } catch (err) {
      appendLog(`加入定时失败: ${err.message}`, "error");
      return;
    }

    try {
      const resp = await chrome.runtime.sendMessage({
        action: "ADD_SCHEDULE_TASKS",
        tasks: newSchedTasks,
      });

      if (resp && resp.ok) {
        appendLog(`已成功将 ${newSchedTasks.length} 条任务加入定时队列 [${isDryRun ? "演练" : "实盘"}]！`, "success");
        tabNavSchedule.click();
      } else {
        appendLog(`加入定时失败: ${resp?.error || "未知异常"}`, "error");
      }
    } catch (e) {
      appendLog(`加入定时异常: ${e.message}`, "error");
    }
  });

  btnEnqueueConfirm?.addEventListener("click", async () => {
    const dryRadioVal = document.querySelector('input[name="enqueueDryRun"]:checked')?.value;
    const isDryRun = dryRadioVal != null ? dryRadioVal === "true" : !!dryRunToggle?.checked;
    const staggerEnabled = !!customStaggerToggle?.checked;
    const staggerStepMs = Math.max(1, Number(customStaggerMinutes?.value || 5)) * 60 * 1000;

    if (pendingEnqueueSource === "parser") {
      if (parsedTaskGroups.length === 0) return;
      const parserMode = document.querySelector('input[name="parserSchedMode"]:checked')?.value || "stagger";
      let customTs = 0;
      if (parserMode === "custom") {
        customTs = new Date(customScheduleTime?.value || "").getTime();
        if (!Number.isFinite(customTs) || customTs <= 0) {
          appendLog("请先填写有效的统一定时时间！", "warn");
          return;
        }
      }

      const baseTs = Date.now() + 10 * 60 * 1000;
      const schedList = parsedTaskGroups.map((t, idx) => {
        const fireTs = parserMode === "custom"
          ? (staggerEnabled ? customTs + idx * staggerStepMs : customTs)
          : (baseTs + idx * 5 * 60 * 1000);
        const fireStr = parserMode === "custom"
          ? formatDateTimeLocal(new Date(fireTs)).replace("T", " ")
          : new Date(fireTs).toLocaleString();
        return {
          id: `sched_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 5)}`,
          docName: t.docName || "任务解析",
          row: `${idx + 1}`,
          targetCell: "-",
          account: String(t.account || "").trim(),
          content: String(t.content || "").trim(),
          poll: t.poll
            ? {
                ...t.poll,
                title: String(t.poll.title || "").trim() || "参与投票",
                options: (t.poll.options || []).map((o) => String(o || "").trim()).filter(Boolean),
              }
            : null,
          repostUrl: t.repostUrl || "",
          commentOriginal: !!t.commentOriginal,
          imgUrls: [],
          fireAtTimestamp: fireTs,
          fireAtTime: fireStr,
          status: "pending",
          dryRun: isDryRun,
          createdAt: Date.now(),
        };
      });

      try {
        const resp = await chrome.runtime.sendMessage({
          action: "ADD_SCHEDULE_TASKS",
          tasks: schedList,
        });
        if (resp && resp.ok) {
          closeEnqueueScheduleModal();
          appendLog(`✅ 已将解析出的 ${schedList.length} 条任务按${parserMode === "custom" ? (staggerEnabled ? "统一时刻+自动错峰" : "统一时刻") : "错峰 5 分钟"}排入定时队列！`, "success");
          switchTab("schedule");
        } else {
          appendLog(`加入定时队列失败: ${resp?.error || "未知异常"}`, "error");
        }
      } catch (err) {
        appendLog(`加入定时队列异常: ${err.message}`, "error");
      }
      return;
    }

    const selected = getSelectedTasks();
    if (!selected.length) {
      appendLog("请先扫描并在列表中勾选要加入定时的任务！", "warn");
      return;
    }

    const mode = document.querySelector('input[name="schedMode"]:checked')?.value || "table";
    const baseCustomTs = mode === "custom" ? new Date(customScheduleTime?.value || "").getTime() : 0;
    if (mode === "custom" && (!Number.isFinite(baseCustomTs) || baseCustomTs <= 0)) {
      appendLog("请先填写有效的统一定时时间！", "warn");
      return;
    }

    const newSchedTasks = [];
    try {
      for (let idx = 0; idx < selected.length; idx++) {
        const item = selected[idx];
        let fireTimestamp = 0;
        let fireTimeStr = "";

        if (mode === "custom" && customScheduleTime.value) {
          fireTimestamp = staggerEnabled ? (baseCustomTs + idx * staggerStepMs) : baseCustomTs;
          fireTimeStr = formatDateTimeLocal(new Date(fireTimestamp)).replace("T", " ");
        } else if (item.time) {
          const parsed = parseTableTime(item.time);
          fireTimestamp = parsed.ts;
          fireTimeStr = parsed.text;
        } else {
          fireTimestamp = Date.now() + 15 * 60 * 1000;
          fireTimeStr = new Date(fireTimestamp).toLocaleTimeString();
        }

        newSchedTasks.push(Object.assign({}, item, {
          dryRun: isDryRun,
          fireAtTimestamp: fireTimestamp,
          fireAtTime: fireTimeStr,
        }));
      }
    } catch (err) {
      appendLog(`加入定时失败: ${err.message}`, "error");
      return;
    }

    try {
      const resp = await chrome.runtime.sendMessage({
        action: "ADD_SCHEDULE_TASKS",
        tasks: newSchedTasks,
      });

      if (resp && resp.ok) {
        closeEnqueueScheduleModal();
        appendLog(`已成功将 ${newSchedTasks.length} 条任务加入定时队列 [${isDryRun ? "演练" : "实盘"}]！`, "success");
        tabNavSchedule.click();
      } else {
        appendLog(`加入定时失败: ${resp?.error || "未知异常"}`, "error");
      }
    } catch (e) {
      appendLog(`加入定时异常: ${e.message}`, "error");
    }
  });

  function parseTableTime(timeStr) {
    const raw = String(timeStr || "")
      .replace(/：/g, ":")
      .replace(/(\d{1,2})[点时](\d{1,2})?分?/g, (_, h, min) => `${h}:${min || "00"}`)
      .trim();
    const now = new Date();

    // 1. 尝试识别包含日期的完整格式 (如 2026-11-12 18:30 或 11/12 18:30)
    const fullDateMatch = raw.match(/(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})[日\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (fullDateMatch) {
      const year = fullDateMatch[1] ? parseInt(fullDateMatch[1], 10) : now.getFullYear();
      const month = parseInt(fullDateMatch[2], 10) - 1;
      const day = parseInt(fullDateMatch[3], 10);
      const hour = parseInt(fullDateMatch[4], 10);
      const minute = parseInt(fullDateMatch[5], 10);
      const sec = fullDateMatch[6] ? parseInt(fullDateMatch[6], 10) : 0;
      const target = new Date(year, month, day, hour, minute, sec, 0);
      if (target.getFullYear() !== year || target.getMonth() !== month || target.getDate() !== day || hour > 23 || minute > 59 || sec > 59) {
        throw new Error(`日期或时间无效: ${raw}`);
      }
      return { ts: target.getTime(), text: target.toLocaleString() };
    }

    // 2. 只有“12日 18:30”这种没写月份的日期。不能退化成今天的 18:30。
    const dayOnly = raw.match(/(?:^|[^\d])(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (dayOnly) {
      const day = parseInt(dayOnly[1], 10);
      const hour = parseInt(dayOnly[2], 10);
      const minute = parseInt(dayOnly[3], 10);
      const sec = dayOnly[4] ? parseInt(dayOnly[4], 10) : 0;
      if (day < 1 || day > 31 || hour > 23 || minute > 59 || sec > 59) throw new Error(`日期或时间无效: ${raw}`);
      let target = new Date(now.getFullYear(), now.getMonth(), day, hour, minute, sec, 0);
      if (target.getDate() !== day) throw new Error(`日期或时间无效: ${raw}`);
      if (target.getTime() < now.getTime() - 30 * 60 * 1000) {
        target = new Date(now.getFullYear(), now.getMonth() + 1, day, hour, minute, sec, 0);
        if (target.getDate() !== day) throw new Error(`日期或时间无效: ${raw}`);
      }
      return { ts: target.getTime(), text: target.toLocaleString() };
    }

    // 3. 尝试仅时间格式 (如 18:30 或 18:30:00)
    const m = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      const second = Number(m[3] || 0);
      if (hour > 23 || minute > 59 || second > 59) throw new Error(`时间无效: ${raw}`);
      const target = new Date();
      target.setHours(hour, minute, second, 0);
      // 容错：若刚过去 30 分钟内（用户刚过整点才点加入定时），保留在今天立即触发，绝不误推迟到明天！
      if (target.getTime() < now.getTime() - 30 * 60 * 1000) {
        target.setDate(target.getDate() + 1);
      }
      return { ts: target.getTime(), text: target.toLocaleString() };
    }

    if (/(?:\d{4}[-/年])?\d{1,2}[-/月]\d{1,2}|\d{1,2}日/.test(raw)) {
      throw new Error(`日期缺少具体时刻，无法排程: ${raw}`);
    }

    const fallback = Date.now() + 15 * 60 * 1000;
    return { ts: fallback, text: new Date(fallback).toLocaleTimeString() };
  }

  // ── 9. 定时管理与批量排程控制器 ──
  // 9.1 分类过滤芯片切换
  schedFilterChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      schedFilterChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      currentSchedFilter = chip.dataset.filter || "all";
      refreshScheduleQueue();
    });
  });

  // 9.2 来源文档与关键词筛选切换
  if (schedDocFilter) {
    schedDocFilter.addEventListener("change", (e) => {
      currentSchedDoc = e.target.value || "all";
      refreshScheduleQueue();
    });
  }

  if (schedSearchInput) {
    schedSearchInput.addEventListener("input", () => {
      refreshScheduleQueue();
    });
  }

  // 9.3 批量全选与反选
  if (schedSelectAllCb) {
    schedSelectAllCb.addEventListener("change", (e) => {
      const isChecked = e.target.checked;
      const visibleCbs = schedListContainer.querySelectorAll(".sched-item-cb");
      visibleCbs.forEach((cb) => {
        cb.checked = isChecked;
        const id = cb.dataset.id;
        if (isChecked) selectedSchedIds.add(id);
        else selectedSchedIds.delete(id);
        const card = document.getElementById(`sched-card-${id}`);
        if (card) card.classList.toggle("is-selected", isChecked);
      });
      updateBatchToolbarUI();
    });
  }

  if (btnSchedInvertSelect) {
    btnSchedInvertSelect.addEventListener("click", () => {
      const visibleCbs = schedListContainer.querySelectorAll(".sched-item-cb");
      visibleCbs.forEach((cb) => {
        cb.checked = !cb.checked;
        const id = cb.dataset.id;
        if (cb.checked) selectedSchedIds.add(id);
        else selectedSchedIds.delete(id);
        const card = document.getElementById(`sched-card-${id}`);
        if (card) card.classList.toggle("is-selected", cb.checked);
      });
      updateBatchToolbarUI();
    });
  }

  // 9.4 批量立即发布
  if (btnBatchFireSched) {
    btnBatchFireSched.addEventListener("click", async () => {
      const targetIds = Array.from(selectedSchedIds);
      if (!targetIds.length) return;

      const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
      const targets = scheduledTasks.filter((t) => targetIds.includes(t.id) && t.status !== "done" && t.status !== "firing");
      if (!targets.length) {
        appendLog("所选任务均已发布完成或正在发布中", "warn");
        return;
      }

      const realCount = targets.filter((t) => t.dryRun === false).length;
      const dryCount = targets.length - realCount;
      const modeTip = realCount > 0
        ? `（含 ${realCount} 条【真实发博】${dryCount > 0 ? `、${dryCount} 条【安全演练】` : ""}）`
        : "（全部为安全演练）";
      if (!confirm(`确认要将已选中的 ${targets.length} 个定时任务执行【立即发布】吗？\n${modeTip}`)) return;

      btnBatchFireSched.disabled = true;
      btnBatchFireSched.title = "正在批量发布...";
      try {
        const resp = await chrome.runtime.sendMessage({
          action: "BATCH_FIRE_SCHEDULE",
          taskIds: targets.map((t) => t.id),
        });
        if (resp && resp.ok) {
          appendLog(`已成功触发 ${targets.length} 条任务批量立即发布！`, "success");
          selectedSchedIds.clear();
          refreshScheduleQueue();
        } else {
          appendLog(`批量发布失败: ${resp?.error || "未知异常"}`, "error");
        }
      } catch (err) {
        appendLog(`批量发布通讯异常: ${err.message}`, "error");
      } finally {
        btnBatchFireSched.disabled = false;
        btnBatchFireSched.title = "";
        refreshScheduleQueue();
      }
    });
  }

  // 9.5 批量取消/删除
  if (btnBatchDeleteSched) {
    btnBatchDeleteSched.addEventListener("click", async () => {
      const targetIds = Array.from(selectedSchedIds);
      if (!targetIds.length) return;

      if (!confirm(`确定要批量取消/删除选中的 ${targetIds.length} 项定时任务吗？`)) return;

      btnBatchDeleteSched.disabled = true;
      btnBatchDeleteSched.title = "正在删除...";
      try {
        const resp = await chrome.runtime.sendMessage({
          action: "BATCH_CANCEL_SCHEDULE",
          taskIds: targetIds,
        });
        if (resp && resp.ok) {
          appendLog(`已成功批量取消/删除 ${targetIds.length} 项任务！`, "success");
          selectedSchedIds.clear();
          refreshScheduleQueue();
        } else {
          appendLog(`批量删除失败: ${resp?.error || "未知异常"}`, "error");
        }
      } catch (err) {
        appendLog(`批量删除异常: ${err.message}`, "error");
      } finally {
        btnBatchDeleteSched.disabled = false;
        btnBatchDeleteSched.title = "";
        refreshScheduleQueue();
      }
    });
  }

  // 9.5b 批量顺延推迟
  async function handleBatchDelay(delayMinutes) {
    const targetIds = Array.from(selectedSchedIds);
    if (!targetIds.length) return;
    const allTasks = cachedScheduledTasks || [];
    const editable = allTasks.filter((t) => targetIds.includes(t.id) && (t.status === "pending" || t.status === "error"));
    if (!editable.length) {
      appendLog("所选任务均为发布中或已完成状态，无法推迟", "warn");
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({
        action: "BATCH_RESCHEDULE_TASKS",
        taskIds: editable.map((t) => t.id),
        options: { delayMinutes },
      });
      if (resp && resp.ok) {
        appendLog(`已将 ${editable.length} 条任务顺延 +${delayMinutes} 分钟！`, "success");
        selectedSchedIds.clear();
        refreshScheduleQueue();
      } else {
        appendLog(`批量推迟失败: ${resp?.error || "未知异常"}`, "error");
      }
    } catch (err) {
      appendLog(`批量推迟通讯异常: ${err.message}`, "error");
    }
  }

  btnBatchDelay15?.addEventListener("click", () => handleBatchDelay(15));
  btnBatchDelay30?.addEventListener("click", () => handleBatchDelay(30));

  // 9.6 更新批量操作栏 UI
  function updateBatchToolbarUI() {
    const allTasks = cachedScheduledTasks || [];
    const totalSelected = selectedSchedIds.size;
    if (schedSelectedCount) schedSelectedCount.textContent = totalSelected;
    if (schedBatchActions) {
      schedBatchActions.style.display = totalSelected > 0 ? "flex" : "none";
    }

    const visibleCbs = Array.from(schedListContainer.querySelectorAll(".sched-item-cb"));
    if (schedSelectAllCb) {
      if (visibleCbs.length > 0 && visibleCbs.every((cb) => cb.checked)) {
        schedSelectAllCb.checked = true;
        schedSelectAllCb.indeterminate = false;
      } else if (visibleCbs.some((cb) => cb.checked)) {
        schedSelectAllCb.checked = false;
        schedSelectAllCb.indeterminate = true;
      } else {
        schedSelectAllCb.checked = false;
        schedSelectAllCb.indeterminate = false;
      }
    }

    // 检查已选中有多少是可立即发布/改期的（非 done 且非 firing）
    const fireable = allTasks.filter((t) => selectedSchedIds.has(t.id) && t.status !== "done" && t.status !== "firing");

    if (btnBatchDelay15) btnBatchDelay15.disabled = fireable.length === 0;
    if (btnBatchDelay30) btnBatchDelay30.disabled = fireable.length === 0;

    if (btnBatchFireSched) {
      if (fireable.length > 0) {
        btnBatchFireSched.disabled = false;
        if (batchFireCount) batchFireCount.textContent = fireable.length;
      } else {
        btnBatchFireSched.disabled = true;
        if (batchFireCount) batchFireCount.textContent = "0";
      }
    }

    if (btnBatchDeleteSched) {
      if (totalSelected > 0) {
        btnBatchDeleteSched.disabled = false;
        if (batchDelCount) batchDelCount.textContent = totalSelected;
      } else {
        btnBatchDeleteSched.disabled = true;
        if (batchDelCount) batchDelCount.textContent = "0";
      }
    }
  }

  // 9.7 刷新排程列表
  btnRefreshSched.addEventListener("click", refreshScheduleQueue);

  if (btnClearDoneSched) {
    btnClearDoneSched.addEventListener("click", async () => {
      try {
        const resp = await chrome.runtime.sendMessage({ action: "CLEAR_DONE_SCHEDULE" });
        if (resp && resp.ok) {
          const cleared = resp.res?.cleared || 0;
          const kept = resp.res?.keptWriteBackFailed || 0;
          if (cleared === 0 && kept === 0) {
            appendLog("当前没有可清理的已完成记录", "info");
          } else {
            appendLog(`已清理 ${cleared} 条已完成记录${kept > 0 ? `（保留 ${kept} 条待补写文档条目）` : ""}`, "success");
          }
          selectedSchedIds.clear();
          refreshScheduleQueue();
        } else {
          appendLog(`清理已完成失败: ${resp?.error || "未知异常"}`, "error");
        }
      } catch (err) {
        appendLog(`清理已完成异常: ${err.message}`, "error");
      }
    });
  }

  if (btnClearAllSched) {
    btnClearAllSched.addEventListener("click", async () => {
      if (!confirm("⚠️ 确定要清空全部定时任务及后台闹钟吗？此操作不可逆！")) return;
      try {
        const resp = await chrome.runtime.sendMessage({ action: "CLEAR_ALL_SCHEDULE" });
        if (resp && resp.ok) {
          selectedSchedIds.clear();
          refreshScheduleQueue();
        } else {
          appendLog(`清空定时队列失败: ${resp?.error || "未知异常"}`, "error");
        }
      } catch (err) {
        appendLog(`清空定时队列异常: ${err.message}`, "error");
      }
    });
  }

  async function refreshScheduleQueue() {
    const { scheduledTasks = [], schedulePaused = false } = await chrome.storage.local.get(["scheduledTasks", "schedulePaused"]);
    cachedScheduledTasks = scheduledTasks;
    const validSelectableIds = new Set(
      scheduledTasks.filter((t) => t && (t.status === "pending" || t.status === "error")).map((t) => t.id)
    );
    for (const sid of Array.from(selectedSchedIds)) {
      if (!validSelectableIds.has(sid)) selectedSchedIds.delete(sid);
    }
    updateBatchToolbarUI();
    schedQueueCount.textContent = `${scheduledTasks.length} 条`;

    // 若发现已到期的 pending 任务或残留 firing 任务且未暂停，主动唤醒后台扫描/自愈
    if (!schedulePaused) {
      const hasDuePending = scheduledTasks.some((t) => t.status === "pending" && Number(t.fireAtTimestamp || 0) <= Date.now() + 2000);
      const hasFiring = scheduledTasks.some((t) => t.status === "firing");
      if (hasDuePending || hasFiring) {
        try {
          chrome.runtime.sendMessage({ action: "SWEEP_DUE_SCHEDULES" }, () => {
            if (chrome.runtime.lastError) {}
          });
        } catch (_) {}
      }
    }

    // 统计各状态数量
    const countAll = scheduledTasks.length;
    const countPending = scheduledTasks.filter((t) => t.status === "pending" || t.status === "firing").length;
    const countDone = scheduledTasks.filter((t) => t.status === "done").length;
    const countError = scheduledTasks.filter((t) => t.status === "error").length;

    schedFilterChips.forEach((chip) => {
      const f = chip.dataset.filter;
      if (f === "all") chip.textContent = `全部 (${countAll})`;
      if (f === "pending") chip.textContent = `待触发 (${countPending})`;
      if (f === "done") chip.textContent = `已完成 (${countDone})`;
      if (f === "error") chip.textContent = `异常 (${countError})`;
    });

    if (countPending > 0) {
      schedBadge.style.display = "inline-block";
      schedBadge.textContent = countPending;
    } else {
      schedBadge.style.display = "none";
    }

    // 更新来源文档下拉选项 (精简文案防挤压)
    if (schedDocFilter) {
      const docMap = new Map();
      scheduledTasks.forEach((t) => {
        const u = String(t.docUrl || "").trim();
        const name = t.docName || "未知文档";
        if (u) {
          docMap.set(u, { name, count: (docMap.get(u)?.count || 0) + 1 });
        }
      });

      let optsHtml = `<option value="all">全部文档 (${countAll})</option>`;
      docMap.forEach((val, url) => {
        optsHtml += `<option value="${escapeHtml(url)}">${escapeHtml(val.name)} (${val.count})</option>`;
      });
      schedDocFilter.innerHTML = optsHtml;
      schedDocFilter.value = currentSchedDoc;
    }

    // 过滤任务并按紧迫度排序：发布中 -> 异常 -> 待触发（时间升序） -> 已完成（时间降序）
    const schedQuery = String(schedSearchInput?.value || "").trim().toLowerCase();
    const statusOrder = { firing: 0, error: 1, pending: 2, done: 3 };
    const filteredTasks = scheduledTasks
      .filter((t) => {
        if (currentSchedFilter === "pending" && t.status !== "pending" && t.status !== "firing") return false;
        if (currentSchedFilter === "done" && t.status !== "done") return false;
        if (currentSchedFilter === "error" && t.status !== "error") return false;

        if (currentSchedDoc !== "all" && String(t.docUrl || "").trim() !== currentSchedDoc) return false;
        if (schedQuery) {
          const hitAcct = String(t.account || "").toLowerCase().includes(schedQuery);
          const hitContent = String(t.content || "").toLowerCase().includes(schedQuery);
          const hitDoc = String(t.docName || "").toLowerCase().includes(schedQuery);
          if (!hitAcct && !hitContent && !hitDoc) return false;
        }
        return true;
      })
      .slice()
      .sort((a, b) => {
        const oa = statusOrder[a.status] ?? 9;
        const ob = statusOrder[b.status] ?? 9;
        if (oa !== ob) return oa - ob;
        const ta = Number(a.fireAtTimestamp || a.createdAt || 0);
        const tb = Number(b.fireAtTimestamp || b.createdAt || 0);
        return a.status === "done" ? tb - ta : ta - tb;
      });

    schedListContainer.innerHTML = "";
    if (filteredTasks.length === 0) {
      schedListContainer.innerHTML = `<div class="empty-placeholder">${scheduledTasks.length === 0 ? "暂无定时任务，可在【📋 同步发布】或【✨ 任务解析】中加入" : "当前筛选条件下无任务"}</div>`;
      updateBatchToolbarUI(scheduledTasks);
      return;
    }

    filteredTasks.forEach((t) => {
      const card = document.createElement("div");
      card.className = "sched-item-card";
      card.id = `sched-card-${t.id}`;
      if (t.status === "pending") card.classList.add("is-pending");
      if (t.status === "done") card.classList.add("is-done");
      if (t.status === "error") card.classList.add("is-error");
      if (selectedSchedIds.has(t.id)) card.classList.add("is-selected");

      const docName = t.docName || `文档 ${t.docIndex || 1}`;
      const remainingSecs = Math.max(0, Math.round((t.fireAtTimestamp - Date.now()) / 1000));

      let statusClass = "pending";
      let statusText = "待触发";
      let countdownHtml = `<span class="sched-countdown" data-fire-at="${Number(t.fireAtTimestamp || 0)}">${formatRemaining(remainingSecs)}</span>`;

      if (t.status === "done") {
        statusClass = t.preparedOnly || t.dryRun !== false ? "pending" : (t.writeBackOk ? "done" : t.writeBackError ? "error" : "done");
        statusText = t.preparedOnly ? "待人工发送" : t.dryRun !== false ? "演练完成" : (t.writeBackOk ? "已发布" : t.writeBackError ? "发布成功（回写失败）" : "已发布");
        countdownHtml = "";
      } else if (t.status === "firing") {
        statusClass = "firing";
        statusText = "发布中...";
        countdownHtml = "";
      } else if (t.status === "error") {
        statusClass = "error";
        statusText = "异常";
        countdownHtml = "";
      }

      const cellHint = t.targetCell && t.targetCell !== "-" ? ` · ${escapeHtml(t.targetCell)}` : "";
      const rowHint = t.row && t.row !== "-" ? ` · #行${t.row}` : "";
      const pollMeta = t.poll ? `<span class="sched-sub-meta is-poll">📊 投票</span>` : "";
      const imgMeta = (t.imgUrls && t.imgUrls.length > 0)
        ? `<span class="sched-sub-meta is-img btn-sched-img-preview" data-id="${t.id}" title="点击放大预览全部配图">🖼️ ${t.imgUrls.length}图</span>`
        : "";

      const isChecked = selectedSchedIds.has(t.id);

      card.innerHTML = `
        <input type="checkbox" class="task-item-cb sched-item-cb" data-id="${t.id}" ${isChecked ? "checked" : ""} style="margin-top: 4px;">
        <div class="sched-card-body">
          <div class="sched-card-header">
            <div class="sched-card-left-meta">
              <span class="sched-acct-name">👤 ${escapeHtml(t.account || "默认账号")}</span>
              ${pollMeta}
              ${imgMeta}
            </div>
            <div class="sched-card-right-status">
              <span class="sched-time-text">🕒 ${escapeHtml(t.fireAtTime || "")}</span>
              ${countdownHtml}
              <span class="sched-status-pill ${statusClass}" title="${escapeHtml(t.error || t.writeBackError || "")}">${statusText}</span>
            </div>
          </div>

          <div class="sched-card-content" title="${escapeHtml(t.content)}">${escapeHtml(t.content)}</div>

          ${t.status === "error" && t.error ? `
            <div style="font-size:11px;color:#991B1B;background:#FEF2F2;padding:4px 8px;border-radius:4px;border:1px solid #FECACA;">
              ⚠ 异常原因: ${escapeHtml(t.error)}
            </div>
          ` : ""}
          ${t.status === "done" && !t.writeBackOk && t.writeBackError ? `
            <div style="font-size:11px;color:#92400E;background:#FFFBEB;padding:4px 8px;border-radius:4px;border:1px solid #FDE68A;">
              ⚠ 回写失败原因: ${escapeHtml(t.writeBackError)}
            </div>
          ` : ""}

          <div class="sched-card-footer">
            <div class="sched-card-tags">
              <span class="sched-sub-meta">📄 ${escapeHtml(docName)}${rowHint}${cellHint}</span>
              <span class="sched-mode-dot ${t.dryRun !== false ? "is-dry" : "is-live"}">${t.dryRun !== false ? "演练" : "实盘"}</span>
              ${t.postUrl ? `<a href="${escapeHtml(t.postUrl)}" target="_blank" style="color:var(--primary);text-decoration:none;font-weight:600;">🔗 微博直链 ↗</a>` : ""}
            </div>
            <div class="sched-card-actions">
              ${(t.status === "pending" || t.status === "error") ? `
                <button type="button" class="sched-btn-clean primary btn-fire-now" data-id="${t.id}">🚀 立即发布</button>
                <button type="button" class="sched-btn-clean btn-delay-10" data-id="${t.id}" title="顺延10分钟">+10分</button>
                <button type="button" class="sched-btn-clean btn-edit-task" data-id="${t.id}">✏️ 编辑</button>
                <button type="button" class="sched-btn-clean danger btn-cancel-sched" data-id="${t.id}">🗑️ 取消</button>
              ` : ""}
              ${(t.status === "done" && t.postUrl && !t.writeBackOk && t.dryRun === false && !t.preparedOnly && t.targetCell && t.targetCell !== "-" && t.docUrl) ? `
                <button type="button" class="sched-btn-clean primary btn-retry-writeback" data-id="${t.id}">📝 补写文档</button>
              ` : ""}
              ${t.status === "done" ? `
                <button type="button" class="sched-btn-clean btn-cancel-sched" data-id="${t.id}">🗑️ 删除</button>
              ` : ""}
            </div>
          </div>
        </div>
      `;

      schedListContainer.appendChild(card);
    });

    // 绑定卡片复选框
    schedListContainer.querySelectorAll(".sched-item-cb").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const id = e.target.dataset.id;
        if (e.target.checked) selectedSchedIds.add(id);
        else selectedSchedIds.delete(id);
        const card = document.getElementById(`sched-card-${id}`);
        if (card) card.classList.toggle("is-selected", e.target.checked);
        updateBatchToolbarUI();
      });
    });

    // 绑定单条操作
    schedListContainer.querySelectorAll(".btn-sched-img-preview").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const target = cachedScheduledTasks.find((t) => t.id === el.dataset.id);
        const imgs = Array.isArray(target?.imgUrls) ? target.imgUrls.filter(Boolean).slice(0, 9) : [];
        if (imgs.length > 0) {
          openImagePreview(imgs, 0, target.docUrl || "");
        }
      });
    });

    schedListContainer.querySelectorAll(".sched-card-content").forEach((el) => {
      el.addEventListener("click", () => {
        el.classList.toggle("is-expanded");
      });
    });

    schedListContainer.querySelectorAll(".btn-delay-10").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        try {
          const resp = await chrome.runtime.sendMessage({
            action: "BATCH_RESCHEDULE_TASKS",
            taskIds: [id],
            options: { delayMinutes: 10 },
          });
          if (!resp?.ok) throw new Error(resp?.error || "顺延失败");
          appendLog(`任务 [${id}] 已顺延 +10 分钟`, "success");
          await refreshScheduleQueue();
        } catch (err) {
          appendLog(`顺延失败: ${err.message}`, "error");
        }
      });
    });

    schedListContainer.querySelectorAll(".btn-fire-now").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        appendLog(`准备立即触发任务: [${id}]`, "info");
        try {
          const resp = await chrome.runtime.sendMessage({ action: "FIRE_SCHEDULE_NOW", taskId: id });
          if (!resp?.ok) throw new Error(resp?.error || "触发立即发布失败");
          await refreshScheduleQueue();
        } catch (err) {
          appendLog(`立即发布失败: ${err.message}`, "error");
        }
      });
    });

    schedListContainer.querySelectorAll(".btn-edit-task").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        openEditScheduleModal(id);
      });
    });

    schedListContainer.querySelectorAll(".btn-cancel-sched").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        await chrome.runtime.sendMessage({ action: "CANCEL_SCHEDULE_TASK", taskId: id });
        selectedSchedIds.delete(id);
        refreshScheduleQueue();
      });
    });

    schedListContainer.querySelectorAll(".btn-retry-writeback").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const target = cachedScheduledTasks.find((t) => t.id === id);
        if (!target) return;
        btn.disabled = true;
        btn.textContent = "⏳ 补写中...";
        try {
          const resp = await chrome.runtime.sendMessage({
            action: "RETRY_WRITE_BACK",
            payload: {
              scheduleId: target.id,
              docUrl: target.docUrl,
              docName: target.docName,
              row: target.row,
              targetCell: target.targetCell,
              targetSheetId: target.targetSheetId,
              postUrl: target.postUrl,
            },
          });
          if (!resp?.ok) {
            appendLog(`补写失败: ${resp?.error || "未知异常"}`, "error");
          }
        } catch (err) {
          appendLog(`补写通信异常: ${err?.message || String(err)}`, "error");
        } finally {
          refreshScheduleQueue();
        }
      });
    });

    updateBatchToolbarUI();
  }

  // 定时管理面板可见时，每秒局部刷新待触发倒计时，不重绘列表
  if (typeof setInterval === "function") {
    setInterval(() => {
      if (!panelSchedule || panelSchedule.style.display === "none" || !schedListContainer) return;
      const now = Date.now();
      schedListContainer.querySelectorAll(".sched-countdown[data-fire-at]").forEach((el) => {
        const fireAt = Number(el.dataset.fireAt || 0);
        if (!fireAt) return;
        const secs = Math.max(0, Math.round((fireAt - now) / 1000));
        el.textContent = formatRemaining(secs);
      });
    }, 1000);
  }

  // ── 9.8 编辑定时博文模态弹窗逻辑 ──
  async function openEditScheduleModal(taskId) {
    const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
    const task = scheduledTasks.find((t) => t.id === taskId);
    if (!task) return;

    editModalTaskId.value = task.id;
    editModalAccount.value = task.account || "";
    editModalContent.value = task.content || "";
    updateEditModalCharCount();

    editModalDateTime.value = task.fireAtTimestamp && Number.isFinite(new Date(task.fireAtTimestamp).getTime())
      ? formatDateTimeLocal(new Date(task.fireAtTimestamp))
      : "";

    const dryRadio = document.querySelector(`input[name="editModalDryRun"][value="${task.dryRun !== false ? "true" : "false"}"]`);
    if (dryRadio) dryRadio.checked = true;

    // 渲染配图
    if (task.imgUrls && task.imgUrls.length > 0) {
      const modalImgs = task.imgUrls.filter(Boolean).slice(0, 9);
      editModalImagesGroup.style.display = "block";
      editModalImagesList.innerHTML = modalImgs.map((u, imgIdx) => `
        <img src="${escapeHtml(getPreviewImageSrc(u))}" class="modal-thumb-img" referrerpolicy="no-referrer" data-img-index="${imgIdx}" data-raw-url="${escapeHtml(u)}" title="点击放大预览配图 ${imgIdx + 1}">
      `).join("");
      bindThumbImages(editModalImagesList, modalImgs, task.docUrl || "");
    } else {
      editModalImagesGroup.style.display = "none";
      editModalImagesList.innerHTML = "";
    }

    // 渲染投票配置
    if (task.poll) {
      if (editModalPollTitle) editModalPollTitle.value = task.poll.title || "";
      if (editModalPollOpt1) editModalPollOpt1.value = task.poll.options?.[0] || "";
      if (editModalPollOpt2) editModalPollOpt2.value = task.poll.options?.[1] || "";
      if (editModalPollOpt3) editModalPollOpt3.value = task.poll.options?.[2] || "";
      if (editModalPollOpt4) editModalPollOpt4.value = task.poll.options?.[3] || "";
      const days = task.poll.days || 30;
      const dRadio = document.querySelector(`input[name="editPollDays"][value="${days}"]`);
      if (dRadio) dRadio.checked = true;
    } else {
      if (editModalPollTitle) editModalPollTitle.value = "";
      if (editModalPollOpt1) editModalPollOpt1.value = "";
      if (editModalPollOpt2) editModalPollOpt2.value = "";
      if (editModalPollOpt3) editModalPollOpt3.value = "";
      if (editModalPollOpt4) editModalPollOpt4.value = "";
    }

    scheduleEditModal.style.display = "flex";
  }

  function closeEditScheduleModal() {
    scheduleEditModal.style.display = "none";
  }

  if (btnEditModalClose) btnEditModalClose.addEventListener("click", closeEditScheduleModal);
  if (btnEditModalCancel) btnEditModalCancel.addEventListener("click", closeEditScheduleModal);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (imagePreviewModal && imagePreviewModal.style.display === "flex") {
      closeImagePreview();
    } else if (enqueueScheduleModal && enqueueScheduleModal.style.display === "flex") {
      closeEnqueueScheduleModal();
    } else if (scheduleEditModal && scheduleEditModal.style.display === "flex") {
      closeEditScheduleModal();
    }
  });

  // 弹窗快捷推迟芯片
  document.querySelectorAll("[data-edit-min]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const min = parseInt(btn.dataset.editMin, 10);
      const targetDate = new Date(Date.now() + min * 60 * 1000);
      editModalDateTime.value = formatDateTimeLocal(targetDate);
    });
  });

  document.querySelectorAll("[data-edit-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.editPreset;
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + 1);
      if (preset === "tomorrow-10") targetDate.setHours(10, 0, 0, 0);
      if (preset === "tomorrow-15") targetDate.setHours(15, 0, 0, 0);
      editModalDateTime.value = formatDateTimeLocal(targetDate);
    });
  });

  function updateEditModalCharCount() {
    const len = (editModalContent.value || "").length;
    if (editModalCharCount) editModalCharCount.textContent = `${len} 字`;
  }
  if (editModalContent) editModalContent.addEventListener("input", updateEditModalCharCount);

  // 保存修改
  if (btnEditModalSave) {
    btnEditModalSave.addEventListener("click", async () => {
      const taskId = editModalTaskId.value;
      const newAccount = editModalAccount.value.trim();
      const newContent = editModalContent.value.trim();
      const newDateVal = editModalDateTime.value;

      if (!newContent) {
        alert("博文内容不能为空！");
        return;
      }

      let fireTs = 0;
      let fireStr = "";
      if (newDateVal) {
        fireTs = new Date(newDateVal).getTime();
        fireStr = newDateVal.replace("T", " ");
      }

      // 提取附加投票配置
      let pollData = null;
      const pTitle = editModalPollTitle?.value.trim() || "";
      const pOpt1 = editModalPollOpt1?.value.trim() || "";
      const pOpt2 = editModalPollOpt2?.value.trim() || "";
      const pOpt3 = editModalPollOpt3?.value.trim() || "";
      const pOpt4 = editModalPollOpt4?.value.trim() || "";
      const pollOpts = [pOpt1, pOpt2, pOpt3, pOpt4].filter(Boolean);
      if (pollOpts.length >= 2) {
        const checkedDayRadio = document.querySelector('input[name="editPollDays"]:checked');
        const days = checkedDayRadio ? parseInt(checkedDayRadio.value, 10) : 30;
        pollData = {
          title: pTitle || "投票",
          options: pollOpts,
          days: days,
        };
      }

      const editDryVal = document.querySelector('input[name="editModalDryRun"]:checked')?.value;
      const editDryUpdates = editDryVal != null ? { dryRun: editDryVal === "true" } : {};

      try {
        const resp = await chrome.runtime.sendMessage({
          action: "UPDATE_SCHEDULE_TASK",
          taskId: taskId,
          updates: {
            account: newAccount,
            content: newContent,
            fireAtTimestamp: fireTs || null,
            fireAtTime: fireStr || null,
            poll: pollData,
            ...editDryUpdates,
          },
        });
        if (resp && resp.ok) {
          appendLog(`定时任务 [${taskId}] 已成功保存修改！`, "success");
          closeEditScheduleModal();
          refreshScheduleQueue();
        } else {
          alert(`保存修改失败: ${resp?.error || "未知异常"}`);
        }
      } catch (err) {
        alert(`保存修改通讯异常: ${err.message}`);
      }
    });
  }

  // 弹窗内立即发布
  if (btnEditModalFireNow) {
    btnEditModalFireNow.addEventListener("click", async () => {
      const taskId = editModalTaskId.value;
      const newAccount = editModalAccount.value.trim();
      const newContent = editModalContent.value.trim();

      if (!newContent) {
        alert("博文内容不能为空！");
        return;
      }

      if (!confirm("确认对该任务执行【立即发布】吗？")) return;

      // 提取附加投票配置
      let pollData = null;
      const pTitle = editModalPollTitle?.value.trim() || "";
      const pOpt1 = editModalPollOpt1?.value.trim() || "";
      const pOpt2 = editModalPollOpt2?.value.trim() || "";
      const pOpt3 = editModalPollOpt3?.value.trim() || "";
      const pOpt4 = editModalPollOpt4?.value.trim() || "";
      const pollOpts = [pOpt1, pOpt2, pOpt3, pOpt4].filter(Boolean);
      if (pollOpts.length >= 2) {
        const checkedDayRadio = document.querySelector('input[name="editPollDays"]:checked');
        const days = checkedDayRadio ? parseInt(checkedDayRadio.value, 10) : 30;
        pollData = {
          title: pTitle || "投票",
          options: pollOpts,
          days: days,
        };
      }

      const editDryVal = document.querySelector('input[name="editModalDryRun"]:checked')?.value;
      const editDryUpdates = editDryVal != null ? { dryRun: editDryVal === "true" } : {};

      try {
        const saved = await chrome.runtime.sendMessage({
          action: "UPDATE_SCHEDULE_TASK",
          taskId: taskId,
          updates: { account: newAccount, content: newContent, poll: pollData, ...editDryUpdates },
        });
        if (!saved?.ok) throw new Error(saved?.error || "保存任务失败，已取消立即发布");

        const fired = await chrome.runtime.sendMessage({ action: "FIRE_SCHEDULE_NOW", taskId: taskId });
        if (!fired?.ok) throw new Error(fired?.error || "触发立即发布失败");
        closeEditScheduleModal();
        appendLog(`已触发任务: [${taskId}]`, "info");
        refreshScheduleQueue();
      } catch (err) {
        alert(`触发立即发布异常: ${err.message}`);
      }
    });
  }

  function formatRemaining(secs) {
    if (secs <= 0) return "即将触发";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return `${h}小时${m % 60}分后`;
    }
    return `${m}分${s}秒后`;
  }

  // ── 10. 日志与全局通信 ──
  function renderLogItem(msg, type = "info", timeStr = null) {
    const isNearBottom = logWindow
      ? (logWindow.scrollHeight - logWindow.scrollTop - logWindow.clientHeight < 32)
      : true;
    const item = document.createElement("div");
    item.className = `log-item ${type}`;
    const time = timeStr || new Date().toLocaleTimeString("zh-CN", { hour12: false });
    item.textContent = `[${time}] ${msg}`;
    logWindow.appendChild(item);
    if (isNearBottom) {
      logWindow.scrollTop = logWindow.scrollHeight;
    }
    if (logStatusPeek) logStatusPeek.textContent = msg.substring(0, 30);
    if (type === "error" && logWindow?.classList.contains("collapsed")) {
      logWindow.classList.remove("collapsed");
      logArrow?.classList.remove("collapsed");
    }
  }

  function appendLog(msg, type = "info") {
    renderLogItem(msg, type);
  }

  btnCopyLog?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const text = String(logWindow?.innerText || logWindow?.textContent || "").trim();
    if (!text) {
      appendLog("当前暂无日志可复制", "warn");
      return;
    }
    const ok = await writeTextToClipboard(text);
    if (ok) {
      const orig = btnCopyLog.textContent;
      btnCopyLog.textContent = "✅ 已复制";
      setTimeout(() => { btnCopyLog.textContent = orig; }, 1500);
    } else {
      appendLog("复制日志失败，请检查剪贴板权限", "error");
    }
  });

  btnClearLog.addEventListener("click", () => {
    logWindow.innerHTML = "";
    chrome.runtime.sendMessage({ action: "CLEAR_LOGS" });
  });

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "SCHEDULE_UPDATED") {
      refreshScheduleQueue().then(() => {
        if (scannedTasks.length > 0) renderTaskList(scannedTasks);
      });
    }

    if (request.action === "LEDGER_UPDATED") {
      if (panelLedger && panelLedger.style.display !== "none") {
        renderLedgerList();
      }
    }

    if (request.action === "TASK_ITEM_COMPLETED") {
      const result = request.payload || {};
      const card = document.getElementById(getTaskCardId(result));
      if (card) {
        const published = !result.dryRun && !result.preparedOnly;
        card.classList.toggle("is-completed", published);
        const meta = card.querySelector(".sched-card-left-meta, .task-item-meta");
        if (meta) {
          let doneTag = meta.querySelector(".task-done-badge");
          if (!doneTag) {
            doneTag = document.createElement("span");
            meta.appendChild(doneTag);
          }
          doneTag.className = `sched-status-pill ${published ? "done" : "pending"} task-done-badge`;
          doneTag.textContent = result.preparedOnly
            ? (result.manualImagesRequired ? "📝 投票已装配，配图需人工补传" : "📝 投票已装配，待人工发送")
            : result.dryRun ? "🛡️ 演练完成，未发布或写回"
            : result.writeBackOk ? `✅ ${result.targetCell} 已写回`
            : result.writeBackError ? "⚠️ 已发布，回写失败"
            : "✅ 已发布，未写回";
          if (result.writeBackError) doneTag.title = result.writeBackError;
        }
        if (published && result.writeBackOk) {
          const doneKey = getTaskCardId(result);
          scannedTasks = scannedTasks.filter((t) => getTaskCardId(t) !== doneKey);
          chrome.storage.local.set({
            cachedScannedTasks: scannedTasks,
            cachedScannedAt: scannedTasks.length > 0 ? Date.now() : 0,
          }).catch(() => {});
          // 复选框的 data-task-index 指向渲染时的数组下标，数组缩短后必须重绘，
          // 否则后续勾选会把索引错位到相邻行，发错账号。
          renderTaskList(scannedTasks);
        }
      }
    }

    if (request.action === "PIPELINE_LOG") {
      const { detail, level, time } = request.payload;
      renderLogItem(detail, level, time);
    }

    if (request.action === "PIPELINE_PROGRESS") {
      const { stage, percentage, isRunning } = request.payload;
      if (typeof isRunning === "boolean") updatePipelineControls(isRunning);
      progressWrap.style.display = "block";
      progressStage.textContent = stage;
      progressPct.textContent = `${percentage}%`;
      progressBar.style.width = `${percentage}%`;
    }
  });

  // ── 11. 开始即时发布 ──
  btnStart.addEventListener("click", async () => {
    const validSlots = docSlots.filter((s) => s.url && s.url.trim().startsWith("http"));
    if (validSlots.length === 0) {
      appendLog("请先填入至少一个云文档链接！", "error");
      return;
    }

    const selectedTasks = getSelectedTasks();
    if (scannedTasks.length > 0 && selectedTasks.length === 0) {
      appendLog("当前未勾选任何任务行！", "warn");
      return;
    }

    saveSlotsConfig();

    updatePipelineControls(true);
    progressWrap.style.display = "block";
    progressBar.style.width = "5%";
    progressPct.textContent = "5%";
    progressStage.textContent = "正在启动多文档同步流水线...";

    try {
      const resp = await chrome.runtime.sendMessage({
        action: "START_PIPELINE",
        config: {
          docs: validSlots.map((s, idx) => ({
            id: s.id,
            name: s.name || `文档 ${idx + 1}`,
            url: s.url.trim(),
            linkCol: (s.linkCol || "E").trim().toUpperCase(),
          })),
          dryRun: dryRunToggle.checked,
          silentMode: silentModeToggle ? silentModeToggle.checked : true,
          selectedTasks: selectedTasks.length > 0 ? selectedTasks : null,
        },
      });

      if (resp && resp.ok) {
        appendLog(`处理完成: ${formatPipelineSummary(resp.summary)}`, "success");
      } else {
        appendLog(`流水线报错: ${resp?.error || "未知异常"}`, "error");
      }
    } catch (err) {
      appendLog(`通讯异常: ${err.message}`, "error");
    } finally {
      await refreshPipelineControls();
    }
  });

  async function handleStopPipelineClick() {
    if (btnStop) btnStop.textContent = "⏳ 停止中...";
    if (btnGlobalStop) btnGlobalStop.textContent = "⏳ 停止中...";
    try {
      const resp = await chrome.runtime.sendMessage({ action: "STOP_PIPELINE" });
      appendLog(resp?.message || "已向后台发送停止指令", "warn");
    } catch (err) {
      appendLog(`停止失败: ${err.message}`, "error");
    }
  }

  btnStop.addEventListener("click", handleStopPipelineClick);
  btnGlobalStop?.addEventListener("click", handleStopPipelineClick);

  // ── 12. 定时队列全局一键暂停 / 恢复控制器 ──
  async function updateSchedulePauseUI() {
    const { schedulePaused = false } = await chrome.storage.local.get(["schedulePaused"]);
    if (btnTogglePauseSched) {
      if (schedulePaused) {
        btnTogglePauseSched.textContent = "▶ 恢复定时";
        btnTogglePauseSched.style.color = "#059669";
        btnTogglePauseSched.style.borderColor = "#6EE7B7";
      } else {
        btnTogglePauseSched.textContent = "⏸ 暂停定时";
        btnTogglePauseSched.style.color = "#D97706";
        btnTogglePauseSched.style.borderColor = "#FCD34D";
      }
    }
    if (schedulePauseToggle) {
      schedulePauseToggle.checked = schedulePaused;
    }
    if (schedPausedBanner) {
      schedPausedBanner.style.display = schedulePaused ? "flex" : "none";
    }
  }

  schedulePauseToggle?.addEventListener("change", async () => {
    const newPaused = !!schedulePauseToggle.checked;
    await chrome.storage.local.set({ schedulePaused: newPaused });
    updateSchedulePauseUI();
    if (!newPaused) {
      chrome.runtime.sendMessage({ action: "SWEEP_DUE_SCHEDULES" }, () => { if (chrome.runtime.lastError) {} });
    }
    appendLog(newPaused ? "⏸️ 定时队列已全局暂停挂起" : "▶️ 定时队列已恢复正常触发", newPaused ? "warn" : "success");
  });

  btnTogglePauseSched?.addEventListener("click", async () => {
    const { schedulePaused = false } = await chrome.storage.local.get(["schedulePaused"]);
    const newPaused = !schedulePaused;
    await chrome.storage.local.set({ schedulePaused: newPaused });
    updateSchedulePauseUI();
    if (!newPaused) {
      chrome.runtime.sendMessage({ action: "SWEEP_DUE_SCHEDULES" }, () => { if (chrome.runtime.lastError) {} });
    }
    appendLog(newPaused ? "⏸️ 定时队列已全局暂停挂起，到期任务将不会自动触发" : "▶️ 定时队列已恢复正常，到期将准时自动触发发博", newPaused ? "warn" : "success");
  });

  btnResumeSchedQuick?.addEventListener("click", async () => {
    await chrome.storage.local.set({ schedulePaused: false });
    updateSchedulePauseUI();
    chrome.runtime.sendMessage({ action: "SWEEP_DUE_SCHEDULES" }, () => { if (chrome.runtime.lastError) {} });
    appendLog("▶️ 定时队列已恢复正常触发", "success");
  });

  // ── 13. 发博流水账本控制器 (Publish Ledger) ──
  async function writeTextToClipboard(text) {
    const content = String(text || "");
    if (!content) return false;
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(content);
        return true;
      } catch (_) {}
    }
    if (typeof document.createElement === "function" && document.body && typeof document.execCommand === "function") {
      try {
        const ta = document.createElement("textarea");
        ta.value = content;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select?.();
        const ok = document.execCommand("copy");
        ta.remove?.();
        return !!ok;
      } catch (_) {}
    }
    return false;
  }

  function formatLedgerCopyLine(item) {
    const acct = String(item?.account || "").trim();
    const url = String(item?.postUrl || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) return "";
    return acct ? `${acct} ${url}` : url;
  }

  function filterLedgerItems(publishLedger) {
    const query = (ledgerSearchInput?.value || "").trim().toLowerCase();
    const docFilter = ledgerDocFilter?.value || "all";
    return (publishLedger || []).filter((item) => {
      if (currentLedgerFilter === "live" && item.mode !== "真实发布") return false;
      if (currentLedgerFilter === "writeback_fail" && !(item.mode === "真实发布" && item.postUrl && !item.writeBackOk)) return false;
      if (docFilter !== "all" && item.docName !== docFilter) return false;
      if (query) {
        const mAcct = String(item.account || "").toLowerCase().includes(query);
        const mContent = String(item.fullContent || item.contentSummary || "").toLowerCase().includes(query);
        const mDoc = String(item.docName || "").toLowerCase().includes(query);
        if (!mAcct && !mContent && !mDoc) return false;
      }
      return true;
    });
  }

  ledgerFilterChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      ledgerFilterChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      currentLedgerFilter = chip.dataset.ledgerFilter || "all";
      renderLedgerList();
    });
  });

  async function renderLedgerList() {
    if (!ledgerListContainer) return;
    const { publishLedger = [] } = await chrome.storage.local.get(["publishLedger"]);

    // 填充文档筛选下拉框
    if (ledgerDocFilter) {
      const docNames = Array.from(new Set(publishLedger.map((i) => i.docName).filter(Boolean)));
      const curVal = ledgerDocFilter.value;
      ledgerDocFilter.innerHTML = `<option value="all">📑 全部来源文档 (${publishLedger.length})</option>`;
      docNames.forEach((name) => {
        const count = publishLedger.filter((i) => i.docName === name).length;
        ledgerDocFilter.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)} (${count})</option>`;
      });
      ledgerDocFilter.value = curVal || "all";
    }

    const filtered = filterLedgerItems(publishLedger);

    if (ledgerCountBadge) {
      ledgerCountBadge.textContent = `${filtered.length} / ${publishLedger.length} 条`;
    }

    ledgerListContainer.innerHTML = "";
    if (filtered.length === 0) {
      ledgerListContainer.innerHTML = `<div class="empty-placeholder">${publishLedger.length === 0 ? "暂无历史发博流水记录。每次成功发博后，此处将自动记录" : "未找到匹配的历史发博记录"}</div>`;
      return;
    }

    filtered.forEach((item, idx) => {
      const card = document.createElement("div");
      card.className = "ledger-item-card";
      const copyLine = formatLedgerCopyLine(item);
      const copyBtnHtml = copyLine
        ? `<button type="button" class="sched-btn-clean btn-copy-ledger-item" data-idx="${idx}" title="复制账号名和博文链接">📋 复制</button>`
        : "";
      const canRetryWriteBack = item.mode === "真实发布" && item.postUrl && !item.writeBackOk && item.targetCell && item.targetCell !== "-" && item.docUrl;
      const retryWriteBackBtnHtml = canRetryWriteBack
        ? `<button type="button" class="sched-btn-clean primary btn-retry-ledger-writeback" data-idx="${idx}">📝 补写文档</button>`
        : "";
      const writeBackWarnHtml = (!item.writeBackOk && item.writeBackError)
        ? `<div style="font-size:11px;color:#92400E;background:#FFFBEB;padding:4px 8px;border-radius:4px;border:1px solid #FDE68A;">⚠ 回写失败原因: ${escapeHtml(item.writeBackError)}</div>`
        : "";
      card.innerHTML = `
        <div class="ledger-item-body">
          <div class="sched-card-header">
            <div class="sched-card-left-meta">
              <span class="sched-acct-name">👤 ${escapeHtml(item.account || "默认账号")}</span>
              <span class="sched-sub-meta">${escapeHtml(item.docName || "主表")} · 行 ${item.row || "-"}</span>
              <span class="sched-sub-meta">[${escapeHtml(item.trigger || "即时")}]</span>
            </div>
            <div class="sched-card-right-status">
              <span class="sched-time-text">🕒 ${escapeHtml(item.time || "")}</span>
              <span class="sched-status-pill ${item.mode === "真实发布" ? "done" : "pending"}">${escapeHtml(item.mode || "发布")}</span>
            </div>
          </div>
          <div class="sched-card-content ledger-content-toggle" data-idx="${idx}" title="点击切换完整正文">${escapeHtml(item.contentSummary || "")}</div>
          ${writeBackWarnHtml}
          <div class="sched-card-footer" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div class="sched-card-tags">
              ${item.postUrl ? `<a href="${escapeHtml(item.postUrl)}" target="_blank" title="${escapeHtml(item.postUrl)}" style="color:var(--primary);text-decoration:none;font-weight:600;">🔗 查看微博 ↗</a>` : `<span style="color:var(--text-sub);font-size:11px;">无链接（演练/草稿）</span>`}
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              ${retryWriteBackBtnHtml}
              ${copyBtnHtml}
            </div>
          </div>
        </div>
      `;
      ledgerListContainer.appendChild(card);
    });

    ledgerListContainer.querySelectorAll(".ledger-content-toggle").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.idx, 10);
        const item = filtered[idx];
        if (!item) return;
        const expanded = el.classList.toggle("is-expanded");
        el.textContent = expanded ? (item.fullContent || item.contentSummary || "") : (item.contentSummary || "");
      });
    });

    ledgerListContainer.querySelectorAll(".btn-retry-ledger-writeback").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const item = filtered[idx];
        if (!item) return;
        btn.disabled = true;
        btn.textContent = "⏳ 补写中...";
        try {
          const resp = await chrome.runtime.sendMessage({
            action: "RETRY_WRITE_BACK",
            payload: {
              ledgerId: item.id,
              docUrl: item.docUrl,
              docName: item.docName,
              row: item.row,
              targetCell: item.targetCell,
              targetSheetId: item.targetSheetId,
              postUrl: item.postUrl,
            },
          });
          if (!resp?.ok) {
            appendLog(`补写失败: ${resp?.error || "未知异常"}`, "error");
          }
        } catch (err) {
          appendLog(`补写通信异常: ${err?.message || String(err)}`, "error");
        } finally {
          renderLedgerList();
        }
      });
    });

    ledgerListContainer.querySelectorAll(".btn-copy-ledger-item").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const line = formatLedgerCopyLine(filtered[idx]);
        if (!line) return;
        const ok = await writeTextToClipboard(line);
        if (ok) {
          btn.textContent = "✅ 已复制";
          setTimeout(() => { btn.textContent = "📋 复制"; }, 1500);
          appendLog(`📋 已复制账号与链接: ${line}`, "success");
        } else {
          appendLog("复制到剪贴板失败，请检查浏览器权限", "error");
        }
      });
    });
  }

  btnCopyLedgerLinks?.addEventListener("click", async () => {
    const { publishLedger = [] } = await chrome.storage.local.get(["publishLedger"]);
    const filtered = filterLedgerItems(publishLedger);
    const lines = filtered
      .filter((item) => item && item.mode === "真实发布")
      .map(formatLedgerCopyLine)
      .filter(Boolean);
    if (lines.length === 0) {
      appendLog("当前筛选结果中没有已成功发布的账号与链接可复制", "warn");
      return;
    }
    const ok = await writeTextToClipboard(lines.join("\n"));
    if (ok) {
      const origText = btnCopyLedgerLinks.textContent;
      btnCopyLedgerLinks.textContent = `✅ 已复制 ${lines.length} 条`;
      setTimeout(() => { btnCopyLedgerLinks.textContent = origText; }, 1800);
      appendLog(`📋 已一键复制 ${lines.length} 条发布成功的账号与链接`, "success");
    } else {
      appendLog("批量复制到剪贴板失败，请检查浏览器权限", "error");
    }
  });

  let ledgerSearchTimer = null;
  ledgerSearchInput?.addEventListener("input", () => {
    if (typeof clearTimeout === "function") clearTimeout(ledgerSearchTimer);
    if (typeof setTimeout === "function") {
      ledgerSearchTimer = setTimeout(() => renderLedgerList(), 150);
    } else {
      renderLedgerList();
    }
  });
  ledgerDocFilter?.addEventListener("change", () => renderLedgerList());

  btnExportLedgerCsv?.addEventListener("click", async () => {
    const { publishLedger = [] } = await chrome.storage.local.get(["publishLedger"]);
    if (publishLedger.length === 0) {
      appendLog("当前账本为空，暂无可导出的数据", "warn");
      return;
    }
    const headers = ["时间", "来源文档", "行号", "目标单元格", "发博账号", "博文正文", "回写博文链接", "执行模式", "触发来源"];
    const rows = publishLedger.map((item) => [
      `"${String(item.time || "").replace(/"/g, '""')}"`,
      `"${String(item.docName || "").replace(/"/g, '""')}"`,
      `"${item.row || ""}"`,
      `"${item.targetCell || ""}"`,
      `"${String(item.account || "").replace(/"/g, '""')}"`,
      `"${String(item.fullContent || item.contentSummary || "").replace(/"/g, '""')}"`,
      `"${String(item.postUrl || "").replace(/"/g, '""')}"`,
      `"${item.mode || ""}"`,
      `"${item.trigger || ""}"`,
    ]);
    const csvContent = "﻿" + [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `weibo_publish_ledger_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    appendLog(`✅ 账本数据已成功导出为 CSV (共 ${publishLedger.length} 条记录)`, "success");
  });

  btnClearLedger?.addEventListener("click", async () => {
    if (!confirm("确定要清空全部历史发博流水账本吗？清空后无法恢复。")) return;
    const { publishLedger = [], __unwrittenReceipts__ = [] } = await chrome.storage.local.get([
      "publishLedger",
      "__unwrittenReceipts__",
    ]);
    const unwritten = publishLedger.filter(
      (item) => item && item.mode === "真实发布" && item.postUrl && !item.writeBackOk
    );
    const mergedUnwritten = [...unwritten, ...__unwrittenReceipts__].slice(0, 500);
    await chrome.storage.local.set({
      publishLedger: [],
      __unwrittenReceipts__: mergedUnwritten,
    });
    renderLedgerList();
    appendLog(
      unwritten.length > 0
        ? `已清空历史账本界面（已自动保留 ${unwritten.length} 条未回写真实发博的防重回执）`
        : "已清空历史发博流水账本",
      "info"
    );
  });

  // ── 14. 账号别名智能映射字典控制器 (Alias Dictionary) ──
  const DEFAULT_ALIASES = {
    "BOOM": "BOOM视频",
    "对焦": "对焦Focus",
    "军事": "新浪军事",
    "健康派": "新浪健康派",
    "手机": "新浪手机",
    "出行": "新浪出行",
    "文旅": "新浪文旅",
    "AI": "新浪AI",
    "新浪 AI": "新浪AI",
    "锐视频": "锐视频RAYVIDEO",
    "时刻": "时刻TIMEVIDEO",
    "时刻视频": "时刻TIMEVIDEO",
    "头条": "手机头条",
    "资讯": "微资讯",
  };

  async function getAccountAliases() {
    const { accountAliases } = await chrome.storage.local.get(["accountAliases"]);
    if (accountAliases && typeof accountAliases === "object" && !Array.isArray(accountAliases)) {
      return accountAliases;
    }
    await chrome.storage.local.set({ accountAliases: DEFAULT_ALIASES });
    return DEFAULT_ALIASES;
  }

  async function saveAccountAliases(aliases) {
    await chrome.storage.local.set({ accountAliases: aliases });
    if (aliasCountBadge) {
      aliasCountBadge.textContent = `${Object.keys(aliases).length} 个映射`;
    }
  }

  async function renderAliasList() {
    if (!aliasListContainer) return;
    const aliases = await getAccountAliases();
    const entries = Object.entries(aliases);

    if (aliasCountBadge) {
      aliasCountBadge.textContent = `${entries.length} 个映射`;
    }

    aliasListContainer.innerHTML = "";
    if (entries.length === 0) {
      aliasListContainer.innerHTML = `<div class="empty-placeholder">暂无别名映射，可点击上方【恢复默认】或【新增映射】</div>`;
      return;
    }

    entries.forEach(([fromAcct, toAcct]) => {
      const row = document.createElement("div");
      row.className = "alias-item-row";
      row.innerHTML = `
        <input type="text" class="alias-input alias-from-input" value="${escapeHtml(fromAcct)}" placeholder="文档简写 (如: BOOM)">
        <span class="alias-arrow">➔</span>
        <input type="text" class="alias-input alias-to-input" value="${escapeHtml(toAcct)}" placeholder="中台全称 (如: BOOM视频)">
        <button type="button" class="btn-xs btn-outline danger-text btn-del-alias">✕</button>
      `;
      aliasListContainer.appendChild(row);
    });

    // 绑定行输入自动保存与删除
    aliasListContainer.querySelectorAll(".alias-item-row").forEach((row) => {
      const fromInput = row.querySelector(".alias-from-input");
      const toInput = row.querySelector(".alias-to-input");
      const delBtn = row.querySelector(".btn-del-alias");

      const handleSave = () => {
        const updated = {};
        aliasListContainer.querySelectorAll(".alias-item-row").forEach((r) => {
          const f = r.querySelector(".alias-from-input").value.trim();
          const t = r.querySelector(".alias-to-input").value.trim();
          if (f && t) updated[f] = t;
        });
        saveAccountAliases(updated);
      };

      fromInput.addEventListener("change", handleSave);
      toInput.addEventListener("change", handleSave);

      delBtn.addEventListener("click", () => {
        row.remove();
        handleSave();
      });
    });
  }

  btnAddAliasRow?.addEventListener("click", () => {
    const row = document.createElement("div");
    row.className = "alias-item-row";
    row.innerHTML = `
      <input type="text" class="alias-input alias-from-input" placeholder="文档简写 (如: 对焦)">
      <span class="alias-arrow">➔</span>
      <input type="text" class="alias-input alias-to-input" placeholder="中台全称 (如: 对焦Focus)">
      <button type="button" class="btn-xs btn-outline danger-text btn-del-alias">✕</button>
    `;
    aliasListContainer.appendChild(row);
    row.querySelector(".alias-from-input").focus();

    const handleSave = () => {
      const updated = {};
      aliasListContainer.querySelectorAll(".alias-item-row").forEach((r) => {
        const f = r.querySelector(".alias-from-input").value.trim();
        const t = r.querySelector(".alias-to-input").value.trim();
        if (f && t) updated[f] = t;
      });
      saveAccountAliases(updated);
    };

    row.querySelector(".alias-from-input").addEventListener("change", handleSave);
    row.querySelector(".alias-to-input").addEventListener("change", handleSave);
    row.querySelector(".btn-del-alias").addEventListener("click", () => {
      row.remove();
      handleSave();
    });
  });

  btnResetDefaultAliases?.addEventListener("click", async () => {
    if (!confirm("确定要恢复默认的官方别名字典吗？自定义映射将被重置。")) return;
    await saveAccountAliases(DEFAULT_ALIASES);
    renderAliasList();
    appendLog("已恢复官方推荐的账号别名字典", "success");
  });

  quickAliasChips?.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const fromAcct = btn.dataset.aliasFrom;
      const toAcct = btn.dataset.aliasTo;
      if (!fromAcct || !toAcct) return;
      const aliases = await getAccountAliases();
      aliases[fromAcct] = toAcct;
      await saveAccountAliases(aliases);
      renderAliasList();
      appendLog(`已添加别名映射: [${fromAcct}] ➔ [${toAcct}]`, "success");
    });
  });

  // ── 15. 智能任务解析独立功能区 (完全对齐原系统 instant.html 任务解析引擎) ──

  const KNOWN_OFFICIAL_ACCOUNTS = [
    "新浪新闻滚动",
    "时刻TIMEVIDEO",
    "锐视频RAYVIDEO",
    "新浪健康派",
    "民生温度计",
    "新浪非遗",
    "新浪颜选",
    "新浪运动",
    "新浪航天",
    "新浪科普",
    "新浪生活",
    "新浪民生",
    "新浪文旅",
    "新浪手机",
    "新浪天文",
    "新浪医典",
    "新浪出行",
    "新浪军事",
    "新浪热点",
    "硬核大脑",
    "美食头条",
    "瑞峰财经",
    "对焦Focus",
    "BOOM视频",
    "手机头条",
    "新浪AI",
    "微资讯",
    "汽车君",
    "苹果君",
  ];

  const BUILTIN_OFFICIAL_ALIASES = {
    "新浪军事（军事）": "新浪军事",
    "新浪军事(军事)": "新浪军事",
    "军事": "新浪军事",
    "对焦": "对焦Focus",
    "对焦 Focus": "对焦Focus",
    "新浪 AI": "新浪AI",
    "锐视频": "锐视频RAYVIDEO",
    "时刻": "时刻TIMEVIDEO",
    "时刻视频": "时刻TIMEVIDEO",
    "boom 视频": "BOOM视频",
    "BOOM 视频": "BOOM视频",
    "boom视频": "BOOM视频",
    "Boom视频": "BOOM视频",
    "boom": "BOOM视频",
    "BOOM": "BOOM视频",
  };

  function normalizeUnicodeSpaces(str) {
    return String(str || "").replace(/[ -‏ 　﻿]/g, " ");
  }

  function escapeRegExpStr(str) {
    return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getActiveOfficialAccounts() {
    if (Array.isArray(cachedPlatformAccounts) && cachedPlatformAccounts.length >= 2) {
      return Array.from(new Set(cachedPlatformAccounts));
    }
    return KNOWN_OFFICIAL_ACCOUNTS;
  }

  function buildKnownAccountLookup(aliases) {
    const map = new Map();
    for (const name of getActiveOfficialAccounts()) {
      map.set(name.toLowerCase(), name);
    }
    for (const [k, v] of Object.entries(BUILTIN_OFFICIAL_ALIASES)) {
      map.set(k.toLowerCase(), v);
    }
    for (const [k, v] of Object.entries(aliases || {})) {
      const key = String(k || "").trim();
      const val = String(v || "").trim();
      if (val) map.set(val.toLowerCase(), val);
      if (key && val) map.set(key.toLowerCase(), val);
    }
    const keysSorted = Array.from(map.keys()).sort((a, b) => b.length - a.length);
    return { map, keysSorted };
  }

  function resolveSingleAccountName(rawName, aliases) {
    const clean = String(rawName || "").replace(/值班$/, "").trim();
    if (!clean) return "";
    if (aliases && aliases[clean]) return aliases[clean];
    const lower = clean.toLowerCase();
    for (const [k, v] of Object.entries(aliases || {})) {
      if (lower === k.toLowerCase()) return v;
    }
    for (const [k, v] of Object.entries(BUILTIN_OFFICIAL_ALIASES)) {
      if (lower === k.toLowerCase()) return v;
    }
    for (const official of getActiveOfficialAccounts()) {
      if (lower === official.toLowerCase()) return official;
    }
    return clean;
  }

  taskParserStripKeywords?.addEventListener("change", () => {
    chrome.storage.local.set({ stripKeywords: taskParserStripKeywords.value || "" });
  });

  function getStripKeywordsList() {
    const raw = (taskParserStripKeywords?.value || "").trim();
    if (!raw) return [];
    return raw
      .split(/\r?\n|[,，]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
  }

  function applyStripKeywords(text, keywords) {
    let result = normalizeUnicodeSpaces(text);
    for (const kw of keywords) {
      if (!kw) continue;
      result = result.split(kw).join("");
    }
    return result.trim();
  }

  function parseLeadingAccountDirective(line, aliases) {
    const text = normalizeUnicodeSpaces(line).trim();
    if (!text) return null;

    // 1. 显式标签开头：位置：@xxx / 账号：xxx / 发布账号：xxx
    const prefixM = text.match(/^(?:位置|账号|发稿账号|发博账号|微博账号|发布账号|账户)[：:]\s*(.+)$/i);
    if (prefixM) {
      const rest = prefixM[1].trim();
      const accts = extractAccountsFromLine(rest, aliases);
      if (accts.length > 0) return { accounts: accts, content: "" };
      const rawNames = rest
        .replace(/@/g, "")
        .split(/[、，,\s]+/)
        .filter((s) => s && !/(辛苦|发下|发一下|发布)/.test(s))
        .map((s) => resolveSingleAccountName(s, aliases));
      if (rawNames.length > 0) return { accounts: rawNames, content: "" };
    }

    // 2. 纯 @账号 开头（如 "@BOOM视频、@对焦Focus 辛苦发下" 或 "@BOOM视频 #话题# 正文..."）
    if (text.startsWith("@")) {
      const m = text.match(/^((?:@\s*[^\s、，,：:]+[、，,\s]*)+)(.*)$/);
      if (m) {
        const mentionPart = m[1];
        let remain = (m[2] || "").trim();
        remain = remain.replace(/^(?:[:：]\s*|值班|老师|辛苦了|辛苦|请|麻烦|发下|发一下|发布|发微博|发稿|发这条|安排下|安排|~|！)+/g, "").trim();
        const accts = extractAccountsFromLine(mentionPart, aliases);
        if (accts.length > 0) {
          return { accounts: accts, content: remain };
        }
      }
    }

    // 3. 已知账号/别名直写开头（对齐原系统 instant.html:6111-6170，支持无 @ 的 "账号名：正文" / "账号名 正文" / 多账号顿号连接）
    const { map, keysSorted } = buildKnownAccountLookup(aliases);
    for (const key of keysSorted) {
      const targetAcct = map.get(key);
      const escaped = escapeRegExpStr(key);

      // 3a. 多账号连写开头，如 "瑞峰财经、新浪科普：正文"
      const multiPat = new RegExp(`^@?\\s*${escaped}((?:\\s*[、，,]\\s*@?[^\\s、，,：:]+)+)\\s*[:：]\\s*(.*)$`, "i");
      const multiM = text.match(multiPat);
      if (multiM) {
        const extraAccts = [targetAcct];
        const extraParts = multiM[1].split(/[、，,]+/).map((s) => s.replace(/^@/, "").trim()).filter(Boolean);
        for (const ep of extraParts) {
          const resolved = resolveSingleAccountName(ep, aliases);
          if (resolved && !extraAccts.includes(resolved)) extraAccts.push(resolved);
        }
        return { accounts: extraAccts, content: (multiM[2] || "").trim() };
      }

      // 3b. 单账号 6 种形态（带冒号 / 带空格 / 独占一行，有无 @ 均可）
      const patterns = [
        new RegExp(`^@?\\s*${escaped}\\s*[:：]\\s*(.*)$`, "i"),
        new RegExp(`^@?\\s*${escaped}(?=\\s+)\\s*(.*)$`, "i"),
        new RegExp(`^@?\\s*${escaped}\\s*$`, "i"),
      ];
      for (const pat of patterns) {
        const m = text.match(pat);
        if (!m) continue;
        return { accounts: [targetAcct], content: (m[1] || "").trim() };
      }
    }

    return null;
  }

  function extractAccountsFromLine(line, aliases) {
    const text = normalizeUnicodeSpaces(line);
    const found = [];

    // 1. 先按最长完整账号/别名匹配（支持 "@BOOM 视频" 这类中间带空格的账号写法），并按文本出现顺序排列
    const { map, keysSorted } = buildKnownAccountLookup(aliases);
    let textForAtScan = text;
    const matchedWithPos = [];
    for (const key of keysSorted) {
      if (key.length < 2) continue;
      const re = new RegExp(`@\\s*${escapeRegExpStr(key)}(?=$|[\\s、，,：:！!~])`, "i");
      const mPos = textForAtScan.match(re);
      if (mPos) {
        const target = map.get(key);
        if (target) matchedWithPos.push({ index: mPos.index ?? 0, target });
        textForAtScan = textForAtScan.replace(new RegExp(`@\\s*${escapeRegExpStr(key)}(?=$|[\\s、，,：:！!~])`, "ig"), " ");
      }
    }
    matchedWithPos.sort((a, b) => a.index - b.index);
    for (const item of matchedWithPos) {
      if (!found.includes(item.target)) found.push(item.target);
    }

    // 2. 提取普通 @ 用户名（仅扫描未被已知含空格别名消费的 @ 片段，避免 "@新浪 AI" 误拆出 "新浪"）
    for (const m of textForAtScan.matchAll(/@\s*([^\s、，,：:。！!~～)）；;]+)/g)) {
      const name = resolveSingleAccountName(m[1], aliases);
      if (name && !found.includes(name)) found.push(name);
    }

    // 3. 支持“大号”关键词映射
    if (/(?:大号|新浪热点值班)/.test(text) && !found.includes("新浪热点")) {
      found.push("新浪热点");
    }

    // 4. 如果行中含已知账号名且带有账号指令/标签语境，补充匹配（最长优先并消费已匹配片段，避免子串误命中）
    if (/^(?:位置|账号|发稿账号|发博账号|转发账号|微博账号|发布账号|账户)[：:]/i.test(text) || found.length === 0) {
      let scanLower = text.toLowerCase();
      for (const key of keysSorted) {
        if (key.length < 2) continue;
        if (scanLower.includes(key)) {
          const target = map.get(key);
          if (target && !found.includes(target)) found.push(target);
          scanLower = scanLower.split(key).join(" ");
        }
      }
    }

    // 4. 支持 "+其他所有小号" / "+全部小号" / "N个小号" / "N小号" 随机抽号（对齐 instant.html:6890-6908）
    const pool = getActiveOfficialAccounts().filter((n) => n !== "新浪热点" && !found.includes(n));
    if (/[+＋]\s*(?:其他所有|全部)小号/.test(text)) {
      for (const n of pool) {
        if (!found.includes(n)) found.push(n);
      }
    } else {
      const smallMatch = text.match(/(\d+)\s*(?:个)?\s*小号/);
      const smallCount = smallMatch ? Number.parseInt(smallMatch[1], 10) || 0 : 0;
      if (smallCount > 0 && pool.length > 0) {
        const shuffled = [...pool];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        for (const n of shuffled.slice(0, smallCount)) {
          if (!found.includes(n)) found.push(n);
        }
      }
    }

    // 5. 如果行中有“账号：A、B”但未命中已知账号词典，按分隔符兜底提取
    if (found.length === 0 && /^(?:位置|账号|发稿账号|发博账号|微博账号|发布账号|账户)[：:]/i.test(text)) {
      const body = text.replace(/^(?:位置|账号|发稿账号|发博账号|微博账号|发布账号|账户)[：:]/i, "").trim();
      const parts = body.split(/[、，,\s]+/).filter(Boolean);
      for (const p of parts) {
        if (!/(辛苦|老师|发布|发稿|发下)/.test(p)) {
          const name = resolveSingleAccountName(p, aliases);
          if (name && !found.includes(name)) found.push(name);
        }
      }
    }

    return found;
  }

  function isPureDirectiveLine(line, aliases) {
    const text = normalizeUnicodeSpaces(line).trim();
    if (!text) return false;
    if (/#.+?#/.test(text) || /https?:\/\/\S+/i.test(text)) return false;

    const hasAccountHint = /(?:@|大号|小号|^(?:位置|账号|发稿账号|发博账号|微博账号|发布账号|账户)[：:])/i.test(text);
    const { keysSorted } = buildKnownAccountLookup(aliases);
    let residue = text;
    for (const k of keysSorted) {
      residue = residue.replace(new RegExp(`@?\\s*${escapeRegExpStr(k)}`, "gi"), " ");
    }
    residue = residue
      .replace(/@\s*[^\s、，,：:]+/g, (m) => (hasAccountHint && /值班$/.test(m) ? " " : m))
      .replace(/[+＋]?\s*\d+\s*(?:个)?\s*小号/g, " ")
      .replace(/[+＋]?\s*(?:其他所有|全部)?\s*小号/g, " ")
      .replace(/[+＋]?\s*大号/g, " ")
      .replace(/\b\d+\b/g, " ")
      .replace(/值班老师|值班|辛苦了|辛苦|老师|以上|麻烦|请|谢谢|查收|劳驾|帮忙|一起|各自|分别|同步|随机|另外|以及|还有|加上|带着|发布投票|发投票|投票|发布|发稿吧|发稿|发微博|发一下|发下|发吧|发这条|安排下|安排|账号|转发评论|转发并评论|转发|转评|评转|评论|和|与|跟|及|再|并|都|发|下|一下|了|吧/g, " ")
      .replace(/[、，,\s:：;；。.!！？?~\-—_+＋()（）[\]【】]/g, "")
      .trim();

    if (!residue && hasAccountHint) return true;

    const leading = parseLeadingAccountDirective(text, aliases);
    if (leading && !leading.content) return true;

    return (
      text.length <= 35 &&
      /(辛苦|老师|发布|发稿|发吧|发下|发一下|安排下|发微博|发这条|转发评论|谢谢|劳驾)[~！!：:]*$/.test(text)
    );
  }

  function splitDirectiveSuffixFromContentLine(line, aliases) {
    const text = normalizeUnicodeSpaces(line).trim();
    if (!text) return null;
    if (isPureDirectiveLine(text, aliases)) return null;

    if (/https?:\/\/\S+/i.test(text)) {
      const urlMatches = [...text.matchAll(/https?:\/\/\S+/ig)];
      const last = urlMatches[urlMatches.length - 1];
      const suffixStart = (last.index || 0) + last[0].length;
      const suffix = text.slice(suffixStart).trim();
      const content = text.slice(0, suffixStart).trim();
      if (suffix && isPureDirectiveLine(suffix, aliases) && content) {
        return { content, directive: suffix };
      }
    }

    const firstAt = text.indexOf("@");
    if (firstAt > 0) {
      const content = text.slice(0, firstAt).trim();
      const directive = text.slice(firstAt).trim();
      const accts = extractAccountsFromLine(directive, aliases);
      if (content && directive && accts.length > 0 && isPureDirectiveLine(directive, aliases)) {
        return { content, directive };
      }
    }
    return null;
  }

  // ── 投票智能识别与选项拆解 (100% 对齐原系统 instant.html:11745-11920) ──
  function normalizePollOptionLine(line) {
    return String(line || "")
      .trim()
      .replace(/^(?:[A-Za-z][.、:：]\s*|\d+[.、:：]\s*|[①②③④⑤⑥⑦⑧⑨⑩]\s*|[一二三四五六七八九十]+[、.．]\s*|[-•●]\s*)/, "")
      .trim();
  }

  function looksLikePollQuestionLine(line) {
    const text = String(line || "").trim();
    if (!text) return false;
    return /[？?]$/.test(text) || /投票/.test(text) || /(哪一个|哪个|你最|你会选|你更|评论区聊聊|你心中的|你支持)/.test(text);
  }

  function splitTrailingPollQuestion(text) {
    const src = String(text || "").trim();
    if (!src) return null;
    const candidates = [];
    const punct = /[。！？!?；;]/g;
    let m;
    while ((m = punct.exec(src)) !== null) {
      const tail = src.slice(m.index + m[0].length).trim();
      if (!tail) continue;
      if (looksLikePollQuestionLine(tail)) {
        candidates.push(tail);
      }
    }
    if (looksLikePollQuestionLine(src)) {
      candidates.push(src);
    }
    const question = candidates.sort((a, b) => a.length - b.length)[0] || "";
    if (!question) return null;
    return { content: src, question };
  }

  function stripPollHashTitle(title) {
    return String(title || "").replace(/【#.*?#】/g, "").replace(/#.*?#/g, "").trim();
  }

  function extractPollOptionBlock(lines, startIndex) {
    const options = [];
    for (let i = startIndex; i < lines.length; i++) {
      const raw = String(lines[i] || "").trim();
      if (!raw) continue;
      const normalized = normalizePollOptionLine(raw);
      if (!normalized || /https?:\/\/\S+/i.test(normalized) || normalized.length > 60) {
        return [];
      }
      options.push(normalized);
    }
    return options.length >= 2 ? options.slice(0, 6) : [];
  }

  function detectPollFromLines(lines, forcePollMode = false) {
    if (!lines || lines.length < 3) return null;

    // 1. 强特征匹配：独立问句行 + 后续至少 2 个选项
    for (let i = 0; i < lines.length - 2; i++) {
      if (looksLikePollQuestionLine(lines[i])) {
        const opts = extractPollOptionBlock(lines, i + 1);
        if (opts.length >= 2) {
          const splitQ = splitTrailingPollQuestion(lines[i]);
          const title = stripPollHashTitle((splitQ && splitQ.question) || lines[i]) || "参与投票";
          // 把正文中末尾的选项行剥离，只保留问题及之前的正文（防止选项重复贴入微博正文中）
          const contentText = lines.slice(0, i + 1).join("\n").trim();
          return {
            title,
            options: opts,
            days: 30,
            cleanContent: contentText,
          };
        }
      }
    }

    // 2. 段落结尾带问句匹配 (如第一段末尾有问句，后面紧跟选项1、选项2...)
    for (let i = 1; i < lines.length; i++) {
      const split = splitTrailingPollQuestion(lines[i - 1]);
      if (split) {
        const opts = extractPollOptionBlock(lines, i);
        if (opts.length >= 2) {
          const title = stripPollHashTitle(split.question) || "参与投票";
          const contentText = lines.slice(0, i).join("\n").trim();
          return {
            title,
            options: opts,
            days: 30,
            cleanContent: contentText,
          };
        }
      }
    }

    // 无问句时仅由显式强制模式识别投票，避免截断普通短文或编号列表。
    let optionStart = -1;
    for (let i = lines.length - 1; i >= 1; i--) {
      const raw = lines[i];
      const hasBullet = /^(?:[A-Za-z][.、:：]|\d+[.、:：]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十]+[、.．]|[-•●])/.test(raw);
      const norm = normalizePollOptionLine(raw);
      if (norm && norm.length <= 32 && (hasBullet || forcePollMode)) {
        optionStart = i;
      } else {
        break;
      }
    }

    if (optionStart >= 1) {
      const opts = extractPollOptionBlock(lines, optionStart);
      if (opts.length >= 2 && (forcePollMode || looksLikePollQuestionLine(lines[optionStart - 1]))) {
        const titleLine = lines[optionStart - 1];
        const split = splitTrailingPollQuestion(titleLine);
        const title = stripPollHashTitle((split && split.question) || titleLine) || "参与投票";
        const contentText = lines.slice(0, optionStart).join("\n").trim();
        return {
          title,
          options: opts,
          days: 30,
          cleanContent: contentText,
        };
      }
    }

    // 4. 强制投票模式兜底（用户勾选了“优先作为投票任务解析”）
    if (forcePollMode && lines.length >= 3) {
      const opts = extractPollOptionBlock(lines, 1);
      if (opts.length >= 2) {
        const split = splitTrailingPollQuestion(lines[0]);
        const title = stripPollHashTitle((split && split.question) || lines[0]) || "参与投票";
        return {
          title,
          options: opts,
          days: 30,
          cleanContent: lines[0],
        };
      }
    }

    return null;
  }

  async function parseBatchTaskText(rawText) {
    const stripKws = getStripKeywordsList();
    const aliases = await getAccountAliases();
    const forcePollMode = !!(taskParserPollToggle && taskParserPollToggle.checked);
    const cleanedRaw = applyStripKeywords(String(rawText || "").replace(/\r/g, "").trim(), stripKws);
    if (!cleanedRaw) throw new Error("请先粘贴需要解析的派单任务文本！");

    // 对齐原系统 instant.html:7197-7228：优先识别转发链接及转发评论意图，剥离头部推广说明
    let repostUrl = "";
    let commentOriginal = false;
    let effectiveText = cleanedRaw;
    let repostMatch = cleanedRaw.match(/(?:转发链接|微博链接|原博链接|原微博链接|转发)[：:]\s*(https?:\/\/\S+)/i);
    if (repostMatch) {
      repostUrl = repostMatch[1].trim();
      const markerMatch = cleanedRaw.match(/(?:转发文案|转发内容|转发理由|文案)[：:]/);
      effectiveText = markerMatch
        ? cleanedRaw.slice(markerMatch.index + markerMatch[0].length).trim()
        : cleanedRaw.slice(repostMatch.index + repostMatch[0].length).trim();
    } else {
      const linesCheck = cleanedRaw.split("\n").map((l) => l.trim()).filter(Boolean);
      if (linesCheck.length > 1) {
        const urlMatch = cleanedRaw.match(/https?:\/\/(?:(?:www\.)?weibo\.com\/(?:\d+|[a-zA-Z0-9_-]+)\/[0-9a-zA-Z]+|m\.weibo\.cn\/(?:status|detail)\/[0-9a-zA-Z]+)(?:[?#][^\s\r\n一-龥]+)?/i);
        if (urlMatch && !urlMatch[0].includes("video.weibo.com")) {
          const isRepostIntent = /转发|转评|评转|评论给原微博|同时评论/.test(linesCheck.slice(0, 3).join("\n"));
          const isUrlAtStart = linesCheck[0].includes(urlMatch[0]) || (linesCheck.length > 1 && linesCheck[1].includes(urlMatch[0]));
          if (isUrlAtStart || (isRepostIntent && linesCheck.slice(0, 3).some((l) => l.includes(urlMatch[0])))) {
            repostUrl = urlMatch[0].trim();
            effectiveText = cleanedRaw.slice(urlMatch.index + urlMatch[0].length).trim();
          }
        }
      }
    }
    if (repostUrl) {
      commentOriginal = /评论按钮|同时评论给原微博|转发评论|转发并评论|评转|转评/.test(cleanedRaw);
      effectiveText = effectiveText.replace(/^\s*(?:同时评论给原微博|评论按钮|转发评论|转发并评论|评转|转评)\s*$/gm, "").trim();
    }

    const lines = effectiveText.split("\n").map((l) => l.trim());
    const groups = [];
    let current = null;

    for (const line of lines) {
      if (!line) {
        if (current && current.contentLines.length > 0 && !current.closedByDirective) {
          current.contentLines.push("");
        }
        continue;
      }

      // 1. 优先识别纯派单指令行（如 "@xxx值班 辛苦大号+3小号发" 或 "@手机头条 @新浪新闻滚动"）
      if (isPureDirectiveLine(line, aliases)) {
        const accts = extractAccountsFromLine(line, aliases);
        const hasContent = current && current.contentLines.some((l) => l.length > 0);
        if (hasContent && current.accounts.length === 0) {
          // 情况 A：前文尚无账号（如正文在上方、派单指令在末尾），将账号归属到当前正文并闭环
          if (accts.length > 0) {
            current.accounts = Array.from(new Set([...current.accounts, ...accts]));
          }
          current.closedByDirective = true;
          continue;
        }
        if (hasContent && current.accounts.length > 0) {
          // 情况 B：前文已有账号且已有正文，说明该指令行是下一组新任务的起点
          groups.push(current);
          current = { accounts: accts, contentLines: [], closedByDirective: false };
          continue;
        }
        if (current) {
          // 情况 C：当前组尚无正文（连续多行派单指令），合并账号
          if (accts.length > 0) {
            current.accounts = Array.from(new Set([...current.accounts, ...accts]));
          }
          continue;
        }
        if (accts.length > 0) {
          current = { accounts: accts, contentLines: [], closedByDirective: false };
          continue;
        }
      }

      // 2. 检查是否为新的任务起点（带账号前缀 + 正文，如 "瑞峰财经：正文..." 或 "@BOOM视频 #话题# 正文..."）
      const leading = parseLeadingAccountDirective(line, aliases);
      if (leading) {
        if (current && current.contentLines.some((l) => l.length > 0)) {
          groups.push(current);
        }
        let accts = [...leading.accounts];
        let bodyLine = leading.content || "";
        let closed = false;
        if (bodyLine) {
          const tailSplit = splitDirectiveSuffixFromContentLine(bodyLine, aliases);
          if (tailSplit) {
            const tailAccts = extractAccountsFromLine(tailSplit.directive, aliases);
            if (tailAccts.length > 0) {
              accts = Array.from(new Set([...accts, ...tailAccts]));
              bodyLine = tailSplit.content;
              closed = true;
            }
          }
        }
        current = {
          accounts: accts,
          contentLines: bodyLine ? [bodyLine] : [],
          closedByDirective: closed,
        };
        continue;
      }

      // 3. 检查行尾附带指令/账号（如 "正文... https://video.weibo.com/... @BOOM视频 辛苦发下"）
      const suffixSplit = splitDirectiveSuffixFromContentLine(line, aliases);
      if (suffixSplit) {
        const accts = extractAccountsFromLine(suffixSplit.directive, aliases);
        if (accts.length > 0) {
          if (current && current.closedByDirective) {
            groups.push(current);
            current = null;
          }
          if (!current) current = { accounts: accts, contentLines: [], closedByDirective: false };
          else current.accounts = Array.from(new Set([...current.accounts, ...accts]));
          current.contentLines.push(suffixSplit.content);
          current.closedByDirective = true;
          continue;
        }
      }

      // 4. 普通正文行（若上一组已由结尾指令闭环，则开启新一组）
      if (current && current.closedByDirective) {
        groups.push(current);
        current = null;
      }
      if (!current) {
        current = { accounts: [], contentLines: [], closedByDirective: false };
      }
      current.contentLines.push(line);
    }

    if (current && current.contentLines.some((l) => l.length > 0)) {
      groups.push(current);
    }

    // 整理为结构化独立任务（若一组内有多个账号，则展开为多条精准任务）
    const finalTasks = [];
    groups.forEach((grp) => {
      const nonEmptyLines = grp.contentLines.map((l) => l.trim()).filter(Boolean);
      if (nonEmptyLines.length === 0) return;

      const poll = detectPollFromLines(nonEmptyLines, forcePollMode);
      // 如果识别出了投票，且正文中剥离了选项行，正文就用干净的主体文案，选项交给中台投票控件装配
      const body = poll && poll.cleanContent ? poll.cleanContent : grp.contentLines.join("\n").trim();
      if (!body) return;

      const acctList = grp.accounts.length > 0 ? grp.accounts : [""];
      acctList.forEach((acct) => {
        finalTasks.push({
          id: `parsed_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          account: acct,
          content: body,
          poll: poll ? { title: poll.title, options: poll.options, days: poll.days } : null,
          repostUrl: repostUrl || "",
          commentOriginal: !!commentOriginal,
          docName: repostUrl ? "转发解析" : "任务解析",
          row: "-",
          targetCell: "-",
        });
      });
    });

    if (finalTasks.length === 0) {
      throw new Error("未能从输入文本中识别出有效微博正文，请检查粘贴格式");
    }

    return finalTasks;
  }

  function renderParsedTasksPreview() {
    if (!parsedTasksPreviewContainer) return;
    if (parserCountBadge) {
      parserCountBadge.textContent = parsedTaskGroups.length > 0 ? `已解析 ${parsedTaskGroups.length} 条任务` : "尚未解析";
    }
    if (btnParserToSchedule) btnParserToSchedule.disabled = pipelineRunning || parsedTaskGroups.length === 0;
    if (btnParserRunNow) btnParserRunNow.disabled = pipelineRunning || parsedTaskGroups.length === 0;

    parsedTasksPreviewContainer.innerHTML = "";
    if (parsedTaskGroups.length === 0) {
      parsedTasksPreviewContainer.innerHTML = `<div class="empty-placeholder">粘贴任务文本或微博投票链接后，点击【🔍 智能解析预览】</div>`;
      return;
    }

    parsedTaskGroups.forEach((t, idx) => {
      const card = document.createElement("div");
      card.className = "sched-item-card";
      const pollTag = t.poll ? `<span class="sched-sub-meta" style="color:var(--primary);border-color:#C7D2FE;">📊 投票(${t.poll.options.length}项)</span>` : "";
      const repostTag = t.repostUrl ? `<span class="sched-sub-meta" style="color:#B45309;border-color:#FDE68A;background:#FEF3C7;">🔁 ${t.commentOriginal ? "转评原博" : "转发原博"}</span>` : "";

      const pollDetailHtml = t.poll ? `
        <div class="collapsible-box" style="margin: 4px 0 0 0; padding: 6px 8px;">
          <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
            <span style="font-weight: 600; color: var(--primary); font-size: 11px; white-space:nowrap;">📊 投票标题：</span>
            <input type="text" class="ui-input parsed-poll-title-input" data-idx="${idx}" value="${escapeHtml(t.poll.title)}" style="flex:1; height:22px; font-size:11px; padding:0 6px;">
            <button type="button" class="sched-btn-clean btn-add-parsed-opt" data-idx="${idx}" title="手动补加一个投票选项" style="font-size:11px; padding:2px 6px;">+ 补加选项</button>
          </div>
          <div style="display:flex; flex-direction:column; gap:3px;">
            ${t.poll.options.map((o, i) => `
              <div style="display:flex; align-items:center; gap:4px;">
                <span style="color: var(--text-muted); font-size: 11px; min-width:16px;">${i + 1}.</span>
                <input type="text" class="ui-input parsed-poll-opt-input" data-idx="${idx}" data-opt-idx="${i}" value="${escapeHtml(o)}" style="flex:1; height:22px; font-size:11px; padding:0 6px;">
                ${t.poll.options.length > 2 ? `<button type="button" class="sched-btn-clean danger btn-del-parsed-opt" data-idx="${idx}" data-opt-idx="${i}" title="移除该选项" style="padding:0 5px; height:20px; font-size:10px;">✕</button>` : ""}
              </div>
            `).join("")}
          </div>
        </div>
      ` : "";

      const repostDetailHtml = t.repostUrl ? `
        <div class="collapsible-box" style="margin: 4px 0 0 0; padding: 6px 8px; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <span style="font-weight: 600; color: #B45309; font-size: 11px; white-space:nowrap;">🔁 转发链接：</span>
          <input type="text" class="ui-input parsed-repost-url-input" data-idx="${idx}" value="${escapeHtml(t.repostUrl)}" placeholder="原微博链接 (https://weibo.com/...)" style="flex:1; min-width:160px; height:22px; font-size:11px; padding:0 6px;">
          <label style="display:flex; align-items:center; gap:3px; font-size:11px; color:var(--text-muted); cursor:pointer; white-space:nowrap;">
            <input type="checkbox" class="parsed-comment-orig-input" data-idx="${idx}" ${t.commentOriginal ? "checked" : ""}> 同时评论原微博
          </label>
        </div>
      ` : "";

      card.innerHTML = `
        <div class="sched-card-body">
          <div class="sched-card-header">
            <div class="sched-card-left-meta">
              <span class="sched-sub-meta">第 ${idx + 1} 组</span>
              <input type="text" class="ui-input parsed-acct-input" data-idx="${idx}" value="${escapeHtml(t.account || "")}" placeholder="填写账号 (留空默认)" style="width: 140px; height: 22px; font-size: 11px; padding: 0 6px;">
              ${pollTag}${repostTag}
            </div>
            <div class="sched-card-right-status">
              <span class="sched-time-text parsed-char-count" data-idx="${idx}">${t.content.length} 字</span>
              <button type="button" class="sched-btn-clean danger btn-del-parsed" data-idx="${idx}" title="移除此条">✕</button>
            </div>
          </div>
          <textarea class="ui-input parsed-content-input" data-idx="${idx}" rows="3" style="width:100%; font-size:11.5px; line-height:1.45; padding:4px 6px; resize:vertical; margin-top:4px;">${escapeHtml(t.content)}</textarea>
          ${repostDetailHtml}
          ${pollDetailHtml}
        </div>
      `;
      parsedTasksPreviewContainer.appendChild(card);
    });

    parsedTasksPreviewContainer.querySelectorAll(".parsed-acct-input").forEach((input) => {
      const syncAcct = () => {
        const idx = parseInt(input.dataset.idx, 10);
        if (parsedTaskGroups[idx]) {
          parsedTaskGroups[idx].account = input.value.trim();
        }
      };
      input.addEventListener("input", syncAcct);
      input.addEventListener("change", syncAcct);
    });

    parsedTasksPreviewContainer.querySelectorAll(".parsed-content-input").forEach((textarea) => {
      textarea.addEventListener("input", () => {
        const idx = parseInt(textarea.dataset.idx, 10);
        if (parsedTaskGroups[idx]) {
          parsedTaskGroups[idx].content = textarea.value;
          const countEl = parsedTasksPreviewContainer.querySelector(`.parsed-char-count[data-idx="${idx}"]`);
          if (countEl) countEl.textContent = `${textarea.value.length} 字`;
        }
      });
      textarea.addEventListener("change", () => {
        const idx = parseInt(textarea.dataset.idx, 10);
        if (parsedTaskGroups[idx]) {
          parsedTaskGroups[idx].content = textarea.value.trim();
        }
      });
    });

    parsedTasksPreviewContainer.querySelectorAll(".parsed-repost-url-input").forEach((input) => {
      const syncRepost = () => {
        const idx = parseInt(input.dataset.idx, 10);
        if (parsedTaskGroups[idx]) {
          parsedTaskGroups[idx].repostUrl = input.value.trim();
        }
      };
      input.addEventListener("input", syncRepost);
      input.addEventListener("change", syncRepost);
    });

    parsedTasksPreviewContainer.querySelectorAll(".parsed-comment-orig-input").forEach((cb) => {
      cb.addEventListener("change", () => {
        const idx = parseInt(cb.dataset.idx, 10);
        if (parsedTaskGroups[idx]) {
          parsedTaskGroups[idx].commentOriginal = !!cb.checked;
        }
      });
    });

    parsedTasksPreviewContainer.querySelectorAll(".parsed-poll-title-input").forEach((input) => {
      const syncTitle = () => {
        const idx = parseInt(input.dataset.idx, 10);
        if (parsedTaskGroups[idx]?.poll) {
          parsedTaskGroups[idx].poll.title = input.value.trim() || "参与投票";
        }
      };
      input.addEventListener("input", syncTitle);
      input.addEventListener("change", syncTitle);
    });

    parsedTasksPreviewContainer.querySelectorAll(".parsed-poll-opt-input").forEach((input) => {
      const syncOpt = () => {
        const idx = parseInt(input.dataset.idx, 10);
        const optIdx = parseInt(input.dataset.optIdx, 10);
        if (parsedTaskGroups[idx]?.poll && Number.isInteger(optIdx)) {
          parsedTaskGroups[idx].poll.options[optIdx] = input.value.trim();
        }
      };
      input.addEventListener("input", syncOpt);
      input.addEventListener("change", syncOpt);
    });

    parsedTasksPreviewContainer.querySelectorAll(".btn-add-parsed-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        if (parsedTaskGroups[idx]?.poll) {
          if (parsedTaskGroups[idx].poll.options.length >= 20) {
            alert("单条投票最多支持 20 个选项！");
            return;
          }
          parsedTaskGroups[idx].poll.options.push("");
          renderParsedTasksPreview();
        }
      });
    });

    parsedTasksPreviewContainer.querySelectorAll(".btn-del-parsed-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const optIdx = parseInt(btn.dataset.optIdx, 10);
        if (parsedTaskGroups[idx]?.poll && parsedTaskGroups[idx].poll.options.length > 2) {
          parsedTaskGroups[idx].poll.options.splice(optIdx, 1);
          renderParsedTasksPreview();
        }
      });
    });

    parsedTasksPreviewContainer.querySelectorAll(".btn-del-parsed").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        parsedTaskGroups.splice(idx, 1);
        renderParsedTasksPreview();
      });
    });
  }

  btnParseTasks?.addEventListener("click", async () => {
    const raw = (taskParserInput?.value || "").trim();
    if (!raw) {
      alert("请先粘贴需要解析的任务文本或单条微博链接！");
      return;
    }

    // 0. 第一优先级 (对齐原系统 instant.html:7031-7050)：单行微博 URL 自动克隆原微博投票任务！
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const isSingleWeiboUrl =
      lines.length === 1 && /^https?:\/\/(?:www\.|m\.)?(?:weibo\.com|weibo\.cn)\/\S+$/i.test(lines[0]);

    if (isSingleWeiboUrl) {
      const weiboUrl = lines[0];
      btnParseTasks.disabled = true;
      btnParseTasks.textContent = "⏳ 正在读取原博投票活动与正文...";
      appendLog(`检测到单条微博链接，正在克隆提取原博正文与投票活动: ${weiboUrl.substring(0, 42)}...`, "info");

      try {
        const resp = await chrome.runtime.sendMessage({
          action: "CLONE_WEIBO_POLL",
          weiboUrl: weiboUrl,
        });

        if (resp && resp.ok && resp.data) {
          const d = resp.data;
          parsedTaskGroups = [
            {
              id: `parsed_${Date.now()}_clone`,
              account: "",
              content: d.content || weiboUrl,
              poll: {
                title: d.pollTitle || "参与投票",
                options: d.pollOptions || [],
                days: 30,
              },
              docName: "投票克隆",
              row: "1",
              targetCell: "-",
            },
          ];
          renderParsedTasksPreview();
          appendLog(
            `🎉 成功克隆原博投票活动！【${d.pollTitle}】(含 ${d.pollOptions.length} 个选项)，正文已就绪`,
            "success"
          );
          return;
        } else {
          appendLog(`克隆原博投票提示: ${resp?.error || "未识别到投票"}，已转为常规解析`, "warn");
        }
      } catch (cloneErr) {
        console.warn("克隆投票通信异常:", cloneErr);
      } finally {
        btnParseTasks.disabled = false;
        btnParseTasks.textContent = "🔍 智能解析预览";
      }
    }

    btnParseTasks.disabled = true;
    try {
      parsedTaskGroups = await parseBatchTaskText(raw);
      renderParsedTasksPreview();
      appendLog(`✨ 任务智能解析完成，共拆分出 ${parsedTaskGroups.length} 条独立发博任务`, "success");
    } catch (err) {
      parsedTaskGroups = [];
      renderParsedTasksPreview();
      appendLog(`任务解析失败: ${err.message}`, "warn");
      alert(err.message);
    } finally {
      btnParseTasks.disabled = false;
    }
  });

  btnClearParser?.addEventListener("click", () => {
    if (taskParserInput) taskParserInput.value = "";
    parsedTaskGroups = [];
    renderParsedTasksPreview();
  });

  btnToggleParserInput?.addEventListener("click", () => {
    if (!taskParserInput) return;
    const isHidden = taskParserInput.style.display === "none";
    taskParserInput.style.display = isHidden ? "block" : "none";
    btnToggleParserInput.textContent = isHidden ? "🔼 收起原文" : "🔽 展开原文";
  });

  btnParserToSchedule?.addEventListener("click", () => {
    openEnqueueScheduleModal("parser");
  });

  btnParserRunNow?.addEventListener("click", async () => {
    if (parsedTaskGroups.length === 0) return;
    const isDryRun = dryRunToggle.checked;
    if (!isDryRun && !confirm(`当前处于【真实发博模式】，确认要立即向中台批量发送这 ${parsedTaskGroups.length} 条解析任务吗？`)) {
      return;
    }

    updatePipelineControls(true);
    appendLog(`🚀 开始批量执行任务解析生成的 ${parsedTaskGroups.length} 条任务 [${isDryRun ? "安全演练" : "真实发布"}]...`, "info");

    try {
      const resp = await chrome.runtime.sendMessage({
        action: "START_PIPELINE",
        config: {
          docs: [],
          dryRun: isDryRun,
          silentMode: silentModeToggle ? silentModeToggle.checked : true,
          selectedTasks: parsedTaskGroups.map((t, idx) => ({
            docName: t.docName || "任务解析",
            row: `${idx + 1}`,
            targetCell: "-",
            account: String(t.account || "").trim(),
            content: String(t.content || "").trim(),
            poll: t.poll
              ? {
                  ...t.poll,
                  title: String(t.poll.title || "").trim() || "参与投票",
                  options: (t.poll.options || []).map((o) => String(o || "").trim()).filter(Boolean),
                }
              : null,
            repostUrl: t.repostUrl || "",
            commentOriginal: !!t.commentOriginal,
            imgUrls: [],
          })),
        },
      });

      if (resp && resp.ok) {
        appendLog(`任务解析批量执行完成！${formatPipelineSummary(resp.summary)}`, "success");
      } else {
        appendLog(`批量执行报错: ${resp?.error || "未知异常"}`, "error");
      }
    } catch (err) {
      appendLog(`通讯异常: ${err.message}`, "error");
    } finally {
      await refreshPipelineControls();
    }
  });

  function formatPipelineSummary(summary = {}) {
    return `已处理 ${summary.processed ?? summary.published ?? 0} 条：真实发布 ${summary.published || 0} 条，演练 ${summary.rehearsed || 0} 条，投票待人工发送 ${summary.prepared || 0} 条，文档写回 ${summary.writtenBack || 0} 条`;
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
});
