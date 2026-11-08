<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import CodeEditor from '../components/CodeEditor.vue';
import PairsEditor from '../components/PairsEditor.vue';
import MultipartEditor from '../components/MultipartEditor.vue';
import FilePicker from '../components/FilePicker.vue';
import JsonTree from '../components/JsonTree.vue';
import {
  httpSchema,
  pairSchema,
  type HistoryItem,
  type HttpState,
  type SavedRequest,
} from '../lib/models';
import { remember, reportError, settings, snapshot, useDraft } from '../lib/state';
import { prepareRequest, readResponse, responseBlob, RAW_CONTENT_TYPES } from '../lib/http';
import { importCurl, exportCurl } from '../lib/curl';
import {
  loadRequestFiles,
  putAttachment,
  readRequests,
  saveRequest,
  removeRequest,
} from '../lib/storage';
import { copyText, downloadBlob, formatBytes } from '../lib/files';

const props = defineProps<{ restored?: HistoryItem }>();
const { form, ready } = useDraft(
  'http',
  httpSchema.parse({ timeout: settings.value.timeout }),
  () => {
    return props.restored;
  },
);
const tab = ref('params');
const responseTab = ref('pretty');
const busy = ref(false);
const fileSaving = ref(false);
const binarySaving = ref(false);
const error = ref('');
const warnings = ref<string[]>([]);
const collectionOpen = ref(false);
const collectionQuery = ref('');
const requests = ref<SavedRequest[]>([]);
const selectedId = ref('');
const saveOpen = ref(false);
const saveAsNew = ref(false);
const requestName = ref('');
const folderName = ref('默认集合');
const curlOpen = ref(false);
const curlMode = ref<'import' | 'export'>('import');
const curlText = ref('');
const curlError = ref('');
let controller: AbortController | undefined;
let alive = true;
let generation = 0;
const saving = computed(() => {
  return fileSaving.value || binarySaving.value;
});
const bodyMode = computed({
  get() {
    return Object.hasOwn(RAW_CONTENT_TYPES, form.value.bodyType) ? 'raw' : form.value.bodyType;
  },
  set(value: string) {
    form.value.bodyType = value === 'raw' ? 'json' : (value as HttpState['bodyType']);
  },
});
const groups = computed(() => {
  const result: Record<string, SavedRequest[]> = Object.create(null);
  for (const row of requests.value) {
    if (
      `${row.name} ${row.folder} ${row.state.method} ${row.state.url}`
        .toLowerCase()
        .includes(collectionQuery.value.toLowerCase())
    ) {
      (result[row.folder] ??= []).push(row);
    }
  }
  return result;
});
const responseText = computed(() => {
  const response = form.value.response;
  if (!response) {
    return '';
  }
  if (responseTab.value === 'headers') {
    return response.headers;
  }
  if (response.encoding === 'base64') {
    return response.body;
  }
  if (responseTab.value !== 'raw') {
    try {
      return JSON.stringify(JSON.parse(response.body), null, settings.value.indent);
    } catch {
      /* 非 JSON 保留原文。 */
    }
  }
  return response.body;
});
const responseJson = computed(() => {
  try {
    return {
      valid: form.value.response?.encoding === 'text',
      value: JSON.parse(form.value.response?.body || '') as unknown,
    };
  } catch {
    return { valid: false, value: null };
  }
});
const imageUrl = ref('');
watch(
  () => {
    return form.value.response;
  },
  (response) => {
    if (imageUrl.value) {
      URL.revokeObjectURL(imageUrl.value);
      imageUrl.value = '';
    }
    if (
      response &&
      !response.truncated &&
      /^image\/(png|jpeg|gif|webp|avif|bmp)(?:;|$)/i.test(response.contentType)
    ) {
      imageUrl.value = URL.createObjectURL(responseBlob(response));
    }
  },
  { immediate: true },
);
watch(
  () => {
    return props.restored;
  },
  () => {
    invalidate();
    selectedId.value = '';
  },
  { flush: 'sync' },
);
/**
 * 中止当前请求，由发送流程统一更新结果与提示。
 * @returns 无返回值。
 */
