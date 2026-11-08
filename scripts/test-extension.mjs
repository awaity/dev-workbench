import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const root = resolve(import.meta.dirname, '..');
const extensionPath = resolve(process.env.EXTENSION_PATH || join(root, 'dist'));
const artifacts = join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'dev-workbench-e2e-'));
const failures = [];
const completed = [];
const unexpectedRequests = [];
const server = createServer(async (request, response) => {
  if (request.url.startsWith('/slow')) {
    const timeout = setTimeout(() => {
      response.end('slow result');
    }, 3000);
    request.on('close', () => {
      clearTimeout(timeout);
    });
    return;
  }
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const body = bytes.toString();
  if (request.url.startsWith('/binary')) {
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Disposition', 'attachment; filename="download.bin"');
    response.end(Buffer.from([0, 255, 128, 13, 10, 1]));
    return;
  }
  if (request.url.startsWith('/multipart')) {
    const parsed = await new Request(`http://localhost${request.url}`, {
      method: request.method,
      headers: request.headers,
      body: bytes,
    }).formData();
    const fields = [];
    for (const [name, value] of parsed) {
      fields.push(
        typeof value === 'string'
          ? { name, value }
          : {
              name,
              filename: value.name,
              type: value.type,
              base64: Buffer.from(await value.arrayBuffer()).toString('base64'),
            },
      );
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        fields,
        apiKey: request.headers['x-api-key'] || null,
        contentType: request.headers['content-type'],
      }),
    );
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('X-Workbench-Test', 'yes');
  response.statusCode = request.url.startsWith('/error') ? 418 : 200;
  response.end(
    JSON.stringify({
      method: request.method,
      url: request.url,
      body,
      base64: bytes.toString('base64'),
      authorization: request.headers.authorization || null,
      custom: request.headers['x-test'] || null,
    }),
  );
});
const ws = new WebSocketServer({ server });
ws.on('connection', (socket) => {
  socket.send('welcome');
  socket.on('message', (data) => {
    socket.send(`echo:${data}`);
  });
});
await new Promise((resolveListen) => {
  server.listen(0, '127.0.0.1', resolveListen);
});
const base = `http://127.0.0.1:${server.address().port}`;
let context;
let page;
let extensionUrl;

/**
 * 使用实际扩展执行一步验收，将结果写入可审查的报告。
 * @param name - 要解析的依赖包名称。
 * @param action - 执行当前验收步骤的异步函数。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function step(name, action) {
  console.log(`验证：${name}`);
  await action();
  completed.push(name);
}
/**
 * 导航到工具，并等待延迟加载面板挂载。
 * @param tool - 目标工具标识。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function navigate(tool) {
  await page.locator(`[data-tool="${tool}"]`).click();
  const selector = ['json', 'json-editor', 'jsonpath'].includes(tool)
    ? '[data-editor="JSON 输入"]'
    : tool === 'http'
      ? '[aria-label="请求地址"]'
      : tool === 'websocket'
        ? '[aria-label="WebSocket 地址"]'
        : tool === 'qrcode'
          ? '.qr-controls'
          : '[data-editor="加密输入"]';
  await page.locator(selector).waitFor();
}
/**
 * 通过真实 contenteditable 交互修改编辑器内容。
 * @param label - 目标控件或编辑器的可访问名称。
 * @param text - 待处理的原始文本。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function editor(label, text) {
  await page.locator(`[data-editor="${label}"]`).fill(text);
}
/**
 * 读取编辑器显示的多行文本。
 * @param label - 目标控件或编辑器的可访问名称。
 * @returns 编辑器当前文本，空白占位时返回空字符串。
 */
