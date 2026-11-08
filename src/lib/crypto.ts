import CryptoJS from 'crypto-js';
import bcrypt from 'bcryptjs';
import forge from 'node-forge';
import { sm2, sm4 } from './sm';
import type { CryptoState, ToolId } from './models';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export { toHex, fromHex, toBase64, fromBase64, randomHex } from './encoding';
import { toHex, fromHex, toBase64, fromBase64, randomHex } from './encoding';
/**
 * 将原始字节转换为 CryptoJS 使用的 WordArray。
 * @param bytes - 待处理的原始字节数组。
 * @returns 对应的 CryptoJS WordArray。
 */
const words = (bytes: Uint8Array) => {
  return CryptoJS.enc.Hex.parse(toHex(bytes));
};
/**
 * 将 CryptoJS 的 WordArray 无损转换为字节数组。
 * @param value - 待校验、转换或保存的值。
 * @returns 与输入等长的原始字节。
 */
const bytesFromWords = (value: CryptoJS.lib.WordArray) => {
  return fromHex(value.toString(CryptoJS.enc.Hex));
};
/**
 * 根据输入格式将密钥或 IV 转换为字节。
 * @param text - 待处理的原始文本。
 * @param format - 输入或输出编码格式。
 * @returns 编码后的密钥或 IV 字节。
 */
const encoded = (text: string, format: string) => {
  return format === 'hex' ? fromHex(text) : encoder.encode(text);
};
/**
 * 根据密文格式解析 Hex 或 Base64 输入。
 * @param state - 已经结构校验的工具配置。
 * @returns 解析后的密文字节。
 */
const cipherInput = (state: CryptoState) => {
  return state.format === 'hex' ? fromHex(state.input) : fromBase64(state.input);
};
/**
 * 将密码学计算结果编码为所选密文格式。
 * @param bytes - 待处理的原始字节数组。
 * @param state - 已经结构校验的工具配置。
 * @returns Hex 或 Base64 密文字符串。
 */
const cipherOutput = (bytes: Uint8Array, state: CryptoState) => {
  return state.format === 'hex' ? toHex(bytes) : toBase64(bytes);
};
/**
 * 验证并移除 PKCS#7，拒绝错误密钥造成的偶然可解码结果。
 * @param bytes - 待处理的原始字节数组。
 * @param block - 算法的分组字节数。
 * @returns 移除 PKCS#7 尾部填充后的字节。
 */
export function unpad(bytes: Uint8Array, block: number) {
  const count = bytes.at(-1) ?? 0;
  if (
    !count ||
    count > block ||
    count > bytes.length ||
    !bytes.slice(-count).every((v) => {
      return v === count;
    })
  ) {
    throw new Error('填充校验失败，请检查密钥、IV、模式和密文');
  }
  return bytes.slice(0, -count);
}
/**
 * 校验密钥、IV 与分组长度，执行 SM4、AES、DES 或 Triple DES 加解密。
 * @param tool - 目标工具标识。
 * @param state - 已经结构校验的工具配置。
 * @param decrypt - 是否执行解密。
 * @returns 加密后的编码密文或解密后的 UTF-8 明文。
 */
