import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { openDB } from 'idb';
import { database, readSettings } from '../src/lib/storage';
import { readTodos } from '../src/lib/todos';

it('IndexedDB v2 升级 v3 增加待办仓库，保留设置、集合与附件原始字节', async () => {
  const legacy = await openDB('dev-workbench', 2, {
    upgrade(db) {
      db.createObjectStore('settings');
      db.createObjectStore('drafts', { keyPath: 'tool' });
      const history = db.createObjectStore('history', { keyPath: 'id' });
      history.createIndex('createdAt', 'createdAt');
      history.createIndex('tool', 'tool');
      db.createObjectStore('requests', { keyPath: 'id' });
      db.createObjectStore('attachments', { keyPath: 'id' });
    },
  });
  const bytes = new Uint8Array([0, 255, 128]);
  await legacy.put('settings', { theme: 'dark', retentionDays: 7 }, 'global');
  await legacy.put('requests', { id: 'old-request', name: '原请求' });
  await legacy.put('attachments', { id: 'old-file', blob: new Blob([bytes]) });
  legacy.close();
  const upgraded = await database();
  expect(upgraded.version).toBe(3);
  expect((await readSettings()).retentionDays).toBe(7);
  expect((await upgraded.get('requests', 'old-request'))?.name).toBe('原请求');
  expect(
    new Uint8Array(await (await upgraded.get('attachments', 'old-file'))!.blob.arrayBuffer()),
  ).toEqual(bytes);
  expect(await readTodos()).toEqual([]);
});
