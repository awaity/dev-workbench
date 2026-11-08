<script setup lang="ts">
import FilePicker from '../components/FilePicker.vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import QRCodeStyling from 'qr-code-styling';
import { qrSchema, type HistoryItem } from '../lib/models';
import { remember, reportError, settings, snapshot, useDraft } from '../lib/state';
import { downloadBlob } from '../lib/files';

const props = defineProps<{ restored?: HistoryItem }>();
const { form, ready } = useDraft('qrcode', qrSchema.parse({ size: settings.value.qrSize }), () => {
  return props.restored;
});
const container = ref<HTMLElement>();
const error = ref('');
const busy = ref(false);
const generated = ref('');
let qr: QRCodeStyling | undefined;
let generation = 0;
const contentBytes = computed(() => {
  return new TextEncoder().encode(form.value.text).length;
});
const stale = computed(() => {
  return !!generated.value && generated.value !== JSON.stringify(form.value);
});
const canDownload = computed(() => {
  return !!generated.value && !stale.value && !busy.value;
});
/**
 * 按 sRGB 规则计算相对亮度，用于二维码前景背景对比度校验。
 * @param hex - 六位十六进制颜色值。
 * @returns 0 到 1 之间的相对亮度。
 */
function luminance(hex: string) {
  const c = hex
    .slice(1)
    .match(/../g)!
    .map((v) => {
      const n = parseInt(v, 16) / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    });
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
/**
 * 校验内容与对比度后生成二维码，忽略已失效的异步结果。
 * @param save - 是否将此次生成写入历史；恢复预览时传入 false。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function generate(save = true) {
  const current = ++generation;
  error.value = '';
  busy.value = true;
  try {
    const value = qrSchema.parse(snapshot(form.value));
    if (!value.text.trim()) {
      throw new Error('请输入要生成二维码的文字或网址');
    }
    if (new TextEncoder().encode(value.text).length > 2200) {
      throw new Error('内容过长，请缩短至 2,200 个 UTF-8 字节以内；高纠错等级容量更小');
    }
    const dark = luminance(value.color);
    const light = luminance(value.background);
    if (dark >= light || (light + 0.05) / (dark + 0.05) < 3) {
      throw new Error('请使用深色码点和浅色背景，颜色对比度至少为 3:1');
    }
    const next = new QRCodeStyling({
      width: value.size,
      height: value.size,
      type: 'svg',
      // 打包版 qrcode-generator 默认按单字节读取字符，先提供 UTF-8 字节串。
      data: String.fromCharCode(...new TextEncoder().encode(value.text)),
      margin: value.margin,
      qrOptions: { errorCorrectionLevel: value.logo ? 'H' : value.level },
      dotsOptions: { color: value.color, type: value.dots },
      cornersSquareOptions: { color: value.color, type: value.corners },
      cornersDotOptions: { color: value.color, type: value.corners === 'dot' ? 'dot' : 'square' },
      backgroundOptions: { color: value.background },
      image: value.logo || undefined,
      imageOptions: {
        hideBackgroundDots: true,
        imageSize: value.logoSize,
        margin: 4,
        saveAsBlob: true,
      },
    });
    await next.getRawData('svg');
    if (current !== generation) {
      return;
    }
    await nextTick();
    container.value?.replaceChildren();
    if (container.value) {
      next.append(container.value);
    }
    qr = next;
    generated.value = JSON.stringify(value);
    if (save) {
      await remember(
        'qrcode',
        value.title || value.text.slice(0, 50),
        `${value.size} × ${value.size} · ${value.logo ? '含 Logo' : '文字二维码'}`,
        value,
      );
    }
  } catch (e) {
    if (current === generation) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    if (current === generation) {
      busy.value = false;
    }
  }
}
/**
 * 验证本地 Logo 的类型、大小与像素尺寸后保存为 data URL。
 * @param file - 用户选择的本地文件。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function upload(file: File) {
  try {
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 2 * 1024 * 1024
    ) {
      throw new Error('Logo 支持 PNG、JPG、WebP，大小不超过 2 MB');
    }
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(String(reader.result));
      };
      reader.onerror = () => {
        reject(new Error('Logo 读取失败'));
      };
      reader.readAsDataURL(file);
    });
    const image = new Image();
    image.src = data;
    await image.decode();
    if (image.naturalWidth > 4096 || image.naturalHeight > 4096) {
      throw new Error('Logo 长宽不能超过 4096 像素');
    }
    form.value.logo = data;
    form.value.level = 'H';
    error.value = '';
  } catch (e) {
    reportError(e);
  }
}
/**
 * 下载与当前配置一致的二维码，避免输出过期预览。
 * @param format - 输入或输出编码格式。
 * @returns 下载生成与校验完成的 Promise。
 */
async function download(format: 'png' | 'svg') {
  if (!qr || !canDownload.value) {
    return;
  }
  try {
    const blob = await qr.getRawData(format);
    if (!(blob instanceof Blob)) {
      throw new Error('下载生成失败，请重新生成二维码');
    }
    downloadBlob(
      blob,
      `${form.value.title.replace(/[/\\:*?"<>|]/g, '-').slice(0, 60) || 'qrcode'}.${format}`,
    );
  } catch (e) {
    reportError(e);
  }
}
watch(ready, (value) => {
  if (value && form.value.text) {
    void generate(false);
  }
});
watch(
  () => {
    return props.restored;
  },
  async () => {
    await nextTick();
    if (form.value.text) {
      void generate(false);
    }
  },
);
onBeforeUnmount(() => {
  generation++;
});
</script>
<template>
  <div v-if="ready" class="tool-surface qr-layout">
    <div class="qr-controls">
      <label class="field"
        >二维码内容<ElInput
          v-model="form.text"
          :rows="6"
          placeholder="输入文字、网址、产品编号…"
          aria-label="二维码内容"
          type="textarea"
        />
      </label>
      <div class="field-meta">
        <span>{{ contentBytes }} 字节</span
        ><ElButton class="text-button" @click="form.text = 'https://example.com'">
          使用示例网址
        </ElButton>
      </div>
      <label class="field"
        >名称（方便在历史中查找）<ElInput
          v-model="form.title"
          placeholder="例如：测试环境入口"
          maxlength="100"
          aria-label="名称（方便在历史中查找）"
      /></label>
      <h3 class="subheading">美化二维码</h3>
      <div class="form-grid two-columns">
        <label class="field"
          >尺寸（px）<ElInputNumber
            v-model="form.size"
            :min="128"
            :max="2048"
            :step="8"
            aria-label="尺寸（px）" /></label
        ><label class="field"
          >边距（px）<ElInputNumber
            v-model="form.margin"
            :min="4"
            :max="100"
            aria-label="边距（px）" /></label
        ><label class="field"
          >码点颜色
          <div class="color-field">
            <ElColorPicker v-model="form.color" aria-label="码点颜色" /><span>{{
              form.color
            }}</span>
          </div></label
        ><label class="field"
          >背景颜色
          <div class="color-field">
            <ElColorPicker v-model="form.background" aria-label="背景颜色" /><span>{{
              form.background
            }}</span>
          </div></label
        ><label class="field"
          >码点样式<ElSelect v-model="form.dots" aria-label="码点样式">
            <ElOption value="square" label="方形" />
            <ElOption value="rounded" label="圆角" />
            <ElOption value="dots" label="圆点" />
            <ElOption value="classy" label="叶形" /> </ElSelect></label
        ><label class="field"
          >定位点样式<ElSelect v-model="form.corners" aria-label="定位点样式">
            <ElOption value="square" label="方形" />
            <ElOption value="extra-rounded" label="圆角" />
            <ElOption value="dot" label="圆形" /> </ElSelect></label
        ><label class="field"
          >纠错等级<ElSelect v-model="form.level" :disabled="!!form.logo" aria-label="纠错等级">
            <ElOption value="L" label="L · 7%" />
            <ElOption value="M" label="M · 15%" />
            <ElOption value="Q" label="Q · 25%" />
            <ElOption value="H" label="H · 30%" /> </ElSelect></label
        ><label v-if="form.logo" class="field"
          >Logo 比例<ElSelect v-model="form.logoSize" aria-label="Logo 比例">
            <ElOption :value="0.15" label="15%" />
            <ElOption :value="0.22" label="22%" />
            <ElOption :value="0.3" label="30%" /> </ElSelect
        ></label>
      </div>
      <div class="logo-upload">
        <img v-if="form.logo" :src="form.logo" alt="已上传的 Logo" />
        <div>
          <FilePicker
            label="上传 Logo 文件"
            accept="image/png,image/jpeg,image/webp"
            @select="upload"
          /><ElButton v-if="form.logo" class="text-button danger-text" @click="form.logo = ''">
            移除
          </ElButton>
          <p>PNG / JPG / WebP，最多 2 MB。使用 Logo 时自动启用 H 纠错。</p>
        </div>
      </div>
      <ElButton class="primary wide" :disabled="busy" type="primary" @click="generate()">
        {{ busy ? '正在生成…' : '生成二维码并保存历史' }}
      </ElButton>
      <div v-if="error" role="alert" class="error-banner">{{ error }}</div>
    </div>
    <div class="qr-preview-panel">
      <div class="pane-heading">
        <h2>二维码预览</h2>
        <span class="local-label">本地生成</span>
      </div>
      <div class="qr-stage">
        <div ref="container" class="qr-image" :class="{ hidden: !generated }" />
        <div v-if="!generated" class="empty-state">
          <span class="empty-symbol">▦</span>
          <h3>让信息触手可及</h3>
          <p>填写内容，自定义样式，<br />生成你的第一张二维码。</p>
        </div>
      </div>
      <p v-if="stale" role="status" class="qr-caption">配置已变更，请重新生成后下载。</p>
      <p v-else-if="generated" class="qr-caption">
        {{ form.size }} × {{ form.size }} px · {{ form.logo ? 'H' : form.level }} 纠错
      </p>
      <div class="qr-downloads">
        <ElButton class="primary" :disabled="!canDownload" type="primary" @click="download('png')"
          >下载 PNG</ElButton
        ><ElButton :disabled="!canDownload" @click="download('svg')">下载 SVG</ElButton>
      </div>
      <p class="tool-note">
        静态二维码长期有效。下载前可用手机扫码确认内容；更换颜色或添加 Logo 后建议再次试扫。
      </p>
    </div>
  </div>
</template>