function symmetric(tool: ToolId, state: CryptoState, decrypt: boolean) {
  const key = encoded(state.key, state.keyFormat);
  const block = tool === 'des' ? 8 : 16;
  const keySizes =
    tool === 'aes' ? [16, 24, 32] : tool === 'des' ? (state.tripleDes ? [16, 24] : [8]) : [16];
  if (!keySizes.includes(key.length)) {
    throw new Error(`密钥必须为 ${keySizes.join(' / ')} 字节，当前为 ${key.length} 字节`);
  }
  const iv = state.mode === 'CBC' ? encoded(state.iv, state.ivFormat) : new Uint8Array(block);
  if (iv.length !== block) {
    throw new Error(`CBC 的 IV 必须为 ${block} 字节，当前为 ${iv.length} 字节`);
  }
  let input = decrypt ? cipherInput(state) : encoder.encode(state.input);
  if (!decrypt && state.padding === 'pkcs7') {
    const count = block - (input.length % block);
    const padded = new Uint8Array(input.length + count);
    padded.set(input);
    padded.fill(count, input.length);
    input = padded;
  }
  if (input.length % block !== 0 || (decrypt && input.length === 0)) {
    throw new Error(`数据长度必须为 ${block} 字节的整数倍；解密内容不能为空`);
  }
  let output: Uint8Array;
  if (tool === 'sm4') {
    const options = {
      mode: state.mode === 'CBC' ? 'cbc' : undefined,
      iv: toHex(iv),
      padding: 'none',
      output: 'array',
    } as const;
    output = Uint8Array.from(
      (decrypt
        ? sm4.decrypt(Array.from(input), toHex(key), options)
        : sm4.encrypt(Array.from(input), toHex(key), options)) as unknown as number[],
    );
  } else {
    const algorithm =
      tool === 'aes' ? CryptoJS.AES : state.tripleDes ? CryptoJS.TripleDES : CryptoJS.DES;
    const options = {
      iv: words(iv),
      mode: state.mode === 'CBC' ? CryptoJS.mode.CBC : CryptoJS.mode.ECB,
      padding: CryptoJS.pad.NoPadding,
    };
    const result = decrypt
      ? algorithm.decrypt(
          CryptoJS.lib.CipherParams.create({ ciphertext: words(input) }),
          words(key),
          options,
        )
      : algorithm.encrypt(words(input), words(key), options).ciphertext;
    output = bytesFromWords(result);
  }
  if (decrypt) {
    if (state.padding === 'pkcs7') {
      output = unpad(output, block);
    }
    try {
      return decoder.decode(output);
    } catch {
      throw new Error('结果不是有效 UTF-8，请检查密钥或输入的明文编码');
    }
  }
  return cipherOutput(output, state);
}
/**
 * 计算原文 MD5 并与完整或中间 16 位摘要匹配。
 * @param text - 待处理的原始文本。
 * @param target - 已规范化的目标摘要。
 * @returns 摘要是否匹配。
 */
function digestMatches(text: string, target: string) {
  const hash = CryptoJS.MD5(text).toString();
  return (target.length === 16 ? hash.slice(8, 24) : hash) === target;
}
/**
 * 规范化并校验待匹配的 MD5 摘要。
 * @param state - 已经结构校验的工具配置。
 * @returns 小写的 16 或 32 位 MD5 摘要。
 */
function checkedTarget(state: CryptoState) {
  const target = state.target.trim().toLowerCase();
  if (!/^(?:[\da-f]{16}|[\da-f]{32})$/.test(target)) {
    throw new Error('请输入 16 或 32 位 MD5 摘要');
  }
  return target;
}
/**
 * 解析 JWT 声明与时间，提供密钥时验证 HS256 签名。
 * @param state - 已经结构校验的工具配置。
 * @returns 包含声明、验签与时间状态的格式化 JSON 字符串。
 */
