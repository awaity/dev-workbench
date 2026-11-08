<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { ArrowDown, ArrowRight, Check, Download, Plus, TopRight } from '@element-plus/icons-vue';
import { ElMessage, type InputInstance } from 'element-plus';
import { ZodError } from 'zod';
import TodoRow from './TodoRow.vue';
import { DATA_CHANNEL } from '../lib/changes';
import { downloadBlob } from '../lib/files';
import { readSettings } from '../lib/storage';
import { completeTodo, readTodos, removeTodo, saveTodo } from '../lib/todos';
import {
  emptyTodo,
  localDate,
  priorityLabels,
  selectTodos,
  todosMarkdown,
  viewLabels,
  type Todo,
  type TodoView,
} from '../lib/todo-model';

const rows = ref<Todo[]>([]);
const view = ref<TodoView>('today');
const today = ref(localDate());
const loading = ref(true);
const ready = ref(false);
const busy = ref(false);
const error = ref('');
const editorOpen = ref(false);
const editingId = ref<string>();
const form = ref(emptyTodo());
const titleInput = ref<InputInstance>();
const scrollArea = ref<HTMLElement>();
const showCompleted = ref(false);
const media = matchMedia('(prefers-color-scheme: dark)');
let preference = 'light';
let channel: BroadcastChannel | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
let refreshVersion = 0;
const selected = computed(() => {
  return selectTodos(rows.value, view.value, today.value);
});
const todayRows = computed(() => {
  return selectTodos(rows.value, 'today', today.value);
});
const todayDone = computed(() => {
  return todayRows.value.filter((row) => {
    return row.completedAt !== null;
  }).length;
});
const counts = computed(() => {
  return {
    today: todayRows.value.filter((row) => {
      return row.completedAt === null;
    }).length,
    all: rows.value.filter((row) => {
      return row.completedAt === null;
    }).length,
    completed: rows.value.filter((row) => {
      return row.completedAt !== null;
    }).length,
  };
});
const dateLabel = computed(() => {
  return new Date(`${today.value}T12:00:00`).toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
});
const completed = computed(() => {
  return selected.value.filter((row) => {
    return row.completedAt !== null;
  });
});
const groups = computed(() => {
  const pending = selected.value.filter((row) => {
    return row.completedAt === null;
  });
  return [
    {
      key: 'overdue',
      label: '过期',
      items: pending.filter((row) => {
        return row.dueDate !== null && row.dueDate < today.value;
      }),
    },
    {
      key: 'today',
      label: '今天',
      items: pending.filter((row) => {
        return row.dueDate === today.value;
      }),
    },
    {
      key: 'upcoming',
      label: '接下来',
      items: pending.filter((row) => {
        return row.dueDate !== null && row.dueDate > today.value;
      }),
    },
    {
      key: 'unscheduled',
      label: '未安排日期',
      items: pending.filter((row) => {
        return row.dueDate === null;
      }),
    },
  ].filter((group) => {
    return group.items.length > 0;
  });
});
const emptyTitle = computed(() => {
  if (view.value === 'completed') {
    return '完成的事情，都在这里';
  }
  return view.value === 'today' ? '今天，先做一件重要的事' : '把想做的事，记在这里';
});

/**
 * 将全局外观偏好应用于弹窗，跟随系统时响应系统主题变化。
 * @returns 无返回值。
 */
function applyTheme(): void {
  document.documentElement.classList.toggle(
    'dark',
    preference === 'dark' || (preference === 'system' && media.matches),
  );
}
/**
 * 将存储或校验异常转成用户可理解的错误，保留原有任务与编辑内容。
 * @param reason - 捕获到的异常。
 * @returns 无返回值。
 */
function showError(reason: unknown): void {
  error.value =
    reason instanceof ZodError
      ? '待办数据格式有误，请重新加载或从工作台恢复有效备份。'
      : reason instanceof Error
        ? reason.message
        : String(reason);
}
/**
 * 刷新本地数据与主题，忽略较早请求的迟到结果。
 * @returns 数据读取及界面更新完成后的 Promise。
 */
