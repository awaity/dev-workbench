import { openDB, type DBSchema, type IDBPTransaction } from 'idb';
import { z } from 'zod';
import { fromBase64, toBase64 } from './encoding';
import { requestFileRefs, type RequestFiles } from './http';
import { todoSchema, type Todo } from './todo-model';
import { notifyDataChanged } from './changes';
import {
  attachmentRefSchema,
  defaultSettings,
  draftSchema,
  historySchema,
  httpSchema,
  parseState,
  savedRequestSchema,
  settingsSchema,
  type AttachmentRef,
  type HistoryItem,
  type HttpState,
  type SavedRequest,
  type Settings,
  type ToolId,
} from './models';

/** 单文件上限，与请求模型一致。 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** 包含 Base64 附件的 JSON 备份上限；导入与导出采用同一限制。 */
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;
/** 附件字节和稳定元信息，独立于草稿与历史存储。 */
interface StoredAttachment extends AttachmentRef {
  blob: Blob;
  createdAt: number;
}
/** IndexedDB v3 的仓库结构；升级时保留旧版本的全部工具数据。 */
interface WorkbenchDB extends DBSchema {
  settings: { key: string; value: Settings };
  drafts: { key: ToolId; value: z.infer<typeof draftSchema> };
  history: { key: string; value: HistoryItem; indexes: { createdAt: number; tool: ToolId } };
  attachments: { key: string; value: StoredAttachment };
  requests: { key: string; value: SavedRequest };
  todos: { key: string; value: Todo };
}
/** 清理事务同时锁定引用来源与附件，避免与保存操作交错而误删文件。 */
const dataStores = ['settings', 'drafts', 'history', 'requests', 'attachments', 'todos'] as const;
/** 覆盖全部本地用户数据的读写事务。 */
type DataTransaction = IDBPTransaction<WorkbenchDB, typeof dataStores, 'readwrite'>;
/** 自动清理的实际删除数量与附件释放字节数。 */
export interface CleanupResult {
  history: number;
  attachments: number;
  bytes: number;
}
/**
 * 根据已保存规则清理过期历史和过期孤立附件，保留草稿、集合及仍有效的引用。
 * @param tx - 覆盖全部数据仓库的活动读写事务。
 * @param policy - 已通过校验的清理设置。
 * @param now - 本次检查的毫秒级时间戳；边界时间内的记录继续保留。
 * @returns 本次事务中删除的记录数和附件字节数。
 */
async function pruneExpired(
  tx: DataTransaction,
  policy: Settings,
  now: number,
): Promise<CleanupResult> {
  const result: CleanupResult = { history: 0, attachments: 0, bytes: 0 };
  if (!policy.autoCleanup) {
    return result;
  }
  const cutoff = now - policy.retentionDays * 24 * 60 * 60 * 1000;
  const expired = await tx
    .objectStore('history')
    .index('createdAt')
    .getAllKeys(IDBKeyRange.upperBound(cutoff, true));
  for (const id of expired) {
    await tx.objectStore('history').delete(id);
    result.history++;
  }
  const used = new Set<string>();
  // 逐条读取引用，避免后台一次载入所有历史中的大响应内容。
  for (const name of ['drafts', 'history', 'requests'] as const) {
    let reference =
      name === 'history'
        ? await tx.objectStore('history').index('tool').openCursor('http')
        : await tx.objectStore(name).openCursor();
    while (reference) {
      const row = reference.value;
      if (!('tool' in row) || row.tool === 'http') {
        for (const file of allReferences(httpSchema.parse(row.state))) {
          used.add(file.id);
        }
      }
      reference = await reference.continue();
    }
  }
  let cursor = await tx.objectStore('attachments').openCursor();
  while (cursor) {
    const row = cursor.value;
    if (row.createdAt < cutoff && !used.has(row.id)) {
      await cursor.delete();
      result.attachments++;
      result.bytes += row.size;
    }
    cursor = await cursor.continue();
  }
  return result;
}
/**
 * 回滚业务校验失败的事务并消费结束事件，避免部分清理提交或未处理拒绝。
 * @param tx - 需要回滚的读写事务，可能已被 IndexedDB 自动中止。
 * @returns 事务结束后的 Promise。
 */
