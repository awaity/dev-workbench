import { ElMessage } from 'element-plus';
/**
 * 使用合适的单位展示文件大小，避免小附件显示成零 KB。
 * @param bytes - 文件的原始字节数。
 * @returns 带 B、KB 或 MB 单位的可读大小。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
/**
 * 在本机下载 Blob，延迟释放地址以兼容浏览器下载流程。
 * @param blob - 要下载的文件字节与 MIME 类型。
 * @param filename - 提供给浏览器的下载文件名。
 * @returns 无返回值。
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 30000);
}
/**
 * 以 UTF-8 文本下载工具结果。
 * @param text - 待处理的原始文本。
 * @param filename - 提供给浏览器的下载文件名。
 * @returns 无返回值。
 */
export function downloadText(text: string, filename: string) {
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
}
/**
 * 复制文本并显示成功反馈；剪贴板权限错误向调用者传播。
 * @param value - 需要写入系统剪贴板的文本。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
export async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
  ElMessage.success('已复制');
}
/**
 * 统一格式化本地时间。
 * @param time - 毫秒级时间戳。
 * @returns 以中文区域规则格式化的日期时间。
 */
export function formatTime(time: number) {
  return new Date(time).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
