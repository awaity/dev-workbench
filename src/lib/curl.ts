import { httpSchema, pairSchema, multipartSchema, type HttpState } from './models';
import { prepareRequest, resolveVariables, type RequestFiles } from './http';

/**
 * 将 POSIX 风格 cURL 文本分词，仅解析引号和转义，不执行任何命令。
 * @param command - 用户粘贴的单条 cURL 命令。
 * @returns 保留引号内原始内容的参数列表。
 * @throws {Error} 引号不完整或包含管道、命令替换等 Shell 语法时抛出。
 */
export function tokenizeCurl(command: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") {
        quote = '';
      } else {
        token += c;
      }
      continue;
    }
    if (c === '\\') {
      const next = command[++i];
      if (next === undefined) {
        throw new Error('cURL 末尾的转义符不完整');
      }
      if (next === '\n') {
        continue;
      }
      if (next === '\r' && command[i + 1] === '\n') {
        i++;
        continue;
      }
      if (quote === '"' && !['"', '\\', '$', '`'].includes(next)) {
        token += '\\';
      }
      token += next;
      started = true;
      continue;
    }
    if (c === '`' || (c === '$' && command[i + 1] === '(')) {
      throw new Error('不支持 Shell 命令替换，请粘贴完整的静态 cURL 请求');
    }
    if (quote === '"') {
      if (c === '"') {
        quote = '';
      } else {
        token += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/[|;&<>]/.test(c)) {
      throw new Error('仅支持单条 cURL 请求；含特殊字符的参数请用引号包裹');
    }
    if (/\s/.test(c)) {
      if (started) {
        tokens.push(token);
        token = '';
        started = false;
      }
    } else {
      token += c;
      started = true;
    }
  }
  if (quote) {
    throw new Error('cURL 引号未闭合');
  }
  if (started) {
    tokens.push(token);
  }
  return tokens;
}
/**
 * 将常见 cURL 参数转换为请求配置，本地文件路径仅作为待选择提示。
 * @param command - POSIX cURL 命令，支持浏览器 Copy as cURL。
 * @returns 请求状态和明确列出的兼容性提示。
 * @throws {Error} 未知选项、缺少参数或不能无损转换的语法会拒绝导入。
 */
