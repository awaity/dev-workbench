<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { InputInstance } from 'element-plus';
import { Clock, Search, Setting, Menu, Star, Delete, Close } from '@element-plus/icons-vue';
import { toolIds, tools, type HistoryItem, type ToolId } from './lib/models';
import { historyVersion, reportError, settings, snapshot } from './lib/state';
import {
  readHistory,
  readSettings,
  removeHistory,
  runAutoCleanup,
  writeSettings,
} from './lib/storage';
import { DATA_CLEANED, syncCleanupSchedule } from './lib/maintenance';
import { formatTime } from './lib/files';

const JsonTool = defineAsyncComponent(() => {
  return import('./tools/JsonTool.vue');
});
const CryptoTool = defineAsyncComponent(() => {
  return import('./tools/CryptoTool.vue');
});
const HttpTool = defineAsyncComponent(() => {
  return import('./tools/HttpTool.vue');
});
const WebSocketTool = defineAsyncComponent(() => {
  return import('./tools/WebSocketTool.vue');
});
const QrTool = defineAsyncComponent(() => {
  return import('./tools/QrTool.vue');
});
const SettingsTool = defineAsyncComponent(() => {
  return import('./tools/SettingsTool.vue');
});
const active = ref<ToolId | 'settings'>('json');
const loaded = ref(false);
const fatal = ref('');
const search = ref('');
const historySearch = ref('');
const searchInput = ref<InputInstance>();
const showHistory = ref(true);
const mobileNav = ref(false);
const history = ref<HistoryItem[]>([]);
const restored = ref<HistoryItem>();
const epoch = ref(0);
const current = computed(() => {
  return tools.find((tool) => {
    return tool.id === active.value;
  });
});
const groups = ['开发', 'JSON', '加密与编码', '二维码'];
const filteredTools = computed(() => {
  const q = search.value.toLowerCase().trim();
  return tools.filter((t) => {
    return `${t.name} ${t.id}`.toLowerCase().includes(q);
  });
});
const favorites = computed(() => {
  return tools.filter((t) => {
    return settings.value.favorites.includes(t.id);
  });
});
const historyRows = computed(() => {
  const q = historySearch.value.toLowerCase();
  return history.value.filter((row) => {
    return `${row.title} ${row.detail}`.toLowerCase().includes(q);
  });
});
const media = matchMedia('(prefers-color-scheme: dark)');
/**
 * 根据全局设置与系统偏好更新页面深浅主题。
 * @returns 无返回值。
 */
function theme() {
  document.documentElement.classList.toggle(
    'dark',
    settings.value.theme === 'dark' || (settings.value.theme === 'system' && media.matches),
  );
}
/**
 * 解析地址片段并切换到有效工具，未知片段回退到默认工具。
 * @returns 无返回值。
 */
function readHash() {
  const value = location.hash.slice(1);
  active.value =
    value === 'settings' || toolIds.includes(value as ToolId)
      ? (value as ToolId | 'settings')
      : settings.value.defaultTool;
}
/**
 * 导航至工具并关闭移动导航，按需保留历史恢复内容。
 * @param tool - 目标工具标识。
 * @param keepRestore - 是否保留当前历史恢复内容。
 * @returns 无返回值。
 */
function navigate(tool: ToolId | 'settings', keepRestore = false) {
  if (!keepRestore) {
    restored.value = undefined;
  }
  active.value = tool;
  location.hash = tool;
  mobileNav.value = false;
  historySearch.value = '';
}
/**
 * 处理工作台键盘快捷键，将搜索焦点移到工具导航。
 * @param event - 触发快捷键的键盘事件。
 * @returns 无返回值。
 */
function shortcuts(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    mobileNav.value = true;
    searchInput.value?.focus();
  }
}
/**
 * 读取当前工具历史，并忽略切换工具之前的过期读取结果。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function refreshHistory() {
  if (active.value === 'settings') {
    return;
  }
  const requested = active.value;
  try {
    const rows = await readHistory(requested);
    if (requested === active.value) {
      history.value = rows;
    }
  } catch (e) {
    reportError(e);
  }
}
/**
 * 切换当前工具的收藏状态并保存全局设置。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function favorite() {
  if (active.value === 'settings') {
    return;
  }
  const ids = settings.value.favorites;
  const next = {
    ...settings.value,
    favorites: ids.includes(active.value)
      ? ids.filter((id) => {
          return id !== active.value;
        })
      : [...ids, active.value],
  };
  try {
    await writeSettings(next);
    settings.value = next;
    historyVersion.value++;
  } catch (e) {
    reportError(e);
  }
}
/**
 * 创建历史记录快照并交给对应工具恢复。
 * @param row - 待恢复的历史记录。
 * @returns 无返回值。
 */