async function refresh(): Promise<void> {
  const version = ++refreshVersion;
  try {
    const [items, settings] = await Promise.all([readTodos(), readSettings()]);
    if (version !== refreshVersion) {
      return;
    }
    rows.value = items;
    preference = settings.theme;
    applyTheme();
    today.value = localDate();
    ready.value = true;
    error.value = '';
  } catch (reason) {
    if (version === refreshVersion) {
      showError(reason);
    }
  } finally {
    if (version === refreshVersion) {
      loading.value = false;
    }
  }
}
/**
 * 展开新增或编辑表单，并将键盘焦点移至标题。
 * @param todo - 需要编辑的任务，省略时新增。
 * @returns 焦点与滚动位置调整完成后的 Promise。
 */
async function edit(todo?: Todo): Promise<void> {
  editingId.value = todo?.id;
  form.value = todo
    ? { title: todo.title, notes: todo.notes, dueDate: todo.dueDate, priority: todo.priority }
    : emptyTodo(today.value);
  editorOpen.value = true;
  await nextTick();
  scrollArea.value?.scrollTo({ top: 0 });
  titleInput.value?.focus();
}
/**
 * 保存当前表单，成功后才清空输入，未来或未安排任务自动显示在全部视图。
 * @returns 任务提交及列表刷新完成后的 Promise。
 */
async function submit(): Promise<void> {
  if (busy.value || !form.value.title.trim()) {
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const editing = !!editingId.value;
    const row = await saveTodo(
      { ...form.value, dueDate: form.value.dueDate || null },
      editingId.value,
    );
    if (
      view.value === 'completed' ||
      (view.value === 'today' && (!row.dueDate || row.dueDate > today.value))
    ) {
      view.value = 'all';
    }
    editorOpen.value = false;
    editingId.value = undefined;
    form.value = emptyTodo(today.value);
    await refresh();
    ElMessage.success({ message: editing ? '待办已更新' : '待办已添加', duration: 1400 });
  } catch (reason) {
    showError(reason);
  } finally {
    busy.value = false;
  }
}
/**
 * 处理标题回车，中文输入法确认候选字时不提前提交。
 * @param event - 输入框的键盘事件。
 * @returns 无返回值。
 */
function submitKey(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  event.preventDefault();
  void submit();
}
/**
 * 切换完成状态，数据库失败时保持界面中的原状态。
 * @param todo - 用户操作的待办。
 * @returns 持久化与列表更新完成后的 Promise。
 */
async function toggle(todo: Todo): Promise<void> {
  if (busy.value) {
    return;
  }
  busy.value = true;
  try {
    await completeTodo(todo.id, todo.completedAt === null);
    await refresh();
    if (todo.completedAt === null) {
      showCompleted.value = true;
    }
  } catch (reason) {
    showError(reason);
  } finally {
    busy.value = false;
  }
}
/**
 * 在用户确认后删除任务，同时关闭该任务的编辑表单。
 * @param todo - 已确认删除的任务。
 * @returns 删除与列表刷新完成后的 Promise。
 */
async function erase(todo: Todo): Promise<void> {
  if (busy.value) {
    return;
  }
  busy.value = true;
  try {
    await removeTodo(todo.id);
    if (editingId.value === todo.id) {
      editorOpen.value = false;
    }
    await refresh();
  } catch (reason) {
    showError(reason);
  } finally {
    busy.value = false;
  }
}
/**
 * 重新读取已保存任务并下载 Markdown，包含完成状态、日期、优先级与备注。
 * @param scope - 导出当前视图或全部任务。
 * @returns 文件准备并触发下载后的 Promise。
 */
async function exportMarkdown(scope: 'current' | 'all'): Promise<void> {
  try {
    const items = await readTodos();
    const selectedView = scope === 'all' ? 'all' : view.value;
    const date = localDate();
    downloadBlob(
      new Blob([todosMarkdown(items, selectedView, date)], { type: 'text/markdown;charset=utf-8' }),
      `${viewLabels[selectedView]}-${date}.md`,
    );
    ElMessage.success('Markdown 已导出');
  } catch (reason) {
    showError(reason);
  }
}
/**
 * 直接创建新的开发工作台标签页，成功后关闭浏览器弹窗。
 * @returns 标签页创建完成后的 Promise。
 */
