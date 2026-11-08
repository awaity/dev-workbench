import { fromBase64, toBase64 } from './encoding';
import type { AttachmentRef, HttpState } from './models';

/** 单次请求允许的附件总大小，防止构造 FormData 时产生过高内存占用。 */
export const MAX_REQUEST_FILE_BYTES = 50 * 1024 * 1024;
/** 原始请求体格式对应的默认 Content-Type；用户显式填写的请求头优先。 */
export const RAW_CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  text: 'text/plain;charset=UTF-8',
  xml: 'application/xml',
  html: 'text/html;charset=UTF-8',
  javascript: 'application/javascript',
};
/** 已恢复的附件字节表，以稳定文件 ID 索引。 */
export type RequestFiles = Map<string, Blob>;

/**
 * 拒绝由浏览器接管的请求头，避免界面显示已发送但实际上被忽略。
 * @param name - 展开变量后的请求头名称。
 * @returns 校验通过时无返回值。
 * @throws {Error} 请求头受浏览器限制时抛出。
 */
function assertHeader(name: string): void {
  if (
    /^(host|cookie|origin|content-length|connection|upgrade|referer|accept-encoding|access-control-request-.*|sec-.*|proxy-.*|transfer-encoding|te|trailer|keep-alive|expect|date|dnt|via)$/i.test(
      name,
    )
  ) {
    throw new Error(`${name} 由浏览器控制，不能手动设置；Cookie 请使用「携带站点 Cookie」`);
  }
}

/**
 * 展开请求级变量，支持嵌套引用并检测缺失或循环。
 * @param text - 可包含 `{{变量名}}` 的原始字符串。
 * @param variables - 变量表；重复的启用变量名会拒绝处理。
 * @returns 替换后的字符串，不执行任何 JavaScript。
 * @throws {Error} 变量不存在、重复、循环或嵌套超过 20 层时抛出。
 */
export function resolveVariables(text: string, variables: HttpState['variables']): string {
  const values = new Map<string, string>();
  for (const row of variables) {
    if (!row.enabled || !row.name.trim()) {
      continue;
    }
    const name = row.name.trim();
    if (values.has(name)) {
      throw new Error(`变量 ${name} 重复，请保留一个启用项`);
    }
    values.set(name, row.value);
  }
  /**
   * 递归替换当前文本，保留变量调用链以定位循环。
   * @param value - 当前层待替换文本。
   * @param chain - 已访问的变量名称。
   * @returns 当前层替换后的文本。
   */
  function expand(value: string, chain: string[]): string {
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, name: string) => {
      if (!values.has(name)) {
        throw new Error(`变量 ${name} 未定义，请在「变量」中添加`);
      }
      if (chain.includes(name) || chain.length >= 20) {
        throw new Error(`变量循环或嵌套过深：${[...chain, name].join(' → ')}`);
      }
      return expand(values.get(name)!, [...chain, name]);
    });
  }
  return expand(text, []);
}

/**
 * 收集当前请求体实际使用的文件引用，跳过停用字段及 GET/HEAD 请求体。
 * @param form - HTTP 请求配置。
 * @returns 按发送顺序排列的文件引用，允许重复引用同一文件。
 */
export function requestFileRefs(form: HttpState): AttachmentRef[] {
  if (['GET', 'HEAD'].includes(form.method)) {
    return [];
  }
  if (form.bodyType === 'binary') {
    return form.binary ? [form.binary] : [];
  }
  return form.bodyType === 'multipart'
    ? form.multipart
        .filter((row) => {
          return row.enabled && !!row.name && row.kind === 'file';
        })
        .flatMap((row) => {
          return row.files;
        })
    : [];
}

/**
 * 构造浏览器 Fetch 请求，保留重复参数、字段顺序和附件原始字节。
 * @param form - 已通过 httpSchema 校验的请求配置。
 * @param files - 从 IndexedDB 恢复的附件字节；文本请求可省略。
 * @returns 完整 URL、Fetch 选项，以及自动调整请求头的提示。
 * @throws {Error} URL、请求头、JSON、变量或附件不合法时抛出，不发送请求。
 */