function jwt(state: CryptoState) {
  const parts = state.input.trim().split('.');
  if (parts.length !== 3) {
    throw new Error('JWT 应由 Header.Payload.Signature 三部分组成');
  }
  const header = JSON.parse(decoder.decode(fromBase64(parts[0], true)));
  const payload = JSON.parse(decoder.decode(fromBase64(parts[1], true)));
  if (
    !header ||
    typeof header !== 'object' ||
    Array.isArray(header) ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new Error('JWT Header 和 Payload 必须为 JSON 对象');
  }
  const signature = fromBase64(parts[2], true);
  let verified: boolean | null = null;
  if (state.key) {
    if (header.alg !== 'HS256') {
      throw new Error('当前签名验证支持 HS256；移除密钥可仅解析其他算法的 JWT');
    }
    const expected = bytesFromWords(CryptoJS.HmacSHA256(`${parts[0]}.${parts[1]}`, state.key));
    let diff = expected.length ^ signature.length;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected[i] ^ (signature[i] ?? 0);
    }
    verified = diff === 0;
  }
  const now = Math.floor(Date.now() / 1000);
  const times: Record<string, string> = {};
  for (const claim of ['iat', 'nbf', 'exp']) {
    if (payload[claim] !== undefined) {
      if (
        typeof payload[claim] !== 'number' ||
        !Number.isFinite(payload[claim]) ||
        Math.abs(payload[claim]) > 8640000000000
      ) {
        throw new Error(`${claim} 必须为有效的秒级时间戳`);
      }
      times[claim] = new Date(payload[claim] * 1000).toISOString();
    }
  }
  return JSON.stringify(
    {
      header,
      payload,
      signature: parts[2],
      signatureVerified: verified,
      verification:
        verified === null ? '仅解码，未验证签名' : verified ? 'HS256 签名匹配' : '签名不匹配',
      timeStatus:
        payload.exp !== undefined && now >= payload.exp
          ? '已过期'
          : payload.nbf !== undefined && now < payload.nbf
            ? '尚未生效'
            : '时间声明检查通过（不代表身份可信）',
      times,
    },
    null,
    2,
  );
}
/**
 * 执行本地密码学工具；高耗时操作由调用方放入 Worker，可终止。
 * @param tool - 目标工具标识。
 * @param state - 已经结构校验的工具配置。
 * @param action - 待执行的操作名称。
 * @returns 计算结果文本；密钥生成操作返回包含公私钥的 JSON。
 */
