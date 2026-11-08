<script setup lang="ts">
import { Calendar, Delete, EditPen, Flag } from '@element-plus/icons-vue';
import { priorityLabels, type Todo } from '../lib/todo-model';

defineProps<{ todo: Todo; today: string; busy: boolean }>();
const emit = defineEmits<{ edit: [todo: Todo]; complete: [todo: Todo]; remove: [todo: Todo] }>();
</script>

<template>
  <li class="todo-row" :class="{ 'is-complete': todo.completedAt !== null }" :data-todo="todo.id">
    <ElCheckbox
      class="todo-check"
      :class="`priority-${todo.priority}`"
      :model-value="todo.completedAt !== null"
      :disabled="busy"
      :aria-label="`${todo.completedAt !== null ? '恢复' : '完成'}：${todo.title}`"
      @change="emit('complete', todo)"
    />
    <div class="todo-content">
      <p class="todo-title">{{ todo.title }}</p>
      <p v-if="todo.notes" class="todo-notes">{{ todo.notes }}</p>
      <div class="todo-meta">
        <span
          :class="{ overdue: todo.completedAt === null && todo.dueDate && todo.dueDate < today }"
        >
          <ElIcon><Calendar /></ElIcon>
          {{ todo.dueDate === today ? '今天' : todo.dueDate || '未安排' }}
          <template v-if="todo.completedAt === null && todo.dueDate && todo.dueDate < today">
            · 过期</template
          >
        </span>
        <span v-if="todo.priority < 3" :class="`priority-label-${todo.priority}`">
          <ElIcon><Flag /></ElIcon>{{ priorityLabels[todo.priority] }}
        </span>
      </div>
    </div>
    <div class="todo-actions">
      <ElButton
        text
        circle
        :icon="EditPen"
        :disabled="busy"
        :aria-label="`编辑：${todo.title}`"
        title="编辑待办"
        @click="emit('edit', todo)"
      />
      <ElPopconfirm
        title="删除这条待办？"
        confirm-button-text="删除"
        cancel-button-text="取消"
        placement="left"
        :width="200"
        @confirm="emit('remove', todo)"
      >
        <template #reference>
          <ElButton
            text
            circle
            :icon="Delete"
            :disabled="busy"
            :aria-label="`删除：${todo.title}`"
            title="删除待办"
          />
        </template>
      </ElPopconfirm>
    </div>
  </li>
</template>
