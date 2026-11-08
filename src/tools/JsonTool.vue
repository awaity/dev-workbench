<script setup lang="ts">
import FilePicker from '../components/FilePicker.vue';
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import CodeEditor from '../components/CodeEditor.vue';
import JsonTree from '../components/JsonTree.vue';
import { jsonSchema, type HistoryItem, type ToolId } from '../lib/models';
import { remember, reportError, settings, useDraft } from '../lib/state';
import { deleteNode, jsonExample, parseJson, queryJson, replaceNode } from '../lib/json';
import { copyText, downloadBlob } from '../lib/files';

const props = defineProps<{ tool: ToolId; restored?: HistoryItem }>();
const { form, ready } = useDraft(props.tool, jsonSchema.parse({ input: jsonExample }), () => {
  return props.restored;
});
const error = ref('');
const resultMode = ref(props.tool === 'jsonpath' ? 'result' : 'tree');
const matches = computed({
  get: () => {
    return form.value.matches;
  },
  set: (value) => {
    form.value.matches = value;
  },
});
const parsed = computed(() => {
  try {
    return { ok: true, value: parseJson(form.value.input), message: '' };
  } catch (e) {
    return { ok: false, value: null, message: e instanceof Error ? e.message : String(e) };
  }
});
const tree = computed(() => {
  return parsed.value.value;
});
const nodeDialog = ref(false);
const nodeText = ref('');
const nodeKey = ref('');
const nodePath = ref<(string | number)[]>([]);
const nodeAction = ref<'edit' | 'add'>('edit');
const nodeOriginal = ref<unknown>();
const nodeError = ref('');

/**
 * 根据选定操作格式化、压缩、转义或查询 JSON，并记录成功结果。
 * @param action - 待执行的操作名称。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function run(action: string) {
  error.value = '';
  try {
    let value = parseJson(form.value.input);
    if (action === 'query') {
      matches.value = queryJson(form.value.input, form.value.path);
      form.value.output = JSON.stringify(
        matches.value.map((m) => {
          return m.value;
        }),
        null,
        settings.value.indent,
      );
      resultMode.value = 'result';
    } else if (action === 'escape') {
      form.value.output = JSON.stringify(form.value.input);
      resultMode.value = 'result';
    } else {
      if (action === 'unescape') {
        if (typeof value !== 'string') {
          throw new Error('反转义需要一个 JSON 字符串，如 "{\\"a\\":1}"');
        }
        value = parseJson(value);
      }
      const text = JSON.stringify(
        value,
        null,
        action === 'compact' ? undefined : settings.value.indent,
      );
      form.value.input = text;
      form.value.output = text;
    }
    await remember(
      props.tool,
      action === 'query' ? form.value.path : 'JSON 文档',
      `${form.value.input.length} 字符`,
      form.value,
    );
    ElMessage.success(action === 'query' ? `找到 ${matches.value.length} 项` : '处理完成');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
/**
 * 读取本地 JSON 文本，限制文件大小并移除 UTF-8 BOM。
 * @param selected - 用户选择的 JSON 文件。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function importFile(selected: File) {
  try {
    if (selected.size > 5 * 1024 * 1024) {
      throw new Error('JSON 文件最大 5 MB');
    }
    form.value.input = (await selected.text()).replace(/^\uFEFF/, '');
    error.value = '';
  } catch (e) {
    reportError(e);
  }
}
/**
 * 校验当前 JSON 后按全局缩进导出文件。
 * @returns 无返回值，下载失败时显示错误提示。
 */
function download() {
  try {
    const value = parseJson(form.value.input);
    downloadBlob(
      new Blob([JSON.stringify(value, null, settings.value.indent)], { type: 'application/json' }),
      'document.json',
    );
  } catch (e) {
    reportError(e);
  }
}
/**
 * 准备节点编辑或新增对话框。
 * @param action - 待执行的操作名称。
 * @param path - 从根节点到目标节点的键名或数组索引。
 * @param value - 当前节点值，供编辑初值或判断新增容器类型。
 * @returns 无返回值。
 */
function openNode(action: 'edit' | 'add', path: (string | number)[], value: unknown) {
  nodeAction.value = action;
  nodePath.value = path;
  nodeOriginal.value = value;
  nodeText.value = action === 'edit' ? JSON.stringify(value, null, 2) : 'null';
  nodeKey.value = '';
  nodeError.value = '';
  nodeDialog.value = true;
}
/**
 * 验证节点 JSON 并将增改结果写回文档。
 * @returns 无返回值。
 */
