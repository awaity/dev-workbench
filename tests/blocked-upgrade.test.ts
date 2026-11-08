import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { openDB } from 'idb';
import { database } from '../src/lib/storage';

it('旧页面阻止升级时反馈错误，关闭旧页后可重试且保留数据', async () => {
  const legacy = await openDB('dev-workbench', 1, {
    upgrade(db) {
      db.createObjectStore('settings');
    },
  });
  await legacy.put('settings', { theme: 'dark' }, 'global');
  try {
    await expect(database()).rejects.toThrow('关闭其他工作台标签页');
    expect(await legacy.get('settings', 'global')).toEqual({ theme: 'dark' });
  } finally {
    legacy.close();
  }
  const reopened = await database();
  expect(reopened.version).toBe(3);
  expect(await reopened.get('settings', 'global')).toEqual({ theme: 'dark' });
});
