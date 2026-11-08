import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { openDB } from 'idb';
import { database, readDraft, readSettings } from '../src/lib/storage';

it('IndexedDB v1 升级 v3 保留既有设置、草稿和历史', async () => {
  const legacy = await openDB('dev-workbench', 1, {
    upgrade(db) {
      db.createObjectStore('settings');
      db.createObjectStore('drafts', { keyPath: 'tool' });
      const history = db.createObjectStore('history', { keyPath: 'id' });
      history.createIndex('createdAt', 'createdAt');
      history.createIndex('tool', 'tool');
    },
  });
  await legacy.put('settings', { theme: 'dark' }, 'global');
  await legacy.put('drafts', { tool: 'http', updatedAt: 1, state: { url: 'https://example.com' } });
  legacy.close();
  const upgraded = await database();
  expect(upgraded.version).toBe(3);
  expect([...upgraded.objectStoreNames]).toEqual([
    'attachments',
    'drafts',
    'history',
    'requests',
    'settings',
    'todos',
  ]);
  expect((await readSettings()).theme).toBe('dark');
  expect((await readDraft('http'))!.state.url).toBe('https://example.com');
});
