import { describe, expect, it, vi } from 'vitest';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  generateKeyPairSync,
  publicEncrypt,
  constants,
} from 'node:crypto';
import { cryptoSchema, type ToolId } from '../src/lib/models';
import { executeCrypto, fromBase64, fromHex, toHex } from '../src/lib/crypto';
import { sm2 } from '../src/lib/sm';

const state = (input: Record<string, unknown> = {}) => {
  return cryptoSchema.parse(input);
};
describe('文本编码与摘要', () => {
  it.each(['你好，开发者 👋', '', 'a\u0000b\n'])('Base64 UTF-8 往返：%s', async (input) => {
    for (const urlSafe of [true, false]) {
      const output = await executeCrypto('base64', state({ input, urlSafe }), 'encrypt');
      expect(output).toBe(Buffer.from(input).toString(urlSafe ? 'base64url' : 'base64'));
      expect(await executeCrypto('base64', state({ input: output, urlSafe }), 'decrypt')).toBe(
        input,
      );
    }
  });
  it.each(['a', 'ab=', '**==', 'Zh==', 'a===', 'ab=c'])('拒绝损坏 Base64：%s', (input) => {
    expect(() => {
      return fromBase64(input);
    }).toThrow();
  });
  it('拒绝损坏 Hex', () => {
    expect(() => {
      return fromHex('x123');
    }).toThrow();
    expect(() => {
      return fromHex('a');
    }).toThrow();
  });
  it('MD5 已知向量与短格式', async () => {
    expect(await executeCrypto('md5', state({ input: 'abc' }), 'encrypt')).toBe(
      '900150983cd24fb0d6963f7d28e17f72',
    );
    expect(
      await executeCrypto(
        'md5',
        state({ input: 'abc', md5Short: true, uppercase: true }),
        'encrypt',
      ),
    ).toBe('3CD24FB0D6963F7D');
    expect(await executeCrypto('md5', state({ input: '' }), 'encrypt')).toBe(
      'd41d8cd98f00b204e9800998ecf8427e',
    );
  });
  it('本地 MD5 候选、数字前补零与未找到', async () => {
    expect(
      await executeCrypto(
        'md5',
        state({ target: '5d41402abc4b2a76b9719d911017c592', candidates: 'wrong\nhello' }),
        'dictionary',
      ),
    ).toContain('找到匹配："hello"');
    expect(
      await executeCrypto(
        'md5',
        state({
          target: '4a7d1ed414474e4033ac29ccb8653d9b',
          rangeStart: 0,
          rangeEnd: 10,
          digits: 4,
        }),
        'range',
      ),
    ).toContain('找到匹配："0000"');
    expect(
      await executeCrypto(
        'md5',
        state({ target: '5d41402abc4b2a76b9719d911017c592', candidates: 'wrong' }),
        'dictionary',
      ),
    ).toContain('未找到匹配');
  });
  it('MD5 校验拒绝不匹配及非法范围', async () => {
    expect(
      await executeCrypto(
        'md5',
        state({ target: '5d41402abc4b2a76b9719d911017c592', input: 'hello' }),
        'verify',
      ),
    ).toContain('校验通过');
    await expect(executeCrypto('md5', state({ target: '123' }), 'dictionary')).rejects.toThrow();
    await expect(
      executeCrypto(
        'md5',
        state({ target: '5d41402abc4b2a76b9719d911017c592', rangeEnd: 2000000 }),
        'range',
      ),
    ).rejects.toThrow();
  });
  it.each(['SHA1', 'SHA224', 'SHA256', 'SHA384', 'SHA512'])('HMAC %s 与 Node 对照', async (sha) => {
    const output = await executeCrypto(
      'sha',
      state({ input: 'abc', key: 'key', hmac: true, sha }),
      'encrypt',
    );
    expect(output).toBe(createHmac(sha.toLowerCase(), 'key').update('abc').digest('hex'));
  });
  it('SHA-256 NIST 向量', async () => {
    expect(await executeCrypto('sha', state({ input: 'abc' }), 'encrypt')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('URL 组件、完整地址、表单空格编码', async () => {
    expect(await executeCrypto('url', state({ input: '你好 /?+' }), 'encrypt')).toBe(
      '%E4%BD%A0%E5%A5%BD%20%2F%3F%2B',
    );
    expect(
      await executeCrypto(
        'url',
        state({ input: 'https://example.com/a b?q=你好', wholeUrl: true }),
        'encrypt',
      ),
    ).toContain('https://example.com/a%20b?q=');
    expect(await executeCrypto('url', state({ input: 'a+b%2Bc', formUrl: true }), 'decrypt')).toBe(
      'a b+c',
    );
    await expect(executeCrypto('url', state({ input: '%GG' }), 'decrypt')).rejects.toThrow();
  });
});
describe('对称密码互操作', () => {
  it.each(['aes', 'sm4'] as ToolId[])('%s CBC 与 OpenSSL 实现对照', async (tool) => {
    const input = '本地开发工具 👋';
    const key = '1234567890abcdef';
    const iv = 'abcdef1234567890';
    const cipher = createCipheriv(
      tool === 'aes' ? 'aes-128-cbc' : 'sm4-cbc',
      Buffer.from(key),
      Buffer.from(iv),
    );
    const expected = Buffer.concat([cipher.update(input, 'utf8'), cipher.final()]).toString('hex');
    const form = state({ input, key, iv, format: 'hex' });
    expect(await executeCrypto(tool, form, 'encrypt')).toBe(expected);
    expect(await executeCrypto(tool, { ...form, input: expected }, 'decrypt')).toBe(input);
  });
  it.each([16, 24, 32])('AES %i 字节密钥 ECB，无填充', async (size) => {
    const key = 'a'.repeat(size);
    const input = '1234567890abcdef';
    const cipher = createCipheriv(`aes-${size * 8}-ecb`, Buffer.from(key), null);
    cipher.setAutoPadding(false);
    const expected = Buffer.concat([cipher.update(input), cipher.final()]).toString('base64');
    expect(
      await executeCrypto('aes', state({ input, key, mode: 'ECB', padding: 'none' }), 'encrypt'),
    ).toBe(expected);
  });
  it('Triple DES 与 Node 对照', async () => {
    const key = '123456789012345678901234';
    const iv = '87654321';
    const input = '开发测试';
    const cipher = createCipheriv('des-ede3-cbc', Buffer.from(key), Buffer.from(iv));
    const expected = Buffer.concat([cipher.update(input, 'utf8'), cipher.final()]).toString(
      'base64',
    );
    const form = state({ input, key, iv, tripleDes: true });
    expect(await executeCrypto('des', form, 'encrypt')).toBe(expected);
    expect(await executeCrypto('des', { ...form, input: expected }, 'decrypt')).toBe(input);
  });
  it('DES 等价于三个相同密钥的 3DES', async () => {
    const key = '12345678';
    const iv = '87654321';
    const input = 'Hello DES';
    const cipher = createCipheriv('des-ede3-cbc', Buffer.from(key.repeat(3)), Buffer.from(iv));
    const expected = Buffer.concat([cipher.update(input), cipher.final()]).toString('base64');
    const form = state({ input, key, iv });
    expect(await executeCrypto('des', form, 'encrypt')).toBe(expected);
    expect(await executeCrypto('des', { ...form, input: expected }, 'decrypt')).toBe(input);
  });
  it('验证中文密钥字节数、IV、无填充块长及损坏密文', async () => {
    await expect(executeCrypto('sm4', state({ key: '中文' }), 'encrypt')).rejects.toThrow('字节');
    await expect(
      executeCrypto('aes', state({ key: '1234567890abcdef', iv: 'bad' }), 'encrypt'),
    ).rejects.toThrow('IV');
    await expect(
      executeCrypto(
        'aes',
        state({ key: '1234567890abcdef', mode: 'ECB', padding: 'none', input: 'short' }),
        'encrypt',
      ),
    ).rejects.toThrow('整数倍');
    await expect(
      executeCrypto(
        'aes',
        state({ key: '1234567890abcdef', mode: 'ECB', input: '0'.repeat(32), format: 'hex' }),
        'decrypt',
      ),
    ).rejects.toThrow();
  });
  it('Hex 密钥与 UTF-8 密钥相同', async () => {
    const form = state({ input: 'hello', key: '1234567890abcdef', mode: 'ECB' });
    expect(
      await executeCrypto(
        'sm4',
        { ...form, key: toHex(new TextEncoder().encode(form.key)), keyFormat: 'hex' },
        'encrypt',
      ),
    ).toBe(await executeCrypto('sm4', form, 'encrypt'));
  });
});
describe('公钥、JWT 和 Bcrypt', () => {
  it.each(['C1C3C2', 'C1C2C3'])(
    'SM2 %s 加解密与篡改检测，随机源来自 WebCrypto',
    async (sm2Mode) => {
      const pair = JSON.parse(await executeCrypto('sm2', state(), 'generate'));
      expect(sm2.verifyPublicKey(pair.publicKey)).toBe(true);
      const random = vi.spyOn(crypto, 'getRandomValues');
      const form = state({ ...pair, sm2Mode, input: '国密测试', format: 'hex' });
      const output = await executeCrypto('sm2', form, 'encrypt');
      expect(random).toHaveBeenCalled();
      random.mockRestore();
      expect(output.startsWith('04')).toBe(true);
      expect(await executeCrypto('sm2', { ...form, input: output }, 'decrypt')).toBe('国密测试');
      await expect(
        executeCrypto(
          'sm2',
          { ...form, input: `${output.slice(0, -2)}${output.endsWith('ff') ? '00' : 'ff'}` },
          'decrypt',
        ),
      ).rejects.toThrow();
    },
  );
  it('RSA OAEP 与 Node 互操作，支持 PKCS#8', async () => {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const text = 'RSA 你好';
    const encrypted = publicEncrypt(
      { key: pair.publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from(text),
    ).toString('base64');
    expect(await executeCrypto('rsa', state({ ...pair, input: encrypted }), 'decrypt')).toBe(text);
    const form = state({ ...pair, input: text, rsaPadding: 'PKCS1' });
    const output = await executeCrypto('rsa', form, 'encrypt');
    expect(await executeCrypto('rsa', { ...form, input: output }, 'decrypt')).toBe(text);
    await expect(
      executeCrypto('rsa', { ...form, input: 'a'.repeat(300) }, 'encrypt'),
    ).rejects.toThrow();
  });
  it('RSA 密钥生成可用于加解密', async () => {
    const pair = JSON.parse(await executeCrypto('rsa', state(), 'generate'));
    const form = state({ ...pair, input: 'test', rsaPadding: 'OAEP-SHA1' });
    const cipher = await executeCrypto('rsa', form, 'encrypt');
    expect(await executeCrypto('rsa', { ...form, input: cipher }, 'decrypt')).toBe('test');
  });
  it('JWT 不信任解码结果，HS256 验签、过期和算法边界', async () => {
    const parts = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'dev', exp: 1 })).toString('base64url'),
    ].join('.');
    const token = `${parts}.${createHmac('sha256', 'secret').update(parts).digest('base64url')}`;
    expect(
      JSON.parse(await executeCrypto('jwt', state({ input: token }), 'encrypt')).signatureVerified,
    ).toBe(null);
    const verified = JSON.parse(
      await executeCrypto('jwt', state({ input: token, key: 'secret' }), 'encrypt'),
    );
    expect(verified.signatureVerified).toBe(true);
    expect(verified.timeStatus).toBe('已过期');
    expect(
      JSON.parse(await executeCrypto('jwt', state({ input: token, key: 'wrong' }), 'encrypt'))
        .signatureVerified,
    ).toBe(false);
    await expect(executeCrypto('jwt', state({ input: 'bad' }), 'encrypt')).rejects.toThrow();
  });
  it('Bcrypt 哈希随机盐、匹配、错误密码、长文本边界', async () => {
    const form = state({ input: '我的密码', rounds: 4 });
    const hash = await executeCrypto('bcrypt', form, 'encrypt');
    expect(hash).toMatch(/^\$2[ab]\$04\$/);
    expect(await executeCrypto('bcrypt', form, 'encrypt')).not.toBe(hash);
    expect(await executeCrypto('bcrypt', { ...form, target: hash }, 'verify')).toContain(
      '校验通过',
    );
    expect(
      await executeCrypto('bcrypt', { ...form, input: 'wrong', target: hash }, 'verify'),
    ).toContain('校验失败');
    await expect(
      executeCrypto('bcrypt', { ...form, input: '中'.repeat(25) }, 'encrypt'),
    ).rejects.toThrow('72');
  });
  it('Node 验证 AES 加密输出', async () => {
    const form = state({ key: '1234567890abcdef', iv: 'abcdef1234567890', input: 'another check' });
    const out = await executeCrypto('aes', form, 'encrypt');
    const decipher = createDecipheriv('aes-128-cbc', Buffer.from(form.key), Buffer.from(form.iv));
    expect(
      Buffer.concat([decipher.update(Buffer.from(out, 'base64')), decipher.final()]).toString(),
    ).toBe(form.input);
  });
});