async function rollback(tx: DataTransaction): Promise<void> {
  try {
    tx.abort();
  } catch {
    /* 已结束的事务无需再次中止。 */
  }
  await tx.done.catch(() => {
    /* 原始业务错误由调用方重新抛出。 */
  });
}
/**
 * 原子执行已保存的自动清理规则；关闭开关时保持所有数据不变。
 * @param now - 当前毫秒级时间戳，测试可传入固定时间。
 * @returns 删除的历史、附件数量与附件字节数。
 * @throws {Error} 引用数据损坏或数据库失败时回滚整个清理事务。
 */
export async function runAutoCleanup(now = Date.now()): Promise<CleanupResult> {
  const tx = (await database()).transaction(dataStores, 'readwrite');
  try {
    const policy = settingsSchema.parse((await tx.objectStore('settings').get('global')) ?? {});
    const result = await pruneExpired(tx, policy, now);
    await tx.done;
    return result;
  } catch (error) {
    await rollback(tx);
    throw error;
  }
}
/**
 * 打开数据库并按仓库存在性执行无损升级。
 * @returns 可复用的 v3 数据库连接。
 */
function openDatabase() {
  let wasBlocked = false;
  let rejectUpgrade: (reason: Error) => void;
  const blocked = new Promise<never>((_resolve, reject) => {
    rejectUpgrade = reject;
  });
  const pending = openDB<WorkbenchDB>('dev-workbench', 3, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
      }
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'tool' });
      }
      if (!db.objectStoreNames.contains('history')) {
        const history = db.createObjectStore('history', { keyPath: 'id' });
        history.createIndex('createdAt', 'createdAt');
        history.createIndex('tool', 'tool');
      }
      if (!db.objectStoreNames.contains('attachments')) {
        db.createObjectStore('attachments', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('requests')) {
        db.createObjectStore('requests', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('todos')) {
        db.createObjectStore('todos', { keyPath: 'id' });
      }
    },
    blocking() {
      void pending.then((db) => {
        db.close();
      });
      connection = undefined;
    },
    blocked() {
      wasBlocked = true;
      rejectUpgrade(
        new Error(
          '旧版本工作台页面仍占用数据库，请关闭其他工作台标签页后重新加载。原有数据会保留。',
        ),
      );
    },
    terminated() {
      connection = undefined;
    },
  });
  void pending
    .then((db) => {
      if (wasBlocked) {
        db.close();
      }
    })
    .catch(() => {
      /* 打开失败由返回的 Promise 统一反馈。 */
    });
  return Promise.race([pending, blocked]);
}
let connection: ReturnType<typeof openDatabase> | undefined;
/**
 * 复用 IndexedDB 连接，打开失败后允许重新尝试；不回退到其他持久化存储。
 * @returns 数据库连接 Promise。
 */
export function database() {
  if (!connection) {
    const pending = openDatabase();
    connection = pending;
    void pending.catch(() => {
      if (connection === pending) {
        connection = undefined;
      }
    });
  }
  return connection;
}
/**
 * 获取设置，首次启动时采用默认值。
 * @returns 通过结构校验的全局设置。
 */
export async function readSettings(): Promise<Settings> {
  return settingsSchema.parse((await (await database()).get('settings', 'global')) ?? {});
}
/**
 * 保存设置，并在同一事务中应用草稿开关、历史数量上限与自动清理规则。
 * @param value - 待保存的全局设置。
 * @returns 数据写入完成的 Promise。
 */
export async function writeSettings(value: Settings) {
  const parsed = settingsSchema.parse(value);
  const tx = (await database()).transaction(dataStores, 'readwrite');
  try {
    await tx.objectStore('settings').put(parsed, 'global');
    if (!parsed.saveDrafts) {
      await tx.objectStore('drafts').clear();
    }
    const all = await tx.objectStore('history').index('createdAt').getAll();
    for (const row of all.slice(0, Math.max(0, all.length - parsed.historyLimit))) {
      await tx.objectStore('history').delete(row.id);
    }
    await pruneExpired(tx, parsed, Date.now());
    await tx.done;
    notifyDataChanged();
  } catch (error) {
    await rollback(tx);
    throw error;
  }
}
/**
 * 读取工具草稿。
 * @param tool - 工具标识。
 * @returns 草稿记录；尚未保存时为 undefined。
 */