export async function executeCrypto(
  tool: ToolId,
  state: CryptoState,
  action: string,
): Promise<string> {
  if (['sm4', 'aes', 'des'].includes(tool)) {
    return symmetric(tool, state, action === 'decrypt');
  }
  if (tool === 'base64') {
    if (action === 'decrypt') {
      return decoder.decode(fromBase64(state.input, state.urlSafe));
    }
    const output = toBase64(encoder.encode(state.input));
    return state.urlSafe
      ? output.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      : output;
  }
  if (tool === 'url') {
    if (action === 'decrypt') {
      return (state.wholeUrl ? decodeURI : decodeURIComponent)(
        state.formUrl ? state.input.replace(/\+/g, ' ') : state.input,
      );
    }
    const output = (state.wholeUrl ? encodeURI : encodeURIComponent)(state.input);
    return state.formUrl ? output.replace(/%20/g, '+') : output;
  }
  if (tool === 'md5') {
    if (action === 'verify') {
      return digestMatches(state.input, checkedTarget(state))
        ? '校验通过：原文与 MD5 匹配'
        : '校验失败：原文与 MD5 不匹配';
    }
    if (action === 'dictionary' || action === 'range') {
      const target = checkedTarget(state);
      let count = 0;
      if (action === 'dictionary') {
        const candidates = state.candidates.split(/\r?\n/);
        if (candidates.length > 100000) {
          throw new Error('候选最多 100,000 行');
        }
        for (const candidate of candidates) {
          count++;
          if (digestMatches(candidate, target)) {
            return `找到匹配：${JSON.stringify(candidate)}\n已尝试 ${count} 个候选`;
          }
        }
      } else {
        if (state.rangeEnd < state.rangeStart || state.rangeEnd - state.rangeStart > 1000000) {
          throw new Error('数字范围必须递增，单次最多 1,000,001 个候选');
        }
        for (let n = state.rangeStart; n <= state.rangeEnd; n++) {
          count++;
          const candidate = String(n).padStart(state.digits, '0');
          if (digestMatches(candidate, target)) {
            return `找到匹配：${JSON.stringify(candidate)}\n已尝试 ${count} 个候选`;
          }
        }
      }
      return `未找到匹配，已检查 ${count} 个候选。MD5 不可逆，候选范围外的原文无法由本次匹配得到。`;
    }
    let value = CryptoJS.MD5(state.input).toString();
    if (state.md5Short) {
      value = value.slice(8, 24);
    }
    return state.uppercase ? value.toUpperCase() : value;
  }
  if (tool === 'sha') {
    const hash = state.hmac
      ? CryptoJS[`Hmac${state.sha}`](state.input, state.key)
      : CryptoJS[state.sha](state.input);
    return state.uppercase ? hash.toString().toUpperCase() : hash.toString();
  }
  if (tool === 'bcrypt') {
    if (encoder.encode(state.input).length > 72) {
      throw new Error('Bcrypt 原文最多 72 个 UTF-8 字节，避免密码被静默截断');
    }
    if (action === 'verify') {
      if (!/^\$2[aby]\$(0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}$/.test(state.target.trim())) {
        throw new Error('请输入有效 Bcrypt 哈希（工作因子 4–16）');
      }
      return (await bcrypt.compare(state.input, state.target.trim()))
        ? '校验通过：原文与哈希匹配'
        : '校验失败：原文与哈希不匹配';
    }
    return bcrypt.hash(state.input, state.rounds);
  }
  if (tool === 'jwt') {
    return jwt(state);
  }
  if (tool === 'sm2') {
    if (action === 'generate') {
      const order = BigInt('0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFF7203DF6B21C6052B53BBF40939D54123');
      let privateKey = randomHex(32);
      while (BigInt(`0x${privateKey}`) === 0n || BigInt(`0x${privateKey}`) >= order) {
        privateKey = randomHex(32);
      }
      return JSON.stringify({ privateKey, publicKey: sm2.getPublicKeyFromPrivateKey(privateKey) });
    }
    const mode = state.sm2Mode === 'C1C3C2' ? 1 : 0;
    if (action === 'decrypt') {
      if (!/^[\da-f]{64}$/i.test(state.privateKey.trim())) {
        throw new Error('SM2 私钥必须为 64 位 Hex');
      }
      let hex = toHex(cipherInput(state));
      if (hex.length % 2 || hex.length < 194 || !hex.startsWith('04')) {
        throw new Error('SM2 密文需包含 04 开头的未压缩点前缀');
      }
      hex = hex.slice(2);
      const result = sm2.doDecrypt(hex, state.privateKey.trim(), mode);
      if (!result) {
        throw new Error('SM2 解密或完整性校验失败，请检查私钥和密文顺序');
      }
      return result;
    }
    if (!state.input) {
      throw new Error('请输入待加密内容');
    }
    if (!sm2.verifyPublicKey(state.publicKey.trim())) {
      throw new Error('SM2 公钥无效，应为 04 开头的未压缩公钥');
    }
    return cipherOutput(
      fromHex(`04${sm2.doEncrypt(state.input, state.publicKey.trim(), mode)}`),
      state,
    );
  }
  if (tool === 'rsa') {
    if (action === 'generate') {
      const pair = forge.pki.rsa.generateKeyPair({ bits: Number(state.rsaBits), e: 0x10001 });
      return JSON.stringify({
        publicKey: forge.pki.publicKeyToPem(pair.publicKey),
        privateKey: forge.pki.privateKeyToPem(pair.privateKey),
      });
    }
    const scheme = state.rsaPadding === 'PKCS1' ? 'RSAES-PKCS1-V1_5' : 'RSA-OAEP';
    const options = {
      md: state.rsaPadding === 'OAEP-SHA1' ? forge.md.sha1.create() : forge.md.sha256.create(),
      mgf1: {
        md: state.rsaPadding === 'OAEP-SHA1' ? forge.md.sha1.create() : forge.md.sha256.create(),
      },
    };
    if (action === 'decrypt') {
      const privateKey = forge.pki.privateKeyFromPem(state.privateKey);
      return forge.util.decodeUtf8(
        privateKey.decrypt(forge.util.binary.raw.encode(cipherInput(state)), scheme, options),
      );
    }
    const publicKey = forge.pki.publicKeyFromPem(state.publicKey);
    const encrypted = publicKey.encrypt(forge.util.encodeUtf8(state.input), scheme, options);
    return cipherOutput(
      Uint8Array.from(encrypted, (c) => {
        return c.charCodeAt(0);
      }),
      state,
    );
  }
  throw new Error('不支持的操作');
}
