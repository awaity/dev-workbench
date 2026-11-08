/** @file 验证真实 MV3 action popup、待办持久化、Markdown 下载及工作台数据联动。 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const extensionPath = resolve(process.env.EXTENSION_PATH || join(root, 'dist'));
const artifacts = join(root, 'artifacts');
const profile = await mkdtemp(join(tmpdir(), 'dev-todo-popup-'));
const completed = [];
const failures = [];
const requests = [];
let context;
let control;
let page;
let base;
let worker;
let fixtures;
let dimensions;
await mkdir(artifacts, { recursive: true });

/**
 * 记录独立验收步骤，失败时保留已完成的证据。
 * @param name - 场景名称。
 * @param action - 验收操作。
 * @returns 场景执行完成的 Promise。
 */
async function step(name, action) {
  console.log(`验证：${name}`);
  await action();
  completed.push(name);
}
/**
 * 打开真实浏览器工具栏弹窗，并等待待办加载完成。
 * @returns 弹窗可以操作后的 Promise。
 */
async function openPopup() {
  await control.bringToFront();
  await worker.evaluate(() => {
    return chrome.action.openPopup();
  });
  await control.waitForFunction(() => {
    return chrome.extension.getViews({ type: 'popup' })[0]?.document.querySelector('.add-todo');
  });
}
/**
 * 在实际 action popup 中点击控件，独立于普通标签页预览。
 * @param selector - 弹窗内的 CSS 选择器。
 * @returns 点击事件发出后的 Promise。
 */
async function popupClick(selector) {
  await control.evaluate((css) => {
    const view = chrome.extension.getViews({ type: 'popup' })[0];
    const element = view?.document.querySelector(css);
    if (!element) {
      throw new Error(`弹窗控件不存在：${css}`);
    }
    element.focus();
    element.click();
  }, selector);
}
/**
 * 通过 DevTools 协议截图真实弹窗，保留浏览器实际裁剪尺寸。
 * @param filename - artifacts 中的截图名称。
 * @returns 截图写入完成后的 Promise。
 */
async function screenshotPopup(filename) {
  // 等待浏览器弹窗自动调整尺寸及进度条过渡完成，再留存最终画面。
  await control.waitForTimeout(650);
  const cdp = await context.newCDPSession(control);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const target = targetInfos.find((item) => {
    return item.url === `${base}popup.html` && !item.attached;
  });
  assert(target, '实际 action popup target 应存在');
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: false,
  });
  try {
    const response = new Promise((resolveResponse, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('弹窗截图超时'));
      }, 10000);
      cdp.on('Target.receivedMessageFromTarget', ({ sessionId: incoming, message }) => {
        if (incoming !== sessionId) {
          return;
        }
        const data = JSON.parse(message);
        if (data.id === 1) {
          clearTimeout(timeout);
          if (data.error) {
            reject(new Error(data.error.message));
          } else {
            resolveResponse(data.result.data);
          }
        }
      });
    });
    await cdp.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({
        id: 1,
        method: 'Page.captureScreenshot',
        params: { format: 'png' },
      }),
    });
    await writeFile(join(artifacts, filename), Buffer.from(await response, 'base64'));
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId });
    await cdp.detach();
  }
}
/**
 * 在同源控制页原子写入测试任务与可选主题，通知已打开的弹窗重新读取。
 * @param items - 要写入的完整任务。
 * @param theme - 可选全局主题。
 * @returns 写入完成的 Promise。
 */
