/**
 * doc_parser.js - 云文档（腾讯文档 / 钉钉表格）内容提取与回写脚本
 * 运行在 docs.qq.com 和 alidocs.dingtalk.com 的页面上下文中
 */

(function () {
  console.log("[DocParser] Content script loaded on:", window.location.href);

  // 监听来自 Background 或 Popup 的指令
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "PING_DOC") {
      sendResponse({ ok: true, url: window.location.href, title: document.title });
      return true;
    }

    if (request.action === "EXTRACT_DOC_TASKS") {
      handleExtractTasks(request.options || {})
        .then((result) => sendResponse({ ok: true, data: result }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }

    if (request.action === "WRITE_CELL_LINK") {
      handleWriteCell(request.cellAddr, request.value)
        .then((result) => sendResponse({ ok: result.ok === true, data: result, error: result.error }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }
  });

  /**
   * 辅助函数：等待指定元素出现
   */
  function waitForSelector(selector, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          observer.disconnect();
          resolve(found);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        const finalCheck = document.querySelector(selector);
        if (finalCheck) resolve(finalCheck);
        else reject(new Error(`等待选择器超时: ${selector}`));
      }, timeoutMs);
    });
  }

  /**
   * 获取腾讯文档核心定位框与公式栏
   */
  function getTencentFormulaElements() {
    // 腾讯文档的单元格地址框（name box）和公式栏
    const nameBox =
      document.querySelector('input[data-role="name-box"]') ||
      document.querySelector('.name-box input') ||
      document.querySelector('#formula-name-box') ||
      document.querySelector('.formula-cell-position') ||
      document.querySelector('.formula-bar-name-box input') ||
      document.querySelector('input.position-input');

    const formulaInput =
      document.querySelector('#formula-bar-input') ||
      document.querySelector('.formula-input') ||
      document.querySelector('.formula-bar-edit-input') ||
      document.querySelector('div[contenteditable="true"].formula-input') ||
      document.querySelector('.formula-bar input');

    return { nameBox, formulaInput };
  }

  /**
   * 模拟真实键盘输入
   */
  async function simulateType(element, text) {
    element.focus();
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      element.value = "";
      element.value = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));
    } else if (element.isContentEditable) {
      element.textContent = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
  }

  /**
   * 在线表格导航至指定单元格（如 E12）
   */
  async function navigateToCell(nameBox, cellAddr) {
    if (!nameBox) return false;
    nameBox.focus();
    nameBox.value = "";
    nameBox.value = cellAddr.toUpperCase();
    nameBox.dispatchEvent(new Event("input", { bubbles: true }));
    nameBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));
    await new Promise((r) => setTimeout(r, 350));
    return true;
  }

  /**
   * 提取待发布任务
   */
  async function handleExtractTasks(options) {
    console.log("[DocParser] 开始提取文档待发任务，参数:", options);

    // 尝试在页面中查找可提取的数据结构
    const tasks = [];
    const isTencent = window.location.hostname.includes("qq.com");
    const isDingTalk = window.location.hostname.includes("dingtalk.com");

    const linkColLetter = (options.linkCol || "E").toUpperCase();
    const targetAccount = (options.account || "").trim();

    // 策略 1：检查是否有可读的 DOM 单元格视图（如 HTML 表格、可导出的结构）
    const cellElements = document.querySelectorAll(".grid-row, .table-row, tr, [role='row']");
    if (cellElements.length > 1) {
      console.log(`[DocParser] 检测到行容器 DOM (${cellElements.length} 行)`);
      cellElements.forEach((rowEl, index) => {
        const text = (rowEl.innerText || "").trim();
        if (!text || text.includes("账号") || text.includes("博文内容")) return; // 跳过表头

        const cols = text.split("\t").map((s) => s.trim());
        if (cols.length >= 2) {
          const rowAccount = cols[1] || "";
          const content = cols[2] || cols[0] || "";
          const link = cols[4] || "";

          if (content && !link) {
            if (!targetAccount || rowAccount.includes(targetAccount) || targetAccount.includes(rowAccount)) {
              tasks.push({
                row: index + 1,
                account: rowAccount,
                content: content,
                link: "",
                targetCell: `${linkColLetter}${index + 1}`,
                raw: text,
              });
            }
          }
        }
      });
    }

    // 策略 2：如果 DOM 未展开（Canvas 渲染），提供便捷的公式栏交互探测或手动选区注入
    if (tasks.length === 0) {
      const { nameBox, formulaInput } = getTencentFormulaElements();
      console.log("[DocParser] DOM 未直接暴露行，公式栏探测状态:", { hasNameBox: !!nameBox, hasFormula: !!formulaInput });

      // 如果已探测到编辑栏，至少说明位于可用在线表格中
      if (nameBox || formulaInput) {
        // 返回当前在线表格状态，支持按行读取
        return {
          status: "ready",
          provider: isTencent ? "TencentDocs" : isDingTalk ? "DingTalk" : "Unknown",
          detectedFormulaBar: true,
          tasks: tasks,
          message: tasks.length ? `成功提取到 ${tasks.length} 条待发布任务` : "未发现未填链接的待发布行（或表格处于纯 Canvas 状态）",
        };
      }
    }

    return {
      status: "ready",
      provider: isTencent ? "TencentDocs" : isDingTalk ? "DingTalk" : "Unknown",
      tasks: tasks,
      count: tasks.length,
      message: `已提取 ${tasks.length} 条待发布内容`,
    };
  }

  /**
   * 将链接写回指定单元格
   */
  async function handleWriteCell(cellAddr, linkValue) {
    if (!cellAddr || !linkValue) {
      throw new Error("缺少单元格地址或写入链接");
    }

    console.log(`[DocParser] 准备写入单元格: ${cellAddr} <- ${linkValue}`);
    const { nameBox, formulaInput } = getTencentFormulaElements();

    if (!/^[A-Z]+[1-9][0-9]*$/i.test(String(cellAddr).trim())) throw new Error("无效的单元格地址");
    if (!nameBox || !formulaInput) {
      throw new Error("未找到文档公式栏和单元格定位器，未执行写入");
    }

    // 1. 导航到目标单元格
    if (nameBox) {
      await navigateToCell(nameBox, cellAddr);
      await new Promise((r) => setTimeout(r, 200));
    }

    // 2. 写入公式栏
    if (formulaInput) {
      await simulateType(formulaInput, linkValue);
      await new Promise((r) => setTimeout(r, 300));
    }

    // 3. 触发全局回车确认
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));

    return {
      ok: false,
      dispatched: true,
      cell: cellAddr,
      value: linkValue,
      error: "已触发编辑动作，但隔离内容脚本无法验证表格底层写回，请使用后台流水线进行校验",
      timestamp: Date.now(),
    };
  }
})();
