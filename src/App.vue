<script setup lang="ts">
import { ref, watch } from 'vue'
import TopBar from './components/TopBar.vue'
import Timeline from './components/Timeline.vue'
import ClipEditor from './components/ClipEditor.vue'
import ChatPanel from './components/ChatPanel.vue'
import Welcome from './components/Welcome.vue'

// Timeline above, editor below: the divider sets the editor's share of the column.
const SPLIT_KEY = 'pickup.split'
const MIN = 0.15
const clampSplit = (f: number) => Math.min(1 - MIN, Math.max(MIN, f))
function loadSplit() {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY))
    if (v) return clampSplit(v)
  } catch {}
  return 0.42
}
const split = ref(loadSplit())
watch(split, (v) => {
  try {
    localStorage.setItem(SPLIT_KEY, String(v))
  } catch {}
})

const work = ref<HTMLElement>()
function startDrag(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    const r = work.value!.getBoundingClientRect()
    split.value = clampSplit((r.bottom - ev.clientY) / r.height)
  }
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}
</script>

<template>
  <div class="app">
    <TopBar />
    <main>
      <div ref="work" class="work">
        <Timeline class="board" />
        <div class="divider" title="drag to resize" @pointerdown.prevent="startDrag" />
        <ClipEditor class="editor" :style="{ height: split * 100 + '%' }" />
      </div>
      <aside>
        <ChatPanel />
      </aside>
    </main>
    <Welcome />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}
main {
  flex: 1;
  display: flex;
  min-height: 0;
}
.work {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.board {
  flex: 1;
  min-height: 0;
}
.editor {
  flex: none;
  min-height: 0;
}
.divider {
  flex: none;
  height: 5px;
  margin: -2px 0;
  position: relative;
  z-index: 1;
  cursor: row-resize;
  background: linear-gradient(transparent 2px, var(--border) 2px, var(--border) 3px, transparent 3px);
}
.divider:hover {
  background: linear-gradient(transparent 1px, var(--accent-2) 1px, var(--accent-2) 4px, transparent 4px);
}
aside {
  width: 400px;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  min-height: 0;
}
</style>
