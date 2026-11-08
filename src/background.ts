import { readSettings, runAutoCleanup, type CleanupResult } from './lib/storage';
import { CLEANUP_ALARM, CLEANUP_SETTINGS_CHANGED, DATA_CLEANED } from './lib/maintenance';

/** 顺序执行后台维护，避免设置变更和闹钟事件交错创建过期任务。 */
let cleanupQueue: Promise<void> = Promise.resolve();

/**
 * 按持久化开关创建或移除每日闹钟；已存在任务保持原定时间。
 * @returns 后台任务配置完成的 Promise。
 */
async function configureCleanupAlarm(): Promise<void> {
  const policy = await readSettings();
  if (!policy.autoCleanup) {
    await chrome.alarms.clear(CLEANUP_ALARM);
    return;
  }
  if (!(await chrome.alarms.get(CLEANUP_ALARM))) {
    await chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
  }
}
/**
 * 同步后台任务并执行规则，清理后通知所有已打开的扩展页面。
 * @returns 本次删除的历史和附件统计。
 */
async function maintainData(): Promise<CleanupResult> {
  await configureCleanupAlarm();
  const result = await runAutoCleanup();
  if (result.history || result.attachments) {
    await chrome.runtime.sendMessage({ type: DATA_CLEANED }).catch(() => {
      /* 没有打开的工作台时无需通知；下次打开会读取清理后的数据库。 */
    });
  }
  return result;
}
/**
 * 将后台维护加入队列，前一任务失败也继续读取最新的持久化规则。
 * @returns 当前维护任务的清理统计。
 */
function queueMaintenance(): Promise<CleanupResult> {
  const task = cleanupQueue.then(maintainData);
  cleanupQueue = task.then(
    () => {},
    () => {},
  );
  return task;
}
/**
 * 执行浏览器生命周期触发的维护，将失败保留在后台日志以便诊断。
 * @returns 本次维护结束后的 Promise。
 */
async function scheduledCleanup(): Promise<void> {
  try {
    await queueMaintenance();
  } catch (error) {
    console.error('自动清理失败', error);
  }
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEANUP_ALARM) {
    return scheduledCleanup();
  }
});
chrome.runtime.onStartup.addListener(scheduledCleanup);
chrome.runtime.onInstalled.addListener(scheduledCleanup);
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (
    sender.id !== chrome.runtime.id ||
    !message ||
    typeof message !== 'object' ||
    !('type' in message) ||
    message.type !== CLEANUP_SETTINGS_CHANGED
  ) {
    return;
  }
  void queueMaintenance()
    .then(() => {
      sendResponse({ ok: true });
    })
    .catch((error: unknown) => {
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});
// 闹钟在浏览器重启后可能丢失，每次 Service Worker 启动时检查并恢复。
void scheduledCleanup();
