<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import FilePicker from './FilePicker.vue';
import { multipartSchema, type MultipartField } from '../lib/models';
import { putAttachment } from '../lib/storage';
import { formatBytes } from '../lib/files';
import { reportError } from '../lib/state';
const rows = defineModel<MultipartField[]>({ required: true });
const emit = defineEmits<{ saving: [value: boolean] }>();
const pending = ref(0);
watch(
  pending,
  (value) => {
    emit('saving', value > 0);
  },
  { flush: 'sync' },
);
onBeforeUnmount(() => {
  emit('saving', false);
});
/**
 * 保存选中的附件并挂入对应字段，字段已移除时不再修改配置。
 * @param row - 接收文件的 form-data 行。
 * @param file - 用户选择的本地文件。
 * @returns 附件保存完成的 Promise。
 */
async function selectFile(row: MultipartField, file: File) {
  pending.value++;
  try {
    if (row.files.length >= 20) {
      throw new Error('每个字段最多选择 20 个文件');
    }
    const reference = await putAttachment(file);
    if (rows.value.includes(row) && row.files.length < 20) {
      row.files.push(reference);
      row.fileHint = '';
    }
  } catch (error) {
    reportError(error);
  } finally {
    pending.value--;
  }
}
/**
 * 添加一个默认文本字段，保留重复字段名称的能力。
 * @returns 无返回值。
 */
function add() {
  rows.value.push(multipartSchema.parse({ name: '', value: '', enabled: true }));
}
</script>
<template>
  <div class="multipart-editor">
    <div v-if="rows.length" class="multipart-heading" aria-hidden="true">
      <span /><span>名称</span><span>类型</span><span>值 / 文件</span><span>描述</span><span />
    </div>
    <div v-for="(row, index) in rows" :key="index" class="multipart-row">
      <ElCheckbox v-model="row.enabled" :aria-label="`form-data ${index + 1} 启用`" />
      <ElInput
        v-model="row.name"
        placeholder="字段名称"
        :aria-label="`form-data ${index + 1} 名称`"
      />
      <ElSelect v-model="row.kind" :aria-label="`form-data ${index + 1} 类型`"
        ><ElOption label="Text" value="text" /><ElOption label="File" value="file"
      /></ElSelect>
      <div class="multipart-value">
        <ElInput
          v-if="row.kind === 'text'"
          v-model="row.value"
          placeholder="值，支持变量"
          :aria-label="`form-data ${index + 1} 值`"
        />
        <template v-else>
          <FilePicker
            :label="`选择文件 ${index + 1}`"
            multiple
            @select="(file) => selectFile(row, file)"
          />
          <div v-for="(file, fileIndex) in row.files" :key="file.id" class="attachment-chip">
            <span :title="file.name">{{ file.name }}</span
            ><small>{{ formatBytes(file.size) }}</small
            ><ElButton
              text
              :aria-label="`移除文件 ${file.name}`"
              @click="row.files.splice(fileIndex, 1)"
              >×</ElButton
            >
          </div>
          <p v-if="row.fileHint" class="field-help">待选择：{{ row.fileHint }}</p>
        </template>
      </div>
      <ElButton
        text
        class="icon-button"
        :aria-label="`删除form-data ${index + 1}`"
        @click="rows.splice(index, 1)"
        >×</ElButton
      >
      <ElInput
        v-model="row.description"
        class="multipart-description"
        placeholder="描述（选填）"
        :aria-label="`form-data ${index + 1} 描述`"
      />
    </div>
    <p v-if="!rows.length" class="empty-inline">添加文本字段或文件，可使用相同名称上传多个文件。</p>
    <div class="pair-actions">
      <ElButton text type="primary" @click="add">＋ 添加 form-data 字段</ElButton
      ><span v-if="pending" role="status" class="muted">正在保存附件…</span>
    </div>
    <p class="field-help">
      单文件最多 20 MB，单次请求文件总计最多 50 MB。文件保存在本机，Content-Type 与 boundary
      自动生成。
    </p>
  </div>
</template>
