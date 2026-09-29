<script setup lang="ts">
// Strudel's CodeMirror setup, minus its repl: we feed it the clip's compiled
// pattern and outline the mini-notation bits that are sounding right now.
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { EditorView, keymap, drawSelection, highlightSpecialChars } from '@codemirror/view'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { bracketMatching } from '@codemirror/language'
// deep imports: the package index pulls in a second copy of @strudel/core
// (@strudel/web bundles its own), these files only depend on CodeMirror
import { highlightExtension, updateMiniLocations, highlightMiniLocations } from '@strudel/codemirror/highlight.mjs'
import { flashField, flash } from '@strudel/codemirror/flash.mjs'
import strudelTheme from '@strudel/codemirror/themes/strudel-theme.mjs'
import { compile, clipTime } from '../music/conductor'
import type { Clip } from '../state'

const props = defineProps<{ modelValue: string; clip: Clip; readonly?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [string]; apply: [] }>()

const host = ref<HTMLDivElement>()
let view: EditorView | undefined
const editable = new Compartment()
const editableExt = (ro: boolean) => [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]
/** The compiled pattern of the clip's applied body (what's actually playing). */
const pattern = shallowRef<any>(null)

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        strudelTheme,
        editable.of(editableExt(!!props.readonly)),
        EditorView.theme({
          '&': { backgroundColor: 'var(--bg)', fontSize: '12px', height: '100%' },
          '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
          '.cm-content': { padding: '6px 0' },
          '&.cm-focused': { outline: '1px solid var(--accent-2)' },
        }),
        highlightSpecialChars(),
        history(),
        drawSelection({ cursorBlinkRate: 0 }),
        bracketMatching({ brackets: '()[]{}<>' } as any),
        javascript(),
        Prec.highest(highlightExtension),
        flashField,
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: (v) => {
                if (props.readonly) return true
                flash(v)
                emit('apply')
                return true
              },
            },
          ]),
        ),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
        }),
      ],
    }),
  })
  refreshLocations()
  requestAnimationFrame(frame)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  view?.destroy()
  view = undefined
})

// External changes to the draft (revert, switching clips, the band editing):
// replace only the span that differs, so the cursor and highlights stay put.
watch(
  () => props.modelValue,
  (v) => {
    if (!view) return
    const cur = view.state.doc.toString()
    if (v === cur) return
    let start = 0
    while (start < cur.length && start < v.length && cur[start] === v[start]) start++
    let end = 0
    while (end < cur.length - start && end < v.length - start && cur[cur.length - 1 - end] === v[v.length - 1 - end]) end++
    view.dispatch({ changes: { from: start, to: cur.length - end, insert: v.slice(start, v.length - end) } })
  },
)

watch(
  () => props.readonly,
  (ro) => view?.dispatch({ effects: editable.reconfigure(editableExt(!!ro)) }),
)

watch(() => [props.clip.ref, props.clip.body, props.clip.meta.bars], refreshLocations)

async function refreshLocations() {
  const clip = props.clip
  const res = await compile(clip)
  if (!view || clip.ref !== props.clip.ref || clip.body !== props.clip.body) return
  pattern.value = res?.pattern ?? null
  // Locations are offsets into the applied body; once set, CodeMirror remaps
  // them as the draft is edited. If the draft already differs, they'd be wrong.
  updateMiniLocations(view, res && view.state.doc.toString() === clip.body ? res.miniLocations : [])
}

let raf = 0
let shown = ''
function frame() {
  raf = requestAnimationFrame(frame)
  if (!view) return
  const t = pattern.value ? clipTime(props.clip.ref) : null
  const haps =
    t == null
      ? []
      : pattern.value
          .queryArc(t, t + 1 / 64)
          .filter((h: any) => h.whole && h.whole.begin.valueOf() <= t && t < h.whole.end.valueOf())
  const key = haps.map((h: any) => h.context?.locations?.map((l: any) => `${l.start}:${l.end}`).join()).join('|')
  if (key === shown) return
  shown = key
  highlightMiniLocations(view, t ?? 0, haps)
}
</script>

<template>
  <div ref="host" class="code" :class="{ frozen: readonly }" />
</template>

<style scoped>
.code {
  /* highlight outline color for haps without their own `.color()` */
  --foreground: #fff;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}
.frozen {
  opacity: 0.7;
}
</style>
