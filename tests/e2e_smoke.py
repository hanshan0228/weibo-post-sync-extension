"""使用全新Chromium配置及本地响应夹具，不访问真实账号或发布接口。"""
import argparse
import json
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


DOC_HTML = r'''<!doctype html><meta charset="utf-8"><title>隔离Mock文档</title>
<h1>隔离Mock文档</h1><script>
window.mockWrites = [];
const rows = [ ['时间', '账号', '正文', '素材', '微博链接'],
  ['', '隔离Mock账号', '隔离测试正文', '', ''], ['', '另一个Mock账号', '第二条Mock正文', '', ''] ];
const sheet = { getSheetId: () => 'mock_sheet', getSheetName: () => 'Mock表',
  getIsInitialized: () => true, getRowCount: () => rows.length, getColCount: () => 5,
  getCellDataAtPosition: (r,c) => ({ value: rows[r]?.[c] || '' }) };
window.SpreadsheetApp = { workbook: { worksheetManager: { sheetList: [sheet] } },
  e2eTools: { getCellEditValue: (wb,r,c,sid,cell) => cell?.value || '' },
  behaviorApi: { cellApi: { setSingleValue: async payload => {
    window.mockWrites.push(payload); rows[payload.rowIndex][payload.colIndex] = payload.text;
  } } } };
</script>'''

PLATFORM_HTML = r'''<!doctype html><meta charset="utf-8"><title>隔离Mock发稿中台</title>
<style>.n-checkbox,textarea,button { display:block; margin:15px; padding:10px; min-width:160px; min-height:35px }</style>
<div class="n-checkbox account_selector_checkbox" role="checkbox" aria-checked="false">
<input type="checkbox"><span class="n-checkbox__label">隔离Mock账号</span></div>
<textarea placeholder="微博内容"></textarea><button class="n-button n-button--primary">保存并发布</button>
<script>
window.mockPublishClicks = 0;
const checkbox = document.querySelector('.n-checkbox');
checkbox.onclick = event => {
  const input = checkbox.querySelector('input');
  if (event.target !== input) input.checked = !input.checked;
  checkbox.classList.toggle('n-checkbox--checked', input.checked);
  checkbox.setAttribute('aria-checked', String(input.checked));
};
document.querySelector('button').onclick = () => {
  window.mockPublishClicks++;
  const dialog = document.createElement('div');
  dialog.className = 'n-dialog publish_model';
  dialog.innerHTML = '<p>发布成功：隔离Mock账号 隔离测试正文</p><a class="publish_model_link" href="https://weibo.com/1234567890/MockOnly123">https://weibo.com/1234567890/MockOnly123</a><button class="n-dialog__close">关闭</button>';
  dialog.querySelector('button').onclick = () => dialog.remove();
  document.body.appendChild(dialog);
};
</script>'''


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"通过：{message}")


