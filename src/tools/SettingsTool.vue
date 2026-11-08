<script setup lang="ts">
import FilePicker from '../components/FilePicker.vue';
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { DATA_CHANNEL } from '../lib/changes';
import { ElMessage, ElMessageBox } from 'element-plus';
import { defaultSettings, settingsSchema, tools } from '../lib/models';
import { historyVersion, reportError, settings, snapshot } from '../lib/state';
import {
  clearAll,
  cleanAttachments,
  MAX_BACKUP_BYTES,
  clearHistory,
  database,
  exportBackup,
  importBackup,
  runAutoCleanup,
  writeSettings,
} from '../lib/storage';
import { downloadBlob } from '../lib/files';
const emit = defineEmits<{ reset: [] }>();
const form = ref(snapshot(settings.value));
const count = ref(0);
const draftCount = ref(0);
const requestCount = ref(0);
const attachmentCount = ref(0);
const todoCount = ref(0);
let channel: BroadcastChannel | undefined;
const usage = ref('');
const busy = ref(false);
/**
 * 读取历史、草稿、集合、附件和待办数量，并估算本机存储占用。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function stats() {
  const db = await database();
  count.value = await db.count('history');
  draftCount.value = await db.count('drafts');
  requestCount.value = await db.count('requests');
  attachmentCount.value = await db.count('attachments');
  todoCount.value = await db.count('todos');
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    usage.value = `${((estimate.usage ?? 0) / 1024 / 1024).toFixed(2)} MB`;
  }
}
onMounted(() => {
  void stats().catch(reportError);
  channel = new BroadcastChannel(DATA_CHANNEL);
  channel.onmessage = () => {
    void stats().catch(reportError);
  };
});
onUnmounted(() => {
  channel?.close();
});
watch(historyVersion, () => {
  void stats().catch(reportError);
});
/**
 * 校验并保存全局设置，使主题、历史与草稿策略立即生效。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function save() {
  busy.value = true;
  try {
    const value = settingsSchema.parse(snapshot(form.value));
    await writeSettings(value);
    settings.value = value;
    historyVersion.value++;
    await stats();
    ElMessage.success('全局设置已保存');
  } catch (e) {
    reportError(e);
  } finally {
    busy.value = false;
  }
}
/**
 * 按已保存的保留期限立即清理过期数据，并同步历史和存储统计。
 * @returns 清理及统计更新完成的 Promise。
 */
async function cleanupExpired() {
  busy.value = true;
  try {
    const result = await runAutoCleanup();
    historyVersion.value++;
    await stats();
    ElMessage.success(`已清理 ${result.history} 条过期历史、${result.attachments} 个过期附件`);
  } catch (error) {
    reportError(error);
  } finally {
    busy.value = false;
  }
}
/**
 * 导出包含本地配置、历史、集合、附件和待办的 JSON 备份文件。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function backup() {
  busy.value = true;
  try {
    downloadBlob(
      new Blob([JSON.stringify(await exportBackup())], { type: 'application/json' }),
      `dev-workbench-backup-${new Date().toISOString().slice(0, 10)}.json`,
    );
  } catch (e) {
    reportError(e);
  } finally {
    busy.value = false;
  }
}
/**
 * 验证用户选择的备份并在界面确认后原子替换本地数据。
 * @param file - 用户选择的本地文件。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function restore(file: File) {
  busy.value = true;
  try {
    if (file.size > MAX_BACKUP_BYTES) {
      throw new Error('备份文件最大 200 MB');
    }
    const parsed = JSON.parse(await file.text());
    await ElMessageBox.confirm(
      '导入会替换当前设置、草稿、历史、请求集合和附件；版本 3 备份也会替换待办，旧版备份保留现有待办。建议先导出当前备份。',
      '导入本地备份',
      { confirmButtonText: '确认替换', cancelButtonText: '取消', type: 'warning' },
    );
    settings.value = await importBackup(parsed);
    form.value = snapshot(settings.value);
    historyVersion.value++;
    await stats();
    emit('reset');
    ElMessage.success('备份已导入');
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') {
      reportError(e);
    }
  } finally {
    busy.value = false;
  }
}
/**
 * 确认后清空历史或全部本地数据，并刷新界面统计。
 * @param all - 为 true 时清空全部数据，否则仅清空历史。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function erase(all: boolean) {
  try {
    await ElMessageBox.confirm(
      all
        ? '这会删除所有待办、工具草稿、密钥、Logo、历史、请求集合、附件和设置，无法撤销。'
        : '删除全部操作历史？工具草稿和设置会保留。',
      all ? '清除全部数据' : '清空历史',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' },
    );
    if (all) {
      await clearAll();
      settings.value = snapshot(defaultSettings);
      form.value = snapshot(defaultSettings);
      emit('reset');
    } else {
      await clearHistory();
    }
    historyVersion.value++;
    await stats();
    ElMessage.success('已清除');
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') {
      reportError(e);
    }
  }
}
/**
 * 清理已不被草稿、历史和集合引用的附件，刷新存储统计。
 * @returns 清理完成的 Promise。
 */