function cancel() {
  controller?.abort();
}
/**
 * 使旧请求失效，防止切换配置后旧响应覆盖新草稿。
 * @returns 无返回值。
 */
function invalidate() {
  generation++;
  cancel();
  busy.value = false;
  error.value = '';
  warnings.value = [];
}
onBeforeUnmount(() => {
  alive = false;
  invalidate();
  if (imageUrl.value) {
    URL.revokeObjectURL(imageUrl.value);
  }
});
/**
 * 校验配置、读取本地附件并发送请求，保存有限大小的响应与历史。
 * @returns 请求完成、失败或取消后的 Promise。
 */
async function send() {
  if (busy.value || saving.value) {
    return;
  }
  const current = ++generation;
  const abort = new AbortController();
  controller = abort;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const submitted = snapshot(form.value);
  error.value = '';
  warnings.value = [];
  busy.value = true;
  try {
    const parsed = httpSchema.parse(submitted);
    const files = await loadRequestFiles(parsed);
    if (!alive || current !== generation) {
      return;
    }
    if (abort.signal.aborted) {
      error.value = '请求已取消';
      return;
    }
    const { url, init, warnings: adjustments } = prepareRequest(parsed, files);
    warnings.value = adjustments;
    form.value.response = null;
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, parsed.timeout);
    const start = performance.now();
    const response = await fetch(url, { ...init, signal: abort.signal });
    const content = await readResponse(response);
    const result = {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      redirected: response.redirected,
      duration: Math.round(performance.now() - start),
      headers: Array.from(response.headers, ([k, v]) => {
        return `${k}: ${v}`;
      }).join('\n'),
      ...content,
    };
    if (!alive || current !== generation) {
      return;
    }
    form.value.response = result;
    await remember('http', `${parsed.method} ${url}`, `${result.status} · ${result.duration} ms`, {
      ...parsed,
      response: result,
    });
  } catch (cause) {
    if (!alive || current !== generation) {
      return;
    }
    error.value = abort.signal.aborted
      ? timedOut
        ? `请求超时（${submitted.timeout} ms）`
        : '请求已取消'
      : `请求失败：${cause instanceof Error ? cause.message : String(cause)}`;
  } finally {
    clearTimeout(timer);
    if (current === generation) {
      busy.value = false;
    }
    if (controller === abort) {
      controller = undefined;
    }
  }
}
/**
 * 为 binary 请求体保存本地文件，异步完成后检查配置是否已切换。
 * @param file - 用户选择的文件。
 * @returns 附件保存完成的 Promise。
 */
async function selectBinary(file: File) {
  binarySaving.value = true;
  const target = form.value;
  try {
    const reference = await putAttachment(file);
    if (alive && target === form.value) {
      target.binary = reference;
      target.binaryHint = '';
    }
  } catch (cause) {
    reportError(cause);
  } finally {
    binarySaving.value = false;
  }
}
/**
 * 将地址中的查询字符串移入参数表，方便逐项停用和编辑。
 * @returns 无返回值。
 */
function extractParams() {
  const hashAt = form.value.url.indexOf('#');
  const hash = hashAt < 0 ? '' : form.value.url.slice(hashAt);
  const base = hashAt < 0 ? form.value.url : form.value.url.slice(0, hashAt);
  const at = base.indexOf('?');
  if (at < 0) {
    ElMessage.info('地址中没有查询参数');
    return;
  }
  form.value.params.push(
    ...Array.from(new URLSearchParams(base.slice(at + 1)), ([name, value]) => {
      return pairSchema.parse({ name, value, enabled: true });
    }),
  );
  form.value.url = base.slice(0, at) + hash;
}
/**
 * 读取并展示本地请求集合。
 * @returns 列表读取完成的 Promise。
 */
async function openCollection() {
  try {
    requests.value = await readRequests();
    collectionOpen.value = true;
  } catch (cause) {
    reportError(cause);
  }
}
/**
 * 打开命名对话框，决定覆盖当前记录或另存为新请求。
 * @param asNew - 是否强制另存。
 * @returns 无返回值。
 */
function openSave(asNew = false) {
  saveAsNew.value = asNew;
  requestName.value = form.value.name || `${form.value.method} 请求`;
  folderName.value = form.value.folder;
  saveOpen.value = true;
}
/**
 * 保存当前配置到本地集合，不携带已有响应。
 * @returns 保存完成的 Promise。
 */
