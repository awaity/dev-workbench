/** 浏览器后台每日清理任务的稳定名称，更新扩展时沿用同一任务。 */
export const CLEANUP_ALARM = 'dev-workbench:auto-cleanup';
/** 清理规则变更消息；只通知本扩展后台，不携带用户数据。 */
export const CLEANUP_SETTINGS_CHANGED = 'dev-workbench:cleanup-settings-changed';
/** 后台清理完成后通知已打开的工作台刷新本地统计。 */
export const DATA_CLEANED = 'dev-workbench:data-cleaned';
/**
 * 通知扩展后台更新每日任务；普通网页预览由页面启动检查负责清理。
 * @returns 后台完成规则同步后的 Promise。
 * @throws {Error} 扩展后台不可用或清理失败时抛出，便于界面反馈。
 */
export async function syncCleanupSchedule(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    return;
  }
  const response: { error?: string } | undefined = await chrome.runtime.sendMessage({
    type: CLEANUP_SETTINGS_CHANGED,
  });
  if (response?.error) {
    throw new Error(response.error);
  }
}