async function output(label = '加密结果') {
  const area = page.locator(`[data-editor="${label}"]`);
  if (await area.locator('.cm-placeholder').count()) {
    return '';
  }
  return area.innerText();
}
/**
 * 等待密码学 Worker 完成，并检查可见错误。
 * @param label - 目标控件或编辑器的可访问名称。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function cryptoAction(label) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForFunction(() => {
    return !document.querySelector('.tool-surface > .toolbar > .primary')?.disabled;
  });
  assert.equal(
    await page.locator('.error-banner').count(),
    0,
    await page.locator('.error-banner').allTextContents(),
  );
}
/**
 * 等待 IndexedDB 的单个工具草稿包含目标内容，避免固定延迟。
 * @param tool - 目标工具标识。
 * @param expected - 期望持久化或解码得到的内容。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function waitDraft(tool, expected) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const found = await page.evaluate(
      async ({ tool, expected }) => {
        const db = await new Promise((resolveOpen, reject) => {
          const request = indexedDB.open('dev-workbench');
          request.onsuccess = () => {
            resolveOpen(request.result);
          };
          request.onerror = () => {
            reject(request.error);
          };
        });
        const value = await new Promise((resolveGet) => {
          const request = db.transaction('drafts').objectStore('drafts').get(tool);
          request.onsuccess = () => {
            resolveGet(request.result);
          };
        });
        db.close();
        const content =
          tool === 'websocket'
            ? value?.state.logs
            : tool === 'qrcode'
              ? value?.state.logo
              : tool === 'http'
                ? value?.state
                : value?.state.input;
        return JSON.stringify(content ?? null).includes(expected);
      },
      { tool, expected },
    );
    if (found) {
      return;
    }
    await new Promise((resolvePoll) => {
      setTimeout(resolvePoll, 50);
    });
  }
  throw new Error(`等待 ${tool} 草稿持久化超时`);
}
/**
 * 接收真实浏览器下载并写到验证产物目录。
 * @param button - 触发下载的按钮名称。
 * @param filename - 提供给浏览器的下载文件名。
 * @returns 下载完成后的文件路径。
 */
async function download(button, filename) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const file = await event;
  const path = join(artifacts, filename || file.suggestedFilename());
  await file.saveAs(path);
  return path;
}
/**
 * 用独立解码器验证下载二维码的实际内容。
 * @param path - 从根节点到目标节点的键名或数组索引。
 * @param expected - 期望持久化或解码得到的内容。
 * @returns 经独立解码验证的 PNG 图像数据。
 */
async function decodeQr(path, expected) {
  const image = PNG.sync.read(await readFile(path));
  const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
  assert.equal(decoded?.data, expected, '下载二维码必须能被独立解码器识别');
  return image;
}

/**
 * 通过 Element Plus 的真实下拉选项设置值。
 * @param label - 下拉框的可访问名称。
 * @param option - 要选择的显示文本。
 * @returns 选择完成后的 Promise。
 */
async function select(label, option) {
  await page
    .locator('.el-select')
    .filter({ has: page.getByRole('combobox', { name: label, exact: true }) })
    .locator('.el-select__wrapper')
    .click();
  await page
    .getByRole('listbox', { name: label, exact: true })
    .getByRole('option', { name: option, exact: true })
    .click();
}
/**
 * 获取 Element Plus 下拉框当前显示值。
 * @param label - 下拉框的可访问名称。
 * @returns 当前选中的显示文字。
 */
async function selected(label) {
  return page
    .locator('.el-select')
    .filter({ has: page.getByRole('combobox', { name: label, exact: true }) })
    .innerText();
}
/**
 * 为 ElUpload 组合组件提供测试文件，不触发自动网络上传。
 * @param label - 文件选择按钮名称。
 * @param files - Playwright 支持的文件路径或内存文件列表。
 * @returns 文件选择完成的 Promise。
 */
async function upload(label, files) {
  await page
    .locator('.file-picker')
    .filter({ has: page.getByRole('button', { name: label, exact: true }) })
    .locator('input[type="file"]')
    .setInputFiles(files);
}
/**
 * 发送当前 HTTP 请求并等待请求结束，返回可见 JSON 响应。
 * @returns 服务器返回的 JSON 对象。
 */
async function sendHttp() {
  await page.getByRole('button', { name: '发送请求', exact: true }).click();
  await page.getByRole('button', { name: '发送请求', exact: true }).waitFor();
  await page.locator('[data-editor="HTTP 响应"]').waitFor();
  assert.equal(await page.locator('.http-tool .error-banner').count(), 0);
  return JSON.parse(await output('HTTP 响应'));
}

