<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { song, settings, reasoningLevels, ui, songMeta, clips, trackCount } from '../state'
import { updateSong, writeFile } from '../song/fs'
import { MAX_TRACKS, formatClipFile } from '../song/format'
import { library, openSong, createSong, deleteSong, exportSong, importSong } from '../song/library'
import { start, stop, unloop } from '../music/conductor'
import { recorder, recordings, startRecording, stopRecording, saveRecording, recName, takeBars, REC_PREFIX } from '../music/recordings'
import { chat, transcript, bandModelOptions, resetChat } from '../agent/agent'
import { failedSampleMaps } from '../music/strudel'

/** Set by the Pages workflow; unset in dev. */
const sourceUrl = import.meta.env.VITE_SOURCE_URL as string | undefined
const logoUrl = `${import.meta.env.BASE_URL}favicon.svg`
const header = ref<HTMLElement>()
const showAbout = ref(false)
const showSettings = ref(false)
const showSongs = ref(false)
const importError = ref('')
const songs = computed(() => Object.values(library).sort((a, b) => b.updated - a.updated))
const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })

const model = computed(() => bandModelOptions.find((m) => m.id === settings.model))
const ctxPct = computed(() =>
  model.value ? Math.min(100, (chat.usage.contextTokens / model.value.contextWindow) * 100) : 0,
)

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : `${n}`)
const price = (m: (typeof bandModelOptions)[number]) => `$${m.cost.input}/$${m.cost.output} per M · ${k(m.contextWindow)} ctx`

const loopLabel = computed(() => {
  const l = song.loop
  if (!l) return ''
  if (l.kind === 'clip') return l.ref
  return l.to - l.from === 1 ? `bar ${l.from + 1}` : `bars ${l.from + 1}–${l.to}`
})

// title and tempo live in song.json; edits go through the same validation as the band's
function setTitle(e: Event) {
  const title = (e.target as HTMLInputElement).value
  updateSong((s) => (s.title = title))
}
function setBpm(e: Event) {
  const input = e.target as HTMLInputElement
  const bpm = Number(input.value)
  updateSong((s) => (s.bpm = bpm)).catch(() => (input.value = String(songMeta.value.bpm)))
}

// recording: a take becomes the sample rec_<name>, played by a new clip rec/<name>
const recSeconds = ref(0)
let recTimer: number | undefined
async function toggleRec() {
  if (!recorder.active) {
    await startRecording()
    if (recorder.active) recTimer = window.setInterval(() => (recSeconds.value = (performance.now() - recorder.started) / 1000), 200)
    return
  }
  clearInterval(recTimer)
  recSeconds.value = 0
  const take = await stopRecording()
  if (!take) return
  const n = Object.keys(recordings).length + 1
  const input = prompt(`Name this take (${take.seconds.toFixed(1)}s):`, `take${n}`)
  if (input === null) return
  let name = recName(input)
  for (let i = 2; recordings[name]; i++) name = `${recName(input)}_${i}`
  await saveRecording({ name, ...take })

  // an ordinary clip that plays the take once, on a new track at the loop start: add effects there
  const bars = takeBars(take.seconds, songMeta.value.bpm)
  let ref = `rec/${name.slice(REC_PREFIX.length)}`
  for (let i = 2; clips.value[ref]; i++) ref = `rec/${name.slice(REC_PREFIX.length)}_${i}`
  const at = song.loop?.kind === 'bars' ? song.loop.from : Math.floor(ui.cursor)
  const track = Math.min(MAX_TRACKS - 1, trackCount.value)
  try {
    await writeFile(
      `${ref}.js`,
      formatClipFile(
        { bars, note: `recorded take, ${take.seconds.toFixed(1)}s` },
        `$: s("${name}").slow(${bars})`,
      ),
    )
    ui.selected = ref
    await updateSong((s) => s.placements.push({ at, track, clip: ref }))
  } catch (e: any) {
    recorder.error = `Recorded ${name}, but could not place it: ${e.message}`
  }
}

function toggle() {
  ui.playing ? stop() : start()
}

function closeDrawers() {
  showAbout.value = false
  showSettings.value = false
  showSongs.value = false
}

function onOutsidePointerDown(e: PointerEvent) {
  const target = e.target
  if (!(target instanceof Element)) return
  // Toggles handle their own closing/switching on click.
  if (header.value?.contains(target) && target.closest('.drawer, [data-drawer-toggle]')) return
  closeDrawers()
}

