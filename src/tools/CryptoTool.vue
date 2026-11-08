<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import CodeEditor from '../components/CodeEditor.vue';
import { cryptoSchema, type HistoryItem, type ToolId } from '../lib/models';
import { remember, reportError, snapshot, useDraft } from '../lib/state';
import { copyText, downloadText } from '../lib/files';

const props = defineProps<{ tool: ToolId; restored?: HistoryItem }>();
const { form, ready } = useDraft(
  props.tool,
  cryptoSchema.parse({ format: ['sm2', 'sm4'].includes(props.tool) ? 'hex' : 'base64' }),
  () => {
    return props.restored;
  },
);
const busy = ref(false);
const error = ref('');
let worker: Worker | undefined;
const symmetric = computed(() => {
  return ['sm4', 'aes', 'des'].includes(props.tool);
});
const asymmetric = computed(() => {
  return ['sm2', 'rsa'].includes(props.tool);
});
const reversible = computed(() => {
  return symmetric.value || asymmetric.value || ['base64', 'url'].includes(props.tool);
});
const encodeLabel = computed(() => {
  return ['md5', 'sha'].includes(props.tool)
    ? '计算摘要'
    : props.tool === 'bcrypt'
      ? '生成哈希'
      : props.tool === 'jwt'
        ? '解析 JWT'
        : ['base64', 'url'].includes(props.tool)
          ? '编码'
          : '加密';
});
const hint = computed(() => {
  const hints: Partial<Record<ToolId, string>> = {
    md5: 'MD5 是不可逆摘要。「原文匹配」只在你提供的候选或数字范围内尝试，无法保证找到原文。',
    jwt: '解析不代表签名可信。填写密钥可验证 HS256；时间校验使用本机时钟。',
    bcrypt: 'Bcrypt 自动生成随机盐；原文最多 72 字节。较大的工作因子计算更慢，可随时取消。',
    rsa: '支持公钥 SPKI / PKCS#1、私钥 PKCS#1 / PKCS#8 PEM。RSA 适合短文本，长内容请使用对称加密。',
    sm2: '公钥和密文使用 04 开头的未压缩点格式。私钥为 64 位 Hex；密文含完整性校验。',
    des: 'DES / Triple DES 适合兼容旧系统；新系统建议使用现代认证加密。',
    base64: 'Base64 是编码方式；UTF-8 文本支持中文与 Emoji。URL 安全格式省略末尾 =。',
    url: '组件编码适合参数值，整体 URL 编码保留 : / ? & 等地址结构字符。',
  };
  return (
    hints[props.tool] ?? '所有计算在本机完成。Hex 每两位表示一个字节；UTF-8 中文通常占 3 字节。'
  );
});
/**
 * 终止计算 Worker，并解除界面忙碌状态。
 * @returns 无返回值。
 */
function cancel() {
  worker?.terminate();
  worker = undefined;
  busy.value = false;
}
watch(
  () => {
    return props.restored;
  },
  () => {
    cancel();
    error.value = '';
  },
);
onBeforeUnmount(cancel);
/**
 * 将校验后的计算任务交给 Worker，接收结果并写入操作历史。
 * @param action - 待执行的操作名称。
 * @returns 无返回值。
 */
