// Keeps what's playing in sync with the song: compiles clips, arranges the
// loop region, and switches structure on the next bar line. Code edits apply live.
import { watch } from 'vue'
import { song, ui, clips, placements, songLength, songMeta, trackAudible, type Clip, type LoopTarget } from '../state'
import * as strudel from './strudel'

type Entry = { ref: string; at: number; bars: number }
/**
 * What's being played: song bars [from, to), on repeat, with song bar `from` at
 * cycle `anchor` (and every `to - from` cycles after). It takes over from the
 * previous layout at cycle `switchAt`. `clip` is set when playing a lone clip.
 */
type Layout = { switchAt: number; anchor: number; from: number; to: number; entries: Entry[]; clip: string | null }

const cache = new Map<string, Promise<strudel.Compiled>>()

/** Compile (cached by code + bars), recording errors on `ui.clipStatus`. */
export async function compile(clip: Clip): Promise<strudel.Compiled | null> {
  const key = `${clip.meta.bars}|${clip.body}`
  let p = cache.get(key)
  if (!p) {
    p = strudel.compileClip(clip.body, clip.meta.bars)
    cache.set(key, p)
  }
  try {
    const res = await p
    ui.clipStatus[clip.ref] = { warnings: res.warnings }
    return res
  } catch (e: any) {
    cache.delete(key)
    ui.clipStatus[clip.ref] = { error: e?.message ?? String(e) }
    return null
  }
}

export type Region = { from: number; to: number; entries: Entry[] }

/**
 * What a loop target means right now: which clips, over which bars. With `mixed`,
 * muted (or not soloed) tracks are left out, as for playback.
 */
export function regionOf(loop: LoopTarget, mixed = false): Region {
  if (loop?.kind === 'clip') {
    const c = clips.value[loop.ref]
    return c ? { from: 0, to: c.meta.bars, entries: [{ ref: c.ref, at: 0, bars: c.meta.bars }] } : { from: 0, to: 0, entries: [] }
  }
  const from = loop?.kind === 'bars' ? loop.from : 0
  const to = loop?.kind === 'bars' ? loop.to : songLength.value
  const entries = placements.value
    .filter((p) => p.at < to && p.end > from && (!mixed || trackAudible(p.track)))
    .map((p) => ({ ref: p.clip, at: p.at, bars: p.bars }))
  return { from, to, entries }
}

/** Compile every entry and arrange them over the region, looping from cycle `anchor`. */
export async function buildRegion(region: Region, anchor: number) {
  const patterns = await Promise.all(
    region.entries.map(async (e) => (await compile(clips.value[e.ref]))?.pattern ?? strudel.silence()),
  )
  return strudel.arrange(
    region.entries.map((e, i) => ({ pattern: patterns[i], at: e.at, bars: e.bars })),
    region.from,
    region.to,
    anchor,
  )
}

let prev: any = strudel.silence()
let current: any = strudel.silence()
let layout: Layout = { switchAt: 0, anchor: 0, from: 0, to: 0, entries: [], clip: null }
let prevLayout: Layout = layout
let structureKey = ''
let seq = 0
/** A song bar to jump to on the next bar line (see seek). */
let seekTo: number | null = null

const loopClip = () => (song.loop?.kind === 'clip' ? song.loop.ref : null)

/** Position in `lay` (song bars, or clip bars for a lone clip) at cycle `t`. */
function posIn(lay: Layout, t: number): number {
  const len = lay.to - lay.from
  return len > 0 ? lay.from + ((((t - lay.anchor) % len) + len) % len) : lay.from
}

/**
 * Where to pick up in `region` (playing clip `clip` alone, or the song) when
 * switching at cycle `t` from `old`: the same spot in the song if the new region
 * covers it, else its start. Going between a lone clip and the song maps
 * through the clip's placements.
 */
function continueAt(old: Layout, t: number, region: Region, clip: string | null): number {
  let p = posIn(old, t)
  if (old.clip && !clip) {
    const at = placements.value.find((q) => q.clip === old.clip)?.at
    p = at === undefined ? region.from : at + p
  } else if (!old.clip && clip) {
    const q = placements.value.find((q) => q.clip === clip && q.at <= p && p < q.end)
    p = q ? p - q.at : region.from
  } else if (old.clip !== clip) p = region.from
  return p >= region.from && p < region.to ? p : region.from
}

