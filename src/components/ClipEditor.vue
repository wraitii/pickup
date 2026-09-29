<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { song, ui, clips, placements, songMeta } from '../state'
import { updateClip, moveFile, removeFile, undo, history } from '../song/fs'
import { chat } from '../agent/agent'
import { recordings, deleteRecording, recordingUrl } from '../music/recordings'
import StrudelEditor from './StrudelEditor.vue'

const clip = computed(() => (ui.selected ? clips.value[ui.selected] : undefined))
const status = computed(() => (clip.value ? ui.clipStatus[clip.value.ref] : undefined))
/** Last rejected change (the file is unchanged when this is set). */
const error = ref('')
/** Hands off while the band is working: its writes land in the editor, and ours can't race them. */
const frozen = computed(() => chat.busy)

// The code (without the clip() header) is drafted locally and applied on ⌘/Ctrl+Enter,
// so half-typed code never plays. The header is edited through the fields above it.
const draft = ref('')
const dirty = computed(() => !!clip.value && draft.value !== clip.value.body)
// set when the band changes a clip while we have unsaved edits: keep the draft, but flag it
const bandChanged = ref(false)
watch(
  () => [clip.value?.ref, clip.value?.body] as const,
  ([ref, body], old) => {
    if (ref !== old?.[0]) error.value = ''
    if (ref !== old?.[0] || draft.value === old?.[1]) {
      draft.value = body ?? ''
      bandChanged.value = false
    } else if (body !== draft.value) bandChanged.value = true
  },
  { immediate: true },
)

async function attempt(fn: () => unknown) {
  error.value = ''
  try {
    await fn()
  } catch (e: any) {
    error.value = e?.message ?? String(e)
  }
}

const apply = () =>
  attempt(async () => {
    if (!clip.value || frozen.value) return
    await updateClip(clip.value.ref, { body: draft.value })
    // the file normalizes whitespace; adopt its version so the draft isn't left "dirty"
    draft.value = clip.value.body
    bandChanged.value = false
  })
function revert() {
  draft.value = clip.value?.body ?? ''
  bandChanged.value = false
  error.value = ''
}

/** Rename via mv, so song.json and `from` links follow. */
function rename(part: 'section' | 'variant', e: Event) {
  const input = e.target as HTMLInputElement
  const c = clip.value
  if (!c) return
  const value = input.value.trim().toLowerCase()
  const to = part === 'section' ? `${value}/${c.variant}` : `${c.section}/${value}`
  attempt(() => moveFile(c.path, to)).then(() => {
    if (error.value) input.value = c[part]
  })
}
function setBars(e: Event) {
  const input = e.target as HTMLInputElement
  const c = clip.value
  if (c) attempt(() => updateClip(c.ref, { meta: { bars: Number(input.value) } })).then(() => (input.value = String(clip.value?.meta.bars)))
}
function setNote(e: Event) {
  const c = clip.value
  if (c) attempt(() => updateClip(c.ref, { meta: { note: (e.target as HTMLInputElement).value.trim() } }))
}

const canUndo = computed(() => !!clip.value && !!history[clip.value.path]?.length)
const inSong = computed(() => placements.value.filter((p) => p.clip === clip.value?.ref).length)

const uses = (name: string, text: string) => new RegExp(`\\b${name}\\b`).test(text)
/** Recorded takes this clip plays. */
const takes = computed(() => Object.values(recordings).filter((r) => clip.value && uses(r.name, clip.value.body)))

/** Forget a take along with this clip: only when nothing else in the song plays it. */
function removeTake(name: string) {
  const c = clip.value
  if (!c) return
  attempt(async () => {
    const other = Object.keys(song.files).find((p) => p !== c.path && uses(name, song.files[p]))
    if (other) throw new Error(`${other} also plays ${name}: change it first.`)
    if (inSong.value) throw new Error('This clip is in the song: remove it from the timeline first.')
    if (!confirm(`Delete the recording ${name} and ${c.path}? Other songs using it will lose it too.`)) return
    removeFile(c.path)
    await deleteRecording(name)
  })
}

