import { describe, expect, it } from 'vitest';
import { httpSchema, pairSchema, multipartSchema, responseSchema } from '../src/lib/models';
import {
  prepareRequest,
  readResponse,
  resolveVariables,
  responseBlob,
  responseFilename,
} from '../src/lib/http';
import { exportCurl, importCurl, tokenizeCurl } from '../src/lib/curl';

const pair = (name: string, value: string, enabled = true) => {
  return pairSchema.parse({ name, value, enabled });
};
const reference = (file: File) => {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  };
};

describe('Postman 风格 HTTP 请求', () => {
  it('multipart 真实序列化保留中文、重复字段、多文件字节及自动 boundary', async () => {
    const first = new File([new Uint8Array([0, 255, 13, 10, 128])], 'first.bin', {
      type: 'application/octet-stream',
    });
    const second = new File(['中文文件'], 'second.txt', { type: 'text/plain' });
    const a = reference(first);
    const b = reference(second);
    const state = httpSchema.parse({
      url: 'https://example.com/upload',
      method: 'POST',
      bodyType: 'multipart',
      headers: [pair('Content-Type', 'multipart/form-data')],
      multipart: [
        pair('title', '中文'),
        pair('title', 'second'),
        { ...pair('attachments', ''), kind: 'file', files: [a, b] },
        { ...pair('disabled', '', false), kind: 'file' },
      ],
    });
    const result = prepareRequest(
      state,
      new Map([
        [a.id, first],
        [b.id, second],
      ]),
    );
    expect(result.warnings).toHaveLength(1);
    const request = new Request(result.url, result.init);
    expect(request.headers.get('content-type')).toMatch(/multipart\/form-data; boundary=/);
    const data = await request.formData();
    expect(data.getAll('title')).toEqual(['中文', 'second']);
    const files = data.getAll('attachments') as File[];
    expect(
      files.map((file) => {
        return file.name;
      }),
    ).toEqual(['first.bin', 'second.txt']);
    expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 13, 10, 128]),
    );
    expect(await files[1]!.text()).toBe('中文文件');
    expect(data.has('disabled')).toBe(false);
  });
  it('缺失附件、无文件字段、超大请求和非法方法在发送前失败', () => {
    const state = httpSchema.parse({
      url: 'https://example.com',
      method: 'POST',
      bodyType: 'multipart',
      multipart: [{ ...pair('file', ''), kind: 'file' }],
    });
    expect(() => {
      prepareRequest(state);
    }).toThrow('尚未选择');
    const ref = reference(new File(['data'], 'a.txt'));
    state.multipart[0]!.files = [ref];
    expect(() => {
      prepareRequest(state);
    }).toThrow('不可用');
    state.multipart[0]!.files = [ref, ref, ref].map((file) => {
      return { ...file, size: 20 * 1024 * 1024 };
    });
    expect(() => {
      prepareRequest(state);
    }).toThrow('总大小');
    state.method = 'GET';
    expect(prepareRequest(state).init.body).toBeUndefined();
    state.method = 'TRACE';
    expect(() => {
      prepareRequest(state);
    }).toThrow('Fetch');
  });
  it('binary 原始字节、显式 Content-Type 与禁止重定向', async () => {
    const file = new File([new Uint8Array([0, 254, 128, 10])], 'raw.bin');
    const ref = reference(file);
    const state = httpSchema.parse({
      url: 'https://example.com',
      method: 'PUT',
      bodyType: 'binary',
      binary: ref,
      followRedirects: false,
      headers: [pair('Content-Type', 'image/custom')],
    });
    const { init } = prepareRequest(state, new Map([[ref.id, file]]));
    expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toEqual(
      new Uint8Array([0, 254, 128, 10]),
    );
    expect(new Headers(init.headers).get('content-type')).toBe('image/custom');
    expect(init.redirect).toBe('error');
  });
  it.each([
    ['text', 'text/plain;charset=UTF-8'],
    ['xml', 'application/xml'],
    ['html', 'text/html;charset=UTF-8'],
    ['javascript', 'application/javascript'],
  ])('raw %s 自动设置类型且支持变量', (bodyType, mime) => {
    const { init } = prepareRequest(
      httpSchema.parse({
        url: 'https://example.com',
        method: 'POST',
        bodyType,
        body: '{{value}}',
        variables: [pair('value', '中文')],
      }),
    );
    expect(init.body).toBe('中文');
    expect(new Headers(init.headers).get('content-type')).toBe(mime);
  });
  it('变量覆盖地址、参数、头、JSON 与 API Key，且手工头优先', () => {
    const state = httpSchema.parse({
      url: '{{base}}/users',
      method: 'POST',
      variables: [pair('base', 'https://example.com'), pair('id', '42'), pair('token', 'secret')],
      params: [pair('id', '{{id}}')],
      headers: [pair('X-User', '{{id}}'), pair('Content-Type', 'application/custom+json')],
      auth: 'api-key',
      apiKeyName: 'X-Token',
      apiKeyValue: '{{token}}',
      bodyType: 'json',
      body: '{"id":{{id}}}',
    });
    const result = prepareRequest(state);
    expect(result.url).toBe('https://example.com/users?id=42');
    expect(new Headers(result.init.headers).get('x-token')).toBe('secret');
    expect(new Headers(result.init.headers).get('content-type')).toBe('application/custom+json');
    expect(result.init.body).toBe('{"id":42}');
    state.apiKeyIn = 'query';
    expect(new URL(prepareRequest(state).url).searchParams.get('X-Token')).toBe('secret');
    state.apiKeyIn = 'header';
    state.apiKeyName = 'Cookie';
    expect(() => {
      prepareRequest(state);
    }).toThrow('浏览器控制');
  });
  it('变量支持递归，并明确拒绝缺失、重复和循环', () => {
    expect(
      resolveVariables('{{ url }}', [
        pair('url', '{{base}}/a'),
        pair('base', 'https://example.com'),
      ]),
    ).toBe('https://example.com/a');
    expect(() => {
      resolveVariables('{{x}}', []);
    }).toThrow('未定义');
    expect(() => {
      resolveVariables('{{x}}', [pair('x', '1'), pair('x', '2')]);
    }).toThrow('重复');
    expect(() => {
      resolveVariables('{{x}}', [pair('x', '{{y}}'), pair('y', '{{x}}')]);
    }).toThrow('循环');
    expect(resolveVariables('{{x}}', [pair('x', '1'), pair('x', '2', false)])).toBe('1');
  });
});

