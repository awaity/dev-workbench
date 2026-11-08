import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { completeTodo, readTodos, removeTodo, saveTodo } from '../src/lib/todos';
import {
  emptyTodo,
  localDate,
  selectTodos,
  todoInputSchema,
  todosMarkdown,
  type Todo,
} from '../src/lib/todo-model';
import {
  clearAll,
  database,
  exportBackup,
  importBackup,
  runAutoCleanup,
  writeSettings,
} from '../src/lib/storage';
import { defaultSettings } from '../src/lib/models';

const today = '2026-11-06';

/**
 * 构造独立任务用于日期、排序与导出边界验证。
 * @param patch - 需要覆盖的字段。
 * @returns 完整任务对象。
 */
function task(patch: Partial<Todo> = {}): Todo {
  return {
    ...emptyTodo(today),
    title: '测试任务',
    id: crypto.randomUUID(),
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...patch,
  };
}

describe('待办日期、筛选和 Markdown', () => {
  it('本地日期使用日历字段，覆盖跨月、跨年和闰日', () => {
    expect(localDate(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
    expect(localDate(new Date(2024, 1, 29, 23, 59))).toBe('2024-02-29');
    expect(localDate(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });
  it('校验空标题、非法日期、多行标题和长度上限', () => {
    for (const patch of [
      { title: '  ' },
      { title: 'a\nb' },
      { title: 'a'.repeat(201) },
      { notes: 'a'.repeat(2001) },
      { dueDate: '2026-02-29' },
      { priority: 0 },
    ]) {
      expect(
        todoInputSchema.safeParse({ ...emptyTodo(today), title: '任务', ...patch }).success,
      ).toBe(false);
    }
    expect(todoInputSchema.parse({ ...emptyTodo('2024-02-29'), title: '  中文任务  ' }).title).toBe(
      '中文任务',
    );
  });
  it('今日包含过期未完成和今天完成的任务，排除未来、无日期和昨天完成项', () => {
    const overdue = task({ dueDate: '2026-11-05' });
    const planned = task();
    const doneToday = task({
      dueDate: '2026-11-01',
      completedAt: new Date(2026, 10, 6, 0, 1).getTime(),
    });
    const items = [
      task({ dueDate: '2026-11-07' }),
      task({ dueDate: null }),
      task({ completedAt: new Date(2026, 10, 5, 23, 59).getTime() }),
      doneToday,
      planned,
      overdue,
    ];
    expect(selectTodos(items, 'today', today)).toEqual([overdue, planned, doneToday]);
    expect(selectTodos(items, 'all', today)).toHaveLength(6);
    expect(selectTodos(items, 'completed', today)).toHaveLength(2);
    expect(selectTodos(items, 'today', '2026-11-07')).toHaveLength(3);
  });
  it('按日期、优先级与创建时间稳定排列，不修改输入数组', () => {
    const normal = task({ priority: 3 });
    const high = task({ priority: 1 });
    const overdue = task({ dueDate: '2026-11-05' });
    const unscheduled = task({ dueDate: null, priority: 1 });
    const rows = [normal, unscheduled, high, overdue];
    expect(selectTodos(rows, 'all', today)).toEqual([overdue, high, normal, unscheduled]);
    expect(rows[0]).toBe(normal);
  });
  it('Markdown 保留复选框、日期、优先级和多行备注，并转义结构与 HTML', () => {
    const items = [
      task({ title: '[标题] <script> *文字*', priority: 1, notes: '第一行\n# 标题\n- [x] 伪任务' }),
      task({ title: '完成项目', completedAt: new Date(2026, 10, 6, 12).getTime() }),
      task({ title: '未来事项', dueDate: '2026-11-07' }),
    ];
    const markdown = todosMarkdown(items, 'today', today);
    expect(markdown).toContain('- [ ] \\[标题\\] &lt;script&gt; \\*文字\\*');
    expect(markdown).toContain('- [x] 完成项目');
    expect(markdown).toContain('日期：2026-11-06；优先级：高优先级');
    expect(markdown).toContain('    \\# 标题');
    expect(markdown).toContain('    \\- \\[x\\] 伪任务');
    expect(markdown).not.toContain('未来事项');
    expect(todosMarkdown(items, 'all', today)).toContain('未来事项');
    expect(todosMarkdown([], 'all', today)).toContain('暂无待办');
  });
});

describe('待办持久化、备份与清理隔离', () => {
  beforeEach(async () => {
    await clearAll();
  });
  it('新增、编辑、完成、恢复与删除可重新读取，完成时间在重复操作后稳定', async () => {
    const added = await saveTodo({ ...emptyTodo(today), title: '  准备发布  ' });
    expect((await readTodos())[0].title).toBe('准备发布');
    const done = await completeTodo(added.id, true);
    expect(done.completedAt).not.toBeNull();
    expect((await completeTodo(added.id, true)).completedAt).toBe(done.completedAt);
    await saveTodo({ ...added, title: '更新后的标题', notes: '备注' }, added.id);
    expect((await readTodos())[0]).toMatchObject({
      title: '更新后的标题',
      completedAt: done.completedAt,
      createdAt: added.createdAt,
    });
    await completeTodo(added.id, false);
    expect((await readTodos())[0].completedAt).toBeNull();
    await removeTodo(added.id);
    expect(await readTodos()).toEqual([]);
  });
  it('并发编辑与完成不会互相覆盖字段；删除后旧编辑不能复活记录', async () => {
    const added = await saveTodo({ ...emptyTodo(today), title: '最初名称' });
    await Promise.all([
      completeTodo(added.id, true),
      saveTodo({ ...added, title: '并发编辑' }, added.id),
    ]);
    expect((await readTodos())[0].title).toBe('并发编辑');
    expect((await readTodos())[0].completedAt).not.toBeNull();
    await removeTodo(added.id);
    await expect(saveTodo({ ...added, title: '旧页面提交' }, added.id)).rejects.toThrow('已被删除');
    await expect(completeTodo(added.id, true)).rejects.toThrow('已被删除');
    expect(await readTodos()).toEqual([]);
  });
  it('v3 完整备份往返待办与备注，清除全部数据包含待办', async () => {
    const row = await saveTodo({
      ...emptyTodo(today),
      title: '备份任务',
      notes: '中文\n第二行',
      priority: 2,
    });
    await completeTodo(row.id, true);
    const before = await readTodos();
    const backup = await exportBackup();
    expect(backup.version).toBe(3);
    expect(backup.todos).toEqual(before);
    await clearAll();
    expect(await readTodos()).toHaveLength(0);
    await importBackup(JSON.parse(JSON.stringify(backup)));
    expect(await readTodos()).toEqual(before);
  });
  it('v1 / v2 旧备份保留已有待办，v3 空清单明确替换', async () => {
    await saveTodo({ ...emptyTodo(today), title: '不能丢失' });
    for (const version of [1, 2]) {
      await importBackup({
        app: 'dev-workbench',
        version,
        settings: defaultSettings,
        drafts: [],
        history: [],
      });
      expect((await readTodos())[0].title).toBe('不能丢失');
    }
    await importBackup({ ...(await exportBackup()), todos: [] });
    expect(await readTodos()).toHaveLength(0);
  });
  it('非法、重复或缺失的 v3 待办字段拒绝导入，原数据不变', async () => {
    await saveTodo({ ...emptyTodo(today), title: '保留' });
    const backup = await exportBackup();
    for (const todos of [
      undefined,
      [backup.todos[0], backup.todos[0]],
      [{ ...backup.todos[0], dueDate: '2026-02-30' }],
    ]) {
      await expect(importBackup({ ...backup, todos })).rejects.toThrow();
      expect(await readTodos()).toEqual(backup.todos);
    }
  });
  it('自动清理和关闭工具草稿不会删除任何日期的待办', async () => {
    const db = await database();
    await db.put('todos', task({ title: '很久之前未完成', dueDate: '2020-01-01' }));
    await db.put('todos', task({ title: '很久之前已完成', dueDate: null, completedAt: 1 }));
    await writeSettings({ ...defaultSettings, retentionDays: 1, saveDrafts: false });
    await runAutoCleanup();
    expect(await readTodos()).toHaveLength(2);
  });
});