def run(project):
    blocked = []
    assertions = []
    with tempfile.TemporaryDirectory(prefix="weibo-isolated-e2e-") as profile:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile, channel="chromium", headless=True,
                args=[f"--disable-extensions-except={project}", f"--load-extension={project}",
                      "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"],
            )
            try:
                def route_request(route):
                    request = route.request
                    host = urlparse(request.url).hostname
                    if request.is_navigation_request() and host == "docs.qq.com":
                        route.fulfill(status=200, content_type="text/html", body=DOC_HTML)
                    elif request.is_navigation_request() and host == "ai-publish-platform.weibo.com":
                        route.fulfill(status=200, content_type="text/html", body=PLATFORM_HTML)
                    else:
                        blocked.append(request.url)
                        route.abort("blockedbyclient")

                context.route("http://**/*", route_request)
                context.route("https://**/*", route_request)
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
                extension_id = worker.url.split("/")[2]
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"chrome-extension://{extension_id}/popup/popup.html")
                check(page.url != "about:blank", "扩展控制面板已完成真实导航")
                page.locator("#docSlotsContainer .doc-slot-row").first.wait_for()
                check(page.locator("#docSlotsContainer .doc-slot-row").count() == 2, "空配置正确创建两个文档卡槽")
                page.locator("#tabNavSettings").click()
                check(page.locator("#panelSettings").is_visible(), "设置页导航和DOM事件绑定正常")
                if page.locator("#silentModeToggle").is_checked():
                    page.locator("label.toggle-switch:has(#silentModeToggle)").click()
                page.reload()
                page.locator("#docSlotsContainer .doc-slot-row").first.wait_for()
                page.locator("#tabNavSettings").click()
                check(not page.locator("#silentModeToggle").is_checked(), "关闭静默模式后重开仍正确恢复")
                page.locator("#tabNavParser").click()
                page.locator("#taskParserInput").fill("账号：隔离Mock账号\n这是一段普通正文\n这是另一段正文\n这是第三段正文")
                page.locator("#btnParseTasks").click()
                page.locator("#parsedTasksPreviewContainer .sched-item-card").first.wait_for()
                preview = page.locator("#parsedTasksPreviewContainer").inner_text()
                preview_content = page.locator("#parsedTasksPreviewContainer .parsed-content-input").first.input_value()
                check("这是第三段正文" in preview_content and "投票标题" not in preview, "普通多行正文不会被误拆为投票选项")
                doc_fixture_page = context.new_page()
                doc_fixture_page.goto("https://docs.qq.com/sheet/MOCK?tab=mock_sheet")
                check(doc_fixture_page.evaluate("Boolean(window.SpreadsheetApp)"), "Mock文档夹具运行时已加载，业务域名DNS禁止外联")
                platform_fixture_page = context.new_page()
                platform_fixture_page.goto("https://ai-publish-platform.weibo.com/#/post")
                check(platform_fixture_page.locator("button").inner_text() == "保存并发布", "Mock中台夹具已加载")
                page.locator("#tabNavSync").click()
                page.locator(".doc-slot-url-input").first.fill("https://docs.qq.com/sheet/MOCK?tab=mock_sheet")
                page.locator("#btnScanTasks").click()
                page.locator("#taskListContainer .task-item-card").first.wait_for(timeout=25000)
                check(page.locator("#taskListContainer .task-item-card").count() == 2, "真实扩展后台跨标签注入并提取两条Mock文档任务")
                doc_page = next(p for p in context.pages if "docs.qq.com/sheet/MOCK" in p.url)
                print("文档探针：", doc_page.url, doc_page.locator("body").inner_text())
                task = {"id": "mock_e2e", "account": "隔离Mock账号", "content": "隔离测试正文", "row": 2,
                        "docId": "mock_slot", "docName": "隔离Mock文档", "docUrl": doc_page.url,
                        "targetCell": "E2", "targetSheetId": "mock_sheet"}
                response = page.evaluate("""task => chrome.runtime.sendMessage({ action:'START_PIPELINE',
                    config:{ dryRun:true, silentMode:false, selectedTasks:[task] } })""", task)
                check(response.get("ok"), f"安全演练完成：{json.dumps(response, ensure_ascii=False)}")
                check(doc_page.evaluate("window.mockWrites.length") == 0, "安全演练没有修改Mock文档")
                platform_page = next(p for p in context.pages if "ai-publish-platform.weibo.com" in p.url)
                check(platform_page.evaluate("window.mockPublishClicks") == 0, "安全演练从未点击Mock发布按钮")
                check(response["summary"]["published"] == 0, "演练结果不冒充真实发布")
                print("中台探针：", platform_page.url, platform_page.locator("button").all_text_contents())
                response = page.evaluate("""task => chrome.runtime.sendMessage({ action:'START_PIPELINE',
                    config:{ dryRun:false, silentMode:false, selectedTasks:[task] } })""", task)
                check(response.get("ok"), f"全隔离模拟发布回写完成：{json.dumps(response, ensure_ascii=False)}")
                check(platform_page.evaluate("window.mockPublishClicks") == 1, "模拟发布仅点击一次，无重复发射")
                check(doc_page.evaluate("window.mockWrites.length") == 1, "模拟回执准确回写一次指定Mock单元格")
                check(doc_page.evaluate("window.mockWrites[0].sheetId === 'mock_sheet' && window.mockWrites[0].rowIndex === 1 && window.mockWrites[0].colIndex === 4"), "回写位置为指定子表E2")
                ledger = page.evaluate("async () => (await chrome.storage.local.get('publishLedger')).publishLedger")
                check(len(ledger) == 2 and ledger[0]["writeBackOk"], "演练与模拟真实发布分开记账，并保留已验证回执")
                page.locator("#tabNavLedger").click()
                page.locator("#ledgerListContainer .ledger-item-card").first.wait_for()
                check(page.locator("#ledgerListContainer .ledger-item-card").count() == 2, "账本页真实渲染两条执行记录")
                check(not errors, f"控制面板无未处理JavaScript异常：{errors}")
                print("已阻断非夹具请求：", len(blocked))
                print("隔离浏览器端到端回归全部通过；未接触日常浏览器配置或真实账户。")
            except Exception:
                for probe_page in context.pages:
                    if probe_page.url != "about:blank":
                        print("失败现场URL：", probe_page.url)
                        try:
                            print("失败现场DOM：", probe_page.locator("body").inner_text(timeout=3000)[-5000:])
                        except Exception as probe_error:
                            print("现场读取失败：", str(probe_error))
                raise
            finally:
                context.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    run(args.project.resolve())
