<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { wsSchema, type HistoryItem } from '../lib/models';
import { remember, reportError, snapshot, useDraft } from '../lib/state';
import { copyText, downloadText } from '../lib/files';
const props = defineProps<{ restored?: HistoryItem }>();
const { form, ready } = useDraft('websocket', wsSchema.parse({}), () => {
  return props.restored;
});
const status = ref<'closed' | 'connecting' | 'open'>('closed');
const error = ref('');
let socket: WebSocket | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
/**
 * 追加带时间与方向的消息，按上限裁剪日志数量和消息长度。
 * @param direction - 消息方向：发送、接收或连接事件。
 * @param text - 待处理的原始文本。
 * @returns 无返回值。
 */
function log(direction: 'send' | 'receive' | 'system', text: string) {
  form.value.logs.push({ time: new Date().toISOString(), direction, text: text.slice(0, 100000) });
  if (form.value.logs.length > 500) {
    form.value.logs.splice(0, form.value.logs.length - 500);
  }
}
/**
 * 解除 WebSocket 事件监听并关闭当前连接。
 * @returns 无返回值。
 */
function disconnect() {
  clearTimeout(timer);
  if (socket) {
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close(1000, '用户关闭');
    socket = undefined;
  }
  if (status.value !== 'closed') {
    log('system', '连接已断开');
  }
  status.value = 'closed';
}
/**
 * 将当前连接配置和消息日志保存为可恢复历史。
 * @returns 无返回值。
 */
function record() {
  void remember(
    'websocket',
    form.value.url,
    `${form.value.logs.length} 条日志`,
    snapshot(form.value),
  ).catch(reportError);
}
/**
 * 验证地址与子协议后建立连接，管理超时及收发事件。
 * @returns 无返回值。
 */
function connect() {
  disconnect();
  error.value = '';
  try {
    const url = new URL(form.value.url);
    if (!['ws:', 'wss:'].includes(url.protocol)) {
      throw new Error('地址必须以 ws:// 或 wss:// 开头');
    }
    if (url.hash || url.username || url.password) {
      throw new Error('WebSocket 地址不能包含片段或用户名密码');
    }
    const protocols = form.value.protocols
      .split(',')
      .map((s) => {
        return s.trim();
      })
      .filter(Boolean);
    const current = new WebSocket(url, protocols);
    current.binaryType = 'arraybuffer';
    socket = current;
    status.value = 'connecting';
    timer = setTimeout(() => {
      error.value = '连接超时';
      disconnect();
    }, 15000);
    current.onopen = () => {
      clearTimeout(timer);
      status.value = 'open';
      log('system', `连接成功${current.protocol ? `，协议 ${current.protocol}` : ''}`);
      record();
    };
    current.onmessage = (event) => {
      const text =
        typeof event.data === 'string'
          ? event.data
          : `[二进制 ${event.data.byteLength} 字节]\n${new TextDecoder().decode(event.data)}`;
      log('receive', text);
    };
    current.onerror = () => {
      error.value = '连接发生错误，请检查地址、网络、服务端 Origin 策略及证书';
    };
    current.onclose = (event) => {
      clearTimeout(timer);
      status.value = 'closed';
      socket = undefined;
      log('system', `连接关闭 · ${event.code}${event.reason ? ` · ${event.reason}` : ''}`);
      record();
    };
  } catch (e) {
    status.value = 'closed';
    error.value = e instanceof Error ? e.message : String(e);
  }
}
/**
 * 检查连接与发送队列，发送当前文本并追加本地日志。
 * @returns 无返回值。
 */
function send() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    error.value = '请先建立连接';
    return;
  }
  if (new TextEncoder().encode(form.value.message).length > 1024 * 1024) {
    error.value = '单条消息最多 1 MB';
    return;
  }
  if (socket.bufferedAmount > 1024 * 1024) {
    error.value = '发送队列繁忙，请稍后再试';
    return;
  }
  socket.send(form.value.message);
  log('send', form.value.message);
  error.value = '';
}
watch(
  () => {
    return props.restored;
  },
  disconnect,
  { flush: 'sync' },
);
onBeforeUnmount(disconnect);
/**
 * 将消息日志转换为可复制或下载的逐行文本。
 * @returns 按时间顺序排列的日志文本。
 */
const logText = () => {
  return form.value.logs
    .map((item) => {
      return `${item.time} [${item.direction}] ${item.text}`;
    })
    .join('\n');
};
</script>
<template>
  <div v-if="ready" class="tool-surface">
    <form class="request-bar" @submit.prevent="connect">
      <span class="protocol-label">WS</span
      ><ElInput
        v-model="form.url"
        aria-label="WebSocket 地址"
        placeholder="wss://example.com/socket"
        :disabled="status !== 'closed'"
        required
      /><ElButton v-if="status === 'closed'" class="primary" type="primary" native-type="submit"
        >建立连接</ElButton
      ><ElButton
        v-else
        native-type="button"
        @click="
          disconnect();
          record();
        "
      >
        {{ status === 'connecting' ? '取消连接' : '断开连接' }}
      </ElButton>
    </form>
    <div class="config-area">
      <label class="field"
        >子协议（可选，逗号分隔）<ElInput
          v-model="form.protocols"
          placeholder="例如 chat, json"
          :disabled="status !== 'closed'"
          aria-label="子协议（可选，逗号分隔）" /></label
      ><span class="status-pill" :class="{ neutral: status !== 'open' }">{{
        { open: '● 已连接', connecting: '○ 连接中', closed: '○ 未连接' }[status]
      }}</span>
    </div>
    <div v-if="error" role="alert" class="error-banner">{{ error }}</div>
    <div class="config-area">
      <label class="field"
        >发送内容<ElInput
          v-model="form.message"
          :rows="4"
          class="mono"
          placeholder="输入文本消息，Ctrl / ⌘ + Enter 发送"
          aria-label="发送内容"
          type="textarea"
          @keydown.ctrl.enter.prevent="send"
          @keydown.meta.enter.prevent="send" /></label
      ><ElButton class="primary" :disabled="status !== 'open'" type="primary" @click="send"
        >发送消息</ElButton
      >
    </div>
    <section class="ws-log">
      <div class="pane-heading">
        <h2>
          消息日志 <span class="muted">{{ form.logs.length }}</span>
        </h2>
        <div>
          <ElButton class="text-button" @click="record">保存到历史</ElButton
          ><ElButton class="text-button" @click="copyText(logText()).catch(reportError)"
            >复制</ElButton
          ><ElButton class="text-button" @click="downloadText(logText(), 'websocket.log')">
            下载</ElButton
          ><ElButton class="text-button" @click="form.logs = []">清空日志</ElButton>
        </div>
      </div>
      <div v-if="!form.logs.length" class="empty-state">
        <span class="empty-symbol">⇄</span>
        <p>建立连接后，收发消息将按时间排列在这里。</p>
      </div>
      <div v-else class="message-list" aria-live="polite">
        <div v-for="(item, i) in form.logs" :key="i" class="message-row" :class="item.direction">
          <span class="message-direction">{{
            { send: '↑ 发送', receive: '↓ 接收', system: '连接' }[item.direction]
          }}</span
          ><time>{{ new Date(item.time).toLocaleTimeString('zh-CN') }}</time>
          <pre>{{ item.text }}</pre>
        </div>
      </div>
    </section>
    <div class="tool-note">
      保留最近 500 条日志，每条最多 100,000 字符。离开工具会断开连接；浏览器 WebSocket
      不支持自定义握手请求头。
    </div>
  </div>
</template>