export async function readDraft(tool: ToolId) {
  return (await database()).get('drafts', tool);
}
/**
 * 校验并保存工具草稿。
 * @param tool - 工具标识。
 * @param state - 已去除 Vue 代理的可序列化状态。
 * @returns 写入完成的 Promise。
 */
export async function writeDraft(tool: ToolId, state: Record<string, unknown>) {
  await (
    await database()
  ).put('drafts', { tool, state: parseState(tool, state), updatedAt: Date.now() });
}
/**
 * 新增历史并在同一事务中执行数量上限。
 * @param item - 不含 ID 与时间戳的历史记录。
 * @param limit - 最多保留的记录数。
 * @returns 已保存的完整记录。
 */
export async function addHistory(item: Omit<HistoryItem, 'id' | 'createdAt'>, limit: number) {
  const tx = (await database()).transaction('history', 'readwrite');
  const row = {
    ...item,
    state: parseState(item.tool, item.state),
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  await tx.store.put(row);
  const all = await tx.store.index('createdAt').getAll();
  for (const old of all.slice(0, Math.max(0, all.length - limit))) {
    await tx.store.delete(old.id);
  }
  await tx.done;
  return row;
}
/**
 * 按时间倒序读取历史。
 * @param tool - 可选工具过滤条件。
 * @returns 最新记录在前的历史列表。
 */
export async function readHistory(tool?: ToolId) {
  const db = await database();
  const rows = tool
    ? await db.getAllFromIndex('history', 'tool', tool)
    : await db.getAll('history');
  return rows.sort((a, b) => {
    return b.createdAt - a.createdAt;
  });
}
/**
 * 删除一条历史。
 * @param id - 历史记录 ID。
 * @returns 删除完成的 Promise。
 */
export async function removeHistory(id: string) {
  await (await database()).delete('history', id);
}
/**
 * 清空历史，保留其余仓库。
 * @returns 清除完成的 Promise。
 */
export async function clearHistory() {
  await (await database()).clear('history');
}
/**
 * 将用户选取的文件字节写入本地附件仓库。
 * @param file - 用户通过文件选择器提供的文件。
 * @returns 可安全写入 JSON 草稿的附件引用。
 * @throws {Error} 文件超过 20 MB 或元信息不合法时抛出。
 */
export async function putAttachment(file: File): Promise<AttachmentRef> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('单个文件不能超过 20 MB');
  }
  const reference = attachmentRefSchema.parse({
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  });
  await (
    await database()
  ).put('attachments', { ...reference, blob: file.slice(), createdAt: Date.now() });
  return reference;
}
/**
 * 读取当前请求实际使用的文件，保持二进制原样。
 * @param state - HTTP 请求状态。
 * @returns 以附件 ID 为键的 Blob 表。
 * @throws {Error} 附件丢失时提示重新选择。
 */
export async function loadRequestFiles(state: HttpState): Promise<RequestFiles> {
  const db = await database();
  const result: RequestFiles = new Map();
  for (const reference of requestFileRefs(state)) {
    const row = await db.get('attachments', reference.id);
    if (!row || row.blob.size !== reference.size) {
      throw new Error(`附件「${reference.name}」不可用，请重新选择文件`);
    }
    result.set(reference.id, row.blob);
  }
  return result;
}
/**
 * 收集配置的全部文件，包括停用字段与暂未使用的请求体类型。
 * @param state - HTTP 请求配置。
 * @returns 仍须保留的文件引用。
 */
function allReferences(state: HttpState): AttachmentRef[] {
  return [
    ...state.multipart.flatMap((row) => {
      return row.files;
    }),
    ...(state.binary ? [state.binary] : []),
  ];
}
/**
 * 保存或覆盖一个集合请求，清除响应以避免集合体积增长。
 * @param state - 已命名并分组的请求配置。
 * @param id - 覆盖时提供原记录 ID；省略时创建新记录。
 * @returns 已保存的集合记录。
 */