async function seed(items, theme) {
  await control.evaluate(
    async ({ rows, appearance }) => {
      const db = await new Promise((resolveDb, reject) => {
        const request = indexedDB.open('dev-workbench');
        request.onsuccess = () => {
          resolveDb(request.result);
        };
        request.onerror = () => {
          reject(request.error);
        };
      });
      try {
        await new Promise((resolveTx, reject) => {
          const tx = db.transaction(['todos', 'settings'], 'readwrite');
          tx.oncomplete = resolveTx;
          tx.onerror = () => {
            reject(tx.error);
          };
          tx.onabort = () => {
            reject(tx.error);
          };
          for (const row of rows) {
            tx.objectStore('todos').put(row);
          }
          if (appearance) {
            const saved = tx.objectStore('settings').get('global');
            saved.onsuccess = () => {
              tx.objectStore('settings').put({ ...saved.result, theme: appearance }, 'global');
            };
          }
        });
      } finally {
        db.close();
      }
      const channel = new BroadcastChannel('dev-workbench:data-updated');
      channel.postMessage('changed');
      channel.close();
    },
    { rows: items, appearance: theme },
  );
}
/**
 * 切换页面视图并等待 Vue 更新按钮状态。
 * @param label - 今日、全部或已完成。
 * @returns 视图切换完成的 Promise。
 */