async function sync() {
  if (!ui.playing) return
  const my = ++seq
  const clip = loopClip()
  const region = regionOf(song.loop, true)
  const key = JSON.stringify(region)
  const t = strudel.now() ?? 0
  const seek = seekTo
  let { anchor, switchAt } = layout
  const structural = key !== structureKey || seek !== null
  if (structural) {
    switchAt = Math.ceil(t + 0.05)
    const old = switchAt >= layout.switchAt ? layout : prevLayout
    const bar = seek !== null && seek >= region.from && seek < region.to ? seek : continueAt(old, switchAt, region, clip)
    anchor = switchAt - (bar - region.from)
  }
  const arranged = await buildRegion(region, anchor)
  if (my !== seq || !ui.playing) return
  if (structural) {
    // if a previous switch is still pending, keep what's actually sounding now
    if (t >= layout.switchAt) {
      prev = current
      prevLayout = layout
    }
    structureKey = key
    if (seek === seekTo) seekTo = null
  }
  current = arranged
  layout = { switchAt, anchor, ...region, clip }
  strudel.setPattern(strudel.switchAt(prev, current, switchAt))
}

/** Start playing: the loop, or the song from the cursor. */
export async function start() {
  await strudel.initStrudel()
  strudel.setBpm(songMeta.value.bpm)
  const region = regionOf(song.loop, true)
  const c = ui.cursor
  const bar = !song.loop && c >= region.from && c < region.to ? c : region.from
  const anchor = -(bar - region.from)
  current = await buildRegion(region, anchor)
  prev = strudel.silence()
  seekTo = null
  layout = prevLayout = { switchAt: 0, anchor, ...region, clip: loopClip() }
  structureKey = JSON.stringify(region)
  ui.playing = true
  await strudel.play(current)
  tick()
}

export function stop() {
  ui.playing = false
  seq++
  strudel.stop()
  ui.playhead = { pos: 0, clip: null, sounding: [] }
  ui.pending = false
}

/**
 * Play the song from `bar`: moves the cursor and, while playing, jumps there on
 * the next bar line. Leaves a loop that doesn't cover the bar.
 */
export function seek(bar: number) {
  ui.cursor = bar
  const l = song.loop
  if (l && !(l.kind === 'bars' && l.from <= bar && bar < l.to)) song.loop = null
  if (!ui.playing) return
  seekTo = bar
  scheduleSync()
}

/** Stop looping and carry on through the song from where playback is now. */
export function unloop() {
  song.loop = null
}

/** Where playback is: the sounding layout and the position in song bars (or clip bars for a lone clip). */
function position(): { lay: Layout; pos: number } | null {
  const t = strudel.now()
  if (t == null) return null
  const lay = t >= layout.switchAt ? layout : prevLayout
  if (lay.to - lay.from <= 0) return null
  return { lay, pos: posIn(lay, t) }
}

/** Time within clip `ref` (its own cycle 0 = its first bar) while it's sounding, else null. */
export function clipTime(ref: string): number | null {
  if (!ui.playing) return null
  const p = position()
  const e = p?.lay.entries.find((e) => e.ref === ref && e.at <= p.pos && p.pos < e.at + e.bars)
  return e ? p!.pos - e.at : null
}

function tick() {
  if (!ui.playing) return
  const t = strudel.now()
  if (t != null) {
    ui.pending = t < layout.switchAt
    const p = position()
    if (p) {
      const sounding = p.lay.entries.filter((e) => e.at <= p.pos && p.pos < e.at + e.bars).map((e) => e.ref)
      ui.playhead = { pos: p.pos, clip: p.lay.clip, sounding }
    }
  }
  requestAnimationFrame(tick)
}

let syncTimer: number | undefined
function scheduleSync() {
  clearTimeout(syncTimer)
  syncTimer = window.setTimeout(sync, 150)
}
watch(
  () => [placements.value, song.loop, song.mix, Object.values(clips.value).map((c) => [c.ref, c.body, c.meta.bars])],
  scheduleSync,
  { deep: true },
)
watch(
  () => songMeta.value.bpm,
  (bpm) => strudel.setBpm(bpm),
)