export async function saveRequest(
  state: HttpState,
  id: string = crypto.randomUUID(),
): Promise<SavedRequest> {
  const row = savedRequestSchema.parse({
    id,
    name: state.name.trim(),
    folder: state.folder.trim() || '默认集合',
    state: { ...state, response: null },
    updatedAt: Date.now(),
  });
  row.state.name = row.name;
  row.state.folder = row.folder;
  await (await database()).put('requests', row);
  return row;
}
/**
 * 读取本地请求集合。
 * @returns 按最近更新时间倒序排列的请求。
 */
export async function readRequests(): Promise<SavedRequest[]> {
  return (await (await database()).getAll('requests'))
    .map((row) => {
      return savedRequestSchema.parse(row);
    })
    .sort((a, b) => {
      return b.updatedAt - a.updatedAt;
    });
}
/**
 * 删除集合中的请求，附件留待按引用清理。
 * @param id - 集合记录 ID。
 * @returns 删除完成的 Promise。
 */
export async function removeRequest(id: string) {
  await (await database()).delete('requests', id);
}
/**
 * 统计并清理没有被草稿、历史或集合引用的附件，新上传文件保留一分钟宽限。
 * @returns 已删除的文件数和释放字节数。
 */
export async function cleanAttachments() {
  const tx = (await database()).transaction(
    ['drafts', 'history', 'requests', 'attachments'],
    'readwrite',
  );
  const [drafts, history, requests, attachments] = await Promise.all([
    tx.objectStore('drafts').getAll(),
    tx.objectStore('history').getAll(),
    tx.objectStore('requests').getAll(),
    tx.objectStore('attachments').getAll(),
  ]);
  const used = new Set(
    collectReferences(drafts, history, requests).map((file) => {
      return file.id;
    }),
  );
  let count = 0;
  let bytes = 0;
  for (const row of attachments) {
    if (!used.has(row.id) && row.createdAt < Date.now() - 60000) {
      await tx.objectStore('attachments').delete(row.id);
      count++;
      bytes += row.size;
    }
  }
  await tx.done;
  return { count, bytes };
}
/**
 * 收集备份快照涉及的所有附件引用。
 * @param drafts - 草稿列表。
 * @param history - 历史列表。
 * @param requests - 集合列表。
 * @returns 允许重复的附件引用列表。
 */
function collectReferences(
  drafts: z.infer<typeof draftSchema>[],
  history: HistoryItem[],
  requests: SavedRequest[],
) {
  return [...drafts, ...history]
    .filter((row) => {
      return row.tool === 'http';
    })
    .flatMap((row) => {
      return allReferences(httpSchema.parse(row.state));
    })
    .concat(
      requests.flatMap((row) => {
        return allReferences(row.state);
      }),
    );
}
/**
 * 清除全部用户数据，恢复默认设置。
 * @returns 事务完成的 Promise。
 */
export async function clearAll() {
  const tx = (await database()).transaction(dataStores, 'readwrite');
  for (const name of tx.objectStoreNames) {
    await tx.objectStore(name).clear();
  }
  await tx.objectStore('settings').put(defaultSettings, 'global');
  await tx.done;
  notifyDataChanged();
}
/**
 * 导出包含待办、附件、集合及设置的一致性快照，排除无引用附件。
 * @returns v3 JSON 备份对象。
 * @throws {Error} 备份过大或存在缺失附件时抛出。
 */
export async function exportBackup() {
  const tx = (await database()).transaction(dataStores, 'readonly');
  const [settings, drafts, history, requests, files, todos] = await Promise.all([
    tx.objectStore('settings').get('global'),
    tx.objectStore('drafts').getAll(),
    tx.objectStore('history').getAll(),
    tx.objectStore('requests').getAll(),
    tx.objectStore('attachments').getAll(),
    tx.objectStore('todos').getAll(),
  ]);
  await tx.done;
  const refs = collectReferences(drafts, history, requests);
  const used = new Set(
    refs.map((file) => {
      return file.id;
    }),
  );
  const chosen = files.filter((file) => {
    return used.has(file.id);
  });
  if (chosen.length !== used.size) {
    throw new Error('有请求引用的附件缺失，请重新选择后再备份');
  }
  const attachments = [];
  for (const { blob, ...metadata } of chosen) {
    attachments.push({ ...metadata, data: toBase64(new Uint8Array(await blob.arrayBuffer())) });
  }
  const backup = {
    app: 'dev-workbench' as const,
    version: 3 as const,
    exportedAt: new Date().toISOString(),
    settings: settings ?? defaultSettings,
    drafts,
    history,
    requests,
    attachments,
    todos: todos.map((row) => {
      return todoSchema.parse(row);
    }),
  };
  if (new Blob([JSON.stringify(backup)]).size > MAX_BACKUP_BYTES) {
    throw new Error('备份超过 200 MB，请先减少历史或集合中的附件');
  }
  return backup;
}
/**
 * 校验并原子替换备份，兼容 v1 / v2 并保留它们未包含的待办；校验失败保留原数据库。
 * @param raw - JSON 解析后的未知输入。
 * @returns 导入后的全局设置。
 * @throws {Error} 结构、重复记录、附件字节数或引用校验失败时抛出。
 */
