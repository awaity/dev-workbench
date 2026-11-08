import { SecureRandom } from 'sm-crypto/src/sm2/rng.js';
import { sm2, sm4 } from 'sm-crypto';

// sm-crypto 0.5.8 使用旧式 RC4 扩展随机池；直接使用系统 CSPRNG，
// 同时覆盖库在模块初始化时创建的实例，保证 Worker 中的临时密钥安全。
/**
 * 使用浏览器密码学随机源填充国密算法所需的随机字节。
 * @param target - 由 sm-crypto 分配、需要原地填充的字节数组。
 * @returns 无返回值，随机字节写入 target。
 */
SecureRandom.prototype.nextBytes = function (target: number[]) {
  const bytes = crypto.getRandomValues(new Uint8Array(target.length));
  for (let i = 0; i < target.length; i++) {
    target[i] = bytes[i];
  }
};

export { sm2, sm4 };
