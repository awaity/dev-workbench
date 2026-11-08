import { executeCrypto } from '../lib/crypto';
import { cryptoSchema, toolIdSchema } from '../lib/models';

/**
 * 校验主线程任务并在 Worker 内执行密码学计算，将结果或错误文本回传。
 * @param event - 包含工具标识、配置和操作名称的消息。
 * @returns 任务处理完成的 Promise。
 */
self.onmessage = async (event) => {
  try {
    const { tool, state, action } = event.data;
    const output = await executeCrypto(toolIdSchema.parse(tool), cryptoSchema.parse(state), action);
    self.postMessage({ output });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