export function importCurl(command: string): { state: HttpState; warnings: string[] } {
  const tokens = tokenizeCurl(command);
  const state = httpSchema.parse({});
  const warnings: string[] = [];
  if (!/^curl(?:\.exe)?$/i.test(tokens.shift() || '')) {
    throw new Error('命令必须以 curl 开头');
  }
  let explicitMethod = false;
  let get = false;
  const data: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let flag = tokens[i]!;
    let inline: string | undefined;
    if (flag.startsWith('--') && flag.includes('=')) {
      const at = flag.indexOf('=');
      inline = flag.slice(at + 1);
      flag = flag.slice(0, at);
    } else if (/^-[XHduF](.+)$/.test(flag)) {
      inline = flag.slice(2);
      flag = flag.slice(0, 2);
    }
    /**
     * 取得当前选项的参数，保留空字符串参数。
     * @returns 选项值。
     */
    function value(): string {
      const result = inline ?? tokens[++i];
      if (result === undefined) {
        throw new Error(`${flag} 缺少参数`);
      }
      return result;
    }
    if (flag === '-X' || flag === '--request') {
      state.method = value().toUpperCase();
      explicitMethod = true;
    } else if (flag === '--url') {
      if (state.url) {
        throw new Error('一次只能导入一个 URL');
      }
      state.url = value();
    } else if (flag === '-H' || flag === '--header') {
      const header = value();
      const at = header.indexOf(':');
      if (at < 1) {
        throw new Error('请求头请使用 name: value 格式');
      }
      state.headers.push(
        pairSchema.parse({
          name: header.slice(0, at).trim(),
          value: header.slice(at + 1).trimStart(),
          enabled: true,
        }),
      );
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode'].includes(flag)) {
      const raw = value();
      if (state.bodyType === 'multipart') {
        throw new Error('不能同时导入 form-data 和原始请求体');
      }
      if (flag === '--data-urlencode') {
        if (data.length || state.bodyType === 'binary') {
          throw new Error('暂不支持混用 data-urlencode 与其他 data 选项');
        }
        const at = raw.indexOf('=');
        if (at < 0 && raw.includes('@')) {
          throw new Error('data-urlencode 的文件读取语法需要改为表单字段后手动选择文件');
        }
        state.bodyType = 'form';
        state.fields.push(
          pairSchema.parse({
            name: at < 0 ? raw : raw.slice(0, at),
            value: at < 0 ? '' : raw.slice(at + 1),
            enabled: true,
          }),
        );
      } else if (raw.startsWith('@') && flag !== '--data-raw') {
        if (data.length || state.bodyType === 'form' || state.binaryHint) {
          throw new Error('文件请求体不能与其他 data 选项混用');
        }
        state.bodyType = 'binary';
        state.binaryHint = raw.slice(1);
        warnings.push(`请重新选择请求体文件：${state.binaryHint}`);
        if (flag !== '--data-binary') {
          warnings.push('文件将按原始字节发送，请核对是否需要移除换行。');
        }
      } else {
        if (state.bodyType === 'binary' || state.bodyType === 'form') {
          throw new Error('暂不支持混用不同 data 编码');
        }
        data.push(raw);
        state.bodyType = 'text';
      }
    } else if (['-F', '--form', '--form-string'].includes(flag)) {
      if (!['none', 'multipart'].includes(state.bodyType)) {
        throw new Error('不能同时导入 form-data 和原始请求体');
      }
      const raw = value();
      const at = raw.indexOf('=');
      if (at < 1) {
        throw new Error('form-data 请使用 name=value 格式');
      }
      const content = raw.slice(at + 1);
      const file = flag !== '--form-string' && content.startsWith('@');
      if (
        flag !== '--form-string' &&
        (content.startsWith('<') || /;(?:type|filename|headers)=/.test(content))
      ) {
        throw new Error('此 form-data 文件修饰语暂不支持，请移除修饰语后导入并在界面选择文件');
      }
      state.bodyType = 'multipart';
      state.multipart.push(
        multipartSchema.parse({
          name: raw.slice(0, at),
          value: file ? '' : content,
          enabled: true,
          kind: file ? 'file' : 'text',
          fileHint: file ? content.slice(1) : '',
        }),
      );
      if (file) {
        warnings.push(`请为 ${raw.slice(0, at)} 重新选择文件：${content.slice(1)}`);
      }
    } else if (flag === '-u' || flag === '--user') {
      const raw = value();
      const at = raw.indexOf(':');
      state.auth = 'basic';
      state.username = at < 0 ? raw : raw.slice(0, at);
      state.password = at < 0 ? '' : raw.slice(at + 1);
    } else if (flag === '--oauth2-bearer') {
      state.auth = 'bearer';
      state.token = value();
    } else if (flag === '-G' || flag === '--get') {
      get = true;
    } else if (flag === '-I' || flag === '--head') {
      state.method = 'HEAD';
      explicitMethod = true;
    } else if (flag === '-L' || flag === '--location') {
      state.followRedirects = true;
    } else if (flag === '--max-time' || flag === '-m') {
      state.timeout = Number(value()) * 1000;
    } else if (
      [
        '--compressed',
        '--silent',
        '-s',
        '--show-error',
        '-S',
        '--include',
        '-i',
        '--globoff',
        '-g',
      ].includes(flag)
    ) {
      warnings.push(`${flag} 由浏览器或响应面板接管。`);
    } else if (flag.startsWith('-')) {
      throw new Error(`暂不支持 cURL 选项 ${flag}，请移除或在界面中配置`);
    } else {
      if (state.url) {
        throw new Error('一次只能导入一个 URL');
      }
      state.url = flag;
    }
  }
  if (!state.url) {
    throw new Error('cURL 中没有找到 URL');
  }
  if (data.length) {
    state.body = data.join('&');
    const mime =
      state.headers
        .find((row) => {
          return row.name.toLowerCase() === 'content-type';
        })
        ?.value.toLowerCase() || 'application/x-www-form-urlencoded';
    if (mime.includes('json')) {
      state.bodyType = 'json';
    } else if (mime.includes('xml')) {
      state.bodyType = 'xml';
    } else if (mime.includes('html')) {
      state.bodyType = 'html';
    } else if (mime.includes('javascript')) {
      state.bodyType = 'javascript';
    } else if (mime.includes('application/x-www-form-urlencoded')) {
      state.bodyType = 'form';
      state.fields = Array.from(new URLSearchParams(state.body), ([name, value]) => {
        return pairSchema.parse({ name, value, enabled: true });
      });
    }
  }
  if (get) {
    if (!['none', 'form'].includes(state.bodyType)) {
      throw new Error('-G 仅支持查询参数形式的 data');
    }
    state.params = state.fields;
    state.fields = [];
    state.bodyType = 'none';
    if (!explicitMethod) {
      state.method = 'GET';
    }
  } else if (!explicitMethod && state.bodyType !== 'none') {
    state.method = 'POST';
  }
  return { state: httpSchema.parse(state), warnings: [...new Set(warnings)] };
}
/**
 * 对 POSIX Shell 参数进行单引号转义。
 * @param value - 原始参数。
 * @returns 可安全粘贴为单个参数的文字。
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
/**
 * 导出当前有效请求为 cURL，文件使用文件名占位并保留变量展开后的值。
 * @param state - 当前请求配置。
 * @param files - 已读取的附件字节，用于和实际发送共用校验。
 * @returns POSIX cURL 命令；文件路径需要使用者替换为本机实际路径。
 */
export function exportCurl(state: HttpState, files: RequestFiles = new Map()): string {
  const { url, init } = prepareRequest(state, files);
  const args = ['curl', '-X', shellQuote(state.method), shellQuote(url)];
  if (state.followRedirects) {
    args.push('--location');
  }
  args.push('--max-time', String(state.timeout / 1000));
  new Headers(init.headers).forEach((value, name) => {
    args.push('-H', shellQuote(`${name}: ${value}`));
  });
  /**
   * 使用当前配置的变量表展开导出的 cURL 参数。
   * @param value - 待校验、转换或保存的值。
   * @returns 变量展开后的文本。
   */
  const resolve = (value: string) => {
    return resolveVariables(value, state.variables);
  };
  if (init.body !== undefined) {
    if (state.bodyType === 'multipart') {
      for (const row of state.multipart) {
        if (!row.enabled || !row.name) {
          continue;
        }
        if (row.kind === 'text') {
          args.push('--form-string', shellQuote(`${resolve(row.name)}=${resolve(row.value)}`));
        } else {
          for (const file of row.files) {
            const path = `"${file.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
            args.push('-F', shellQuote(`${resolve(row.name)}=@${path}`));
          }
        }
      }
    } else if (state.bodyType === 'binary') {
      args.push('--data-binary', shellQuote(`@${state.binary!.name}`));
    } else {
      args.push('--data-raw', shellQuote(String(init.body)));
    }
  }
  return args.join(' ');
}
