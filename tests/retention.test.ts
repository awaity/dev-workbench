import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAll,
  database,
  exportBackup,
  importBackup,
  putAttachment,
  readHistory,
  readSettings,
  runAutoCleanup,
  saveRequest,
  writeDraft,
  writeSettings,
} from '../src/lib/storage';
import { defaultSettings, httpSchema, settingsSchema, type HttpState } from '../src/lib/models';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 6, 12);
async function history(id: string, createdAt: number, state: Partial<HttpState> = {}) {
  await (
    await database()
  ).put('history', {
    id,
    tool: 'http',
    title: id,
    detail: '',
    createdAt,
    state: httpSchema.parse(state),
  });
}
async function file(name: string, ageDays: number) {
  const reference = await putAttachment(new File(['data'], name));
  const db = await database();
  const stored = (await db.get('attachments', reference.id))!;
  await db.put('attachments', { ...stored, createdAt: NOW - ageDays * DAY });
  return reference;
}

describe('自动清理与保留期限', () => {
  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    await clearAll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('新设置和旧设置默认开启，保留 30 天；校验天数边界', async () => {
    expect(await readSettings()).toMatchObject({ autoCleanup: true, retentionDays: 30 });
    await (await database()).put('settings', { theme: 'dark' } as typeof defaultSettings, 'global');
    expect(await readSettings()).toMatchObject({
      theme: 'dark',
      autoCleanup: true,
      retentionDays: 30,
    });
    for (const retentionDays of [0, -1, 1.5, 3651, NaN]) {
      expect(settingsSchema.safeParse({ retentionDays }).success).toBe(false);
    }
    expect(settingsSchema.parse({ retentionDays: 1 }).retentionDays).toBe(1);
    expect(settingsSchema.parse({ retentionDays: 3650 }).retentionDays).toBe(3650);
  });

  it('严格删除超过 30 天的记录，保留恰好处在边界及未来时间的记录', async () => {
    await history('expired', NOW - 30 * DAY - 1);
    await history('boundary', NOW - 30 * DAY);
    await history('recent', NOW - DAY);
    await history('future', NOW + DAY);
    expect(await runAutoCleanup()).toEqual({ history: 1, attachments: 0, bytes: 0 });
    expect(
      (await readHistory()).map((row) => {
        return row.id;
      }),
    ).toEqual(['future', 'recent', 'boundary']);
    expect(await runAutoCleanup()).toEqual({ history: 0, attachments: 0, bytes: 0 });
  });

  it('关闭自动清理后，过期历史和孤立附件都保留', async () => {
    await writeSettings({ ...defaultSettings, autoCleanup: false });
    await history('old', NOW - 100 * DAY);
    const orphan = await file('old.bin', 100);
    expect(await runAutoCleanup()).toEqual({ history: 0, attachments: 0, bytes: 0 });
    expect(await readHistory()).toHaveLength(1);
    expect(await (await database()).get('attachments', orphan.id)).toBeDefined();
  });

  it('保存设置立即应用新期限，且仍执行历史总数上限', async () => {
    await writeSettings({ ...defaultSettings, autoCleanup: false });
    await history('10-days', NOW - 10 * DAY);
    for (let index = 0; index < 12; index++) {
      await history(`recent-${index}`, NOW - index);
    }
    await writeSettings({ ...defaultSettings, retentionDays: 7, historyLimit: 10 });
    expect(await readHistory()).toHaveLength(10);
    expect(
      (await readHistory()).some((row) => {
        return row.id === '10-days';
      }),
    ).toBe(false);
    expect(await readSettings()).toMatchObject({
      autoCleanup: true,
      retentionDays: 7,
      historyLimit: 10,
    });
  });

  it('保留草稿、集合、停用字段及新历史引用，清理过期历史释放的旧附件', async () => {
    const draftFile = await file('draft.bin', 100);
    const collectionFile = await file('collection.bin', 100);
    const recentFile = await file('history.bin', 100);
    const expiredFile = await file('expired.bin', 100);
    const orphan = await file('orphan.bin', 31);
    const fresh = await file('fresh.bin', 1);
    const boundary = await file('boundary.bin', 30);
    await writeDraft(
      'http',
      httpSchema.parse({
        bodyType: 'none',
        multipart: [
          { name: 'disabled', value: '', enabled: false, kind: 'file', files: [draftFile] },
        ],
      }),
    );
    const request = await saveRequest(
      httpSchema.parse({ name: '长期保存', bodyType: 'none', binary: collectionFile }),
    );
    await history('recent', NOW - DAY, { binary: recentFile });
    await history('expired', NOW - 31 * DAY, { binary: expiredFile });
    const db = await database();
    const draft = (await db.get('drafts', 'http'))!;
    await db.put('drafts', { ...draft, updatedAt: NOW - 100 * DAY });
    await db.put('requests', { ...request, updatedAt: NOW - 100 * DAY });
    expect(await runAutoCleanup()).toEqual({ history: 1, attachments: 2, bytes: 8 });
    for (const ref of [draftFile, collectionFile, recentFile, fresh, boundary]) {
      expect(await db.get('attachments', ref.id)).toBeDefined();
    }
    for (const ref of [expiredFile, orphan]) {
      expect(await db.get('attachments', ref.id)).toBeUndefined();
    }
    expect(await db.count('drafts')).toBe(1);
    expect(await db.count('requests')).toBe(1);
  });

  it('旧版备份补齐 30 天规则，导入时清理过期历史并保留草稿', async () => {
    await importBackup({
      app: 'dev-workbench',
      version: 1,
      settings: { theme: 'dark' },
      drafts: [{ tool: 'json', state: { input: '{"keep":true}' }, updatedAt: NOW - 100 * DAY }],
      history: [
        {
          id: 'old',
          tool: 'json',
          title: 'old',
          detail: '',
          state: { input: '{}' },
          createdAt: NOW - 31 * DAY,
        },
      ],
    });
    expect(await readSettings()).toMatchObject({ autoCleanup: true, retentionDays: 30 });
    expect(await readHistory()).toHaveLength(0);
    expect(await (await database()).count('drafts')).toBe(1);
  });

  it('备份往返保留自定义期限和关闭状态，关闭时导入的旧历史不被清理', async () => {
    await writeSettings({ ...defaultSettings, autoCleanup: false, retentionDays: 90 });
    await history('old', NOW - 100 * DAY);
    const backup = await exportBackup();
    await clearAll();
    await importBackup(backup);
    expect(await readSettings()).toMatchObject({ autoCleanup: false, retentionDays: 90 });
    expect(await readHistory()).toHaveLength(1);
  });

  it('引用数据损坏时回滚设置、数量裁剪及清理，避免部分删除', async () => {
    const db = await database();
    for (let index = 0; index < 12; index++) {
      await history(`old-${index}`, NOW - 31 * DAY);
    }
    await db.put('drafts', { tool: 'http', state: { binary: { id: 'broken' } }, updatedAt: NOW });
    await expect(
      writeSettings({ ...defaultSettings, theme: 'dark', historyLimit: 10 }),
    ).rejects.toThrow();
    expect((await readSettings()).theme).toBe('light');
    expect(await db.count('history')).toBe(12);
    await expect(runAutoCleanup()).rejects.toThrow();
    expect(await db.count('history')).toBe(12);
  });
});