export function prepareRequest(form: HttpState, files: RequestFiles = new Map()) {
  /**
   * 使用当前请求的变量表展开字符串。
   * @param text - 待处理的原始文本。
   * @returns 变量展开后的文本。
   */
  const resolve = (text: string) => {
    return resolveVariables(text, form.variables);
  };
  let url: URL;
  try {
    url = new URL(resolve(form.url));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('变量')) {
      throw error;
    }
    throw new Error('请输入完整的 http:// 或 https:// 地址', { cause: error });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('仅支持 HTTP 和 HTTPS 地址');
  }
  if (url.username || url.password) {
    throw new Error('请在「鉴权」中填写用户名和密码');
  }
  if (['CONNECT', 'TRACE', 'TRACK'].includes(form.method)) {
    throw new Error(`${form.method} 不受浏览器 Fetch 支持`);
  }
  for (const pair of form.params) {
    if (pair.enabled && pair.name) {
      url.searchParams.append(resolve(pair.name), resolve(pair.value));
    }
  }
  const headers = new Headers();
  const warnings: string[] = [];
  for (const pair of form.headers) {
    if (!pair.enabled || !pair.name.trim()) {
      continue;
    }
    const name = resolve(pair.name).trim();
    assertHeader(name);
    headers.append(name, resolve(pair.value));
  }
  if (form.auth === 'bearer') {
    headers.set('Authorization', `Bearer ${resolve(form.token)}`);
  }
  if (form.auth === 'basic') {
    headers.set(
      'Authorization',
      `Basic ${toBase64(new TextEncoder().encode(`${resolve(form.username)}:${resolve(form.password)}`))}`,
    );
  }
  if (form.auth === 'api-key') {
    const name = resolve(form.apiKeyName).trim();
    if (!name) {
      throw new Error('API Key 名称不能为空');
    }
    if (form.apiKeyIn === 'query') {
      url.searchParams.set(name, resolve(form.apiKeyValue));
    } else {
      assertHeader(name);
      headers.set(name, resolve(form.apiKeyValue));
    }
  }
  const references = requestFileRefs(form);
  if (
    references.reduce((sum, file) => {
      return sum + file.size;
    }, 0) > MAX_REQUEST_FILE_BYTES
  ) {
    throw new Error('单次请求的文件总大小不能超过 50 MB');
  }
  /**
   * 校验文件引用并取得待发送字节。
   * @param reference - 草稿中保存的附件引用。
   * @returns MIME 类型与引用一致的 Blob。
   * @throws {Error} 附件缺失或字节数变化时抛出。
   */
  function getFile(reference: AttachmentRef): Blob {
    const blob = files.get(reference.id);
    if (!blob || blob.size !== reference.size) {
      throw new Error(`附件「${reference.name}」不可用，请重新选择文件`);
    }
    return blob.slice(0, blob.size, reference.type || 'application/octet-stream');
  }
  let body: BodyInit | undefined;
  if (!['GET', 'HEAD'].includes(form.method) && form.bodyType !== 'none') {
    if (form.bodyType === 'form') {
      const data = new URLSearchParams();
      for (const pair of form.fields) {
        if (pair.enabled && pair.name) {
          data.append(resolve(pair.name), resolve(pair.value));
        }
      }
      body = data;
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
      }
    } else if (form.bodyType === 'multipart') {
      const data = new FormData();
      for (const row of form.multipart) {
        if (!row.enabled || !row.name) {
          continue;
        }
        const name = resolve(row.name);
        if (row.kind === 'file') {
          if (!row.files.length) {
            throw new Error(
              `form-data 字段「${name}」尚未选择文件${row.fileHint ? `：${row.fileHint}` : ''}`,
            );
          }
          for (const file of row.files) {
            data.append(name, getFile(file), file.name);
          }
        } else {
          data.append(name, resolve(row.value));
        }
      }
      body = data;
      if (headers.has('Content-Type')) {
        warnings.push('form-data 的 Content-Type 和 boundary 已交由浏览器生成。');
        headers.delete('Content-Type');
      }
    } else if (form.bodyType === 'binary') {
      if (!form.binary) {
        throw new Error(`请选择 binary 请求体文件${form.binaryHint ? `：${form.binaryHint}` : ''}`);
      }
      body = getFile(form.binary);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', body.type || 'application/octet-stream');
      }
    } else {
      body = resolve(form.body);
      if (form.bodyType === 'json') {
        try {
          JSON.parse(body);
        } catch (error) {
          throw new Error('请求体不是有效 JSON，请检查变量替换后的内容', { cause: error });
        }
      }
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', RAW_CONTENT_TYPES[form.bodyType] || 'text/plain');
      }
    }
  }
  return {
    url: url.toString(),
    warnings,
    init: {
      method: form.method,
      headers,
      body,
      credentials: form.credentials ? 'include' : 'omit',
      redirect: form.followRedirects ? 'follow' : 'error',
    } as RequestInit,
  };
}

/**
 * 从 Content-Disposition 读取下载文件名，并移除路径和控制字符。
 * @param header - 响应头原文，可为空。
 * @param binary - 是否为二进制响应，用于选择默认扩展名。
 * @returns 适合浏览器下载属性的文件名。
 */
export function responseFilename(header: string | null, binary: boolean): string {
  const extended = header?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const plain = header?.match(/filename\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  let filename = plain?.[1] || plain?.[2]?.trim() || '';
  if (extended) {
    try {
      filename = decodeURIComponent(extended.trim());
    } catch {
      /* 保留普通文件名作为回退。 */
    }
  }
  return (
    filename.replace(/[/\\:*?"<>|\p{Cc}]/gu, '-').slice(0, 180) ||
    (binary ? 'response.bin' : 'response.txt')
  );
}

/**
 * 按大小上限读取响应，文本依声明字符集解码，二进制无损保存为 Base64。
 * @param response - Fetch 返回的响应对象。
 * @param limit - 最多保留字节数，默认 5 MiB；超出后停止读取并标记截断。
 * @returns 内容、编码、文件名、MIME、字节数和截断标记。
 * @throws {Error} 网络中断或读取取消时向调用方传递异常。
 */
export async function readResponse(response: Response, limit = 5 * 1024 * 1024) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = value.subarray(0, Math.max(0, limit - size));
        chunks.push(chunk);
        size += chunk.byteLength;
        if (value.length > chunk.length) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const contentType = response.headers.get('Content-Type') || 'text/plain';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const binary =
    !/^text\//.test(mime) && !/(?:json|xml|javascript|x-www-form-urlencoded)$/.test(mime);
  const encoding = binary ? ('base64' as const) : ('text' as const);
  const charset = contentType.match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1] || 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder();
  }
  return {
    body: binary ? toBase64(bytes) : decoder.decode(bytes),
    size,
    truncated,
    contentType,
    encoding,
    filename: responseFilename(response.headers.get('Content-Disposition'), binary),
  };
}

/**
 * 从持久化响应恢复下载 Blob，二进制响应保留原始字节。
 * @param response - 最近一次或历史中恢复的 HTTP 响应。
 * @returns 可以交给下载函数的 Blob。
 */
export function responseBlob(response: NonNullable<HttpState['response']>): Blob {
  return new Blob([response.encoding === 'base64' ? fromBase64(response.body) : response.body], {
    type: response.contentType,
  });
}
