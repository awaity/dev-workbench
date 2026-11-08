<script setup lang="ts">
import { ref } from 'vue';
import type { z } from 'zod';
import { pairSchema } from '../lib/models';
const props = defineProps<{ label: string }>();
const rows = defineModel<z.infer<typeof pairSchema>[]>({ required: true });
const bulkOpen = ref(false);
const bulkText = ref('');
const bulkError = ref('');
/**
 * 添加一个启用的空参数行。
 * @returns 无返回值。
 */
function add() {
  rows.value.push(pairSchema.parse({ name: '', value: '', enabled: true }));
}
/**
 * 将参数转换为可批量编辑的逐行文本。
 * @returns 无返回值。
 */
function openBulk() {
  bulkText.value = rows.value
    .map((row) => {
      return `${row.enabled ? '' : '#'}${row.name}:${row.value}`;
    })
    .join('\n');
  bulkError.value = '';
  bulkOpen.value = true;
}
/**
 * 校验并应用批量参数，按同名行的次序保留描述。
 * @returns 无返回值；错误显示在对话框中。
 */
function applyBulk() {
  try {
    const previous = [...rows.value];
    const parsed = bulkText.value
      .split(/\r?\n/)
      .filter((line) => {
        return line.trim();
      })
      .map((line, index) => {
        const enabled = !line.startsWith('#');
        const text = enabled ? line : line.slice(1);
        const at = text.indexOf(':');
        if (at < 1) {
          throw new Error(`第 ${index + 1} 行需要「名称:值」格式`);
        }
        const name = text.slice(0, at).trim();
        const oldIndex = previous.findIndex((row) => {
          return row.name === name;
        });
        const old = oldIndex < 0 ? undefined : previous.splice(oldIndex, 1)[0];
        return pairSchema.parse({
          name,
          value: text.slice(at + 1),
          enabled,
          description: old?.description || '',
        });
      });
    rows.value = parsed;
    bulkOpen.value = false;
  } catch (error) {
    bulkError.value = error instanceof Error ? error.message : String(error);
  }
}
</script>
<template>
  <div class="pairs-editor">
    <div v-if="rows.length" class="pair-heading" aria-hidden="true">
      <span /><span>名称</span><span>值</span><span>描述</span><span />
    </div>
    <div v-for="(row, index) in rows" :key="index" class="pair-row">
      <ElCheckbox v-model="row.enabled" :aria-label="`${label} ${index + 1} 启用`" />
      <ElInput v-model="row.name" :aria-label="`${label} ${index + 1} 名称`" placeholder="名称" />
      <ElInput
        v-model="row.value"
        :aria-label="`${label} ${index + 1} 值`"
        placeholder="值，支持变量"
      />
      <ElInput
        v-model="row.description"
        :aria-label="`${label} ${index + 1} 描述`"
        placeholder="描述（选填）"
      />
      <ElButton
        text
        class="icon-button"
        :aria-label="`删除${label} ${index + 1}`"
        @click="rows.splice(index, 1)"
        >×</ElButton
      >
    </div>
    <p v-if="!rows.length" class="empty-inline">尚未添加{{ label }}。</p>
    <div class="pair-actions">
      <ElButton text type="primary" @click="add">＋ 添加{{ label }}</ElButton
      ><ElButton text @click="openBulk">批量编辑{{ label }}</ElButton>
    </div>
    <ElDialog v-model="bulkOpen" :title="`批量编辑${props.label}`" width="640px" append-to-body>
      <p class="field-help">
        每行填写 名称:值，值可以包含冒号。行首 # 表示停用；已有同名行的描述会保留。
      </p>
      <ElInput
        v-model="bulkText"
        type="textarea"
        :rows="12"
        :aria-label="`批量${label}`"
        placeholder="name:value"
      />
      <p v-if="bulkError" role="alert" class="error-banner">{{ bulkError }}</p>
      <template #footer
        ><ElButton @click="bulkOpen = false">取消</ElButton
        ><ElButton type="primary" @click="applyBulk">应用参数</ElButton></template
      >
    </ElDialog>
  </div>
</template>
