/**
 * weibo_poster.js - 微博发稿中台自动化脚本 (已与 5000 端口核心对齐)
 * 专为 https://ai-publish-platform.weibo.com/#/post 机构发稿中台设计
 * 支持：多分类 Tab 遍历、Naive UI 账号复选框精准勾选、正文填充、安全演练与回执提取
 */

(function () {
  console.log("[WeiboPoster] Content script loaded on AI publish platform:", window.location.href);

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "PING_WEIBO") {
      const isPlatform = window.location.hostname.includes("ai-publish-platform.weibo.com");
      sendResponse({
        ok: true,
        url: window.location.href,
        isPlatform: isPlatform,
      });
      return true;
    }

    if (request.action === "POST_WEIBO_TASK") {
      handlePostOnPlatform(request.task || {}, request.dryRun !== false)
        .then((result) => sendResponse({ ok: true, data: result }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }
  });

  const ACCOUNT_TABS = ["热点", "垂类", "军事", "填充", "游戏"];

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^0-9a-z一-鿿]/g, "");
  }

  /**
   * 切换发稿台顶部分类 Tab
   */
  async function switchAccountTab(tabName) {
    const target = tabName.trim();

    // 优先通过文本匹配 Tab
    const tabCandidates = document.querySelectorAll(".n-tabs-tab, [role='tab'], button");
    for (const el of tabCandidates) {
      if ((el.innerText || "").trim().includes(target)) {
        el.click();
        await new Promise((r) => setTimeout(r, 400));
        return true;
      }
    }
    return false;
  }

  /**
   * 查找并勾选目标账号复选框 (.n-checkbox)
   */
  async function findAndCheckAccount(targetAccount) {
    const normTarget = normalizeText(targetAccount);
    if (!normTarget) return false;

    function isCheckboxChecked(root) {
      const input = root.querySelector('input[type="checkbox"]');
      if (input) return !!input.checked;
      return (
        root.getAttribute("aria-checked") === "true" ||
        root.classList.contains("n-checkbox--checked") ||
        root.classList.contains("is-checked")
      );
    }

    // 在当前 DOM 中查找匹配账号名称的 checkbox
    function findInCurrentView() {
      const candidates = document.querySelectorAll('.n-checkbox, [role="checkbox"], label');
      for (const root of candidates) {
        const text = normalizeText(root.innerText || root.textContent || "");
        if (text === normTarget) {
          return root;
        }
      }
      return null;
    }

    // 1. 先在当前显示的 Tab 下查找
    let found = findInCurrentView();
    if (found) {
      if (!isCheckboxChecked(found)) {
        found.click();
        await new Promise((r) => setTimeout(r, 200));
      }
      return isCheckboxChecked(found);
    }

    // 2. 若当前分类下找不到，遍历各分类 Tab（热点、垂类、军事等）逐个寻找
    for (const tab of ACCOUNT_TABS) {
      await switchAccountTab(tab);
      await new Promise((r) => setTimeout(r, 350));
      found = findInCurrentView();
      if (found) {
        if (!isCheckboxChecked(found)) {
          found.click();
          await new Promise((r) => setTimeout(r, 200));
        }
        return isCheckboxChecked(found);
      }
    }

    return false;
  }

  /**
   * 取消当前所有已选中的账号（防串号多发）
   */
  async function clearAllCheckedAccounts() {
    const checkedBoxes = document.querySelectorAll(
      '.n-checkbox.n-checkbox--checked, .n-checkbox.is-checked, [role="checkbox"][aria-checked="true"]'
    );
    for (const cb of checkedBoxes) {
      cb.click();
    }
    if (checkedBoxes.length > 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /**
   * 查找文案输入框并填入正文
   */
  async function fillContentTextarea(content) {
    const textarea =
      document.querySelector('textarea[placeholder*="微博内容"]') ||
      document.querySelector('textarea[placeholder*="新鲜事"]') ||
      document.querySelector('.n-input textarea') ||
      document.querySelector('textarea');

    if (!textarea) {
      throw new Error("未在中台发稿页中找到文案输入框 (textarea)");
    }

    textarea.focus();
    // 穿透 Vue / Naive UI 受控响应
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(textarea, content);
    } else {
      textarea.value = content;
    }

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  }

  /**
   * 查找最终发布按钮
   */
  function findFinalPublishButton() {
    const publishKeywords = ["保存并发布"];
    const buttons = document.querySelectorAll('button, .n-button, [role="button"]');
    for (const btn of buttons) {
      const text = (btn.innerText || btn.textContent || "").trim();
      if (publishKeywords.includes(text) && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        return btn;
      }
    }
    return null;
  }

  /**
   * 提取发博成功弹窗中的回执链接
   */
  async function extractPublishedUrl(maxWaitMs = 12000) {
    const copyKeywords = ["复制全部链接", "复制全部账号/链接", "复制全部", "复制链接"];
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      // 1. 寻找“复制链接”按钮点击
      const allButtons = document.querySelectorAll('.publish_model button, .n-dialog button, [role="dialog"] button');
      for (const btn of allButtons) {
        const text = (btn.innerText || "").trim();
        if (copyKeywords.includes(text)) {
          btn.click();
          await new Promise((r) => setTimeout(r, 500));
          break;
        }
      }

      // 2. 从弹窗内正文正则抓取 URL
      const textNodes = document.querySelectorAll('.publish_model, .n-dialog, .n-modal, [role="dialog"]');
      for (const node of textNodes) {
        const txt = node.innerText || "";
        if (!/发布成功|复制/.test(txt)) continue;
        const match = txt.match(/https?:\/\/(?:www\.)?weibo\.com\/(?:[0-9]{5,}\/[A-Za-z0-9]+|detail\/[A-Za-z0-9]+)(?=$|[\s?#"'<>])/i) ||
                      txt.match(/https?:\/\/m\.weibo\.cn\/(?:status|detail)\/[A-Za-z0-9]+(?=$|[\s?#"'<>])/i);
        if (match) {
          return match[0];
        }
      }

      await new Promise((r) => setTimeout(r, 400));
    }

    throw new Error("已触发发布动作，但未获得可验证的博文回执链接，请核对后再处理");
  }

  /**
   * 安全浮动提示横幅
   */
  function showBanner(text, isWarning = false) {
    let banner = document.getElementById("__weibo_platform_banner__");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "__weibo_platform_banner__";
      banner.style.cssText = `
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 2147483647;
        padding: 14px 22px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        box-shadow: 0 6px 20px rgba(0,0,0,0.22);
        max-width: 460px;
        line-height: 1.5;
        transition: opacity 0.4s ease;
      `;
      document.body.appendChild(banner);
    }
    banner.style.backgroundColor = isWarning ? "#FEF2F2" : "#ECFDF5";
    banner.style.color = isWarning ? "#991B1B" : "#065F46";
    banner.style.border = `1.5px solid ${isWarning ? "#FCA5A5" : "#10B981"}`;
    banner.innerText = text;

    setTimeout(() => {
      if (banner && banner.parentNode) {
        banner.style.opacity = "0";
        setTimeout(() => banner.remove(), 400);
      }
    }, 6000);
  }

  /**
   * 中台发稿总流程
   */
  async function handlePostOnPlatform(task, isDryRun) {
    const targetAccount = (task.account || "").trim();
    const content = (task.content || "").trim();

    if (!content) throw new Error("待发内容为空");
    if (window.location.hostname !== "ai-publish-platform.weibo.com") throw new Error("当前页面不是发稿中台，已阻断操作");
    if (task.poll || task.imgUrls?.length || task.imagesData?.length) {
      throw new Error("旧消息发布入口不支持图片或投票，请使用插件后台流水线");
    }

    console.log(`[WeiboPoster] 开始在中台调度任务: 目标账号=[${targetAccount || "未指定"}], DryRun=${isDryRun}`);

    // 1. 如果指定了账号，执行多账号复选框勾选
    if (targetAccount) {
      await clearAllCheckedAccounts();
      const matched = await findAndCheckAccount(targetAccount);
      if (!matched) {
        throw new Error(`未找到并勾选指定账号 [${targetAccount}]，已阻断发送`);
      } else {
        console.log(`[WeiboPoster] 已成功匹配并勾选账号: [${targetAccount}]`);
      }
    }

    // 2. 填充正文内容
    await fillContentTextarea(content);

    // 3. 检查最终发布按钮
    const publishBtn = findFinalPublishButton();

    // 4. 安全演练判断 (Dry-Run Gate)
    if (isDryRun) {
      showBanner(`🛡️【安全演练】账号 [${targetAccount || "当前选中"}] 勾选就绪，文案已填入，安全阻断未实际点击发布！`, false);
      const mockUrl = `https://weibo.com/detail/mock_dryrun_${Date.now()}`;
      return {
        success: true,
        dryRun: true,
        account: targetAccount,
        postUrl: mockUrl,
        message: `【演练成功】已匹配并勾选账号 [${targetAccount}]，生成模拟回执链接`,
      };
    }

    // 5. 真实发布流程
    if (!publishBtn) {
      throw new Error("在中台发稿页未找到发布按钮（保存并发布）");
    }

    publishBtn.click();
    showBanner(`🚀 正在向账号 [${targetAccount || "选中账号"}] 提交发布，正在抓取回执链接...`, false);

    // 等待并提取生成的微博回执链接
    const postUrl = await extractPublishedUrl();
    return {
      success: true,
      dryRun: false,
      account: targetAccount,
      postUrl: postUrl,
      message: `账号 [${targetAccount}] 已成功提交发布`,
    };
  }
})();