function saveNode() {
  try {
    let next = parseJson(nodeText.value);
    if (nodeAction.value === 'add') {
      if (Array.isArray(nodeOriginal.value)) {
        next = [...nodeOriginal.value, next];
      } else {
        if (!nodeKey.value) {
          throw new Error('请输入字段名');
        }
        if (Object.hasOwn(nodeOriginal.value as object, nodeKey.value)) {
          throw new Error('该字段已存在，请直接编辑');
        }
        next = { ...(nodeOriginal.value as object), [nodeKey.value]: next };
      }
    }
    form.value.input = JSON.stringify(
      replaceNode(parseJson(form.value.input), nodePath.value, next),
      null,
      settings.value.indent,
    );
    nodeDialog.value = false;
  } catch (e) {
    nodeError.value = e instanceof Error ? e.message : String(e);
  }
}
/**
 * 确认后删除指定节点，并同步代码与树视图。
 * @param path - 从根节点到目标节点的键名或数组索引。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function removeNode(path: (string | number)[]) {
  try {
    await ElMessageBox.confirm(`删除节点 ${path.join('.') || '$'}？`, '删除节点', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    form.value.input = JSON.stringify(
      deleteNode(parseJson(form.value.input), path),
      null,
      settings.value.indent,
    );
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') {
      reportError(e);
    }
  }
}
</script>

<template>
  <div v-if="ready" class="tool-surface">
    <div v-if="tool === 'jsonpath'" class="path-bar">
      <label for="jsonpath">JSONPath</label
      ><ElInput
        id="jsonpath"
        v-model="form.path"
        placeholder="$.tools[?(@.favorite)].name"
        @keydown.enter="run('query')"
      />
      <ElButton class="primary" type="primary" @click="run('query')">查询</ElButton>
      <div class="path-examples">
        <span>试试</span
        ><ElButton
          v-for="path in ['$', '$.tools[*].name', '$.tools[?(@.favorite == true)]']"
          :key="path"
          class="code-link"
          @click="
            form.path = path;
            run('query');
          "
        >
          {{ path }}
        </ElButton>
      </div>
    </div>
    <div class="toolbar">
      <ElButton class="primary" type="primary" @click="run('format')">格式化 / 校验</ElButton
      ><ElButton @click="run('compact')">压缩</ElButton
      ><ElButton @click="run('escape')">转义</ElButton
      ><ElButton @click="run('unescape')">反转义</ElButton>
      <span class="toolbar-spacer" />
      <ElButton
        @click="
          form.input = jsonExample;
          error = '';
        "
      >
        载入示例</ElButton
      ><FilePicker
        label="导入 JSON 文件"
        accept=".json,.txt,application/json"
        @select="importFile"
      /><ElButton @click="download">导出</ElButton>
    </div>
    <div v-if="error" role="alert" class="error-banner">{{ error }}</div>
    <div class="split-editors">
      <section class="editor-pane">
        <div class="pane-heading">
          <h2>JSON 内容</h2>
          <div>
            <ElButton class="text-button" @click="copyText(form.input).catch(reportError)">
              复制</ElButton
            ><ElButton
              class="text-button"
              @click="
                form.input = '';
                form.output = '';
                matches = [];
              "
            >
              清空
            </ElButton>
          </div>
        </div>
        <CodeEditor v-model="form.input" label="JSON 输入" json />
        <div class="editor-status">
          <span>{{ form.input.length.toLocaleString() }} 字符</span
          ><span :class="parsed.ok ? 'success-text' : 'muted'">{{
            parsed.ok ? '✓ 有效 JSON' : '等待有效 JSON'
          }}</span>
        </div>
      </section>
      <section class="editor-pane">
        <div class="pane-heading">
          <div class="segmented">
            <ElButton :class="{ active: resultMode === 'tree' }" @click="resultMode = 'tree'">
              {{ tool === 'json-editor' ? '树形编辑' : '结构视图' }}</ElButton
            ><ElButton :class="{ active: resultMode === 'result' }" @click="resultMode = 'result'">
              {{ tool === 'jsonpath' ? '查询结果' : '文本结果' }}
            </ElButton>
          </div>
          <ElButton
            class="text-button"
            @click="
              copyText(
                resultMode === 'tree' ? JSON.stringify(tree, null, settings.indent) : form.output,
              ).catch(reportError)
            "
          >
            复制
          </ElButton>
        </div>
        <div v-if="resultMode === 'tree'" class="tree-container">
          <JsonTree
            v-if="parsed.ok"
            :value="tree"
            :editable="tool === 'json-editor'"
            @edit="(p, v) => openNode('edit', p, v)"
            @add="(p, v) => openNode('add', p, v)"
            @remove="removeNode"
          />
          <div v-else class="empty-state">
            <span class="empty-symbol">{ }</span>
            <p>{{ parsed.message }}</p>
          </div>
        </div>
        <CodeEditor
          v-else
          v-model="form.output"
          label="JSON 结果"
          json
          readonly
          placeholder="操作结果会显示在这里"
        />
        <div class="editor-status">
          <span>{{ tool === 'jsonpath' ? `${matches.length} 个匹配` : '支持展开与折叠' }}</span
          ><span>本地解析</span>
        </div>
      </section>
    </div>
    <div v-if="tool === 'jsonpath' && matches.length" class="match-paths">
      <h3>匹配路径</h3>
      <div v-for="match in matches.slice(0, 500)" :key="match.path">
        <code>{{ match.path }}</code
        ><ElButton class="text-button" @click="copyText(match.path).catch(reportError)">
          复制路径
        </ElButton>
      </div>
      <p v-if="matches.length > 500">仅展示前 500 条路径，结果包含全部匹配。</p>
    </div>
    <div class="tool-note">
      {{
        tool === 'json-editor'
          ? '点击树节点旁的编辑、＋ 或 × 修改结构；代码与树视图实时同步。'
          : '支持标准 JSON。Ctrl / ⌘ + F 搜索，Tab 缩进；大整数请使用字符串保存精度。'
      }}
    </div>
  </div>
  <ElDialog
    v-model="nodeDialog"
    :title="nodeAction === 'edit' ? '编辑 JSON 节点' : '添加 JSON 节点'"
    width="560px"
  >
    <label v-if="nodeAction === 'add' && !Array.isArray(nodeOriginal)" class="field"
      >字段名<ElInput v-model="nodeKey" aria-label="字段名"
    /></label>
    <label class="field"
      >值（有效 JSON）<ElInput
        v-model="nodeText"
        :rows="9"
        class="mono"
        aria-label="值（有效 JSON）"
        type="textarea"
      />
    </label>
    <p v-if="nodeError" role="alert" class="error-text">{{ nodeError }}</p>
    <template #footer
      ><ElButton @click="nodeDialog = false">取消</ElButton
      ><ElButton class="primary" type="primary" @click="saveNode">保存节点</ElButton></template
    >
  </ElDialog>
</template>