async function cleanup() {
  busy.value = true;
  try {
    const result = await cleanAttachments();
    await stats();
    ElMessage.success(
      `已清理 ${result.count} 个附件，释放 ${(result.bytes / 1024 / 1024).toFixed(2)} MB`,
    );
  } catch (error) {
    reportError(error);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="settings-layout">
    <section class="settings-section">
      <div class="section-intro">
        <h2>工作习惯</h2>
        <p>让工作台以你习惯的方式打开。</p>
      </div>
      <div class="settings-fields">
        <label class="field"
          >外观<ElSelect v-model="form.theme" aria-label="外观">
            <ElOption value="light" label="浅色" />
            <ElOption value="dark" label="深色" />
            <ElOption value="system" label="跟随系统" /> </ElSelect></label
        ><label class="field"
          >默认工具<ElSelect v-model="form.defaultTool" aria-label="默认工具">
            <ElOption
              v-for="tool in tools"
              :key="tool.id"
              :value="tool.id"
              :label="tool.name"
            /> </ElSelect></label
        ><label class="field"
          >JSON 缩进<ElSelect v-model="form.indent" aria-label="JSON 缩进">
            <ElOption :value="2" label="2 个空格" />
            <ElOption :value="4" label="4 个空格" /> </ElSelect></label
        ><label class="field"
          >新 HTTP 请求超时（毫秒）<ElInputNumber
            v-model="form.timeout"
            :min="100"
            :max="120000"
            aria-label="新 HTTP 请求超时（毫秒）" /></label
        ><label class="field"
          >新二维码尺寸（px）<ElInputNumber
            v-model="form.qrSize"
            :min="128"
            :max="2048"
            aria-label="新二维码尺寸（px）"
        /></label>
      </div>
    </section>
    <section class="settings-section">
      <div class="section-intro">
        <h2>本地保存</h2>
        <p>记录只保存在此浏览器的扩展中。</p>
      </div>
      <div class="settings-fields">
        <div class="check-field">
          <ElCheckbox v-model="form.saveDrafts" aria-label="自动保存工具草稿"
            >自动保存工具草稿</ElCheckbox
          >
        </div>
        <p class="field-help">
          关闭并保存会删除现有草稿。草稿包含当前输入、密钥、请求内容和 Logo。
        </p>
        <div class="check-field">
          <ElCheckbox v-model="form.saveHistory" aria-label="记录操作历史">记录操作历史</ElCheckbox>
        </div>
        <p class="field-help">关闭后不记录新历史，已有记录仍按数量与自动清理规则保留。</p>
        <label class="field"
          >最多保留历史（所有工具合计）<ElInputNumber
            v-model="form.historyLimit"
            :min="10"
            :max="2000"
            aria-label="最多保留历史（所有工具合计）"
        /></label>
      </div>
    </section>
    <section class="settings-section">
      <div class="section-intro">
        <h2>数据管理</h2>
        <p>
          {{ count }} 条历史 · {{ draftCount }} 份草稿 · {{ requestCount }} 个请求 ·
          {{ attachmentCount }} 个附件 · {{ todoCount }} 条待办<span v-if="usage">
            · 已用 {{ usage }}</span
          >
        </p>
      </div>
      <div class="settings-fields">
        <div class="field">
          <ElSwitch
            v-model="form.autoCleanup"
            aria-label="自动清理过期数据"
            active-text="自动清理过期数据"
            :disabled="busy"
          />
        </div>
        <label class="field narrow"
          >数据保留天数<ElInputNumber
            v-model="form.retentionDays"
            aria-label="数据保留天数"
            :min="1"
            :max="3650"
            :precision="0"
            :step="1"
            :disabled="busy || !form.autoCleanup"
        /></label>
        <p class="field-help">
          默认保留 30 天，可设置 1–3650
          天。自动清理超过期限的历史记录和无引用附件；待办、草稿、请求集合及仍被引用的文件会保留。
        </p>
        <p class="field-help">
          修改后点击「保存设置」立即生效。开启后每天检查，打开工作台时也会检查；浏览器关闭期间的检查会在下次启动时补做。
        </p>
        <div class="button-row">
          <ElButton :disabled="busy || !settings.autoCleanup" @click="cleanupExpired"
            >按已保存规则清理</ElButton
          >
        </div>
        <p class="field-help">
          备份包含待办、原始数据、密钥、请求集合与文件附件，请妥善保管。支持旧版备份，文件上限 200
          MB。
        </p>
        <div class="button-row">
          <ElButton :disabled="busy" @click="backup">导出本地备份</ElButton
          ><FilePicker
            label="导入备份"
            accept="application/json,.json"
            :disabled="busy"
            @select="restore"
          />
        </div>
        <div class="button-row">
          <ElButton :disabled="busy" @click="cleanup">清理未引用附件</ElButton
          ><ElButton class="danger-text" :disabled="busy" @click="erase(false)"
            >清空全部历史</ElButton
          ><ElButton class="danger-text" :disabled="busy" @click="erase(true)"
            >清除全部数据</ElButton
          >
        </div>
      </div>
    </section>
    <div class="settings-save">
      <ElButton :disabled="busy" @click="form = snapshot(defaultSettings)">恢复默认设置</ElButton
      ><ElButton class="primary" type="primary" :disabled="busy" @click="save">保存设置</ElButton>
    </div>
    <p class="tool-note">
      版本 1.3.0 ·
      无账号、无遥测、无需云服务。卸载扩展、清除扩展数据或更换浏览器配置会影响本地数据，请定期备份。
    </p>
  </div>
</template>
