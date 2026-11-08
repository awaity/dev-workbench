/** 同源页面之间的数据更新通知，不传输具体用户内容。 */
export const DATA_CHANNEL = 'dev-workbench:data-updated';
/**
 * 在事务提交后通知其他扩展页面重新读取数据；通知失败不影响已保存的记录。
 * @returns 无返回值。
 */
export function notifyDataChanged(): void {
  if (typeof BroadcastChannel === 'undefined') {
    return;
  }
  try {
    const channel = new BroadcastChannel(DATA_CHANNEL);
    channel.postMessage('changed');
    channel.close();
  } catch {
    // 页面关闭期间通知可能失效，下次打开仍会直接读取已提交的数据。
  }
}
