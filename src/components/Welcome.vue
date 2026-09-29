<script setup lang="ts">
// First-launch splash: what Pickup is, where the API key goes, and a play
// button for the demo song (the click also unlocks audio). Shown once.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { settings, songMeta } from '../state'
import { start } from '../music/conductor'

const WELCOMED_KEY = 'pickup.welcomed'

function seen() {
  try {
    return !!localStorage.getItem(WELCOMED_KEY)
  } catch {
    return true
  }
}

const open = ref(!seen())
const icon = `${import.meta.env.BASE_URL}favicon.svg`
/** Set by the Pages workflow; unset in dev. */
const sourceUrl = import.meta.env.VITE_SOURCE_URL as string | undefined

function close() {
  open.value = false
  try {
    localStorage.setItem(WELCOMED_KEY, '1')
  } catch {}
}

function playDemo() {
  close()
  start()
}

const onKey = (e: KeyboardEvent) => e.key === 'Escape' && open.value && close()
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-if="open" class="backdrop" @click.self="close">
    <div class="card" role="dialog" aria-labelledby="welcome-title">
      <header>
        <img :src="icon" alt="" width="40" height="40" />
        <h1 id="welcome-title">Pickup</h1>
      </header>
      <p>
        Jam with an AI band. Tell it the vibe (<i>"darker"</i>, <i>"let the bass breathe"</i>,
        <i>"three options for the chorus"</i>) and it writes, arranges and plays
        <a href="https://strudel.cc" target="_blank" rel="noopener">Strudel</a> code on a timeline you can edit too.
      </p>
      <p>
        A demo song, <b>{{ songMeta.title }}</b>, is loaded to start you off.
      </p>
      <label>
        OpenRouter API key, to talk to the band
        <input v-model="settings.apiKey" type="password" placeholder="sk-or-..." autocomplete="off" />
      </label>
      <p class="muted small">
        Stored in this browser only. You can add it later in settings, or drive the band from a local
        subscription instead (<a v-if="sourceUrl" :href="sourceUrl + '#local-usage'" target="_blank" rel="noopener">see the README</a
        ><template v-else>see the README</template>).
      </p>
      <div class="actions">
        <button @click="close">close</button>
        <button class="primary" @click="playDemo">▶ play the demo</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: #000a;
}
.card {
  width: 440px;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 22px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 12px 40px #000c;
}
header {
  display: flex;
  align-items: center;
  gap: 12px;
}
h1 {
  margin: 0;
  font-size: 22px;
  color: var(--accent);
}
p {
  margin: 0;
}
.small {
  font-size: 12px;
}
a {
  color: var(--accent-2);
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--muted);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
