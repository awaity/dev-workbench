import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const extensionPath = resolve(process.env.EXTENSION_PATH || join(root, 'dist'));
const artifacts = join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'workbench-retention-'));
const alarmName = 'dev-workbench:auto-cleanup';
const completed = [];
const errors = [];
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
  viewport: { width: 1440, height: 1100 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
/**
 * 轮询异步数据库状态，避免依赖固定休眠或 Playwright 的同步条件求值。
 * @param check - 返回是否已满足条件的异步检查函数。
 * @returns 条件满足时完成，超时会抛出错误。
 */
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolvePoll) => {
      setTimeout(resolvePoll, 50);
    });
  }
  throw new Error('等待自动清理状态超时');
}
/**
 * 从扩展后台读取全部数据仓库的键，验证工作台关闭时也能清理。
 * @param worker - 实际扩展的 Service Worker。
 * @returns 按仓库名排列的主键列表。
 */
async function keys(worker) {
  return worker.evaluate(async () => {
    const db = await new Promise((resolveOpen, reject) => {
      const request = indexedDB.open('dev-workbench');
      request.onsuccess = () => {
        resolveOpen(request.result);
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
    const result = {};
    for (const store of ['history', 'drafts', 'requests', 'attachments']) {
      result[store] = await new Promise((resolveKeys, reject) => {
        const request = db.transaction(store).objectStore(store).getAllKeys();
        request.onsuccess = () => {
          resolveKeys(request.result);
        };
        request.onerror = () => {
          reject(request.error);
        };
      });
    }
    db.close();
    return result;
  });
}
/**
 * 注入一条指定年龄的历史，时间由浏览器当前时钟计算。
 * @param worker - 实际扩展的 Service Worker。
 * @param id - 测试记录的稳定标识。
 * @param days - 记录距今的天数。
 * @returns 写入事务完成的 Promise。
 */
async function seedHistory(worker, id, days) {
  await worker.evaluate(
    async ({ id, days }) => {
      const db = await new Promise((resolveOpen) => {
        const request = indexedDB.open('dev-workbench');
        request.onsuccess = () => {
          resolveOpen(request.result);
        };
      });
      const tx = db.transaction('history', 'readwrite');
      tx.objectStore('history').put({
        id,
        tool: 'json',
        title: id,
        detail: '',
        state: { input: '{}' },
        createdAt: Date.now() - days * 86400000,
      });
      await new Promise((resolveDone, reject) => {
        tx.oncomplete = resolveDone;
        tx.onerror = () => {
          reject(tx.error);
        };
      });
      db.close();
    },
    { id, days },
  );
}
try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const url = `chrome-extension://${worker.url().split('/')[2]}/index.html#settings`;
  let page = await context.newPage();
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  await page.goto(url);
  await page.locator('.el-switch').waitFor();
  assert(await page.getByRole('switch', { name: '自动清理过期数据', exact: true }).isChecked());
  assert.equal(await page.getByLabel('数据保留天数', { exact: true }).inputValue(), '30');
  await until(async () => {
    return (
      (
        await worker.evaluate((name) => {
          return chrome.alarms.get(name);
        }, alarmName)
      )?.periodInMinutes === 1440
    );
  });
  completed.push('默认开启、保留 30 天、后台每日任务已注册');

  await page.getByLabel('数据保留天数', { exact: true }).fill('7');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('全局设置已保存', { exact: true }).waitFor();
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'dev-workbench:cleanup-settings-changed' });
  });
  const ids = await worker.evaluate(async () => {
    const now = Date.now();
    const day = 86400000;
    const db = await new Promise((resolveOpen) => {
      const request = indexedDB.open('dev-workbench');
      request.onsuccess = () => {
        resolveOpen(request.result);
      };
    });
    const tx = db.transaction(['history', 'drafts', 'requests', 'attachments'], 'readwrite');
    const refs = {};
    for (const name of ['expired', 'orphan', 'fresh', 'draft', 'collection', 'recent']) {
      const reference = {
        id: crypto.randomUUID(),
        name: `${name}.bin`,
        type: 'application/octet-stream',
        size: 4,
        lastModified: now,
      };
      refs[name] = reference;
      tx.objectStore('attachments').put({
        ...reference,
        blob: new Blob(['data']),
        createdAt: now - (name === 'fresh' ? 1 : 20) * day,
      });
    }
    for (const [id, days, ref] of [
      ['expired', 8, refs.expired],
      ['recent', 6, refs.recent],
    ]) {
      tx.objectStore('history').put({
        id,
        tool: 'http',
        title: id,
        detail: '',
        createdAt: now - days * day,
        state: { binary: ref },
      });
    }
    tx.objectStore('drafts').put({
      tool: 'http',
      updatedAt: now - 100 * day,
      state: { binary: refs.draft },
    });
    const requestId = crypto.randomUUID();
    tx.objectStore('requests').put({
      id: requestId,
      name: '长期保存',
      folder: '本地测试',
      updatedAt: now - 100 * day,
      state: { binary: refs.collection },
    });
    await new Promise((resolveDone, reject) => {
      tx.oncomplete = resolveDone;
      tx.onerror = () => {
        reject(tx.error);
      };
    });
    db.close();
    return {
      ...Object.fromEntries(
        Object.entries(refs).map(([name, ref]) => {
          return [name, ref.id];
        }),
      ),
      requestId,
    };
  });
  await page.getByRole('button', { name: '按已保存规则清理', exact: true }).click();
  await until(async () => {
    return !(await keys(worker)).history.includes('expired');
  });
  const result = await keys(worker);
  assert.deepEqual(result.history, ['recent']);
  assert(result.drafts.includes('http'));
  assert(result.requests.includes(ids.requestId));
  assert.deepEqual(
    result.attachments.sort(),
    [ids.fresh, ids.draft, ids.collection, ids.recent].sort(),
  );
  completed.push('自定义 7 天生效，清理过期历史与孤立附件，保留草稿、集合及近期引用');

  await page.locator('.el-switch').click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await until(async () => {
    return !(await worker.evaluate((name) => {
      return chrome.alarms.get(name);
    }, alarmName));
  });
  await seedHistory(worker, 'disabled-old', 100);
  await page.reload();
  await page.locator('.el-switch').waitFor();
  assert(!(await page.getByRole('switch', { name: '自动清理过期数据', exact: true }).isChecked()));
  assert.equal(await page.getByLabel('数据保留天数', { exact: true }).inputValue(), '7');
  assert(await page.getByLabel('数据保留天数', { exact: true }).isDisabled());
  assert((await keys(worker)).history.includes('disabled-old'));
  completed.push('关闭后取消后台任务，重载保留关闭状态、天数和过期记录');

  await page.locator('.el-switch').click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await until(async () => {
    return !(await keys(worker)).history.includes('disabled-old');
  });
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'dev-workbench:cleanup-settings-changed' });
  });
  completed.push('重新开启并保存时立即应用清理规则');
  await seedHistory(worker, 'background-expired', 8);
  await page.close();
  assert.equal(
    context.pages().filter((tab) => {
      return tab.url().startsWith('chrome-extension://');
    }).length,
    0,
  );
  await worker.evaluate((name) => {
    return new Promise((resolveAlarm) => {
      const listener = (alarm) => {
        if (alarm.name === name) {
          chrome.alarms.onAlarm.removeListener(listener);
          resolveAlarm(true);
        }
      };
      chrome.alarms.onAlarm.addListener(listener);
      void chrome.alarms.create(name, { when: Date.now() + 200 });
    });
  }, alarmName);
  await until(async () => {
    return !(await keys(worker)).history.includes('background-expired');
  });
  assert((await keys(worker)).history.includes('recent'));
  completed.push('工作台全部关闭后，实际 chrome.alarms 事件触发后台清理');

  page = await context.newPage();
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  await page.goto(url);
  await page.locator('.el-switch').waitFor();
  assert.equal(await page.getByLabel('数据保留天数', { exact: true }).inputValue(), '7');
  await page
    .locator('.settings-section')
    .filter({ has: page.getByRole('heading', { name: '数据管理', exact: true }) })
    .screenshot({ path: join(artifacts, 'auto-cleanup-settings.png') });
  await worker.evaluate(async () => {
    const db = await new Promise((resolveOpen) => {
      const request = indexedDB.open('dev-workbench');
      request.onsuccess = () => {
        resolveOpen(request.result);
      };
    });
    const tx = db.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').put({
      tool: 'http',
      state: { binary: { id: 'invalid' } },
      updatedAt: Date.now(),
    });
    await new Promise((resolveDone) => {
      tx.oncomplete = resolveDone;
    });
    db.close();
  });
  await seedHistory(worker, 'rollback-old', 100);
  await page.reload();
  await page.locator('.el-switch').waitFor();
  assert.equal(await page.locator('.startup-error[role="alert"]').count(), 0);
  assert((await keys(worker)).history.includes('rollback-old'));
  await page.locator('.el-message--error').first().waitFor();
  completed.push('清理校验失败时整体回滚并提示，工作台仍可打开管理数据');
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifacts, 'auto-cleanup-report.json'),
    JSON.stringify({ date: new Date().toISOString(), extensionPath, completed, errors }, null, 2),
  );
  console.log(`自动清理：${completed.length} 项真实扩展场景通过。`);
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