try {
  const executablePath = process.env.CHROMIUM_PATH || chromium.executablePath();
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath,
    viewport: { width: 1440, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  context.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) {
      unexpectedRequests.push(request.url());
    }
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  extensionUrl = `chrome-extension://${worker.url().split('/')[2]}/index.html`;
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => {
    failures.push(error.message);
  });
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !message.text().includes('net::ERR_ABORTED') &&
      !(message.text().includes('418') && message.location().url.startsWith(`${base}/error`))
    ) {
      failures.push(message.text());
    }
  });
  await page.goto(extensionUrl);
  await page.locator('[data-editor="JSON 输入"]').waitFor();
  await step('MV3 扩展加载、17 个工具、待办弹窗入口与 CSP', async () => {
    assert.equal(await page.locator('[data-tool]').count(), 17);
    const manifest = await page.evaluate(() => {
      return chrome.runtime.getManifest();
    });
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.action.default_popup, 'popup.html');
    assert(!manifest.content_security_policy.extension_pages.includes('unsafe-eval'));
    assert.equal(
      await worker.evaluate(() => {
        return chrome.action.onClicked.hasListeners();
      }),
      false,
    );
    assert.equal(
      await page.evaluate(() => {
        return localStorage.length;
      }),
      0,
    );
  });
  await step('JSON 格式化、压缩、转义、反转义、语法错误、下载与历史', async () => {
    await editor('JSON 输入', '{"name":"中文","n":2}');
    await page.getByRole('button', { name: '格式化 / 校验', exact: true }).click();
    await page.locator('.history-restore').first().waitFor();
    assert((await output('JSON 输入')).includes('\n'));
    await page.getByRole('button', { name: '压缩', exact: true }).click();
    assert.equal(await output('JSON 输入'), '{"name":"中文","n":2}');
    await page.getByRole('button', { name: '转义', exact: true }).click();
    const escaped = await output('JSON 结果');
    assert.equal(JSON.parse(escaped), '{"name":"中文","n":2}');
    await editor('JSON 输入', escaped);
    await page.getByRole('button', { name: '反转义', exact: true }).click();
    const exported = await download('导出', 'document.json');
    assert.equal(JSON.parse(await readFile(exported, 'utf8')).name, '中文');
    await editor('JSON 输入', '{bad}');
    await page.getByRole('button', { name: '格式化 / 校验', exact: true }).click();
    assert((await page.locator('.error-banner').innerText()).includes('语法错误'));
    await upload('导入 JSON 文件', exported);
    await page.getByRole('button', { name: '格式化 / 校验', exact: true }).click();
    await waitDraft('json', '中文');
    await page.reload();
    await page.locator('[data-editor="JSON 输入"]').waitFor();
    assert.equal(JSON.parse(await output('JSON 输入')).name, '中文');
    await page.screenshot({ path: join(artifacts, 'json.png'), fullPage: true });
  });
  await step('JSON 树节点编辑、新增与删除', async () => {
    await navigate('json-editor');
    await page.getByRole('button', { name: '编辑 project', exact: true }).click();
    await page.getByLabel('值（有效 JSON）').fill('"树形修改"');
    await page.getByRole('button', { name: '保存节点', exact: true }).click();
    assert.equal(JSON.parse(await output('JSON 输入')).project, '树形修改');
    await page.getByRole('button', { name: '添加到 $', exact: true }).click();
    await page.getByLabel('字段名', { exact: true }).fill('added');
    await page.getByLabel('值（有效 JSON）').fill('{"ok":true}');
    await page.getByRole('button', { name: '保存节点', exact: true }).click();
    assert.equal(JSON.parse(await output('JSON 输入')).added.ok, true);
    await page.getByRole('button', { name: '删除 added', exact: true }).click();
    await page
      .locator('.el-message-box')
      .getByRole('button', { name: '删除', exact: true })
      .click();
    await page
      .getByRole('button', { name: '删除 added', exact: true })
      .waitFor({ state: 'detached' });
    assert.equal(JSON.parse(await output('JSON 输入')).added, undefined);
  });
  await step('JSONPath 在 MV3 CSP 下支持过滤表达式', async () => {
    await navigate('jsonpath');
    await page.getByLabel('JSONPath', { exact: true }).fill('$.tools[?(@.favorite == true)].name');
    await page.getByRole('button', { name: '查询', exact: true }).click();
    assert.deepEqual(JSON.parse(await output('JSON 结果')), ['JSON', 'SM4']);
    assert((await page.locator('.match-paths').innerText()).includes("$['tools'][1]['name']"));
  });
  for (const tool of ['sm4', 'aes', 'des', 'base64', 'url']) {
    await step(`${tool.toUpperCase()} 扩展内加解密 / 编解码往返`, async () => {
      await navigate(tool);
      await page.getByRole('button', { name: '载入示例', exact: true }).click();
      const plain = await output('加密输入');
      await cryptoAction(['base64', 'url'].includes(tool) ? '编码' : '加密');
      assert.notEqual(await output(), plain);
      await page.getByRole('button', { name: '作为输入', exact: true }).click();
      await cryptoAction(['base64', 'url'].includes(tool) ? '解码' : '解密');
      assert.equal(await output(), plain);
      if (tool === 'sm4') {
        await page.screenshot({ path: join(artifacts, 'sm4.png'), fullPage: true });
      }
    });
  }
  for (const tool of ['sm2', 'rsa']) {
    await step(`${tool.toUpperCase()} Worker 密钥生成与加解密`, async () => {
      await navigate(tool);
      await cryptoAction(`生成${tool.toUpperCase()} 密钥对`);
      assert((await page.getByLabel('公钥', { exact: true }).inputValue()).length > 100);
      await editor('加密输入', '扩展端公钥测试');
      await cryptoAction('加密');
      await page.getByRole('button', { name: '作为输入', exact: true }).click();
      await cryptoAction('解密');
      assert.equal(await output(), '扩展端公钥测试');
    });
  }
  await step('MD5 摘要、校验、本地字典与可取消匹配', async () => {
    await navigate('md5');
    await page.getByRole('button', { name: '载入示例', exact: true }).click();
    await cryptoAction('计算摘要');
    assert.equal(await output(), '5d41402abc4b2a76b9719d911017c592');
    await cryptoAction('校验输入原文');
    assert((await output()).includes('校验通过'));
    await page.getByText('本地候选匹配（MD5 解密）', { exact: true }).click();
    await cryptoAction('匹配候选文本');
    assert((await output()).includes('找到匹配："hello"'));
    await page.getByLabel('数字终点', { exact: true }).fill('1000000');
    await page.getByRole('button', { name: '匹配数字范围', exact: true }).click();
    await page.getByRole('button', { name: '取消计算', exact: true }).click();
    assert.equal(await page.locator('.error-banner').innerText(), '操作已取消');
  });
  await step('SHA 摘要、JWT 解码、Bcrypt 哈希与校验', async () => {
    await navigate('sha');
    await editor('加密输入', 'abc');
    await cryptoAction('计算摘要');
    assert.equal(
      await output(),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    await navigate('jwt');
    await page.getByRole('button', { name: '载入示例', exact: true }).click();
    await cryptoAction('解析 JWT');
    assert.equal(JSON.parse(await output()).payload.name, 'John Doe');
    assert.equal(JSON.parse(await output()).signatureVerified, null);
    await navigate('bcrypt');
    await editor('加密输入', '我的测试密码');
    await page.getByLabel('工作因子', { exact: true }).fill('4');
    await cryptoAction('生成哈希');
    const hash = await output();
    assert(hash.startsWith('$2b$04$'));
    await page.getByLabel('目标 Bcrypt 哈希').fill(hash);
    await cryptoAction('校验输入原文');
    assert((await output()).includes('校验通过'));
  });
  await step('HTTP 无 CORS 服务器：POST、参数、请求头、Bearer 与响应', async () => {
    await navigate('http');
    await select('HTTP 方法', 'POST');
    await page.getByLabel('请求地址').fill(`${base}/echo`);
    await page.getByRole('button', { name: '＋ 添加查询参数', exact: true }).click();
    await page.getByLabel('查询参数 1 名称').fill('q');
    await page.getByLabel('查询参数 1 值').fill('中文');
    await page.getByRole('tab', { name: '请求头', exact: true }).click();
    await page.getByRole('button', { name: '＋ 添加请求头', exact: true }).click();
    await page.getByLabel('请求头 1 名称').fill('X-Test');
    await page.getByLabel('请求头 1 值').fill('local');
    await page.getByRole('tab', { name: '请求体', exact: true }).click();
    await page.getByRole('radio', { name: 'raw', exact: true }).locator('..').click();
    await editor('请求体内容', '{"message":"hello"}');
    await page.getByRole('tab', { name: '鉴权', exact: true }).click();
    await select('鉴权方式', 'Bearer Token');
    await page.getByLabel('Token', { exact: true }).fill('test-token');
    await page.getByRole('button', { name: '发送请求', exact: true }).click();
    await page.locator('[data-editor="HTTP 响应"]').waitFor();
    const response = JSON.parse(await output('HTTP 响应'));
    assert.equal(response.method, 'POST');
    assert.equal(response.custom, 'local');
    assert.equal(response.authorization, 'Bearer test-token');
    assert.equal(response.body, '{"message":"hello"}');
    assert(response.url.includes('q=%E4%B8%AD%E6%96%87'));
    await page.getByRole('radio', { name: '响应头', exact: true }).locator('..').click();
    assert((await output('HTTP 响应')).includes('x-workbench-test: yes'));
    await page.getByRole('radio', { name: 'Pretty', exact: true }).locator('..').click();
    await page.screenshot({ path: join(artifacts, 'http.png'), fullPage: true });
  });
  await step('HTTP 超时、手动取消、错误状态与历史恢复', async () => {
    await page.getByLabel('请求地址').fill(`${base}/slow`);
    await page.getByRole('tab', { name: '请求设置', exact: true }).click();
    await page.getByLabel('超时（毫秒）').fill('100');
    await page.getByRole('button', { name: '发送请求', exact: true }).click();
    await page.locator('.error-banner').filter({ hasText: '请求超时' }).waitFor();
    await page.getByLabel('超时（毫秒）').fill('30000');
    await page.getByRole('button', { name: '发送请求', exact: true }).click();
    await page.getByRole('button', { name: '取消请求', exact: true }).click();
    await page.locator('.error-banner').filter({ hasText: '请求已取消' }).waitFor();
    await page.getByLabel('请求地址').fill(`${base}/error`);
    await page.getByRole('button', { name: '发送请求', exact: true }).click();
    await page.locator('.status-pill').filter({ hasText: '418' }).waitFor();
    await page.locator('.history-restore').filter({ hasText: '/echo' }).first().click();
    assert.equal(await page.getByLabel('请求地址').inputValue(), `${base}/echo`);
  });
  await step('HTTP form-data 文本、多文件、变量、API Key 与请求集合', async () => {
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await select('HTTP 方法', 'POST');
    await page.getByLabel('请求地址', { exact: true }).fill('{{base}}/multipart');
    await page.getByRole('tab', { name: '变量', exact: true }).click();
    await page.getByRole('button', { name: '批量编辑变量', exact: true }).click();
    await page.getByLabel('批量变量', { exact: true }).fill(`base:${base}\nlabel:中文变量`);
    await page.getByRole('button', { name: '应用参数', exact: true }).click();
    await page.getByRole('tab', { name: '鉴权', exact: true }).click();
    await select('鉴权方式', 'API Key');
    await page.getByLabel('API Key 值', { exact: true }).fill('local-key');
    await page.getByRole('tab', { name: '请求体', exact: true }).click();
    await page.getByRole('radio', { name: 'form-data', exact: true }).locator('..').click();
    for (let row = 1; row <= 3; row++) {
      await page.getByRole('button', { name: '＋ 添加 form-data 字段', exact: true }).click();
    }
    await page.getByLabel('form-data 1 名称', { exact: true }).fill('title');
    await page.getByLabel('form-data 1 值', { exact: true }).fill('{{label}}');
    await page.getByLabel('form-data 1 描述', { exact: true }).fill('文本字段说明');
    await page.getByLabel('form-data 2 名称', { exact: true }).fill('title');
    await page.getByLabel('form-data 2 值', { exact: true }).fill('重复值');
    await page.getByLabel('form-data 3 名称', { exact: true }).fill('attachments');
    await select('form-data 3 类型', 'File');
    await upload('选择文件 3', [
      {
        name: 'bytes.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from([0, 255, 128, 13, 10]),
      },
      { name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('中文文件内容') },
    ]);
    await page.getByText('hello.txt', { exact: true }).waitFor();
    const data = await sendHttp();
    assert.deepEqual(data.fields.slice(0, 2), [
      { name: 'title', value: '中文变量' },
      { name: 'title', value: '重复值' },
    ]);
    assert.equal(data.fields[2].filename, 'bytes.bin');
    assert.equal(data.fields[2].base64, Buffer.from([0, 255, 128, 13, 10]).toString('base64'));
    assert.equal(data.fields[3].base64, Buffer.from('中文文件内容').toString('base64'));
    assert.equal(data.apiKey, 'local-key');
    assert(data.contentType.includes('boundary='));
    await page.getByRole('button', { name: '保存请求', exact: true }).click();
    await page.getByLabel('请求名称', { exact: true }).fill('文件上传测试');
    await page.getByLabel('集合名称', { exact: true }).fill('本地测试');
    await page.getByRole('button', { name: '确认保存', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await waitDraft('http', '文件上传测试');
    await page.screenshot({ path: join(artifacts, 'http-multipart.png'), fullPage: true });
    await page.reload();
    await page.getByLabel('请求地址', { exact: true }).waitFor();
    assert.deepEqual((await sendHttp()).fields, data.fields);
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.getByRole('button', { name: '请求集合', exact: true }).click();
    await page.locator('.collection-load').filter({ hasText: '文件上传测试' }).click();
    assert.deepEqual((await sendHttp()).fields, data.fields);
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.locator('.history-restore').filter({ hasText: '/multipart' }).first().click();
    assert.deepEqual((await sendHttp()).fields, data.fields);
    await page.getByRole('button', { name: '导出 cURL', exact: true }).click();
    const command = await page.getByLabel('cURL 命令', { exact: true }).inputValue();
    assert(command.includes('--form-string'));
    assert(command.includes('bytes.bin'));
    assert(command.includes('x-api-key: local-key'));
    await page.getByRole('button', { name: '关闭', exact: true }).click();
  });
  await step('HTTP binary 文件发送、二进制响应原样下载与 cURL 导入', async () => {
    await page.getByRole('tab', { name: '请求体', exact: true }).click();
    await page.getByRole('radio', { name: 'binary', exact: true }).locator('..').click();
    await page.getByLabel('请求地址', { exact: true }).fill(`${base}/echo`);
    await upload('选择 binary 文件', {
      name: 'request.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([0, 255, 1, 128, 10]),
    });
    await page.getByText('request.bin', { exact: true }).waitFor();
    assert.equal((await sendHttp()).base64, Buffer.from([0, 255, 1, 128, 10]).toString('base64'));
    await page.getByRole('button', { name: '导入 cURL', exact: true }).click();
    await page
      .getByLabel('cURL 命令', { exact: true })
      .fill(`curl '${base}/echo' --data-urlencode 'q=中文 空格' --data-urlencode 'q=second'`);
    await page.getByRole('button', { name: '导入请求', exact: true }).click();
    assert.equal((await sendHttp()).body, 'q=%E4%B8%AD%E6%96%87+%E7%A9%BA%E6%A0%BC&q=second');
    await page.getByLabel('请求地址', { exact: true }).fill(`${base}/binary`);
    await page.getByRole('button', { name: '发送请求', exact: true }).click();
    await page.getByText(/二进制响应 ·/).waitFor();
    const downloaded = await download('下载响应', 'response-binary.bin');
    assert.deepEqual(await readFile(downloaded), Buffer.from([0, 255, 128, 13, 10, 1]));
    await page.screenshot({ path: join(artifacts, 'http-binary.png'), fullPage: true });
  });
  await step('WebSocket 实际连接、收发消息、保存日志与断开', async () => {
    await navigate('websocket');
    await page.getByLabel('WebSocket 地址').fill(base.replace('http:', 'ws:'));
    await page.getByRole('button', { name: '建立连接', exact: true }).click();
    await page.getByText('welcome', { exact: true }).waitFor();
    await page.getByLabel('发送内容').fill('你好 WS');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByText('echo:你好 WS', { exact: true }).waitFor();
    await page.getByRole('button', { name: '保存到历史', exact: true }).click();
    await waitDraft('websocket', 'echo:你好 WS');
    await page.getByRole('button', { name: '断开连接', exact: true }).click();
    await page.getByRole('button', { name: '建立连接', exact: true }).waitFor();
    await page.reload();
    await page.getByText('echo:你好 WS', { exact: true }).waitFor();
  });
  await step('二维码生成、独立解码、SVG 下载与 Logo 美化', async () => {
    await navigate('qrcode');
    await page
      .getByLabel('二维码内容', { exact: true })
      .fill('https://example.com/local?name=中文👋');
    await page.getByLabel('名称（方便在历史中查找）').fill('本地测试入口');
    await page.getByRole('button', { name: '生成二维码并保存历史', exact: true }).click();
    await page.locator('.qr-image svg').waitFor();
    const png = await download('下载 PNG', 'qr-plain.png');
    const image = await decodeQr(png, 'https://example.com/local?name=中文👋');
    assert.equal(image.width, 400);
    const svg = await download('下载 SVG', 'qr-plain.svg');
    assert((await readFile(svg, 'utf8')).includes('<svg'));
    await select('码点样式', '圆角');
    await select('定位点样式', '圆角');
    await upload('上传 Logo 文件', join(root, 'public/icons/128.png'));
    await page.locator('.logo-upload img').waitFor();
    assert((await selected('纠错等级')).includes('H · 30%'));
    assert.equal(
      await page.getByRole('button', { name: '下载 PNG', exact: true }).isEnabled(),
      false,
    );
    await page.getByRole('button', { name: '生成二维码并保存历史', exact: true }).click();
    await page.waitForFunction(() => {
      return !document.querySelector('.qr-downloads .primary').disabled;
    });
    const logoPng = await download('下载 PNG', 'qr-logo.png');
    await decodeQr(logoPng, 'https://example.com/local?name=中文👋');
    await download('下载 SVG', 'qr-logo.svg');
    await page.screenshot({ path: join(artifacts, 'qrcode.png'), fullPage: true });
    await waitDraft('qrcode', 'data:image/png;base64,');
    await page.reload();
    await page.locator('.qr-image svg').waitFor();
    assert.equal(await page.locator('.logo-upload img').count(), 1);
    assert.equal(await selected('码点样式'), '圆角');
    await page.locator('.history-restore').filter({ hasText: '文字二维码' }).first().click();
    await page.locator('.logo-upload img').waitFor({ state: 'detached' });
  });
  await step('全局设置：主题、默认工具、缩进、备份、重载恢复', async () => {
    await page.getByRole('button', { name: '打开全局设置', exact: true }).click();
    await select('外观', '深色');
    await select('默认工具', '国密 SM4');
    await select('JSON 缩进', '4 个空格');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.locator('html.dark').waitFor();
    const path = await download('导出本地备份', 'backup.json');
    const backup = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(backup.settings.theme, 'dark');
    assert.equal(backup.version, 3);
    assert(backup.attachments.length >= 3);
    assert(
      backup.requests.some((row) => {
        return row.name === '文件上传测试';
      }),
    );
    assert(backup.history.length >= 17);
    assert(backup.drafts.length >= 17);
    await page.getByRole('button', { name: '清除全部数据', exact: true }).click();
    await page
      .locator('.el-message-box')
      .getByRole('button', { name: '确认删除', exact: true })
      .click();
    await page.locator('html:not(.dark)').waitFor();
    await upload('导入备份', path);
    await page
      .locator('.el-message-box')
      .getByRole('button', { name: '确认替换', exact: true })
      .click();
    await page.locator('html.dark').waitFor();
    await page.reload();
    await page.getByRole('combobox', { name: '外观', exact: true }).waitFor();
    assert.equal(await selected('JSON 缩进'), '4 个空格');
    await page.screenshot({ path: join(artifacts, 'settings-dark.png'), fullPage: true });
    await navigate('http');
    await page.getByRole('button', { name: '请求集合', exact: true }).click();
    await page.locator('.collection-load').filter({ hasText: '文件上传测试' }).click();
    const restoredUpload = await sendHttp();
    assert.equal(
      restoredUpload.fields[2].base64,
      Buffer.from([0, 255, 128, 13, 10]).toString('base64'),
    );
    await page.getByRole('tab', { name: '请求体', exact: true }).click();
    await page.screenshot({ path: join(artifacts, 'http-dark.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(artifacts, 'http-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => {
        return (
          document.documentElement.scrollWidth <= innerWidth &&
          document.querySelector('.tool-surface').scrollWidth <=
            document.querySelector('.tool-surface').clientWidth + 1
        );
      }),
      true,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(extensionUrl);
    await page.getByRole('heading', { name: '国密 SM4', exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => {
        return localStorage.length;
      }),
      0,
    );
  });
  await step('关闭草稿与历史记录生效；删除单条历史与清空历史', async () => {
    await page.getByRole('button', { name: '打开全局设置', exact: true }).click();
    await page
      .getByRole('checkbox', { name: '自动保存工具草稿', exact: true })
      .locator('..')
      .click();
    await page.getByRole('checkbox', { name: '记录操作历史', exact: true }).locator('..').click();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await navigate('base64');
    const count = await page.locator('.history-restore').count();
    await editor('加密输入', '不要保存');
    await cryptoAction('编码');
    assert.equal(await page.locator('.history-restore').count(), count);
    await page.reload();
    await page.locator('[data-editor="加密输入"]').waitFor();
    assert.equal((await output('加密输入')).trim(), '');
    await page.getByRole('button', { name: '删除此记录', exact: true }).first().click();
    await page.waitForFunction((count) => {
      return document.querySelectorAll('.history-restore').length === count - 1;
    }, count);
    await page.getByRole('button', { name: '打开全局设置', exact: true }).click();
    await page.getByRole('button', { name: '清空全部历史', exact: true }).click();
    await page
      .locator('.el-message-box')
      .getByRole('button', { name: '确认删除', exact: true })
      .click();
    await page.getByText(/0 条历史 · 0 份草稿/).waitFor();
  });
  await step('离线启动、响应式布局和无远程资源请求', async () => {
    await context.setOffline(true);
    await page.goto(`${extensionUrl}#json`);
    await page.locator('[data-editor="JSON 输入"]').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(artifacts, 'mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => {
        return document.documentElement.scrollWidth <= innerWidth;
      }),
      true,
    );
    await page.getByRole('button', { name: '打开工具导航', exact: true }).click();
    await page.getByLabel('搜索工具').fill('SM4');
    await page.locator('[data-tool="sm4"]').click();
    await page.getByRole('button', { name: '载入示例', exact: true }).click();
    await cryptoAction('加密');
    assert((await output()).length > 0);
    assert.deepEqual(unexpectedRequests, []);
  });
  assert.deepEqual(failures, [], '浏览器页面 / CSP 不应出现错误');
  await writeFile(
    join(artifacts, 'e2e-report.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: context.browser()?.version(),
        extensionPath,
        completed,
        failures,
        unexpectedRequests,
      },
      null,
      2,
    ),
  );
  console.log(`通过 ${completed.length} 项真实扩展验收。报告：artifacts/e2e-report.json`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  }
  await writeFile(
    join(artifacts, 'e2e-failure.json'),
    JSON.stringify({ completed, failures, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  if (context) {
    await context.close();
  }
  for (const client of ws.clients) {
    client.terminate();
  }
  await new Promise((resolveClose) => {
    ws.close(resolveClose);
  });
  server.closeAllConnections();
  await new Promise((resolveClose) => {
    server.close(resolveClose);
  });
  await rm(profile, { recursive: true, force: true });
}