async function selectView(label) {
  await page
    .locator('.view-tabs .el-button')
    .filter({ hasText: new RegExp(`^${label}`) })
    .click();
  await page.waitForFunction((text) => {
    return document.querySelector('.view-tabs .active')?.textContent.trim().startsWith(text);
  }, label);
}

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
    headless: true,
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'Asia/Shanghai',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--window-size=1440,1000',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  context.on('request', (request) => {
    if (/^https?:/.test(request.url())) {
      requests.push(request.url());
    }
  });
  context.on('page', (tab) => {
    tab.on('pageerror', (error) => {
      failures.push(error.message);
    });
  });
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  base = `chrome-extension://${worker.url().split('/')[2]}/`;
  control = await context.newPage();
  control.setDefaultTimeout(10000);
  await control.goto(`${base}index.html`);
  await control.locator('[data-editor="JSON 输入"]').waitFor();

  await step('真实工具栏弹窗、尺寸、固定底部和空状态', async () => {
    await openPopup();
    await screenshotPopup('todo-popup-empty.png');
    dimensions = await control.evaluate(() => {
      const view = chrome.extension.getViews({ type: 'popup' })[0];
      const shell = view.document.querySelector('.todo-shell').getBoundingClientRect();
      const footer = view.document.querySelector('.popup-footer').getBoundingClientRect();
      return {
        width: view.innerWidth,
        height: view.innerHeight,
        shellWidth: shell.width,
        shellHeight: shell.height,
        footerBottom: footer.bottom,
        content: view.document.body.innerText,
      };
    });
    assert.equal(dimensions.width, 440);
    assert.equal(dimensions.shellWidth, 440);
    assert(dimensions.shellHeight <= 580 && dimensions.shellHeight >= 480);
    assert(dimensions.footerBottom <= dimensions.height, '工作台入口不应被裁切');
    assert(dimensions.content.includes('今天，先做一件重要的事'));
  });

  await step('实际弹窗新增、关闭重开、完成与恢复', async () => {
    await popupClick('.add-todo');
    await control.waitForFunction(() => {
      return chrome.extension
        .getViews({ type: 'popup' })[0]
        ?.document.querySelector('[aria-label="待办名称"]');
    });
    await control.evaluate(() => {
      const view = chrome.extension.getViews({ type: 'popup' })[0];
      const input = view.document.querySelector('[aria-label="待办名称"]');
      input.value = '从工具栏记录第一条待办';
      input.dispatchEvent(new view.Event('input', { bubbles: true }));
      input.dispatchEvent(
        new view.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    await control.waitForFunction(() => {
      return (
        chrome.extension.getViews({ type: 'popup' })[0]?.document.querySelector('.todo-title')
          ?.textContent === '从工具栏记录第一条待办'
      );
    });
    await control.evaluate(() => {
      chrome.extension.getViews({ type: 'popup' })[0].close();
    });
    await openPopup();
    await popupClick('.todo-check input');
    await control.waitForFunction(() => {
      return chrome.extension
        .getViews({ type: 'popup' })[0]
        ?.document.querySelector('.todo-row.is-complete');
    });
    await popupClick('.todo-row.is-complete .todo-check input');
    await control.waitForFunction(() => {
      return chrome.extension
        .getViews({ type: 'popup' })[0]
        ?.document.querySelector('.todo-row:not(.is-complete)');
    });
  });

  await step('工作台入口直接新建标签页并关闭弹窗，已有工作台保留', async () => {
    const created = context.waitForEvent('page');
    await popupClick('.workbench-link');
    const opened = await created;
    await opened.waitForURL(`${base}index.html*`);
    await opened.locator('[data-tool="http"]').waitFor();
    assert.equal(await opened.locator('[data-tool]').count(), 17);
    assert.equal(
      context.pages().filter((tab) => {
        return tab.url().startsWith(`${base}index.html`);
      }).length,
      2,
    );
    await control.waitForFunction(() => {
      return chrome.extension.getViews({ type: 'popup' }).length === 0;
    });
    await opened.close();
  });

  fixtures = await control.evaluate(() => {
    const now = new Date();
    const date = (offset) => {
      const value = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    };
    return {
      today: date(0),
      tomorrow: date(1),
      yesterday: date(-1),
      rows: [
        {
          title: '确认登录接口的异常处理',
          dueDate: date(-1),
          priority: 1,
          notes: '核对 401 与超时场景',
        },
        { title: '完成 HTTP 接口联调', dueDate: date(0), priority: 1 },
        {
          title: '整理本周发布说明',
          dueDate: date(0),
          priority: 2,
          notes: '补充 form-data、自动清理和今日待办',
        },
        { title: '检查生产构建与插件包', dueDate: date(0) },
        { title: '梳理今天的工作安排', dueDate: date(0), completedAt: now.getTime() },
        { title: '安排下一次迭代评审', dueDate: date(1) },
        { title: '整理常用开发资源', dueDate: null },
      ].map((row) => {
        return {
          id: crypto.randomUUID(),
          createdAt: now.getTime(),
          updatedAt: now.getTime(),
          completedAt: null,
          priority: 3,
          notes: '',
          ...row,
        };
      }),
    };
  });
  await seed(fixtures.rows);

  await step('实际弹窗日期分组、任务滚动与编辑面板', async () => {
    await openPopup();
    await control.waitForFunction(() => {
      return chrome.extension
        .getViews({ type: 'popup' })[0]
        ?.document.querySelector('[aria-label="过期"]');
    });
    await screenshotPopup('todo-popup.png');
    await popupClick('.add-todo');
    const fit = await control.evaluate(() => {
      const view = chrome.extension.getViews({ type: 'popup' })[0];
      return {
        width: view.document.documentElement.scrollWidth,
        viewport: view.innerWidth,
        footer: view.document.querySelector('.popup-footer').getBoundingClientRect().bottom,
        height: view.innerHeight,
      };
    });
    assert(fit.width <= fit.viewport);
    assert(fit.footer <= fit.height);
    await screenshotPopup('todo-popup-editor.png');
    await popupClick('.el-date-editor input');
    await control.waitForFunction(() => {
      const view = chrome.extension.getViews({ type: 'popup' })[0];
      return view?.document.querySelector('.todo-date-picker')?.getBoundingClientRect().height > 0;
    });
    await screenshotPopup('todo-popup-calendar.png');
    const calendar = await control.evaluate(() => {
      const view = chrome.extension.getViews({ type: 'popup' })[0];
      const box = view.document.querySelector('.todo-date-picker').getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: view.innerWidth,
        height: view.innerHeight,
      };
    });
    assert(calendar.right > calendar.left && calendar.bottom > calendar.top, '日历应实际可见');
    assert(calendar.left >= 0 && calendar.right <= calendar.width);
    assert(calendar.top >= 0 && calendar.bottom <= calendar.height);
    dimensions.calendar = calendar;
    await control.evaluate(() => {
      chrome.extension.getViews({ type: 'popup' })[0].close();
    });
  });

  page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.setViewportSize({ width: 440, height: 580 });
  await page.goto(`${base}popup.html`);
  await page.getByText('确认登录接口的异常处理', { exact: true }).waitFor();

  await step('今日、全部、已完成筛选；编辑备注、优先级与日历日期', async () => {
    assert.equal(await page.getByText('安排下一次迭代评审', { exact: true }).count(), 0);
    await selectView('全部');
    await page.getByText('安排下一次迭代评审', { exact: true }).waitFor();
    await page.getByRole('button', { name: '编辑：完成 HTTP 接口联调', exact: true }).click();
    await page
      .getByRole('textbox', { name: '待办名称', exact: true })
      .fill('核对 [API] <img src=x>');
    await page
      .getByRole('textbox', { name: '待办备注', exact: true })
      .fill('第一行备注\n第二行备注');
    await page.locator('.editor-options .el-select__wrapper').click();
    await page.getByRole('option', { name: '中优先级', exact: true }).click();
    await page.locator('.el-date-editor').click();
    await page.locator('.el-date-table').waitFor();
    const day = Number(fixtures.tomorrow.slice(-2));
    if (day === 1) {
      await page.locator('.todo-date-picker .el-date-picker__next-btn button').last().click();
    }
    await page
      .locator('.el-date-table td:not(.prev-month):not(.next-month)')
      .filter({ hasText: new RegExp(`^${day}$`) })
      .click();
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.getByText('核对 [API] <img src=x>', { exact: true }).waitFor();
    assert.equal(await page.locator('.todo-content img').count(), 0);
    await page.reload();
    await selectView('全部');
    const edited = page.locator('.todo-row').filter({ hasText: '核对 [API] <img src=x>' });
    await edited.waitFor();
    assert((await edited.innerText()).includes(fixtures.tomorrow));
    assert((await edited.innerText()).includes('中优先级'));
    assert((await edited.innerText()).includes('第二行备注'));
    await selectView('已完成');
    await page.getByText('梳理今天的工作安排', { exact: true }).waitFor();
    assert.equal(await page.locator('.todo-row:not(.is-complete)').count(), 0);
  });

  await step('中文输入法回车不会误提交，普通回车保存；删除取消与确认', async () => {
    await page.getByRole('button', { name: /添加待办/ }).click();
    const input = page.getByRole('textbox', { name: '待办名称', exact: true });
    await input.fill('测试中文输入');
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    assert.equal(await page.locator('.todo-editor').count(), 1);
    await input.press('Enter');
    await page.getByText('测试中文输入', { exact: true }).waitFor();
    await page.getByRole('button', { name: '删除：测试中文输入', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.getByText('测试中文输入', { exact: true }).count(), 1);
    await page.getByRole('button', { name: '删除：测试中文输入', exact: true }).click();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByText('测试中文输入', { exact: true }).waitFor({ state: 'detached' });
  });

  await step('当前视图与全部任务的真实 Markdown 下载', async () => {
    await selectView('今日');
    for (const scope of ['当前视图', '全部待办']) {
      await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
      const pending = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: `导出${scope}`, exact: true }).click();
      const download = await pending;
      assert(download.suggestedFilename().endsWith('.md'));
      const filename = join(artifacts, scope === '当前视图' ? 'todos-today.md' : 'todos-all.md');
      await download.saveAs(filename);
      const markdown = await readFile(filename, 'utf8');
      assert(markdown.includes('- [x] 梳理今天的工作安排'));
      if (scope === '当前视图') {
        assert(!markdown.includes('安排下一次迭代评审'));
      } else {
        assert(markdown.includes('安排下一次迭代评审'));
        assert(markdown.includes('核对 \\[API\\] &lt;img src=x&gt;'));
        assert(markdown.includes('第二行备注'));
      }
    }
  });

  await step('工作台 v3 备份、清除、恢复及跨页面同步', async () => {
    await control.goto(`${base}index.html#settings`);
    await control.getByRole('button', { name: '导出本地备份', exact: true }).waitFor();
    const pending = control.waitForEvent('download');
    await control.getByRole('button', { name: '导出本地备份', exact: true }).click();
    const download = await pending;
    const backupFile = join(artifacts, 'todo-backup.json');
    await download.saveAs(backupFile);
    const backup = JSON.parse(await readFile(backupFile, 'utf8'));
    assert.equal(backup.version, 3);
    assert.equal(backup.todos.length, 8);
    await control.getByRole('button', { name: '清除全部数据', exact: true }).click();
    await control.getByRole('button', { name: '确认删除', exact: true }).click();
    await page.locator('.todo-empty').waitFor();
    await control.locator('input[type="file"]').setInputFiles(backupFile);
    await control.getByRole('button', { name: '确认替换', exact: true }).click();
    await page.getByText('确认登录接口的异常处理', { exact: true }).waitFor();
    await control
      .locator('.settings-section')
      .last()
      .getByText(/8 条待办/)
      .waitFor();
    await control.getByRole('button', { name: '按已保存规则清理', exact: true }).click();
    await page.reload();
    await page.getByText('确认登录接口的异常处理', { exact: true }).waitFor();
  });

  await step('深色主题、长文字、窄屏与离线重新打开', async () => {
    const long = {
      ...fixtures.rows[0],
      id: crypto.randomUUID(),
      title: '长任务名称验证'.repeat(18),
      notes: '多行备注\n'.repeat(30),
      dueDate: fixtures.today,
    };
    await seed([long], 'dark');
    await page.waitForFunction(() => {
      return document.documentElement.classList.contains('dark');
    });
    await page.screenshot({ path: join(artifacts, 'todo-dark.png') });
    await page.setViewportSize({ width: 390, height: 580 });
    assert(
      await page.evaluate(() => {
        return (
          document.documentElement.scrollWidth <= innerWidth &&
          document.querySelector('.popup-footer').getBoundingClientRect().bottom <= innerHeight
        );
      }),
    );
    await page.screenshot({ path: join(artifacts, 'todo-mobile.png') });
    await context.setOffline(true);
    await page.reload();
    await page.getByText(long.title, { exact: true }).waitFor();
    await context.setOffline(false);
    await seed([], 'light');
    await page.setViewportSize({ width: 440, height: 580 });
  });

  await step('跨午夜自动更新日期，未来任务进入今日且过期任务保留', async () => {
    await page.clock.install({ time: new Date(`${fixtures.today}T23:59:55+08:00`) });
    await page.reload();
    await page.getByText('确认登录接口的异常处理', { exact: true }).waitFor();
    await page.clock.runFor(16000);
    await page.getByText('安排下一次迭代评审', { exact: true }).waitFor();
    assert.equal(await page.getByText('确认登录接口的异常处理', { exact: true }).count(), 1);
    await page.clock.setSystemTime(new Date());
  });

  await step('损坏数据提供重试反馈，工作台入口仍然可用', async () => {
    const original = fixtures.rows[0];
    await seed([{ ...original, title: '' }]);
    await page.reload();
    await page.getByRole('alert').waitFor();
    assert(await page.getByRole('button', { name: '打开开发工作台', exact: true }).isEnabled());
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await seed([original]);
    await page.getByText(original.title, { exact: true }).waitFor();
  });
  assert.deepEqual(failures, [], '不应发生未处理页面错误');
  assert.deepEqual(requests, [], '待办应完全离线，不请求第三方资源');
  console.log(`通过 ${completed.length} 项待办弹窗验收。`);
} catch (error) {
  failures.push(error.stack || String(error));
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(artifacts, 'todo-failure.png') }).catch(() => {});
  }
  process.exitCode = 1;
  console.error(error);
} finally {
  await writeFile(
    join(artifacts, 'todo-popup-report.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        completed,
        failures,
        unexpectedRequests: requests,
        popup: dimensions,
      },
      null,
      2,
    ),
  );
  if (context) {
    await context.close();
  }
  await rm(profile, { recursive: true, force: true });
}
