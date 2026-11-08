<script setup lang="ts">
import { computed, ref } from 'vue';
const props = withDefaults(
  defineProps<{
    value: unknown;
    name?: string;
    path?: (string | number)[];
    depth?: number;
    editable?: boolean;
  }>(),
  {
    name: '$',
    path: () => {
      return [];
    },
    depth: 0,
    editable: false,
  },
);
const emit = defineEmits<{
  edit: [path: (string | number)[], value: unknown];
  remove: [path: (string | number)[]];
  add: [path: (string | number)[], value: unknown];
}>();
const expanded = ref(props.depth < 2);
const limit = ref(100);
const compound = computed(() => {
  return props.value !== null && typeof props.value === 'object';
});
const entries = computed(() => {
  return compound.value ? Object.entries(props.value as object) : [];
});
const type = computed(() => {
  return props.value === null ? 'null' : Array.isArray(props.value) ? 'array' : typeof props.value;
});
const summary = computed(() => {
  return compound.value
    ? `${Array.isArray(props.value) ? '[' : '{'} ${entries.value.length} ${Array.isArray(props.value) ? '项 ]' : '个字段 }'}`
    : JSON.stringify(props.value);
});
</script>

<template>
  <div class="tree-node">
    <div class="tree-line">
      <ElButton
        v-if="compound"
        class="tree-toggle"
        :aria-label="`${expanded ? '折叠' : '展开'} ${name}`"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? '▾' : '▸' }}
      </ElButton>
      <span v-else class="tree-spacer" />
      <span class="tree-key">{{ name }}</span
      ><span class="muted">:</span>
      <span class="tree-value" :class="`type-${type}`">{{ summary }}</span>
      <span v-if="editable" class="tree-actions">
        <ElButton :aria-label="`编辑 ${name}`" title="编辑节点" @click="emit('edit', path, value)">
          编辑
        </ElButton>
        <ElButton
          v-if="compound"
          :aria-label="`添加到 ${name}`"
          title="添加子节点"
          @click="emit('add', path, value)"
        >
          ＋
        </ElButton>
        <ElButton :aria-label="`删除 ${name}`" title="删除节点" @click="emit('remove', path)">
          ×
        </ElButton>
      </span>
    </div>
    <div v-if="compound && expanded && depth < 80" class="tree-children">
      <JsonTree
        v-for="[key, val] in entries.slice(0, limit)"
        :key="key"
        :value="val"
        :name="key"
        :path="[...path, Array.isArray(value) ? Number(key) : key]"
        :depth="depth + 1"
        :editable="editable"
        @edit="(p, v) => emit('edit', p, v)"
        @remove="(p) => emit('remove', p)"
        @add="(p, v) => emit('add', p, v)"
      />
      <ElButton v-if="entries.length > limit" class="text-button" @click="limit += 100">
        再显示 100 项（剩余 {{ entries.length - limit }} 项）
      </ElButton>
    </div>
    <p v-if="compound && expanded && depth >= 80" class="muted">更深的节点请在代码编辑器中查看。</p>
  </div>
</template>
