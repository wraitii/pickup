<script setup lang="ts">
// The song as a sequencer timeline: clips placed at bars on parallel tracks,
// plus a library of every clip (grouped by section) to drag onto it.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { song, ui, clips, placements, songLength, trackCount, variantsOf, trackAudible, type Clip, type PlacedClip } from '../state'
import { updateSong } from '../song/fs'
import { MAX_TRACKS } from '../song/format'
import { seek } from '../music/conductor'

/** Lane height when its blocks are small (and for the spare lane). */
const MIN_LANE = 40
/** Block layout: a header line, then one condensed row per variant of the section. */
const HEAD_H = 17
const ROW_H = 15
const BLOCK_PAD = 3
const ZOOM_KEY = 'pickup.barWidth'

/** A stable hue per section folder. */
function hue(section: string) {
  let h = 0
  for (const ch of section) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h} 60% 60%)`
}

// ---------------------------------------------------------------------------
// Geometry

const barW = ref(loadZoom())
function loadZoom() {
  try {
    return Math.min(80, Math.max(10, Number(localStorage.getItem(ZOOM_KEY)) || 28))
  } catch {
    return 28
  }
}
function zoom(factor: number) {
  barW.value = Math.min(80, Math.max(10, Math.round(barW.value * factor)))
  try {
    localStorage.setItem(ZOOM_KEY, String(barW.value))
  } catch {}
}
function onWheel(e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)
}

const scroller = ref<HTMLElement>()
const grid = ref<HTMLElement>()
const viewW = ref(800)
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(([e]) => (viewW.value = e.contentRect.width))
  observer.observe(scroller.value!)
})
onBeforeUnmount(() => observer?.disconnect())

/** Always a spare lane to drop into, and room past the end. */
const lanes = computed(() => Math.min(MAX_TRACKS, trackCount.value + 1))
/** Each lane is tall enough to list the variants of every block on it. */
const laneHeights = computed(() =>
  Array.from({ length: lanes.value }, (_, t) =>
    placements.value
      .filter((p) => p.track === t)
      .reduce((h, p) => Math.max(h, HEAD_H + variantsOf(p.clip).length * ROW_H + 2 * BLOCK_PAD + 4), MIN_LANE),
  ),
)
const laneTops = computed(() => {
  let y = 0
  return laneHeights.value.map((h) => ((y += h), y - h))
})
const gridH = computed(() => laneHeights.value.reduce((a, b) => a + b, 0))
const totalBars = computed(() => Math.max(songLength.value + 8, Math.ceil(viewW.value / barW.value)))
const px = (bars: number) => `${bars * barW.value}px`

/** Bar and lane under the pointer (bar may be fractional). */
function pointAt(e: PointerEvent): { bar: number; lane: number } {
  const r = grid.value!.getBoundingClientRect()
  const y = e.clientY - r.top
  let lane = 0
  while (lane < laneTops.value.length - 1 && laneTops.value[lane + 1] <= y) lane++
  return { bar: (e.clientX - r.left) / barW.value, lane }
}

// ---------------------------------------------------------------------------
// Messages

const toast = ref('')
let toastTimer: number | undefined
function fail(e: any) {
  toast.value = e?.message ?? String(e)
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 5000)
}
const attempt = (p: Promise<unknown>) => p.catch(fail)

// ---------------------------------------------------------------------------
// Ruler: click to play from a bar, drag to loop bars

const loopDrag = ref<{ start: number; end: number } | null>(null)
const loopRange = computed(() => {
  if (loopDrag.value) {
    const { start, end } = loopDrag.value
    return { from: Math.min(start, end), to: Math.max(start, end) + 1 }
  }
  return song.loop?.kind === 'bars' ? song.loop : null
})

function onRulerDown(e: PointerEvent) {
  const bar = Math.floor(pointAt(e).bar)
  loopDrag.value = { start: bar, end: bar }
  let moved = false
  const move = (ev: PointerEvent) => {
    const b = Math.max(0, Math.floor(pointAt(ev).bar))
    if (b !== loopDrag.value!.end) moved = true
    loopDrag.value!.end = b
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    const r = loopRange.value!
    loopDrag.value = null
    if (moved) song.loop = { kind: 'bars', ...r }
    else seek(r.from)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/** Loop the bars a placement covers; `extend` grows the current range to include them. */
function loopPlacement(p: PlacedClip, extend: boolean) {
  const l = song.loop
  song.loop =
    extend && l?.kind === 'bars'
      ? { kind: 'bars', from: Math.min(l.from, p.at), to: Math.max(l.to, p.end) }
      : { kind: 'bars', from: p.at, to: p.end }
}

// ---------------------------------------------------------------------------
// Dragging clips: moving a placement (alt: copy it), or placing one from the library

type Drag = {
  ref: string
  bars: number
  /** Placement being moved, or null when dragging from the library. */
  index: number | null
  copy: boolean
  /** Bars between the block's start and where it was grabbed. */
  grab: number
  moved: boolean
  at: number
  track: number
  over: boolean
}
const drag = ref<Drag | null>(null)

function fits(at: number, track: number, bars: number, ignore: number | null) {
  return placements.value.every((p, i) => i === ignore || p.track !== track || p.end <= at || p.at >= at + bars)
}
const dragValid = computed(() => {
  const d = drag.value
  return !!d && d.over && fits(d.at, d.track, d.bars, d.copy ? null : d.index)
})

function startDrag(e: PointerEvent, init: { ref: string; index: number | null; grab: number }, onClick: () => void) {
  if (e.button !== 0) return
  const x0 = e.clientX
  const y0 = e.clientY
  const bars = clips.value[init.ref].meta.bars
  drag.value = { ...init, bars, copy: e.altKey, moved: false, at: 0, track: 0, over: false }
  const move = (ev: PointerEvent) => {
    const d = drag.value!
    if (!d.moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return
    d.moved = true
    d.copy = ev.altKey && d.index !== null
    const { bar, lane } = pointAt(ev)
    d.at = Math.max(0, Math.round(bar - d.grab))
    d.track = Math.min(lanes.value - 1, Math.max(0, lane))
    const r = grid.value!.getBoundingClientRect()
    d.over = ev.clientY >= r.top - 10 && ev.clientY <= r.top + gridH.value + 10 && ev.clientX >= r.left
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    const d = drag.value!
    drag.value = null
    if (!d.moved) return onClick()
    if (!d.over) return
    attempt(
      updateSong((s) => {
        if (d.index !== null && !d.copy) Object.assign(s.placements[d.index], { at: d.at, track: d.track })
        else s.placements.push({ at: d.at, track: d.track, clip: d.ref })
      }),
    )
    if (d.index === null || d.copy) ui.selected = d.ref
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/** ⌘ (ctrl elsewhere): the modifier that loops what's clicked. */
const loopKey = (e: MouseEvent) => e.metaKey || e.ctrlKey

function onBlockDown(e: PointerEvent, p: PlacedClip, index: number) {
  const grab = Math.floor(pointAt(e).bar - p.at)
  const loop = loopKey(e)
  const shift = e.shiftKey
  startDrag(e, { ref: p.clip, index, grab }, () => {
    ui.selected = p.clip
    if (loop) loopPlacement(p, shift)
  })
}

function onBlockDblClick(p: PlacedClip) {
  seek(p.at)
}

function onChipDown(e: PointerEvent, c: Clip) {
  const loop = loopKey(e)
  startDrag(e, { ref: c.ref, index: null, grab: 0 }, () => {
    ui.selected = c.ref
    if (loop) song.loop = { kind: 'clip', ref: c.ref }
  })
}

// ---------------------------------------------------------------------------
// Placement actions

function remove(index: number) {
  attempt(updateSong((s) => s.placements.splice(index, 1)))
}

/** Put another variant of the section in this placement. */
function useVariant(index: number, ref: string) {
  attempt(updateSong((s) => (s.placements[index].clip = ref)))
  ui.selected = ref
}

// ---------------------------------------------------------------------------
// Track mixer (a playback setting: see trackAudible)

function toggle(list: number[], track: number) {
  const i = list.indexOf(track)
  i < 0 ? list.push(track) : list.splice(i, 1)
}

// ---------------------------------------------------------------------------
// Library: sections in song order, main variant first

const library = computed(() => {
  const bySection = new Map<string, Clip[]>()
  for (const c of Object.values(clips.value)) {
    if (!bySection.has(c.section)) bySection.set(c.section, [])
    bySection.get(c.section)!.push(c)
  }
  const firstAt = (s: string) => {
    const p = placements.value.find((p) => clips.value[p.clip]?.section === s)
    return p ? p.at : Infinity
  }
  return [...bySection.keys()]
    .sort((a, b) => firstAt(a) - firstAt(b) || a.localeCompare(b))
    .map((section) => ({
      section,
      variants: bySection.get(section)!.sort((a, b) => (a.variant === 'main' ? -1 : b.variant === 'main' ? 1 : a.variant.localeCompare(b.variant))),
    }))
})
const placedCount = computed(() => {
  const n: Record<string, number> = {}
  for (const p of placements.value) n[p.clip] = (n[p.clip] ?? 0) + 1
  return n
})

// hovering a library chip: its lineage, and where it's placed
const hovered = ref<string | null>(null)
const kin = computed(() => {
  const h = hovered.value
  const set = new Set<string>()
  if (!h) return set
  for (let r = clips.value[h]?.meta.from; r && !set.has(r); r = clips.value[r]?.meta.from) set.add(r)
  const down = (ref: string) => {
    for (const c of Object.values(clips.value)) if (c.meta.from === ref && !set.has(c.ref)) set.add(c.ref), down(c.ref)
  }
  down(h)
  return set
})

// ---------------------------------------------------------------------------
// Playback

const songPlaying = computed(() => ui.playing && !ui.playhead.clip)
const isSounding = (p: PlacedClip) => songPlaying.value && trackAudible(p.track) && p.at <= ui.playhead.pos && ui.playhead.pos < p.end
const barLabelEvery = computed(() => (barW.value >= 22 ? 1 : barW.value >= 12 ? 2 : 4))
</script>

<template>
  <div class="timeline">
    <aside class="library">
      <div v-for="row in library" :key="row.section" class="lib-section">
        <div class="lib-name" :style="{ color: hue(row.section) }">{{ row.section }}</div>
        <div
          v-for="c in row.variants"
          :key="c.ref"
          class="chip"
          :class="{
            selected: ui.selected === c.ref,
            kin: kin.has(c.ref),
            faded: hovered && hovered !== c.ref && !kin.has(c.ref),
            error: ui.clipStatus[c.ref]?.error,
            looping: song.loop?.kind === 'clip' && song.loop.ref === c.ref,
          }"
          :style="{ borderLeftColor: hue(c.section) }"
          :title="[c.meta.note, c.meta.from && `based on ${c.meta.from}`, 'click: select · ⌘-click: loop on its own · drag onto the timeline'].filter(Boolean).join('\n')"
          @pointerdown="onChipDown($event, c)"
          @mouseenter="hovered = c.ref"
          @mouseleave="hovered = null"
        >
          <span class="chip-name">{{ c.variant }}</span>
          <span class="muted small">{{ c.meta.bars }}b</span>
          <span v-if="placedCount[c.ref]" class="count" title="times placed">×{{ placedCount[c.ref] }}</span>
        </div>
      </div>
      <p v-if="!library.length" class="muted small empty-lib">No clips yet. Ask the band for some.</p>
    </aside>

    <div ref="scroller" class="scroller" @wheel="onWheel">
      <div class="ruler-row" :style="{ width: `calc(${px(totalBars)} + var(--gutter))` }">
        <div class="corner" />
        <div class="ruler" :style="{ width: px(totalBars) }" @pointerdown="onRulerDown">
          <div v-if="!songPlaying" class="cursor-mark" :style="{ left: px(ui.cursor) }" title="plays from here" />
          <div v-if="loopRange" class="loop-mark" :style="{ left: px(loopRange.from), width: px(loopRange.to - loopRange.from) }" />
          <span
            v-for="b in totalBars"
            :key="b"
            class="tick"
            :class="{ strong: (b - 1) % 4 === 0 }"
            :style="{ left: px(b - 1), width: px(1) }"
          >
            <template v-if="(b - 1) % barLabelEvery === 0">{{ b }}</template>
          </span>
        </div>
      </div>

      <div class="body">
        <!-- track headers (sticky on the left) -->
        <div class="heads">
          <div
            v-for="(h, t) in laneHeights"
            :key="t"
            class="lane-head"
            :class="{ silent: !trackAudible(t) }"
            :style="{ height: `${h}px` }"
          >
            <span class="lane-n">{{ t + 1 }}</span>
            <button class="ms" :class="{ on: song.mix.mute.includes(t) }" title="mute track" @click="toggle(song.mix.mute, t)">M</button>
            <button class="ms solo" :class="{ on: song.mix.solo.includes(t) }" title="solo track" @click="toggle(song.mix.solo, t)">S</button>
          </div>
        </div>

        <div
          ref="grid"
          class="grid"
          :style="{ width: px(totalBars), height: `${gridH}px`, backgroundSize: `${barW * 4}px 100%, ${barW}px 100%` }"
        >
          <div
            v-for="(h, t) in laneHeights"
            :key="t"
            class="lane-bg"
            :class="{ odd: t % 2 === 1, silent: !trackAudible(t) }"
            :style="{ top: `${laneTops[t]}px`, height: `${h}px` }"
          />

          <!-- outside the loop region -->
          <template v-if="loopRange">
            <div class="outside" :style="{ left: 0, width: px(loopRange.from) }" />
            <div class="outside" :style="{ left: px(loopRange.to), right: 0 }" />
          </template>

          <div
            v-for="(p, i) in placements"
            :key="`${i}:${p.clip}:${p.at}:${p.track}`"
            class="block"
            :class="{
              selected: ui.selected === p.clip,
              sounding: isSounding(p),
              error: ui.clipStatus[p.clip]?.error,
              dragging: drag?.moved && drag.index === i && !drag.copy,
              highlighted: hovered === p.clip,
              faded: hovered && hovered !== p.clip,
              silent: !trackAudible(p.track),
            }"
            :style="{
              left: px(p.at),
              top: `${laneTops[p.track] + BLOCK_PAD}px`,
              width: `calc(${px(p.bars)} - 2px)`,
              height: `${laneHeights[p.track] - 2 * BLOCK_PAD}px`,
              borderLeftColor: hue(clips[p.clip].section),
            }"
            :title="clips[p.clip].meta.note"
            @pointerdown="onBlockDown($event, p, i)"
            @dblclick="onBlockDblClick(p)"
          >
            <div class="block-head">
              <span class="section" :style="{ color: hue(clips[p.clip].section) }">{{ clips[p.clip].section }}</span>
              <button class="x" title="remove from the song" @pointerdown.stop @click="remove(i)">×</button>
            </div>
            <!-- every variant of the section; the placed one is marked, the others can be swapped in -->
            <div
              v-for="v in variantsOf(p.clip)"
              :key="v.ref"
              class="variant"
              :class="{ active: v.ref === p.clip }"
              :style="{ height: `${ROW_H}px` }"
              :title="v.meta.note"
            >
              <span class="v-name">{{ v.variant }}</span>
              <span v-if="v.meta.bars !== p.bars" class="muted v-bars">{{ v.meta.bars }}b</span>
              <button v-if="v.ref !== p.clip" class="use" title="use this variant here" @pointerdown.stop @click="useVariant(i, v.ref)">
                use
              </button>
            </div>
            <div v-if="isSounding(p)" class="progress" :style="{ width: `${((ui.playhead.pos - p.at) / p.bars) * 100}%` }" />
          </div>

          <!-- where a dragged clip would land -->
          <div
            v-if="drag?.moved && drag.over"
            class="ghost"
            :class="{ invalid: !dragValid }"
            :style="{
              left: px(drag.at),
              top: `${(laneTops[drag.track] ?? gridH) + BLOCK_PAD}px`,
              width: px(drag.bars),
              height: `${(laneHeights[drag.track] ?? MIN_LANE) - 2 * BLOCK_PAD}px`,
            }"
          >
            {{ clips[drag.ref]?.section }} / {{ clips[drag.ref]?.variant }}{{ drag.copy ? ' (copy)' : '' }}
          </div>

          <div v-if="songPlaying" class="playhead" :style="{ left: px(ui.playhead.pos) }" />
          <div v-else class="cursor" :style="{ left: px(ui.cursor) }" />
        </div>
      </div>

      <div class="hint muted">
        click the ruler to play from there, drag it to loop bars · double-click a clip to play from it · ⌘-click a clip to loop it,
        ⌘⇧-click to extend the loop · “use” swaps the variant ·
        drag to move, ⌥-drag to copy · drag from the library to place · M/S mute/solo a track · ⌘-scroll to zoom
      </div>
    </div>

    <div class="zoom">
      <button title="zoom out" @click="zoom(1 / 1.3)">−</button>
      <button title="zoom in" @click="zoom(1.3)">+</button>
    </div>
    <div v-if="toast" class="toast err" @click="toast = ''">✗ {{ toast }}</div>
  </div>
</template>

<style scoped>
.timeline {
  position: relative;
  display: flex;
  min-height: 0;
  background: var(--bg);
  user-select: none;
}

/* library */
.library {
  flex: none;
  width: 170px;
  overflow-y: auto;
  padding: 6px 8px 10px;
  border-right: 1px solid var(--border);
  background: var(--panel);
}
.lib-section {
  margin-bottom: 8px;
}
.lib-name {
  font-family: var(--mono);
  font-weight: 600;
  font-size: 11px;
  margin: 2px 0 3px;
}
.chip {
  display: flex;
  gap: 5px;
  align-items: center;
  margin-bottom: 3px;
  padding: 2px 6px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-left: 3px solid;
  border-radius: 4px;
  cursor: grab;
  transition: opacity 0.1s;
}
.chip.selected {
  border-top-color: var(--accent-2);
  border-right-color: var(--accent-2);
  border-bottom-color: var(--accent-2);
}
.chip.kin {
  border-top-color: var(--muted);
  border-right-color: var(--muted);
  border-bottom-color: var(--muted);
}
.chip.faded {
  opacity: 0.4;
}
.chip.error {
  border-color: var(--err);
}
.chip.looping {
  box-shadow: 0 0 0 1px var(--accent);
}
.chip-name {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.count {
  color: var(--accent-2);
  font-size: 10px;
}
.small {
  font-size: 10px;
}
.empty-lib {
  margin: 4px 0;
}

/* timeline */
.scroller {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: auto;
}
.scroller {
  --gutter: 58px;
}
.ruler-row {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  height: 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.corner {
  position: sticky;
  left: 0;
  z-index: 1;
  flex: none;
  width: var(--gutter);
  background: var(--panel);
  border-right: 1px solid var(--border);
}
.ruler {
  position: relative;
  flex: none;
  height: 100%;
  cursor: col-resize;
}
.body {
  display: flex;
}
.heads {
  position: sticky;
  left: 0;
  z-index: 3;
  flex: none;
  width: var(--gutter);
  background: var(--panel);
  border-right: 1px solid var(--border);
}
.lane-head {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  padding: 5px 4px 0 6px;
  border-bottom: 1px solid #ffffff0a;
}
.lane-head.silent .lane-n {
  color: var(--muted);
}
.lane-n {
  flex: 1;
  font-size: 11px;
  line-height: 16px;
}
.ms {
  width: 17px;
  padding: 0;
  font-size: 10px;
  line-height: 15px;
  color: var(--muted);
}
.ms.on {
  background: var(--err);
  border-color: var(--err);
  color: #1a1a1a;
  font-weight: 700;
}
.ms.solo.on {
  background: var(--accent);
  border-color: var(--accent);
}
.lane-bg {
  position: absolute;
  left: 0;
  right: 0;
  border-bottom: 1px solid #ffffff0a;
  pointer-events: none;
}
.lane-bg.odd {
  background: #ffffff05;
}
.lane-bg.silent {
  background: repeating-linear-gradient(135deg, #ffffff06 0 6px, transparent 6px 12px);
}
.tick {
  position: absolute;
  top: 0;
  height: 100%;
  padding-left: 3px;
  border-left: 1px solid #ffffff14;
  font-size: 10px;
  line-height: 20px;
  color: var(--muted);
  pointer-events: none;
}
.tick.strong {
  border-left-color: #ffffff33;
  color: var(--text);
}
.loop-mark {
  position: absolute;
  top: 2px;
  bottom: 2px;
  background: color-mix(in srgb, var(--accent) 35%, transparent);
  border: 1px solid var(--accent);
  border-radius: 3px;
  pointer-events: none;
}
.grid {
  position: relative;
  background-image:
    linear-gradient(to right, #ffffff1c 1px, transparent 1px),
    linear-gradient(to right, #ffffff0a 1px, transparent 1px);
}
.outside {
  position: absolute;
  top: 0;
  bottom: 0;
  background: #0000008c;
  z-index: 1;
  pointer-events: none;
}
.block {
  position: absolute;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 1px 4px 2px 5px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-left: 3px solid;
  border-radius: 4px;
  overflow: hidden;
  cursor: grab;
  transition: opacity 0.1s;
}
.block.selected {
  border-top-color: var(--accent-2);
  border-right-color: var(--accent-2);
  border-bottom-color: var(--accent-2);
}
.block.sounding {
  box-shadow: inset 0 0 0 1px var(--accent);
}
.block.error {
  border-color: var(--err);
}
.block.dragging {
  opacity: 0.35;
}
.block.highlighted {
  box-shadow: 0 0 0 2px var(--accent-2);
}
.block.faded {
  opacity: 0.45;
}
.block.silent {
  opacity: 0.35;
}
.block-head {
  display: flex;
  align-items: center;
  height: 15px;
  min-width: 0;
  white-space: nowrap;
}
.section {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--mono);
  font-weight: 600;
  font-size: 11px;
}
.block button {
  padding: 0 3px;
  line-height: 13px;
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 11px;
}
.block button:hover {
  color: var(--text);
}
.block .x {
  opacity: 0;
}
.block:hover .x {
  opacity: 1;
}
.variant {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding-left: 2px;
  border-radius: 3px;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 15px;
  white-space: nowrap;
  color: var(--muted);
  opacity: 0.7;
}
.variant.active {
  opacity: 1;
  color: var(--text);
  font-weight: 600;
  background: #ffffff10;
}
.variant.active::before {
  content: '●';
  color: var(--accent);
  font-size: 8px;
}
.variant:not(.active):hover {
  opacity: 1;
}
.v-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.v-bars {
  font-size: 10px;
}
.block .use {
  display: none;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 10px;
  color: var(--text);
}
.variant:hover .use {
  display: block;
}
.progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent);
}
.ghost {
  position: absolute;
  z-index: 5;
  padding: 3px 6px;
  border: 1px dashed var(--accent-2);
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent-2) 22%, var(--panel));
  font-family: var(--mono);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  pointer-events: none;
}
.ghost.invalid {
  border-color: var(--err);
  background: color-mix(in srgb, var(--err) 22%, var(--panel));
}
.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 4;
  width: 1px;
  background: var(--accent);
  pointer-events: none;
}
.cursor {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 4;
  border-left: 1px dashed color-mix(in srgb, var(--accent) 70%, transparent);
  pointer-events: none;
}
.cursor-mark {
  position: absolute;
  top: 0;
  z-index: 2;
  width: 0;
  height: 0;
  margin-left: -5px;
  border: 5px solid transparent;
  border-top: 7px solid var(--accent);
  pointer-events: none;
}
.hint {
  padding: 6px 8px;
  font-size: 11px;
  white-space: nowrap;
}
.zoom {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 7;
  display: flex;
  gap: 2px;
}
.zoom button {
  padding: 0 8px;
}
.toast {
  position: absolute;
  left: 180px;
  right: 80px;
  bottom: 8px;
  z-index: 8;
  padding: 5px 8px;
  background: var(--panel);
  border: 1px solid var(--err);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
</style>
