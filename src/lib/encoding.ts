/**
 * 将字节转为十六进制，统一小写输出。
 * @param bytes - 待处理的原始字节数组。
 * @returns 小写十六进制字符串。
 */
export function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (v) => {
    return v.toString(16).padStart(2, '0');
  }).join('');
}
/**
 * 解析严格偶数长度的 Hex；允许空白分隔。
 * @param text - 待处理的原始文本。
 * @returns 解析后的字节数组。
 */
export function fromHex(text: string) {
  const normalized = text.replace(/\s/g, '');
  if (!/^(?:[\da-f]{2})*$/i.test(normalized)) {
    throw new Error('Hex 必须由完整的十六进制字节组成');
  }
  return Uint8Array.from(normalized.match(/../g) ?? [], (s) => {
    return parseInt(s, 16);
  });
}
/**
 * 编码字节为标准 Base64，不经 Unicode 字符转换。
 * @param bytes - 待处理的原始字节数组。
 * @returns 标准 Base64 字符串。
 */
export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}
/**
 * 严格解析标准或 URL-safe Base64，支持省略末尾填充。
 * @param text - 待处理的原始文本。
 * @param urlSafe - 是否接受 URL 安全字符替换。
 * @returns 校验后的原始字节。
 */
export function fromBase64(text: string, urlSafe = false) {
  let value = text.replace(/\s/g, '');
  if (urlSafe) {
    value = value.replace(/-/g, '+').replace(/_/g, '/');
  }
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.replace(/=/g, '').length % 4 === 1 ||
    (value.includes('=') && value.length % 4 !== 0)
  ) {
    throw new Error('Base64 格式不正确');
  }
  try {
    const bytes = Uint8Array.from(atob(value), (c) => {
      return c.charCodeAt(0);
    });
    if (toBase64(bytes).replace(/=+$/, '') !== value.replace(/=+$/, '')) {
      throw new Error('无效编码');
    }
    return bytes;
  } catch {
    throw new Error('Base64 格式不正确');
  }
}
/**
 * 使用浏览器密码学随机源生成指定长度的 Hex。
 * @param size - 所需的随机字节数。
 * @returns 指定字节数对应的小写 Hex 字符串。
 */
export function randomHex(size: number) {
  return toHex(crypto.getRandomValues(new Uint8Array(size)));
}
