import { database } from './storage';
import { notifyDataChanged } from './changes';
import { todoInputSchema, todoSchema, type Todo, type TodoInput } from './todo-model';

/**
 * 读取并校验本地任务，数据异常时向界面报告而非覆盖为空。
 * @returns 全部已保存待办。
 */
export async function readTodos(): Promise<Todo[]> {
  return (await (await database()).getAll('todos')).map((row) => {
    return todoSchema.parse(row);
  });
}
/**
 * 新建或修改指定任务；编辑仅覆盖表单字段，保留其他页面最新的完成状态。
 * @param input - 标题、备注、日期与优先级。
 * @param id - 编辑时的原记录 ID，省略则新建。
 * @returns 写入并提交后的完整任务。
 * @throws {Error} 表单无效、达到数量限制或记录已被其他页面删除时抛出。
 */
export async function saveTodo(input: TodoInput, id?: string): Promise<Todo> {
  const parsed = todoInputSchema.parse(input);
  const tx = (await database()).transaction('todos', 'readwrite');
  const existing = id ? await tx.store.get(id) : undefined;
  if (id && !existing) {
    await tx.done;
    throw new Error('这条待办已被删除，请关闭编辑后重新添加');
  }
  if (!id && (await tx.store.count()) >= 10000) {
    await tx.done;
    throw new Error('待办最多保留 10000 条，请先导出并整理已完成任务');
  }
  const now = Date.now();
  const row = todoSchema.parse({
    id: id ?? crypto.randomUUID(),
    createdAt: existing?.createdAt ?? now,
    completedAt: existing?.completedAt ?? null,
    ...parsed,
    updatedAt: now,
  });
  await tx.store.put(row);
  await tx.done;
  notifyDataChanged();
  return row;
}
/**
 * 原子更新完成状态，保留其他页面同时修改的标题和备注。
 * @param id - 待办记录 ID。
 * @param completed - 是否完成；false 表示恢复待办。
 * @returns 提交后的任务。
 */
export async function completeTodo(id: string, completed: boolean): Promise<Todo> {
  const tx = (await database()).transaction('todos', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    await tx.done;
    throw new Error('这条待办已被删除，请刷新列表');
  }
  const row = todoSchema.parse({
    ...existing,
    completedAt: completed ? (existing.completedAt ?? Date.now()) : null,
    updatedAt: Date.now(),
  });
  await tx.store.put(row);
  await tx.done;
  notifyDataChanged();
  return row;
}
/**
 * 删除指定待办，其他记录保持不变。
 * @param id - 待删除的待办 ID。
 * @returns 删除事务完成后的 Promise。
 */
export async function removeTodo(id: string): Promise<void> {
  await (await database()).delete('todos', id);
  notifyDataChanged();
}