async function persistRequest() {
  try {
    if (!requestName.value.trim()) {
      throw new Error('请填写请求名称');
    }
    const row = await saveRequest(
      { ...snapshot(form.value), name: requestName.value, folder: folderName.value },
      !saveAsNew.value && selectedId.value ? selectedId.value : undefined,
    );
    form.value.name = row.name;
    form.value.folder = row.folder;
    selectedId.value = row.id;
    saveOpen.value = false;
    ElMessage.success('请求已保存到本地集合');
  } catch (cause) {
    reportError(cause);
  }
}
/**
 * 从集合恢复配置和附件引用，旧请求作废。
 * @param row - 要恢复的集合请求。
 * @returns 无返回值。
 */
function loadRequest(row: SavedRequest) {
  invalidate();
  form.value = httpSchema.parse(snapshot(row.state));
  selectedId.value = row.id;
  collectionOpen.value = false;
}
/**
 * 经界面确认后删除集合记录。
 * @param row - 待删除请求。
 * @returns 删除与列表刷新完成的 Promise。
 */
async function deleteRequest(row: SavedRequest) {
  try {
    await ElMessageBox.confirm(`删除「${row.name}」？`, '删除请求', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
    await removeRequest(row.id);
    requests.value = await readRequests();
    if (selectedId.value === row.id) {
      selectedId.value = '';
    }
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close') {
      reportError(cause);
    }
  }
}
/**
 * 新建空请求，保留全局默认超时设置。
 * @returns 无返回值。
 */
function newRequest() {
  invalidate();
  form.value = httpSchema.parse({ timeout: settings.value.timeout });
  selectedId.value = '';
}
/**
 * 展示 cURL 导入或导出窗口；导出与实际发送共用配置校验。
 * @param mode - 导入或导出模式。
 * @returns 窗口准备完成的 Promise。
 */
async function openCurl(mode: 'import' | 'export') {
  curlMode.value = mode;
  curlError.value = '';
  try {
    curlText.value =
      mode === 'export' ? exportCurl(form.value, await loadRequestFiles(form.value)) : '';
    curlOpen.value = true;
  } catch (cause) {
    reportError(cause);
  }
}
/**
 * 解析 cURL 并载入请求，文件路径保留为待选择提示。
 * @returns 无返回值；解析错误显示在对话框中。
 */
function applyCurl() {
  try {
    const result = importCurl(curlText.value);
    invalidate();
    form.value = result.state;
    selectedId.value = '';
    warnings.value = result.warnings;
    tab.value = result.state.bodyType === 'none' ? 'params' : 'body';
    curlOpen.value = false;
  } catch (cause) {
    curlError.value = cause instanceof Error ? cause.message : String(cause);
  }
}
/**
 * 下载已保存的响应，二进制从 Base64 还原为原始字节。
 * @returns 无返回值。
 */
function downloadResponse() {
  const response = form.value.response;
  if (response) {
    downloadBlob(
      responseBlob(response),
      response.truncated ? `partial-${response.filename}` : response.filename,
    );
  }
}
</script>