// space plays/stops, except while typing
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeDrawers()
    return
  }
  if ((e.target as HTMLElement | null)?.closest('button, a')) return
  if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
  const el = e.target as HTMLElement | null
  if (el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
  e.preventDefault()
  toggle()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  document.addEventListener('pointerdown', onOutsidePointerDown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('pointerdown', onOutsidePointerDown, true)
})

// switching songs clears the chat: say so before throwing a conversation away
const leaveChat = () => !transcript.value.length || confirm('Switch songs? The chat with the band will be cleared (the song is saved).')

function onNewSong() {
  if (!leaveChat()) return
  createSong()
  showSongs.value = false
}
function onOpen(id: string) {
  if (id === song.id || !leaveChat()) return
  openSong(id)
  showSongs.value = false
}
function onDelete(id: string, title: string) {
  if (confirm(`Delete "${title}" from this browser? Export it first if you want to keep a copy.`)) deleteSong(id)
}
async function onImport(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !leaveChat()) return
  importError.value = ''
  try {
    await importSong(file)
    showSongs.value = false
  } catch (err: any) {
    importError.value = err.message
  }
}
</script>

<template>
  <header ref="header">
    <div class="brand" aria-label="Pickup">
      <img :src="logoUrl" width="24" height="24" alt="" />
      <span>Pickup</span>
    </div>
    <button class="primary play" @click="toggle">{{ ui.playing ? '■ stop' : '▶ play' }}</button>
    <button
      class="rec"
      :class="{ on: recorder.active }"
      :title="recorder.error || (recorder.active ? 'stop recording' : 'record from the microphone')"
      @click="toggleRec"
    >
      {{ recorder.active ? `■ ${recSeconds.toFixed(0)}s` : '● rec' }}
    </button>
    <span v-if="recorder.error" class="rec-error">{{ recorder.error }}</span>
    <input class="title" :value="songMeta.title" @change="setTitle" />
    <label>bpm <input type="number" min="30" max="300" :value="songMeta.bpm" class="bpm" @change="setBpm" /></label>
    <template v-if="song.loop">
      <span class="muted">looping <b class="loop">{{ loopLabel }}</b></span>
      <button
        :title="ui.playing ? 'stop looping and carry on through the song from here' : 'stop looping: play plays the song'"
        @click="unloop"
      >
        {{ ui.playing ? '▶ continue' : '✕ unloop' }}
      </button>
    </template>
    <span v-else class="muted">from <b class="loop">bar {{ Math.floor(ui.cursor) + 1 }}</b></span>
    <span v-if="ui.pending" class="pending">⏳ next bar</span>
    <span
      v-if="failedSampleMaps.length"
      class="error"
      :title="`could not load ${failedSampleMaps.join(', ')} from GitHub: those sounds are silent until you reload`"
    >
      ⚠ some samples didn't load
    </span>

    <span class="spacer" />

    <span class="usage" :title="`context: ${chat.usage.contextTokens} tokens of ${model?.contextWindow ?? '?'}`">
      <span class="meter"><span :style="{ width: ctxPct + '%' }" /></span>
      {{ k(chat.usage.contextTokens) }} ctx · ${{ chat.usage.cost.toFixed(3) }}
    </span>
    <button data-drawer-toggle @click="(showSongs = !showSongs), (showSettings = false), (showAbout = false)">songs</button>
    <button data-drawer-toggle @click="(showSettings = !showSettings), (showSongs = false), (showAbout = false)">settings</button>
    <button data-drawer-toggle :aria-expanded="showAbout" aria-controls="about-panel" @click="(showAbout = !showAbout), (showSettings = false), (showSongs = false)">about</button>

    <section v-if="showAbout" id="about-panel" class="drawer about" aria-labelledby="about-heading">
      <h2 id="about-heading">About Pickup</h2>
      <p>A place to make music with an AI band.</p>
      <p>Built by <a href="https://github.com/wraitii" target="_blank" rel="noopener noreferrer">wraitii</a>.</p>
      <p>
        Pickup reuses <a href="https://strudel.cc" target="_blank" rel="noopener noreferrer">Strudel</a>
        for live coding music and playing your patterns.
      </p>
      <p class="muted">Also built with:</p>
      <ul class="credits">
        <li><a href="https://vuejs.org" target="_blank" rel="noopener noreferrer">Vue</a> — interface</li>
        <li><a href="https://codemirror.net" target="_blank" rel="noopener noreferrer">CodeMirror</a> — code editor</li>
        <li><a href="https://github.com/earendil-works/pi" target="_blank" rel="noopener noreferrer">Pi</a> — AI band and model integration</li>
      </ul>
      <p class="muted">
        Free software under the
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">AGPL-3.0</a>
        <template v-if="sourceUrl"> · <a :href="sourceUrl" target="_blank" rel="noopener noreferrer">source code</a></template>
      </p>
    </section>

    <div v-if="showSongs" class="drawer">
      <div class="row">
        <button title="start a new jam (the current song stays in the library)" @click="onNewSong">+ new song</button>
        <label class="button">
          import…
          <input type="file" accept=".json,application/json" hidden @change="onImport" />
        </label>
      </div>
      <p v-if="importError" class="error">{{ importError }}</p>
      <ul class="songs">
        <li v-for="s in songs" :key="s.id" :class="{ current: s.id === song.id }">
          <button class="open" :title="s.id === song.id ? 'open now' : 'open this song'" @click="onOpen(s.id)">
            <b>{{ s.title }}</b>
            <span class="muted">{{ when(s.updated) }}</span>
          </button>
          <button title="download as a .pickup.json file" @click="exportSong(s.id)">export</button>
          <button v-if="s.id !== song.id" title="delete from this browser" @click="onDelete(s.id, s.title)">✕</button>
        </li>
      </ul>
      <p class="muted">Songs are kept in this browser. Export to back one up or share it.</p>
    </div>

    <div v-if="showSettings" class="drawer">
      <label>
        OpenRouter API key
        <input type="password" v-model="settings.apiKey" placeholder="sk-or-..." autocomplete="off" />
      </label>
      <p class="muted">Stored in this browser's localStorage only.</p>
      <label>
        band model (chat + tools)
        <select v-model="settings.model">
          <option v-for="m in bandModelOptions" :key="m.id" :value="m.id">{{ m.id }} — {{ price(m) }}</option>
        </select>
      </label>
      <label>
        reasoning effort
        <select v-model="settings.reasoning" :disabled="!model?.reasoning">
          <option v-for="level in reasoningLevels" :key="level" :value="level">{{ level }}</option>
        </select>
      </label>
      <p class="muted">{{ model?.reasoning ? 'Higher effort can take longer and cost more. Applies to your next message.' : 'Reasoning effort is not available for this model.' }}</p>
      <div class="row">
        <button title="forget the conversation but keep the song; the band gets the full song again" @click="resetChat">
          reset chat
        </button>
      </div>
      <p class="muted">
        Pickup is free software under the
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener">AGPL-3.0</a>
        <template v-if="sourceUrl"> · <a :href="sourceUrl" target="_blank" rel="noopener">source code</a></template>
      </p>
    </div>
  </header>
