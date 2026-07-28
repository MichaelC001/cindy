/**
 * popupTabs —— 记录"由 guest 页面脚本(window.open / target=_blank)催生"的
 * web-browser tab id 集合。
 *
 * 为什么需要:webview guest 调 `window.close()` 会触发 webview 的 `close` DOM
 * 事件,宿主可据此自动关掉对应 tab(OAuth callback 页的标准收尾动作,不接就会
 * 残留空 tab)。但真实浏览器只允许"脚本打开的窗口被脚本关闭",普通 tab 调
 * `window.close()` 会被忽略——不区分来源会让任意网页有能力关掉用户正在用的
 * tab。本模块就是那个"script-opened"标记。
 *
 * 纯 renderer 内存态,不持久化:重启后丢失意味着旧 callback 页需要手关一次,
 * 可接受;换来的是零 DB/schema 面积。
 */

const popupSpawnedTabIds = new Set<string>();

/** popup 路由创建 tab 后登记(RightSidebarShell 的 onRsbBrowserPopup 路径)。 */
export function markPopupSpawnedTab(tabId: string): void {
  popupSpawnedTabIds.add(tabId);
}

/** guest `window.close()` 时查询:只有 popup 催生的 tab 允许自关。 */
export function isPopupSpawnedTab(tabId: string): boolean {
  return popupSpawnedTabIds.has(tabId);
}

/**
 * tab **真正从 store 关闭**后清除登记。清理时机必须跟 tab 生命周期而不是
 * webview 实例生命周期:pool release(LRU 淘汰 / 宿主迁移)只销毁 webview,
 * tab 仍在 bucket,标记必须保留——否则重建后的 callback 页 window.close()
 * 会被误判为普通 tab 而失效。
 */
export function unmarkPopupSpawnedTab(tabId: string): void {
  popupSpawnedTabIds.delete(tabId);
}

/** Test-only reset. */
export function _resetPopupTabsForTests(): void {
  popupSpawnedTabIds.clear();
}