function restore(row: HistoryItem) {
  restored.value = snapshot(row);
  navigate(row.tool, true);
}
/**
 * 删除单条历史并刷新可见列表。
 * @param id - 要删除的记录 ID。
 * @returns 操作完成后的 Promise，错误由调用方或界面提示处理。
 */
async function erase(id: string) {
  try {
    await removeHistory(id);
    historyVersion.value++;
  } catch (e) {
    reportError(e);
  }
}
/**
 * 重新加载扩展工作台页面。
 * @returns 无返回值。
 */
function reload() {
  location.reload();
}
/**
 * 使已加载工具实例失效，以重新读取导入或重置后的数据。
 * @returns 无返回值。
 */
function reset() {
  epoch.value++;
  restored.value = undefined;
}
/**
 * 接收本扩展后台的清理通知，让历史列表和数据管理统计同步刷新。
 * @param message - 后台发送的事件对象。
 * @param sender - Chrome 提供的消息来源。
 * @returns 无返回值。
 */
function receiveCleanup(message: unknown, sender: chrome.runtime.MessageSender): void {
  if (
    sender.id === chrome.runtime.id &&
    message &&
    typeof message === 'object' &&
    'type' in message &&
    message.type === DATA_CLEANED
  ) {
    historyVersion.value++;
  }
}
watch(settings, () => {
  void syncCleanupSchedule().catch(reportError);
});
watch([active, historyVersion], refreshHistory);
watch(() => {
  return settings.value.theme;
}, theme);
onMounted(async () => {
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    chrome.runtime.onMessage.addListener(receiveCleanup);
  }
  try {
    await runAutoCleanup().catch(reportError);
    settings.value = await readSettings();
    readHash();
    theme();
    await refreshHistory();
    loaded.value = true;
  } catch (e) {
    fatal.value = `无法打开本地数据库：${e instanceof Error ? e.message : String(e)}`;
  }
  window.addEventListener('hashchange', readHash);
  window.addEventListener('keydown', shortcuts);
  media.addEventListener('change', theme);
});
onBeforeUnmount(() => {
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    chrome.runtime.onMessage.removeListener(receiveCleanup);
  }
  window.removeEventListener('hashchange', readHash);
  window.removeEventListener('keydown', shortcuts);
  media.removeEventListener('change', theme);
});
</script>

