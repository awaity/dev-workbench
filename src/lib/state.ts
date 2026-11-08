import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { defaultSettings, parseState, type HistoryItem, type ToolId } from './models';
import { addHistory, readDraft, writeDraft } from './storage';

export const settings = ref({ ...defaultSettings });
export const historyVersion = ref(0);
/**
 * 统一显示操作错误。
 * @param error - 需要展示的异常或错误文本。
 * @returns 无返回值。
 */
export function reportError(error: unknown) {
  ElMessage.error(error instanceof Error ? error.message : String(error));
}
/**
 * 拷贝可序列化的表单，去除 Vue Proxy。
 * @param value - 待校验、转换或保存的值。
 * @returns 去除 Vue 代理后的可序列化数据副本。
 */
export function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
/**
 * 保存已完成操作，历史关闭时保持不写入。
 * @param tool - 目标工具标识。
 * @param title - 历史记录标题。
 * @param detail - 历史记录摘要。
 * @param state - 去除代理前的工具状态，内部会生成 JSON 快照。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
export async function remember(
  tool: ToolId,
  title: string,
  detail: string,
  state: Record<string, unknown>,
) {
  if (!settings.value.saveHistory) {
    return;
  }
  await addHistory(
    { tool, title: title.slice(0, 200), detail: detail.slice(0, 300), state: snapshot(state) },
    settings.value.historyLimit,
  );
  historyVersion.value++;
}
/**
 * 自动恢复并防抖保存草稿；组件离开时刷新最后一次编辑。
 * @param tool - 目标工具标识。
 * @param defaults - 当前工具的默认状态。
 * @param restored - 获取外部历史恢复记录的回调。
 * @returns 响应式表单、恢复完成标记与主动保存方法。
 */
export function useDraft<T extends Record<string, unknown>>(
  tool: ToolId,
  defaults: T,
  restored: () => HistoryItem | undefined,
) {
  const form = ref(snapshot(defaults)) as Ref<T>;
  const ready = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let dirty = false;
  /**
   * 将有改动的工具状态写入草稿，并合并防抖期间的重复保存。
   * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
   */
  const save = async () => {
    clearTimeout(timer);
    if (ready.value && dirty && settings.value.saveDrafts) {
      dirty = false;
      try {
        await writeDraft(tool, snapshot(form.value));
      } catch (e) {
        reportError(e);
      }
    }
  };
  onMounted(async () => {
    try {
      const row = settings.value.saveDrafts ? await readDraft(tool) : undefined;
      if (disposed) {
        return;
      }
      if (restored()?.tool === tool) {
        form.value = parseState(tool, restored()!.state) as T;
      } else if (row) {
        form.value = parseState(tool, row.state) as T;
      }
    } catch (e) {
      reportError(e);
    }
    ready.value = true;
  });
  watch(
    form,
    () => {
      if (!ready.value) {
        return;
      }
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void save();
      }, 250);
    },
    { deep: true },
  );
  watch(restored, (row) => {
    if (row?.tool === tool) {
      form.value = parseState(tool, row.state) as T;
    }
  });
  /**
   * 在页面隐藏或退出时触发最后一次草稿保存。
   * @returns 无返回值。
   */
  const unload = () => {
    void save();
  };
  window.addEventListener('pagehide', unload);
  onBeforeUnmount(() => {
    disposed = true;
    void save();
    window.removeEventListener('pagehide', unload);
  });
  return { form, ready, save };
}