describe('响应读取与原文件下载', () => {
  it('二进制 Base64 持久化后仍可无损还原', async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 1]);
    const result = await readResponse(
      new Response(bytes, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.bin",
        },
      }),
    );
    expect(result.encoding).toBe('base64');
    expect(result.filename).toBe('测试.bin');
    const saved = responseSchema.parse({
      ...result,
      status: 200,
      statusText: 'OK',
      duration: 1,
      headers: '',
      url: '',
    });
    expect(new Uint8Array(await responseBlob(saved).arrayBuffer())).toEqual(bytes);
  });
  it('恰好达到上限不截断，超过上限时标记且保留精确字节数', async () => {
    expect(await readResponse(new Response('12345'), 5)).toMatchObject({
      body: '12345',
      truncated: false,
      size: 5,
    });
    expect(await readResponse(new Response('123456'), 5)).toMatchObject({
      body: '12345',
      truncated: true,
      size: 5,
    });
  });
  it('文本响应按声明字符集解码，文件名移除目录字符', async () => {
    const result = await readResponse(
      new Response(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]), {
        headers: { 'Content-Type': 'text/plain; charset=gbk' },
      }),
    );
    expect(result.body).toBe('你好');
    expect(result.encoding).toBe('text');
    expect(responseFilename('attachment; filename="../secret.txt"', false)).toBe('..-secret.txt');
  });
});

describe('cURL 文本互操作', () => {
  it('导入 JSON、Basic Auth 与查询并导出可往返的引号内容', () => {
    const { state } = importCurl(
      `curl 'https://example.com/a?x=1' -X POST -H 'Content-Type: application/json' -u 'name:pa:ss' --data-raw '{"name":"O'"'"'Reilly","text":"中文"}'`,
    );
    expect(state.password).toBe('pa:ss');
    expect(state.bodyType).toBe('json');
    const again = importCurl(exportCurl(state)).state;
    expect(prepareRequest(again).init.body).toBe(state.body);
    expect(new Headers(prepareRequest(again).init.headers).get('authorization')).toBe(
      'Basic bmFtZTpwYTpzcw==',
    );
  });
  it('导入 form-data 的文件路径仅作为提示，文本 @ 不被当作文件', () => {
    const { state, warnings } = importCurl(
      `curl https://example.com/upload -F 'upload=@/tmp/a.bin' --form-string 'literal=@text' -F 'name=中文'`,
    );
    expect(state.method).toBe('POST');
    expect(state.bodyType).toBe('multipart');
    expect(state.multipart[0]!.fileHint).toBe('/tmp/a.bin');
    expect(state.multipart[0]!.files).toEqual([]);
    expect(state.multipart[1]!.kind).toBe('text');
    expect(warnings[0]).toContain('重新选择');
    expect(multipartSchema.parse(state.multipart[2]).value).toBe('中文');
  });
  it('URL 编码表单保留重复字段；-G 转为查询参数', () => {
    const { state } = importCurl(
      `curl https://example.com -G --data-urlencode 'q=中文 空格' --data-urlencode 'q=second'`,
    );
    expect(new URL(prepareRequest(state).url).searchParams.getAll('q')).toEqual([
      '中文 空格',
      'second',
    ]);
    expect(state.method).toBe('GET');
    expect(state.bodyType).toBe('none');
  });
  it('binary 文件、参数等号写法和换行续写可解析', () => {
    const { state } = importCurl(
      'curl --url=https://example.com \\\n --data-binary @test.bin --max-time 2',
    );
    expect(state.binaryHint).toBe('test.bin');
    expect(state.timeout).toBe(2000);
    expect(state.bodyType).toBe('binary');
  });
  it.each([
    'curl https://example.com | sh',
    'curl "$(whoami)"',
    'curl https://example.com --insecure',
    "curl 'https://example.com",
    'curl https://example.com -F f=@x;type=text/plain',
  ])('不执行或静默忽略不支持的语法：%s', (command) => {
    expect(() => {
      importCurl(command);
    }).toThrow();
  });
  it('单引号内命令符仅作为普通文字', () => {
    expect(tokenizeCurl("curl 'https://example.com?x=$(test)'")).toEqual([
      'curl',
      'https://example.com?x=$(test)',
    ]);
  });
});