<template>
  <div v-if="ready" class="tool-surface http-tool">
    <div class="request-actions">
      <div class="request-title">
        <span class="eyebrow">REQUEST</span><strong>{{ form.name || '未命名请求' }}</strong
        ><ElTag v-if="selectedId" size="small" effect="plain">{{ form.folder }}</ElTag>
      </div>
      <div class="button-row">
        <ElButton :disabled="busy || saving" @click="newRequest">新建</ElButton
        ><ElButton :disabled="busy || saving" @click="openCollection">请求集合</ElButton
        ><ElButton :disabled="busy || saving" @click="openSave(false)">保存请求</ElButton
        ><ElButton v-if="selectedId" :disabled="busy || saving" @click="openSave(true)"
          >另存为</ElButton
        ><ElButton :disabled="busy || saving" @click="openCurl('import')">导入 cURL</ElButton
        ><ElButton :disabled="busy || saving" @click="openCurl('export')">导出 cURL</ElButton>
      </div>
    </div>
    <form class="request-bar" @submit.prevent="send">
      <ElSelect
        v-model="form.method"
        class="method-select"
        aria-label="HTTP 方法"
        filterable
        allow-create
        :disabled="busy"
        @change="form.method = form.method.toUpperCase()"
        ><ElOption
          v-for="method in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']"
          :key="method"
          :label="method"
          :value="method"
      /></ElSelect>
      <ElInput
        v-model="form.url"
        aria-label="请求地址"
        placeholder="https://api.example.com/users 或变量地址"
        :disabled="busy"
        required
      />
      <ElButton v-if="!busy" type="primary" native-type="submit" :disabled="saving">{{
        saving ? '保存附件…' : '发送请求'
      }}</ElButton
      ><ElButton v-else type="danger" plain @click="cancel">取消请求</ElButton>
    </form>
    <ElTabs v-model="tab" class="request-tabs">
      <ElTabPane label="查询参数" name="params" /><ElTabPane
        label="请求头"
        name="headers"
      /><ElTabPane label="请求体" name="body" /><ElTabPane label="鉴权" name="auth" /><ElTabPane
        label="变量"
        name="variables"
      /><ElTabPane label="请求设置" name="options" />
    </ElTabs>
    <div class="request-config" :inert="busy">
      <template v-if="tab === 'params'"
        ><PairsEditor v-model="form.params" label="查询参数" /><ElButton text @click="extractParams"
          >从 URL 提取参数到表格</ElButton
        ></template
      >
      <PairsEditor v-if="tab === 'headers'" v-model="form.headers" label="请求头" />
      <template v-if="tab === 'body'">
        <ElAlert
          v-if="['GET', 'HEAD'].includes(form.method)"
          :title="`${form.method} 请求不发送请求体`"
          type="info"
          :closable="false"
        />
        <div class="body-toolbar">
          <ElRadioGroup v-model="bodyMode" aria-label="请求体类型"
            ><ElRadioButton value="none">none</ElRadioButton
            ><ElRadioButton value="multipart">form-data</ElRadioButton
            ><ElRadioButton value="form">x-www-form-urlencoded</ElRadioButton
            ><ElRadioButton value="raw">raw</ElRadioButton
            ><ElRadioButton value="binary">binary</ElRadioButton></ElRadioGroup
          >
          <ElSelect
            v-if="bodyMode === 'raw'"
            v-model="form.bodyType"
            class="raw-format"
            aria-label="raw 格式"
            ><ElOption
              v-for="(label, value) in {
                json: 'JSON',
                text: 'Text',
                xml: 'XML',
                html: 'HTML',
                javascript: 'JavaScript',
              }"
              :key="value"
              :label="label"
              :value="value"
          /></ElSelect>
        </div>
        <CodeEditor
          v-if="bodyMode === 'raw'"
          v-model="form.body"
          label="请求体内容"
          :json="form.bodyType === 'json'"
        />
        <PairsEditor v-if="bodyMode === 'form'" v-model="form.fields" label="表单字段" />
        <MultipartEditor
          v-if="bodyMode === 'multipart'"
          v-model="form.multipart"
          @saving="fileSaving = $event"
        />
        <div v-if="bodyMode === 'binary'" class="binary-upload">
          <FilePicker label="选择 binary 文件" :disabled="binarySaving" @select="selectBinary" />
          <div v-if="form.binary" class="attachment-chip">
            <span>{{ form.binary.name }}</span
            ><small>{{ formatBytes(form.binary.size) }}</small
            ><ElButton text aria-label="移除 binary 文件" @click="form.binary = null">×</ElButton>
          </div>
          <p v-if="form.binaryHint" class="field-help">待选择：{{ form.binaryHint }}</p>
          <p class="field-help">将文件原始字节作为整个请求体发送，单文件最多 20 MB。</p>
        </div>
        <p v-if="bodyMode === 'none'" class="empty-inline">此请求没有请求体。</p>
      </template>
      <template v-if="tab === 'auth'">
        <label class="field narrow"
          >鉴权方式<ElSelect v-model="form.auth" aria-label="鉴权方式"
            ><ElOption label="No Auth" value="none" /><ElOption
              label="Bearer Token"
              value="bearer" /><ElOption label="Basic Auth" value="basic" /><ElOption
              label="API Key"
              value="api-key" /></ElSelect
        ></label>
        <label v-if="form.auth === 'bearer'" class="field"
          >Token<ElInput
            v-model="form.token"
            aria-label="Token"
            type="password"
            show-password
            autocomplete="off"
        /></label>
        <div v-if="form.auth === 'basic'" class="secret-grid">
          <label class="field"
            >用户名<ElInput v-model="form.username" aria-label="用户名" autocomplete="off" /></label
          ><label class="field"
            >密码<ElInput
              v-model="form.password"
              aria-label="密码"
              type="password"
              show-password
              autocomplete="off"
          /></label>
        </div>
        <div v-if="form.auth === 'api-key'" class="form-grid">
          <label class="field"
            >Key<ElInput v-model="form.apiKeyName" aria-label="API Key 名称" /></label
          ><label class="field"
            >Value<ElInput
              v-model="form.apiKeyValue"
              aria-label="API Key 值"
              type="password"
              show-password /></label
          ><label class="field"
            >添加位置<ElSelect v-model="form.apiKeyIn" aria-label="API Key 位置"
              ><ElOption label="Header" value="header" /><ElOption
                label="Query Params"
                value="query" /></ElSelect
          ></label>
        </div>
      </template>
      <template v-if="tab === 'variables'"
        ><PairsEditor v-model="form.variables" label="变量" />
        <p v-pre class="field-help">
          使用 {{ 变量名 }} 引用，例如
          {{
            baseUrl
          }}/users。变量仅作用于当前请求，可用于地址、参数、请求头、鉴权和文本请求体，并随集合保存。
        </p></template
      >
      <template v-if="tab === 'options'"
        ><label class="field narrow"
          >超时（毫秒）<ElInputNumber
            v-model="form.timeout"
            aria-label="超时（毫秒）"
            :min="100"
            :max="120000"
            :step="100"
        /></label>
        <div>
          <ElCheckbox v-model="form.credentials"
            >携带站点 Cookie（遵循浏览器 Cookie 策略）</ElCheckbox
          >
        </div>
        <div><ElCheckbox v-model="form.followRedirects">自动跟随重定向</ElCheckbox></div>
        <p class="field-help">
          关闭自动跟随时，遇到重定向会终止请求。浏览器不支持读取被阻止跳转的原始响应。
        </p></template
      >
    </div>
    <div v-if="error" role="alert" class="error-banner">{{ error }}</div>
    <div v-for="warning in warnings" :key="warning" class="tool-note" role="status">
      {{ warning }}
    </div>
    <section class="response-pane">
      <div class="pane-heading">
        <h2>响应</h2>
        <div v-if="form.response" class="response-meta">
          <span class="status-pill" :class="{ bad: form.response.status >= 400 }"
            >{{ form.response.status }} {{ form.response.statusText }}</span
          ><span>{{ form.response.duration }} ms</span
          ><span>{{ (form.response.size / 1024).toFixed(2) }} KB</span
          ><ElTag v-if="form.response.redirected" size="small" effect="plain">已重定向</ElTag>
        </div>
        <span v-else class="muted">{{ busy ? '等待服务器响应…' : '等待发送请求' }}</span>
      </div>
      <template v-if="form.response">
        <div class="toolbar compact">
          <ElRadioGroup v-model="responseTab" size="small" aria-label="响应视图"
            ><ElRadioButton value="pretty">Pretty</ElRadioButton
            ><ElRadioButton value="raw">Raw</ElRadioButton
            ><ElRadioButton v-if="responseJson.valid || imageUrl" value="preview"
              >预览</ElRadioButton
            ><ElRadioButton value="headers">响应头</ElRadioButton></ElRadioGroup
          ><span class="toolbar-spacer" /><ElButton
            text
            @click="copyText(responseText).catch(reportError)"
            >{{
              form.response.encoding === 'base64' && responseTab !== 'headers'
                ? '复制 Base64'
                : '复制响应'
            }}</ElButton
          ><ElButton text @click="downloadResponse">下载响应</ElButton>
        </div>
        <ElAlert
          v-if="form.response.truncated"
          title="响应超过 5 MB，仅保留前 5 MB；下载文件也是截取内容。"
          type="warning"
          :closable="false"
        />
        <p
          v-if="
            form.response.encoding === 'base64' &&
            responseTab !== 'headers' &&
            responseTab !== 'preview'
          "
          class="tool-note"
        >
          二进制响应 · {{ form.response.contentType }} · 下方为 Base64，下载可还原文件字节。
        </p>
        <div v-if="responseTab === 'preview' && imageUrl" class="response-image">
          <img :src="imageUrl" alt="接口返回的图片" />
        </div>
        <div v-else-if="responseTab === 'preview' && responseJson.valid" class="tree-container">
          <JsonTree :value="responseJson.value" />
        </div>
        <CodeEditor
          v-else
          :model-value="responseText"
          label="HTTP 响应"
          readonly
          :json="responseTab !== 'headers' && responseJson.valid"
        />
        <div class="editor-status">{{ form.response.url }}</div>
      </template>
      <div v-else class="empty-state">
        <span class="empty-symbol">↗</span>
        <h3>从一个请求开始</h3>
        <p>配置参数、鉴权或文件后发送。<br />常用接口可以命名并保存在请求集合中。</p>
      </div>
    </section>
    <div class="tool-note">
      请求由扩展直接发往目标地址。Host、Cookie 等请求头由浏览器控制；HTTPS
      证书错误需在浏览器中处理。
    </div>
    <ElDialog v-model="saveOpen" :title="saveAsNew ? '另存为请求' : '保存请求'" width="480px"
      ><label class="field"
        >请求名称<ElInput v-model="requestName" aria-label="请求名称" :maxlength="120" /></label
      ><label class="field"
        >集合名称<ElInput
          v-model="folderName"
          aria-label="集合名称"
          :maxlength="100"
          placeholder="默认集合" /></label
      ><template #footer
        ><ElButton @click="saveOpen = false">取消</ElButton
        ><ElButton type="primary" @click="persistRequest">确认保存</ElButton></template
      ></ElDialog
    >
    <ElDrawer v-model="collectionOpen" title="本地请求集合" size="min(480px, 100vw)"
      ><ElInput
        v-model="collectionQuery"
        aria-label="搜索请求集合"
        placeholder="搜索名称、集合或 URL"
        clearable
      /><ElEmpty v-if="!Object.keys(groups).length" description="还没有匹配的请求" />
      <section v-for="(items, folder) in groups" :key="folder" class="collection-group">
        <h3>{{ folder }}</h3>
        <div v-for="item in items" :key="item.id" class="collection-item">
          <ElButton text class="collection-load" @click="loadRequest(item)"
            ><ElTag size="small" effect="plain">{{ item.state.method }}</ElTag
            ><span
              ><strong>{{ item.name }}</strong
              ><small>{{ item.state.url || '未填写地址' }}</small></span
            ></ElButton
          ><ElButton
            text
            type="danger"
            :aria-label="`删除请求 ${item.name}`"
            @click="deleteRequest(item)"
            >删除</ElButton
          >
        </div>
      </section></ElDrawer
    >
    <ElDialog
      v-model="curlOpen"
      :title="curlMode === 'import' ? '导入 cURL' : '导出 cURL'"
      width="760px"
      ><p class="field-help">
        使用 POSIX / Bash
        格式。导入仅解析文本；本地文件需重新选择。导出的文件名需替换为实际路径，命令含当前鉴权信息。
      </p>
      <ElInput
        v-model="curlText"
        type="textarea"
        :rows="12"
        aria-label="cURL 命令"
        :readonly="curlMode === 'export'"
        placeholder="curl 'https://api.example.com/users'"
      />
      <p v-if="curlError" role="alert" class="error-banner">{{ curlError }}</p>
      <template #footer
        ><ElButton @click="curlOpen = false">关闭</ElButton
        ><ElButton v-if="curlMode === 'import'" type="primary" @click="applyCurl">导入请求</ElButton
        ><ElButton v-else type="primary" @click="copyText(curlText).catch(reportError)"
          >复制 cURL</ElButton
        ></template
      ></ElDialog
    >
  </div>
</template>
