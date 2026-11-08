import { z } from 'zod';

/** 待办可编辑字段，日期为本地日历日期，避免 UTC 转换导致跨日。 */
export const todoInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, '请输入待办名称')
    .max(200, '待办名称最多 200 字')
    .regex(/^[^\r\n]+$/, '待办名称不能换行'),
  notes: z.string().trim().max(2000, '备注最多 2000 字').default(''),
  dueDate: z.iso.date().nullable(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(3),
});
/** 完整待办记录；完成时间为空表示尚未完成。 */
export const todoSchema = todoInputSchema.extend({
  id: z.uuid(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
});
/** 待办编辑表单。 */
export type TodoInput = z.infer<typeof todoInputSchema>;
/** 持久化的待办。 */
export type Todo = z.infer<typeof todoSchema>;
/** 弹窗的三个视图。 */
export type TodoView = 'today' | 'all' | 'completed';
/** 优先级的文字含义，颜色仅作为辅助提示。 */
export const priorityLabels = { 1: '高优先级', 2: '中优先级', 3: '普通' } as const;
/** 各视图的用户可见名称，同时用于导出标题。 */
export const viewLabels = { today: '今日待办', all: '全部待办', completed: '已完成' } as const;

/**
 * 获取设备时区的日历日期，不使用 UTC 截取。
 * @param date - 当前时间或需要转换的时间。
 * @returns YYYY-MM-DD 格式的本地日期。
 */
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
/**
 * 创建空表单，默认安排到今天。
 * @param today - 当前本地日期。
 * @returns 独立的可编辑表单对象。
 */
export function emptyTodo(today = localDate()): TodoInput {
  return { title: '', notes: '', dueDate: today, priority: 3 };
}
/**
 * 按视图筛选任务，今日包含过期未完成任务和今天完成的任务。
 * @param rows - 全部本地待办。
 * @param view - 当前筛选视图。
 * @param today - 当前本地日期。
 * @returns 未完成在前、日期与优先级稳定排序的副本。
 */
export function selectTodos(rows: Todo[], view: TodoView, today = localDate()): Todo[] {
  return rows
    .filter((row) => {
      if (view === 'completed') {
        return row.completedAt !== null;
      }
      if (view === 'today') {
        return row.completedAt !== null
          ? localDate(new Date(row.completedAt)) === today
          : row.dueDate !== null && row.dueDate <= today;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.completedAt !== null || b.completedAt !== null) {
        if (a.completedAt === null) {
          return -1;
        }
        if (b.completedAt === null) {
          return 1;
        }
        return b.completedAt - a.completedAt || a.id.localeCompare(b.id);
      }
      return (
        (a.dueDate ?? '9999-99-99').localeCompare(b.dueDate ?? '9999-99-99') ||
        a.priority - b.priority ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id)
      );
    });
}
/**
 * 将用户文字转为 Markdown 字面量，避免标题、HTML 或链接改变导出结构。
 * @param text - 用户输入的单行文本。
 * @returns 可用于任务标题或备注行的安全文本。
 */
function markdownText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+.!|~-])/g, '\\$1');
}
/**
 * 导出可直接在 Markdown 编辑器中勾选的清单，保留日期、优先级与多行备注。
 * @param rows - 全部本地待办。
 * @param view - 导出当前视图或全部任务。
 * @param today - 导出当天的本地日期。
 * @returns UTF-8 Markdown 文件内容。
 */
export function todosMarkdown(rows: Todo[], view: TodoView, today = localDate()): string {
  const selected = selectTodos(rows, view, today);
  const lines = [`# ${viewLabels[view]}`, '', `日期：${today}`, ''];
  const done = selected.filter((row) => {
    return row.completedAt !== null;
  }).length;
  lines.push(`共 ${selected.length} 项，已完成 ${done} 项`, '');
  for (const completed of [false, true]) {
    const group = selected.filter((row) => {
      return (row.completedAt !== null) === completed;
    });
    if (!group.length) {
      continue;
    }
    lines.push(`## ${completed ? '已完成' : '待完成'}`, '');
    for (const row of group) {
      lines.push(`- [${completed ? 'x' : ' '}] ${markdownText(row.title)}`);
      lines.push(
        `  - 日期：${row.dueDate ?? '未安排'}；优先级：${priorityLabels[row.priority]}${row.completedAt !== null ? `；完成于：${localDate(new Date(row.completedAt))}` : ''}`,
      );
      if (row.notes) {
        lines.push('  - 备注：');
        for (const line of row.notes.split(/\r?\n/)) {
          lines.push(`    ${markdownText(line)}  `);
        }
      }
    }
    lines.push('');
  }
  if (!selected.length) {
    lines.push('暂无待办。', '');
  }
  return lines.join('\n');
}