</template>

<style scoped>
header {
  position: relative;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.brand {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 7px;
  margin-right: 4px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.4px;
}
.drawer.about {
  width: 340px;
  line-height: 1.6;
}
.about h2 {
  margin: 0;
  font-size: 15px;
}
.credits {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--muted);
}
.play {
  min-width: 70px;
}
.rec {
  color: var(--err);
  min-width: 58px;
}
.rec.on {
  background: var(--err);
  color: var(--bg);
}
.rec-error {
  color: var(--err);
  font-size: 12px;
}
.title {
  width: 180px;
  font-weight: 600;
  background: transparent;
  border-color: transparent;
}
.bpm {
  width: 56px;
}
.loop {
  color: var(--accent-2);
  font-weight: 500;
}
.pending {
  color: var(--accent);
}
.spacer {
  flex: 1;
}
.usage {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}
.meter {
  width: 60px;
  height: 5px;
  background: var(--panel-2);
  border-radius: 3px;
  overflow: hidden;
}
.meter span {
  display: block;
  height: 100%;
  background: var(--accent-2);
}
.drawer {
  position: absolute;
  top: 100%;
  right: 10px;
  z-index: 20;
  width: 420px;
  max-width: calc(100vw - 20px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px #0008;
}
.drawer label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--muted);
}
.drawer p {
  margin: 0;
  font-size: 12px;
}
.drawer select,
.drawer input,
.drawer textarea {
  color: var(--text);
}
.row {
  display: flex;
  gap: 8px;
}
/* a <label> dressed as a button (wraps the hidden file input); beats `.drawer label` */
.drawer label.button {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel-2);
  color: var(--text);
  cursor: pointer;
}
.drawer label.button:hover {
  border-color: var(--muted);
}
.error {
  color: var(--err);
}
.drawer a {
  color: var(--accent-2);
}
.songs {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 50vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.songs li {
  display: flex;
  gap: 4px;
}
.songs .open {
  flex: 1;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
}
.songs .current .open {
  border-color: var(--accent-2);
}
</style>
