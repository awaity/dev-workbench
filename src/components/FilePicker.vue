<script setup lang="ts">
import { nextTick, ref } from 'vue';
import type { UploadFile, UploadInstance } from 'element-plus';
defineProps<{ label: string; accept?: string; multiple?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ select: [file: File] }>();
const upload = ref<UploadInstance>();
/**
 * 转交用户选择的文件并重置选择器，允许再次选择同名文件。
 * @param file - Element Plus 提供的本地文件记录。
 * @returns 选择器重置完成的 Promise。
 */
async function select(file: UploadFile) {
  if (file.raw) {
    emit('select', file.raw);
  }
  await nextTick();
  upload.value?.clearFiles();
}
</script>
<template>
  <ElUpload
    ref="upload"
    class="file-picker"
    :auto-upload="false"
    :show-file-list="false"
    :accept="accept"
    :multiple="multiple"
    :disabled="disabled"
    @change="select"
  >
    <ElButton :disabled="disabled" :aria-label="label">{{ label }}</ElButton>
  </ElUpload>
</template>
