<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  placeholder as editorPlaceholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  syntaxHighlighting,
  HighlightStyle,
  indentUnit,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { json as jsonLanguage } from '@codemirror/lang-json';
import { tags } from '@lezer/highlight';
import { settings } from '../lib/state';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    json?: boolean;
    readonly?: boolean;
    placeholder?: string;
  }>(),
  { json: false, readonly: false, placeholder: '在这里输入内容…' },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const container = ref<HTMLElement>();
let view: EditorView | undefined;
const indentation = new Compartment();
const language = new Compartment();
onMounted(() => {
  view = new EditorView({
    parent: container.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        history(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        foldGutter(),
        bracketMatching(),
        highlightSelectionMatches(),
        syntaxHighlighting(
          HighlightStyle.define([
            { tag: tags.string, color: 'var(--green)' },
            { tag: tags.propertyName, color: 'var(--accent)' },
            { tag: [tags.bool, tags.null], color: 'var(--code-literal)' },
            { tag: tags.number, color: 'var(--code-number)' },
            { tag: tags.punctuation, color: 'var(--muted)' },
          ]),
        ),
        EditorView.lineWrapping,
        editorPlaceholder(props.placeholder),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        indentation.of(indentUnit.of(' '.repeat(settings.value.indent))),
        EditorState.readOnly.of(props.readonly),
        EditorView.editable.of(!props.readonly),
        EditorView.contentAttributes.of({
          'aria-label': props.label,
          role: 'textbox',
          'aria-multiline': 'true',
          spellcheck: 'false',
          'data-editor': props.label,
        }),
        language.of(props.json ? [jsonLanguage()] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            emit('update:modelValue', update.state.doc.toString());
          }
        }),
      ],
    }),
  });
});
watch(
  () => {
    return props.modelValue;
  },
  (value) => {
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  },
);
watch(
  () => {
    return settings.value.indent;
  },
  (value) => {
    view?.dispatch({ effects: indentation.reconfigure(indentUnit.of(' '.repeat(value))) });
  },
);
onBeforeUnmount(() => {
  view?.destroy();
});
watch(
  () => {
    return props.json;
  },
  (value) => {
    view?.dispatch({ effects: language.reconfigure(value ? [jsonLanguage()] : []) });
  },
);
</script>

<template>
  <div ref="container" class="code-editor" :class="{ 'is-readonly': readonly }" />
</template>
