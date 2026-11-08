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