<template>
  <div v-if="fatal" class="startup-error" role="alert">
    <h1>无法启动工作台</h1>
    <p>{{ fatal }}</p>
    <ElButton @click="reload">重新加载</ElButton>
  </div>
  <div v-else-if="!loaded" class="startup-error" role="status">正在打开本地工作台…</div>
  <div v-else class="app-shell">
    <ElButton
      v-if="mobileNav"
      class="nav-overlay"
      aria-label="关闭工具导航"
      @click="mobileNav = false"
    />
    <aside class="sidebar" :class="{ 'mobile-open': mobileNav }">
      <ElLink class="brand" href="#json" :underline="false" @click.prevent="navigate('json')"
        ><img src="/favicon.svg" alt="" />
        <div><strong>开发工作台</strong><span>Developer workbench</span></div></ElLink
      >
      <div class="nav-search">
        <Search /><ElInput
          ref="searchInput"
          v-model="search"
          aria-label="搜索工具"
          placeholder="搜索工具"
        /><kbd>⌘ K</kbd>
      </div>
      <nav class="tool-navigation" aria-label="工具导航">
        <div v-if="!search && favorites.length" class="nav-group favorites">
          <h2>常用工具 <Star /></h2>
          <ElButton
            v-for="tool in favorites"
            :key="tool.id"
            :class="{ active: active === tool.id }"
            @click="navigate(tool.id)"
          >
            <span class="nav-mark">{{ tool.mark }}</span
            >{{ tool.name }}
          </ElButton>
        </div>
        <div v-for="group in groups" :key="group" class="nav-group nav-main">
          <template v-if="filteredTools.some((t) => t.group === group)"
            ><h2>{{ group }}</h2>
            <ElButton
              v-for="tool in filteredTools.filter((t) => t.group === group)"
              :key="tool.id"
              :data-tool="tool.id"
              :class="{ active: active === tool.id }"
              :aria-current="active === tool.id ? 'page' : undefined"
              @click="navigate(tool.id)"
            >
              <span class="nav-mark">{{ tool.mark }}</span
              >{{ tool.name }}
            </ElButton></template
          >
        </div>
        <p v-if="!filteredTools.length" class="nav-empty">没有找到工具，试试 JSON 或 SM4。</p>
      </nav>
      <div class="sidebar-footer">
        <ElButton :class="{ active: active === 'settings' }" @click="navigate('settings')">
          <Setting />全局设置<span>v1.2</span>
        </ElButton>
      </div>
    </aside>
    <main class="main-shell">
      <header class="topbar">
        <div class="breadcrumb">
          <ElButton
            class="icon-button mobile-menu"
            aria-label="打开工具导航"
            @click="mobileNav = !mobileNav"
          >
            <Menu /></ElButton
          ><span>工作台</span><span class="slash">/</span
          ><span>{{ current?.group || '偏好设置' }}</span>
        </div>
        <div class="top-actions">
          <span class="local-indicator"><i />数据仅存本机</span
          ><ElButton
            class="icon-button"
            title="全局设置"
            aria-label="打开全局设置"
            @click="navigate('settings')"
          >
            <Setting />
          </ElButton>
        </div>
      </header>
      <div class="workspace" :class="{ 'with-history': showHistory && active !== 'settings' }">
        <div class="tool-main">
          <div class="page-heading">
            <div>
              <h1>{{ current?.name || '全局设置' }}</h1>
              <p>{{ current?.description || '管理工作习惯、本地数据和备份。' }}</p>
            </div>
            <div v-if="active !== 'settings'" class="heading-actions">
              <ElButton
                class="icon-button favorite-action"
                :class="{ selected: settings.favorites.includes(active) }"
                :title="settings.favorites.includes(active) ? '取消收藏' : '收藏工具'"
                :aria-label="settings.favorites.includes(active) ? '取消收藏工具' : '收藏工具'"
                @click="favorite"
              >
                <Star /></ElButton
              ><ElButton
                class="history-toggle"
                :class="{ selected: showHistory }"
                @click="showHistory = !showHistory"
              >
                <Clock />历史
              </ElButton>
            </div>
          </div>
          <SettingsTool v-if="active === 'settings'" :key="`settings-${epoch}`" @reset="reset" />
          <HttpTool v-else-if="active === 'http'" :key="`http-${epoch}`" :restored="restored" />
          <WebSocketTool
            v-else-if="active === 'websocket'"
            :key="`ws-${epoch}`"
            :restored="restored"
          />
          <QrTool v-else-if="active === 'qrcode'" :key="`qr-${epoch}`" :restored="restored" />
          <JsonTool
            v-else-if="['json', 'json-editor', 'jsonpath'].includes(active)"
            :key="`${active}-${epoch}`"
            :tool="active"
            :restored="restored"
          />
          <CryptoTool v-else :key="`${active}-${epoch}`" :tool="active" :restored="restored" />
          <footer class="workspace-footer">
            <span
              ><i class="small-dot" />{{
                settings.saveDrafts ? '自动保存草稿已开启' : '自动保存草稿已关闭'
              }}</span
            ><span>你的日常开发工具，随手可用。</span>
          </footer>
        </div>
        <aside
          v-if="showHistory && active !== 'settings'"
          class="history-panel"
          aria-label="本地历史"
        >
          <div class="history-heading">
            <h2>
              本地历史 <span>{{ history.length }}</span>
            </h2>
            <ElButton class="icon-button" aria-label="收起历史" @click="showHistory = false">
              <Close />
            </ElButton>
          </div>
          <p class="history-caption">点击记录，恢复当时的内容与配置。</p>
          <ElInput
            v-model="historySearch"
            class="history-search"
            aria-label="搜索当前工具历史"
            placeholder="搜索历史…"
          />
          <div v-if="!settings.saveHistory" class="history-notice">
            新操作不记录历史，可在设置中开启。
          </div>
          <div v-if="!historyRows.length" class="history-empty">
            <Clock />
            <h3>{{ historySearch ? '没有匹配的记录' : '还没有操作记录' }}</h3>
            <p>{{ historySearch ? '换个关键词试试。' : '完成一次操作后，记录会出现在这里。' }}</p>
          </div>
          <div v-else class="history-list">
            <div v-for="row in historyRows" :key="row.id" class="history-item">
              <ElButton class="history-restore" @click="restore(row)">
                <time>{{ formatTime(row.createdAt) }}</time
                ><strong>{{ row.title }}</strong
                ><span>{{ row.detail }}</span></ElButton
              ><ElButton
                class="history-delete icon-button"
                aria-label="删除此记录"
                title="删除此记录"
                @click="erase(row.id)"
              >
                <Delete />
              </ElButton>
            </div>
          </div>
          <p class="history-footnote">
            所有工具合计保留最近 {{ settings.historyLimit }} 条<span v-if="settings.autoCleanup"
              ><br />自动清理 {{ settings.retentionDays }} 天前的历史</span
            >
          </p>
        </aside>
      </div>
    </main>
  </div>
</template>
