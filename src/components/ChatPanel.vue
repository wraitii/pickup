<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { userChangeList } from '../agent/changes'
import { chat, transcript, streaming, send, abort, userText, attachedChanges } from '../agent/agent'

type Line =
  | { kind: 'user'; text: string; changes: string }
  | { kind: 'band'; text: string }
  | { kind: 'tool'; name: string; summary: string; result?: string; diff?: string; image?: string; isError?: boolean; running: boolean }

function summarize(name: string, args: any): string {
  if (!args) return ''
  switch (name) {
    case 'edit':
      return `${args.path} (${args.edits?.length ?? 0} change${args.edits?.length === 1 ? '' : 's'})`
    case 'mv':
      return `${args.from} → ${args.to}`
    case 'list_sounds':
      return args.query ?? ''
    case 'ls':
      return ''
    default:
      return args.path ?? args.target ?? ''
  }
}

/** Colour unified-diff lines. */
function diffClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'muted'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  if (line.startsWith('@@')) return 'muted'
  return ''
}

const lines = computed<Line[]>(() => {
  const msgs = streaming.value ? [...transcript.value, streaming.value] : transcript.value
  const results = new Map<string, any>()
  for (const m of msgs as any[]) if (m.role === 'toolResult') results.set(m.toolCallId, m)
  const out: Line[] = []
  for (const m of msgs as any[]) {
    if (m.role === 'user') out.push({ kind: 'user', text: userText(m), changes: attachedChanges(m) })
    else if (m.role === 'assistant') {
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) out.push({ kind: 'band', text: b.text })
        else if (b.type === 'toolCall') {
          const r = results.get(b.id)
          out.push({
            kind: 'tool',
            name: b.name,
            summary: summarize(b.name, b.arguments),
            result: r?.content?.map((c: any) => c.text ?? '').join(''),
            image: r?.details?.image,
            diff: r?.details?.diff,
            isError: r?.isError,
            running: !r,
          })
        }
      }
      if (m.stopReason === 'error' && m.errorMessage) out.push({ kind: 'band', text: `⚠ ${m.errorMessage}` })
    }
  }
  return out
})

const pendingChanges = computed(() => userChangeList().length)

const input = ref('')
const log = ref<HTMLElement>()

function submit() {
  const text = input.value.trim()
  if (!text || chat.busy) return
  input.value = ''
  send(text)
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}

watch(
  () => lines.value.length + (streaming.value ? 1 : 0),
  () => nextTick(() => log.value?.scrollTo({ top: log.value.scrollHeight })),
)
</script>

<template>
  <section class="chat">
    <div ref="log" class="log">
      <p v-if="!lines.length" class="muted">
        Talk to the band: "late-night lo-fi, dusty drums, around 85 bpm", "make the bass groovier", "give me three
        options for a chorus"…
      </p>
      <p v-if="!lines.length" class="muted">
        You can also ask how to use Pickup: "How do I loop the chorus?" or "How do I record a take?"
      </p>
      <template v-for="(l, i) in lines" :key="i">
        <div v-if="l.kind === 'user'" class="user">
          <details v-if="l.changes" class="changes">
            <summary>+ your edits since last reply</summary>
            <pre>{{ l.changes }}</pre>
          </details>
          {{ l.text }}
        </div>
        <div v-else-if="l.kind === 'band'" class="band">{{ l.text }}</div>
        <details v-else class="tool" :class="{ error: l.isError }">
          <summary>
            <span class="name">{{ l.name }}</span> {{ l.summary }}
            <span v-if="l.running" class="muted">…</span>
          </summary>
          <pre v-if="l.diff" class="diff"><span v-for="(dl, j) in l.diff.split('\n')" :key="j" :class="diffClass(dl)">{{ dl }}
</span></pre>
          <pre v-else-if="l.result">{{ l.result }}</pre>
          <img v-if="l.image" class="spectrogram" :src="`data:image/png;base64,${l.image}`" alt="spectrogram" />
        </details>
      </template>
    </div>
    <div v-if="chat.error" class="err error-line">{{ chat.error }}</div>
    <div v-if="pendingChanges && !chat.busy" class="muted pending" title="tempo, code edits, variations and arrangement changes are sent as context">
      {{ pendingChanges }} hand edit{{ pendingChanges > 1 ? 's' : '' }} will be shared with the band in your next message
    </div>
    <div class="compose">
      <textarea v-model="input" rows="2" placeholder="talk to the band… (Enter to send)" @keydown="onKey" />
      <button v-if="chat.busy" @click="abort">stop</button>
      <button v-else class="primary" :disabled="!input.trim()" @click="submit">send</button>
    </div>
  </section>
</template>

<style scoped>
.chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.log {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.log p {
  margin: 0;
}
.user {
  align-self: flex-end;
  max-width: 85%;
  background: var(--panel-2);
  padding: 5px 9px;
  border-radius: 8px;
  white-space: pre-wrap;
}
.changes {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 3px;
}
.changes summary {
  cursor: pointer;
}
.changes pre {
  margin: 4px 0;
  font-size: 11px;
  white-space: pre-wrap;
  max-height: 200px;
  overflow: auto;
}
.band {
  max-width: 92%;
  white-space: pre-wrap;
}
.tool {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono);
}
.tool summary {
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool .name {
  color: var(--accent-2);
}
.tool.error .name {
  color: var(--err);
}
.diff .add {
  color: var(--ok);
}
.diff .del {
  color: var(--err);
}
.spectrogram {
  display: block;
  max-width: 100%;
  margin-top: 4px;
  border-radius: 3px;
}
.tool pre {
  margin: 4px 0 0;
  white-space: pre-wrap;
  font-size: 11px;
}
.pending {
  padding: 2px 10px;
  font-size: 11px;
}
.error-line {
  padding: 4px 10px;
  font-size: 12px;
}
.compose {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid var(--border);
}
.compose textarea {
  flex: 1;
  font-family: inherit;
  font-size: 13px;
  resize: none;
}
</style>