async function openWorkbench(): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
      window.close();
    } else {
      window.open(new URL('index.html', location.href), '_blank', 'noopener');
    }
  } catch (reason) {
    showError(reason);
  }
}
/**
 * 页面恢复可见时刷新日期与其他页面修改的任务。
 * @returns 无返回值。
 */
function onVisible(): void {
  if (!document.hidden) {
    void refresh();
  }
}
onMounted(() => {
  void refresh();
  channel = new BroadcastChannel(DATA_CHANNEL);
  channel.onmessage = () => {
    void refresh();
  };
  media.addEventListener('change', applyTheme);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  clock = setInterval(() => {
    today.value = localDate();
  }, 15000);
});
onUnmounted(() => {
  channel?.close();
  clearInterval(clock);
  media.removeEventListener('change', applyTheme);
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('focus', onVisible);
});
</script>

<template>
  <div class="todo-shell">
    <header class="popup-header">
      <div class="popup-brand">
        <img src="/favicon.svg" alt="" width="24" height="24" /><span>开发工作台</span>
      </div>
      <ElDropdown trigger="click" :disabled="!ready || busy" @command="exportMarkdown">
        <ElButton
          class="export-button"
          text
          :icon="Download"
          :disabled="!ready || busy"
          aria-label="导出 Markdown"
          >导出 MD<ElIcon><ArrowDown /></ElIcon
        ></ElButton>
        <template #dropdown>
          <ElDropdownMenu>
            <ElDropdownItem command="current">导出当前视图</ElDropdownItem>
            <ElDropdownItem command="all">导出全部待办</ElDropdownItem>
          </ElDropdownMenu>
        </template>
      </ElDropdown>
    </header>
    <section class="today-overview" aria-label="今日进度">
      <div class="today-heading">
        <h1>今日待办</h1>
        <span>{{ dateLabel }}</span>
      </div>
      <div class="today-summary">
        <span v-if="todayRows.length"
          >今日已完成 <strong>{{ todayDone }}</strong> / {{ todayRows.length }} 项</span
        ><span v-else>留一点空间，给今天的重要事项。</span
        ><span v-if="todayRows.length && todayDone === todayRows.length" class="all-done"
          >今天的计划已完成</span
        >
      </div>
      <ElProgress
        :percentage="todayRows.length ? Math.round((todayDone / todayRows.length) * 100) : 0"
        :show-text="false"
        :stroke-width="3"
        aria-label="今日完成进度"
      />
    </section>
    <nav class="view-tabs" aria-label="待办视图">
      <ElButton
        v-for="key in ['today', 'all', 'completed'] as const"
        :key="key"
        text
        :class="{ active: view === key }"
        :aria-pressed="view === key"
        @click="view = key"
      >
        {{ key === 'today' ? '今日' : key === 'all' ? '全部' : '已完成'
        }}<span>{{ counts[key] }}</span>
      </ElButton>
    </nav>
    <main ref="scrollArea" class="todo-scroll" aria-label="待办列表" :aria-busy="loading || busy">
      <div v-if="error" class="popup-error" role="alert">
        <p>{{ error }}</p>
        <ElButton size="small" :disabled="busy" @click="refresh">重新加载</ElButton>
      </div>
      <ElSkeleton v-if="loading" :rows="3" animated />
      <template v-else-if="ready">
        <ElButton
          v-if="!editorOpen"
          class="add-todo"
          text
          :icon="Plus"
          :disabled="busy"
          @click="edit()"
          >添加待办<span>Enter 快速保存</span></ElButton
        >
        <ElForm
          v-else
          class="todo-editor"
          :disabled="busy"
          aria-label="待办编辑"
          @submit.prevent="submit"
        >
          <ElInput
            ref="titleInput"
            v-model="form.title"
            aria-label="待办名称"
            placeholder="准备做什么？"
            :maxlength="200"
            @keydown.enter="submitKey"
          />
          <ElInput
            v-model="form.notes"
            type="textarea"
            aria-label="待办备注"
            placeholder="添加备注（可选）"
            :rows="2"
            :maxlength="2000"
            resize="none"
            @keydown.ctrl.enter="submitKey"
            @keydown.meta.enter="submitKey"
          />
          <div class="editor-options">
            <ElDatePicker
              v-model="form.dueDate"
              type="date"
              value-format="YYYY-MM-DD"
              format="MM月DD日"
              placeholder="未安排日期"
              aria-label="待办日期"
              :editable="false"
              placement="top-start"
              :fallback-placements="['top-start']"
              :popper-options="{
                modifiers: [
                  {
                    name: 'preventOverflow',
                    options: { altAxis: true, tether: false, padding: 8 },
                  },
                ],
              }"
              size="small"
              popper-class="todo-date-picker"
            />
            <ElSelect v-model="form.priority" aria-label="待办优先级" size="small">
              <ElOption
                v-for="priority in [1, 2, 3] as const"
                :key="priority"
                :value="priority"
                :label="priorityLabels[priority]"
              />
            </ElSelect>
          </div>
          <div class="editor-footer">
            <span>{{ editingId ? '编辑待办' : '默认安排在今天' }}</span
            ><ElButton size="small" @click="editorOpen = false">取消</ElButton
            ><ElButton
              type="primary"
              size="small"
              :loading="busy"
              :disabled="!form.title.trim()"
              @click="submit"
              >{{ editingId ? '保存修改' : '添加任务' }}</ElButton
            >
          </div>
        </ElForm>
        <section
          v-for="group in groups"
          :key="group.key"
          class="todo-group"
          :aria-label="group.label"
        >
          <h2 :class="{ overdue: group.key === 'overdue' }">
            {{ group.label }}<span>{{ group.items.length }}</span>
          </h2>
          <ul>
            <TodoRow
              v-for="todo in group.items"
              :key="todo.id"
              :todo="todo"
              :today="today"
              :busy="busy"
              @edit="edit"
              @complete="toggle"
              @remove="erase"
            />
          </ul>
        </section>
        <section
          v-if="completed.length"
          class="todo-group completed-group"
          aria-label="已完成的任务"
        >
          <ElButton
            v-if="view !== 'completed'"
            class="completed-toggle"
            text
            :icon="showCompleted ? ArrowDown : ArrowRight"
            :aria-expanded="showCompleted"
            @click="showCompleted = !showCompleted"
            >已完成<span>{{ completed.length }}</span></ElButton
          >
          <h2 v-else>
            已完成<span>{{ completed.length }}</span>
          </h2>
          <ul v-if="view === 'completed' || showCompleted">
            <TodoRow
              v-for="todo in completed"
              :key="todo.id"
              :todo="todo"
              :today="today"
              :busy="busy"
              @edit="edit"
              @complete="toggle"
              @remove="erase"
            />
          </ul>
        </section>
        <div v-if="!selected.length && !editorOpen" class="todo-empty">
          <div class="empty-check">
            <ElIcon :size="25"><Check /></ElIcon>
          </div>
          <h2>{{ emptyTitle }}</h2>
          <p>
            {{
              view === 'completed'
                ? '勾选任务后，可以在这里查看或恢复。'
                : '添加一条待办，把想法变成行动。'
            }}
          </p>
          <ElButton v-if="view === 'today' && counts.all" text @click="view = 'all'"
            >查看其他 {{ counts.all }} 项待办<ElIcon><ArrowRight /></ElIcon
          ></ElButton>
        </div>
      </template>
    </main>
    <footer class="popup-footer">
      <span>仅保存在本机</span
      ><ElButton class="workbench-link" text :icon="TopRight" @click="openWorkbench"
        >打开开发工作台</ElButton
      >
    </footer>
  </div>
</template>