export async function importBackup(raw: unknown) {
  const backup = z
    .object({
      app: z.literal('dev-workbench'),
      version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      settings: settingsSchema,
      drafts: z.array(draftSchema).max(17),
      history: z.array(historySchema).max(2000),
      requests: z.array(savedRequestSchema).max(5000).default([]),
      todos: z.array(todoSchema).max(10000).optional(),
      attachments: z
        .array(attachmentRefSchema.extend({ createdAt: z.number(), data: z.string() }))
        .max(10000)
        .default([]),
    })
    .parse(raw);
  if (backup.version === 3 && !backup.todos) {
    throw new Error('版本 3 备份缺少待办数据，导入已取消');
  }
  const drafts = backup.drafts.map((row) => {
    return { ...row, state: parseState(row.tool, row.state) };
  });
  const history = backup.history.map((row) => {
    return { ...row, state: parseState(row.tool, row.state) };
  });
  for (const ids of [
    drafts.map((row) => {
      return row.tool;
    }),
    history.map((row) => {
      return row.id;
    }),
    backup.requests.map((row) => {
      return row.id;
    }),
    backup.attachments.map((row) => {
      return row.id;
    }),
    (backup.todos ?? []).map((row) => {
      return row.id;
    }),
  ]) {
    if (new Set(ids).size !== ids.length) {
      throw new Error('备份包含重复记录');
    }
  }
  const attachments = backup.attachments.map(({ data, ...metadata }) => {
    const bytes = fromBase64(data);
    if (bytes.length !== metadata.size) {
      throw new Error(`附件「${metadata.name}」字节数不匹配`);
    }
    return { ...metadata, blob: new Blob([bytes], { type: metadata.type }) };
  });
  const byId = new Map(
    attachments.map((file) => {
      return [file.id, file];
    }),
  );
  for (const reference of collectReferences(drafts, history, backup.requests)) {
    const file = byId.get(reference.id);
    if (
      !file ||
      file.size !== reference.size ||
      file.name !== reference.name ||
      file.type !== reference.type
    ) {
      throw new Error(`附件引用「${reference.name}」不完整`);
    }
  }
  const tx = (await database()).transaction(dataStores, 'readwrite');
  try {
    for (const name of tx.objectStoreNames) {
      if (name === 'todos' && backup.version < 3) {
        continue;
      }
      await tx.objectStore(name).clear();
    }
    await tx.objectStore('settings').put(backup.settings, 'global');
    if (backup.settings.saveDrafts) {
      for (const row of drafts) {
        await tx.objectStore('drafts').put(row);
      }
    }
    for (const row of history
      .sort((a, b) => {
        return b.createdAt - a.createdAt;
      })
      .slice(0, backup.settings.historyLimit)) {
      await tx.objectStore('history').put(row);
    }
    for (const row of backup.requests) {
      await tx.objectStore('requests').put(row);
    }
    for (const row of attachments) {
      await tx.objectStore('attachments').put(row);
    }
    if (backup.version === 3) {
      for (const row of backup.todos ?? []) {
        await tx.objectStore('todos').put(row);
      }
    }
    await pruneExpired(tx, backup.settings, Date.now());
    await tx.done;
    notifyDataChanged();
    return backup.settings;
  } catch (error) {
    await rollback(tx);
    throw error;
  }
}
