import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAll,
  database,
  putAttachment,
  saveRequest,
  readRequests,
  removeRequest,
  writeDraft,
  readDraft,
  exportBackup,
  importBackup,
  loadRequestFiles,
  cleanAttachments,
} from '../src/lib/storage';
import { defaultSettings, httpSchema } from '../src/lib/models';

describe('附件、集合与 v3 备份', () => {
  beforeEach(async () => {
    await clearAll();
  });
  it('文件存储后通过草稿和请求集合恢复，二进制字节保持一致', async () => {
    const file = new File([new Uint8Array([0, 255, 128, 13, 10])], 'data.bin', {
      type: 'application/octet-stream',
    });
    const ref = await putAttachment(file);
    const state = httpSchema.parse({
      name: '上传',
      folder: '测试',
      url: 'https://example.com',
      method: 'POST',
      bodyType: 'binary',
      binary: ref,
    });
    await writeDraft('http', state);
    await saveRequest(state);
    const backup = JSON.parse(JSON.stringify(await exportBackup()));
    expect(backup.version).toBe(3);
    expect(backup.attachments).toHaveLength(1);
    await clearAll();
    await importBackup(backup);
    const restored = httpSchema.parse((await readDraft('http'))!.state);
    const files = await loadRequestFiles(restored);
    expect(new Uint8Array(await files.get(ref.id)!.arrayBuffer())).toEqual(
      new Uint8Array(await file.arrayBuffer()),
    );
    expect((await readRequests())[0]!.state.binary!.id).toBe(ref.id);
  });
  it('引用、重复 ID 或字节数损坏时拒绝导入，旧数据完整保留', async () => {
    const ref = await putAttachment(new File(['keep'], 'file.txt'));
    await saveRequest(httpSchema.parse({ name: '保留的请求', binary: ref }));
    const backup = await exportBackup();
    for (const broken of [
      { ...backup, attachments: [] },
      { ...backup, requests: [...backup.requests, ...backup.requests] },
      {
        ...backup,
        attachments: backup.attachments.map((row) => {
          return { ...row, data: 'YQ==' };
        }),
      },
    ]) {
      await expect(importBackup(broken)).rejects.toThrow();
      expect((await readRequests())[0]!.name).toBe('保留的请求');
      expect(await (await database()).count('attachments')).toBe(1);
    }
  });
  it('清理保留停用字段、非当前请求体、集合引用和刚上传的文件', async () => {
    const a = await putAttachment(new File(['a'], 'a.txt'));
    const b = await putAttachment(new File(['b'], 'b.txt'));
    const fresh = await putAttachment(new File(['c'], 'c.txt'));
    const db = await database();
    for (const id of [a.id, b.id]) {
      const row = (await db.get('attachments', id))!;
      await db.put('attachments', { ...row, createdAt: Date.now() - 120000 });
    }
    const saved = await saveRequest(
      httpSchema.parse({
        name: '附件引用',
        bodyType: 'none',
        multipart: [{ name: 'a', value: '', enabled: false, kind: 'file', files: [a] }],
      }),
    );
    expect(await cleanAttachments()).toEqual({ count: 1, bytes: 1 });
    expect(await db.get('attachments', a.id)).toBeDefined();
    expect(await db.get('attachments', fresh.id)).toBeDefined();
    await removeRequest(saved.id);
    expect((await cleanAttachments()).count).toBe(1);
  });
  it('覆盖集合不新增记录；保存集合清除旧响应', async () => {
    const state = httpSchema.parse({ name: 'first' });
    const first = await saveRequest(state);
    await saveRequest({ ...state, name: 'updated' }, first.id);
    expect(await readRequests()).toHaveLength(1);
    expect((await readRequests())[0]!.name).toBe('updated');
    expect((await readRequests())[0]!.state.response).toBeNull();
  });
  it('旧版备份补齐新字段且仍可发送原请求', async () => {
    await importBackup({
      app: 'dev-workbench',
      version: 1,
      settings: defaultSettings,
      drafts: [
        {
          tool: 'http',
          updatedAt: 1,
          state: {
            url: 'https://example.com',
            method: 'POST',
            bodyType: 'form',
            fields: [{ name: 'a', value: 'b', enabled: true }],
          },
        },
      ],
      history: [],
    });
    const state = httpSchema.parse((await readDraft('http'))!.state);
    expect(state.fields[0]!.description).toBe('');
    expect(state.multipart).toEqual([]);
    expect(state.followRedirects).toBe(true);
  });
});