function execute(action: string) {
  cancel();
  error.value = '';
  busy.value = true;
  const submitted = snapshot(form.value);
  worker = new Worker(new URL('../workers/crypto.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = async (event) => {
    cancel();
    if (event.data.error) {
      error.value = event.data.error;
      return;
    }
    try {
      if (action === 'generate') {
        const pair = JSON.parse(event.data.output);
        form.value.publicKey = pair.publicKey;
        form.value.privateKey = pair.privateKey;
        ElMessage.success('密钥已生成');
      } else {
        form.value.output = event.data.output;
        await remember(
          props.tool,
          `${props.tool.toUpperCase()} · ${action === 'decrypt' ? '解码 / 解密' : action === 'verify' ? '校验' : action === 'range' || action === 'dictionary' ? '原文匹配' : encodeLabel.value}`,
          submitted.input.slice(0, 100) || '空字符串',
          { ...submitted, output: event.data.output },
        );
      }
    } catch (e) {
      reportError(e);
    }
  };
  worker.onerror = (event) => {
    error.value = `执行失败：${event.message}`;
    cancel();
  };
  worker.postMessage({ tool: props.tool, state: submitted, action });
}
/**
 * 为当前算法生成符合字节长度要求的随机密钥或 IV。
 * @param field - 要生成的字段，取 key 或 iv。
 * @returns 无返回值。
 */
function random(field: 'key' | 'iv') {
  const length = props.tool === 'des' ? (field === 'key' && form.value.tripleDes ? 24 : 8) : 16;
  form.value[field] = Array.from(crypto.getRandomValues(new Uint8Array(length)), (v) => {
    return v.toString(16).padStart(2, '0');
  }).join('');
  form.value[field === 'key' ? 'keyFormat' : 'ivFormat'] = 'hex';
}
/**
 * 加载当前算法的可运行示例，同时清除旧结果。
 * @returns 无返回值。
 */
function example() {
  form.value.input =
    props.tool === 'jwt'
      ? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
      : 'Hello, 开发者 👋';
  if (symmetric.value) {
    form.value.key =
      props.tool === 'des'
        ? form.value.tripleDes
          ? '123456789012345678901234'
          : '12345678'
        : '1234567890abcdef';
    form.value.iv = props.tool === 'des' ? '87654321' : 'abcdef1234567890';
    form.value.keyFormat = 'utf8';
    form.value.ivFormat = 'utf8';
    form.value.padding = 'pkcs7';
  }
  if (props.tool === 'md5') {
    form.value.input = 'hello';
    form.value.target = '5d41402abc4b2a76b9719d911017c592';
    form.value.candidates = 'world\nhello\n开发者';
  }
  error.value = '';
  form.value.output = '';
}
</script>

<template>
  <div v-if="ready" class="tool-surface">
    <div class="config-area" :inert="busy">
      <div v-if="symmetric || asymmetric" class="form-grid">
        <label v-if="symmetric" class="field"
          >加密模式<ElSelect v-model="form.mode" aria-label="加密模式">
            <ElOption value="CBC" label="CBC" />
            <ElOption value="ECB" label="ECB" /> </ElSelect
        ></label>
        <label v-if="symmetric" class="field"
          >填充方式<ElSelect v-model="form.padding" aria-label="填充方式">
            <ElOption value="pkcs7" label="PKCS#7" />
            <ElOption value="none" label="无填充" /> </ElSelect
        ></label>
        <label class="field"
          >密文格式<ElSelect v-model="form.format" aria-label="密文格式">
            <ElOption value="hex" label="Hex" />
            <ElOption value="base64" label="Base64" /> </ElSelect
        ></label>
        <label v-if="tool === 'sm2'" class="field"
          >密文顺序<ElSelect v-model="form.sm2Mode" aria-label="密文顺序">
            <ElOption value="C1C3C2" label="C1C3C2" />
            <ElOption value="C1C2C3" label="C1C2C3" /> </ElSelect
        ></label>
        <label v-if="tool === 'rsa'" class="field"
          >填充方案<ElSelect v-model="form.rsaPadding" aria-label="填充方案">
            <ElOption value="OAEP-SHA256" label="OAEP · SHA-256" />
            <ElOption value="OAEP-SHA1" label="OAEP · SHA-1" />
            <ElOption value="PKCS1" label="PKCS#1 v1.5" /> </ElSelect
        ></label>
        <label v-if="tool === 'rsa'" class="field"
          >密钥位数<ElSelect v-model="form.rsaBits" aria-label="密钥位数">
            <ElOption value="2048" label="2048" />
            <ElOption value="3072" label="3072" />
            <ElOption value="4096" label="4096" /> </ElSelect
        ></label>
        <div v-if="tool === 'des'" class="check-field">
          <ElCheckbox v-model="form.tripleDes" aria-label="使用 Triple DES"
            >使用 Triple DES</ElCheckbox
          >
        </div>
      </div>
      <div v-if="symmetric" class="secret-grid">
        <label class="field"
          >密钥
          <div class="input-group">
            <ElInput
              v-model="form.key"
              autocomplete="off"
              placeholder="输入密钥"
              aria-label="密钥"
            /><ElSelect v-model="form.keyFormat" aria-label="密钥格式">
              <ElOption value="utf8" label="UTF-8" />
              <ElOption value="hex" label="Hex" /></ElSelect
            ><ElButton @click="random('key')">随机</ElButton>
          </div></label
        >
        <label v-if="form.mode === 'CBC'" class="field"
          >IV 偏移量
          <div class="input-group">
            <ElInput
              v-model="form.iv"
              autocomplete="off"
              placeholder="输入 IV"
              aria-label="IV 偏移量"
            /><ElSelect v-model="form.ivFormat" aria-label="IV 格式">
              <ElOption value="utf8" label="UTF-8" />
              <ElOption value="hex" label="Hex" /></ElSelect
            ><ElButton @click="random('iv')">随机</ElButton>
          </div></label
        >
      </div>
      <template v-if="asymmetric">
        <div class="toolbar compact">
          <ElButton @click="execute('generate')">生成{{ tool.toUpperCase() }} 密钥对</ElButton
          ><span class="muted">生成结果仅保存在本机</span>
        </div>
        <div class="secret-grid">
          <label class="field"
            >公钥<ElInput
              v-model="form.publicKey"
              :rows="3"
              class="mono"
              placeholder="加密时使用"
              aria-label="公钥"
              type="textarea" /></label
          ><label class="field"
            >私钥<ElInput
              v-model="form.privateKey"
              :rows="3"
              class="mono"
              placeholder="解密时使用"
              aria-label="私钥"
              type="textarea"
            />
          </label>
        </div>
      </template>
      <div v-if="tool === 'sha'" class="form-grid">
        <label class="field"
          >摘要算法<ElSelect v-model="form.sha" aria-label="摘要算法">
            <ElOption
              v-for="s in ['SHA1', 'SHA224', 'SHA256', 'SHA384', 'SHA512']"
              :key="s"
              :value="s"
              :label="s"
            /> </ElSelect
        ></label>
        <div class="check-field">
          <ElCheckbox v-model="form.hmac" aria-label="使用 HMAC">使用 HMAC</ElCheckbox>
        </div>
        <div class="check-field">
          <ElCheckbox v-model="form.uppercase" aria-label="大写输出">大写输出</ElCheckbox>
        </div>
        <label v-if="form.hmac" class="field"
          >HMAC 密钥<ElInput v-model="form.key" autocomplete="off" aria-label="HMAC 密钥"
        /></label>
      </div>
      <div v-if="tool === 'md5'" class="form-grid">
        <div class="check-field">
          <ElCheckbox v-model="form.md5Short" aria-label="16 位摘要（中间 16 位）"
            >16 位摘要（中间 16 位）</ElCheckbox
          >
        </div>
        <div class="check-field">
          <ElCheckbox v-model="form.uppercase" aria-label="大写输出">大写输出</ElCheckbox>
        </div>
      </div>
      <div v-if="tool === 'base64'" class="check-field">
        <ElCheckbox v-model="form.urlSafe" aria-label="使用 URL 安全 Base64"
          >使用 URL 安全 Base64</ElCheckbox
        >
      </div>
      <div v-if="tool === 'url'" class="form-grid">
        <label class="field"
          >编码范围<ElSelect v-model="form.wholeUrl" aria-label="编码范围">
            <ElOption :value="false" label="URL 组件（encodeURIComponent）" />
            <ElOption :value="true" label="完整 URL（encodeURI）" /> </ElSelect
        ></label>
        <div class="check-field">
          <ElCheckbox v-model="form.formUrl" aria-label="空格与 + 互转">空格与 + 互转</ElCheckbox>
        </div>
      </div>
      <label v-if="tool === 'bcrypt'" class="field narrow"
        >工作因子<ElInputNumber v-model="form.rounds" :min="4" :max="16" aria-label="工作因子"
      /></label>
      <label v-if="tool === 'jwt'" class="field"
        >HS256 验签密钥（可选）<ElInput
          v-model="form.key"
          placeholder="留空仅解析；填写后同时验证签名"
          autocomplete="off"
          aria-label="HS256 验签密钥（可选）"
      /></label>
    </div>
    <div class="toolbar">
      <ElButton class="primary" :disabled="busy" type="primary" @click="execute('encrypt')">{{
        encodeLabel
      }}</ElButton
      ><ElButton v-if="reversible" :disabled="busy" @click="execute('decrypt')">
        {{ ['base64', 'url'].includes(tool) ? '解码' : '解密' }}</ElButton
      ><ElButton
        v-if="busy"
        class="danger-text"
        @click="
          cancel();
          error = '操作已取消';
        "
      >
        取消计算</ElButton
      ><span v-if="busy" role="status" class="muted">正在本机计算…</span
      ><span class="toolbar-spacer" /><ElButton :disabled="busy" @click="example"
        >载入示例</ElButton
      >
    </div>
    <div v-if="error" role="alert" class="error-banner">{{ error }}</div>
    <div class="split-editors" :inert="busy">
      <section class="editor-pane">
        <div class="pane-heading">
          <h2>输入内容</h2>
          <ElButton
            class="text-button"
            @click="
              form.input = '';
              form.output = '';
            "
          >
            清空
          </ElButton>
        </div>
        <CodeEditor v-model="form.input" label="加密输入" />
        <div class="editor-status">{{ form.input.length }} 字符</div>
      </section>
      <section class="editor-pane">
        <div class="pane-heading">
          <h2>输出结果</h2>
          <div>
            <ElButton class="text-button" @click="copyText(form.output).catch(reportError)">
              复制</ElButton
            ><ElButton
              class="text-button"
              :disabled="!form.output"
              @click="downloadText(form.output, `${tool}-result.txt`)"
            >
              下载</ElButton
            ><ElButton
              class="text-button"
              :disabled="!form.output"
              @click="
                form.input = form.output;
                form.output = '';
              "
            >
              作为输入
            </ElButton>
          </div>
        </div>
        <CodeEditor
          v-model="form.output"
          label="加密结果"
          readonly
          :json="tool === 'jwt'"
          placeholder="运行后在这里查看结果"
        />
        <div class="editor-status">{{ form.output.length }} 字符<span>本地运算</span></div>
      </section>
    </div>
    <div v-if="tool === 'md5' || tool === 'bcrypt'" class="config-area" :inert="busy">
      <h3>{{ tool === 'md5' ? '校验与原文匹配' : '校验已有哈希' }}</h3>
      <div class="input-group">
        <ElInput
          v-model="form.target"
          :aria-label="tool === 'md5' ? '目标 MD5' : '目标 Bcrypt 哈希'"
          :placeholder="tool === 'md5' ? '待匹配的 16 / 32 位 MD5' : '$2b$10$…'"
        /><ElButton @click="execute('verify')">校验输入原文</ElButton>
      </div>
      <ElCollapse v-if="tool === 'md5'" class="advanced"
        ><ElCollapseItem name="advanced" title="本地候选匹配（MD5 解密）">
          <label class="field"
            >候选文本，每行一条<ElInput
              v-model="form.candidates"
              :rows="4"
              placeholder="hello&#10;world"
              aria-label="候选文本，每行一条"
              type="textarea" /></label
          ><ElButton @click="execute('dictionary')">匹配候选文本</ElButton>
          <div class="form-grid range-fields">
            <label class="field"
              >数字起点<ElInputNumber
                v-model="form.rangeStart"
                :min="0"
                aria-label="数字起点" /></label
            ><label class="field"
              >数字终点<ElInputNumber
                v-model="form.rangeEnd"
                :min="0"
                aria-label="数字终点" /></label
            ><label class="field"
              >最少位数（前补零）<ElInputNumber
                v-model="form.digits"
                :min="1"
                :max="12"
                aria-label="最少位数（前补零）" /></label
            ><ElButton @click="execute('range')">匹配数字范围</ElButton>
          </div>
        </ElCollapseItem></ElCollapse
      >
    </div>
    <div class="tool-note">{{ hint }}</div>
  </div>
</template>
