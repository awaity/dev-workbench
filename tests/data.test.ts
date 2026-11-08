import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addHistory,
  clearAll,
  exportBackup,
  importBackup,
  readDraft,
  readHistory,
  readSettings,
  writeDraft,
  writeSettings,
} from '../src/lib/storage';
import { defaultSettings, httpSchema, qrSchema } from '../src/lib/models';
import { deleteNode, parseJson, queryJson, replaceNode } from '../src/lib/json';
import { prepareRequest, readResponse } from '../src/lib/http';

describe('IndexedDB 本地持久化', () => {
  beforeEach(async () => {
    await clearAll();
  });
  it('设置与草稿可重新读取', async () => {
    await writeSettings({ ...defaultSettings, theme: 'dark', indent: 4 });
    await writeDraft('sm4', { input: 'local secret', key: '1234567890abcdef' });
    expect((await readSettings()).theme).toBe('dark');
    expect((await readDraft('sm4'))?.state.input).toBe('local secret');
  });
  it('保留数量按所有工具合计，并可按工具查询', async () => {
    for (let n = 0; n < 15; n++) {
      await addHistory(
        {
          tool: n % 2 ? 'sm4' : 'json',
          title: `record ${n}`,
          detail: '',
          state: { input: String(n) },
        },
        10,
      );
    }
    expect(await readHistory()).toHaveLength(10);
    expect(
      (await readHistory('sm4')).every((row) => {
        return row.tool === 'sm4';
      }),
    ).toBe(true);
  });
  it('备份往返含密钥和二维码 Logo，错误备份不改动原数据', async () => {
    const logo = 'data:image/png;base64,aGVsbG8=';
    await writeDraft('qrcode', qrSchema.parse({ text: 'hello', logo }));
    await addHistory(
      {
        tool: 'aes',
        title: 'aes test',
        detail: '',
        state: { key: 'secret', input: 'hello', output: 'world' },
      },
      100,
    );
    const backup = await exportBackup();
    await clearAll();
    await importBackup(backup);
    expect((await readDraft('qrcode'))?.state.logo).toBe(logo);
    expect((await readHistory())[0].state.key).toBe('secret');
    await expect(
      importBackup({ ...backup, settings: { ...backup.settings, historyLimit: -1 } }),
    ).rejects.toThrow();
    expect(await readHistory()).toHaveLength(1);
    await expect(
      importBackup({
        ...backup,
        drafts: [{ tool: 'qrcode', state: { logo: 'https://remote.test/x.png' }, updatedAt: 1 }],
      }),
    ).rejects.toThrow();
    expect((await readDraft('qrcode'))?.state.text).toBe('hello');
  });
  it('关闭草稿自动保存会清除草稿，清除全部恢复默认设置', async () => {
    await writeDraft('json', { input: '{}' });
    await writeSettings({ ...defaultSettings, saveDrafts: false });
    expect(await readDraft('json')).toBeUndefined();
    await clearAll();
    expect(await readSettings()).toEqual(defaultSettings);
  });
});
describe('JSON 结构与路径查询', () => {
  const text = '{"tools":[{"name":"JSON","n":1},{"name":"SM4","n":2}],"null":null}';
  it('递归、通配、过滤和匹配路径', () => {
    expect(
      queryJson(text, '$.tools[*].name').map((r) => {
        return r.value;
      }),
    ).toEqual(['JSON', 'SM4']);
    expect(queryJson(text, '$.tools[?(@.n >= 2)].name')[0]).toMatchObject({
      value: 'SM4',
      path: "$['tools'][1]['name']",
    });
    expect(queryJson(text, '$..name')).toHaveLength(2);
    expect(queryJson(text, '$.missing')).toEqual([]);
  });
  it('错误 JSON、错误路径和危险表达式', () => {
    expect(() => {
      return parseJson('{"a":}');
    }).toThrow('语法错误');
    expect(() => {
      return queryJson(text, 'tools');
    }).toThrow();
    expect(() => {
      return queryJson(text, '$.tools[?(@.constructor.constructor("return globalThis")())]');
    }).toThrow();
  });
  it('节点修改、数组删除与特殊对象键不会污染原型', () => {
    const original = JSON.parse(text);
    const next = replaceNode(original, ['tools', 0, 'name'], 'new');
    expect(original.tools[0].name).toBe('JSON');
    expect((next as typeof original).tools[0].name).toBe('new');
    expect((deleteNode(next, ['tools', 0]) as typeof original).tools[0].name).toBe('SM4');
    const proto = replaceNode(JSON.parse('{"__proto__":0}'), ['__proto__'], { polluted: true });
    expect(Object.hasOwn(proto as object, '__proto__')).toBe(true);
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
  });
});
describe('HTTP 请求构造与响应边界', () => {
  it('保持重复查询参数、Basic Auth、JSON Content-Type', () => {
    const form = httpSchema.parse({
      url: 'http://localhost/test?x=1',
      method: 'POST',
      params: [{ name: 'x', value: '中文', enabled: true }],
      auth: 'basic',
      username: 'user',
      password: 'pass',
      bodyType: 'json',
      body: '{"a":1}',
    });
    const { url, init } = prepareRequest(form);
    expect(new URL(url).searchParams.getAll('x')).toEqual(['1', '中文']);
    expect((init.headers as Headers).get('Authorization')).toBe('Basic dXNlcjpwYXNz');
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });
  it('拒绝危险协议、禁止的请求头和非法 JSON', () => {
    expect(() => {
      return prepareRequest(httpSchema.parse({ url: 'file:///etc/passwd' }));
    }).toThrow();
    expect(() => {
      return prepareRequest(
        httpSchema.parse({
          url: 'https://example.com',
          headers: [{ name: 'Cookie', value: 'a=b', enabled: true }],
        }),
      );
    }).toThrow('浏览器控制');
    expect(() => {
      return prepareRequest(
        httpSchema.parse({
          url: 'https://example.com',
          method: 'POST',
          bodyType: 'json',
          body: 'bad',
        }),
      );
    }).toThrow();
  });
  it('GET 不发送请求体，表单保留重复字段', () => {
    expect(
      prepareRequest(
        httpSchema.parse({ url: 'https://example.com', bodyType: 'text', body: 'not sent' }),
      ).init.body,
    ).toBeUndefined();
    const result = prepareRequest(
      httpSchema.parse({
        url: 'https://example.com',
        method: 'POST',
        bodyType: 'form',
        fields: [
          { name: 'a', value: '1', enabled: true },
          { name: 'a', value: '2', enabled: true },
        ],
      }),
    );
    expect(String(result.init.body)).toBe('a=1&a=2');
  });
  it('响应达到大小上限时停止流读取', async () => {
    const result = await readResponse(new Response('123456789'), 5);
    expect(result).toMatchObject({ body: '12345', size: 5, truncated: true });
  });
});