function remove() {
  const c = clip.value
  if (!c || !confirm(`Delete ${c.path}?`)) return
  attempt(() => {
    if (songMeta.value.placements.some((p) => p.clip === c.ref)) throw new Error('This clip is in the song: remove it from the timeline first.')
    removeFile(c.path)
  })
}
</script>

<template>
  <section class="editor">
    <template v-if="clip">
      <div class="head">
        <input class="path" :value="clip.section" :disabled="frozen" title="section folder (rename)" @change="rename('section', $event)" />
        <span class="muted">/</span>
        <input class="path" :value="clip.variant" :disabled="frozen" title="variant name (rename)" @change="rename('variant', $event)" />
        <label class="muted" title="length in bars">
          <input type="number" min="1" max="64" :value="clip.meta.bars" class="bars" :disabled="frozen" @change="setBars" /> bars
        </label>
        <input class="note" :value="clip.meta.note ?? ''" :disabled="frozen" placeholder="what's this variant about?" @change="setNote" />
        <span v-if="clip.meta.from" class="muted from">
          from <a href="#" @click.prevent="ui.selected = clip.meta.from!">{{ clip.meta.from }}</a>
        </span>
        <button class="icon" :disabled="frozen || !canUndo" title="undo the last change to this file" @click="attempt(() => undo(clip!.path))">↶</button>
        <button class="icon" :disabled="frozen" title="delete clip" @click="remove">🗑</button>
      </div>

      <div v-for="t in takes" :key="t.name" class="take-row">
        <span class="mono small">{{ t.name }}</span>
        <audio class="take" controls :src="recordingUrl(t.name)" />
        <span class="muted small">{{ t.seconds.toFixed(1) }}s</span>
        <button class="icon" :disabled="frozen" title="delete this recording (and this clip)" @click="removeTake(t.name)">🗑</button>
      </div>

      <StrudelEditor v-model="draft" :clip="clip" :readonly="frozen" class="code" @apply="apply" />

      <div v-if="bandChanged" class="msg" style="color: var(--accent)">
        The band changed this clip while you were editing. Apply yours or revert to theirs.
      </div>
      <div v-if="error" class="err mono msg">✗ not applied: {{ error }}</div>
      <div v-else-if="status?.error" class="err mono msg">{{ status.error }}</div>
      <div v-else-if="status?.warnings?.length" class="muted msg">{{ status.warnings.join(' ') }}</div>

      <div class="bar">
        <template v-if="frozen">
          <span class="muted msg">The band is working: editing is paused until it's done.</span>
        </template>
        <template v-else-if="dirty">
          <span class="muted msg">unsaved edits</span>
          <button class="primary" @click="apply">apply ⌘↵</button>
          <button @click="revert">revert</button>
        </template>
      </div>
    </template>
    <p v-else class="muted empty">Select a clip above to see and edit its code.</p>
  </section>
</template>

<style scoped>
.take-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.take {
  height: 28px;
  flex: 1;
  max-width: 420px;
}
.small {
  font-size: 11px;
}
.editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px 10px;
  background: var(--panel);
}
.head {
  display: flex;
  gap: 4px;
  align-items: center;
}
.path {
  width: 90px;
  font-family: var(--mono);
  font-weight: 600;
}
.bars {
  width: 44px;
}
.note {
  flex: 1;
  min-width: 80px;
  margin-left: 6px;
}
.spacer {
  flex: 1;
}
.icon {
  background: transparent;
  border-color: transparent;
  padding: 2px 5px;
}
.from {
  flex: none;
  font-size: 11px;
  margin: 0 4px;
}
.from a {
  color: var(--accent-2);
  font-family: var(--mono);
}
.code {
  flex: 1;
  min-height: 60px;
}
.msg {
  font-size: 11px;
  white-space: pre-wrap;
}
.bar {
  display: flex;
  gap: 6px;
  align-items: center;
}
.empty {
  margin: 0;
}
</style>
