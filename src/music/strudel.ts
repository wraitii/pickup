// Thin layer over @strudel/web: init, compile a clip's code into a Pattern
// without playing it, and play an arranged pattern.
import { reactive } from 'vue'
import * as S from '@strudel/web'

const SAMPLE_MAPS = [
  'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/strudel.json',
  'https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json',
  'https://raw.githubusercontent.com/felixroos/dough-samples/main/piano.json',
  'https://raw.githubusercontent.com/felixroos/dough-samples/main/vcsl.json',
]

const SYNTHS = ['sine', 'square', 'triangle', 'sawtooth', 'supersaw', 'pulse', 'white', 'pink', 'brown', 'crackle']

/** Every sound name we registered, for the agent's `list_sounds` tool. */
export const soundNames: string[] = []
/** Drum machine bank names (for `.bank(...)`). */
export const drumBanks: string[] = []
/** The loaded sample maps, so the offline renderer can register the same sounds. */
export const sampleMaps: any[] = []
/** Sample maps that failed to load (offline, rate-limited): their sounds play as silence. */
export const failedSampleMaps = reactive<string[]>([])

let repl: any
let ready: Promise<void> | null = null

// `$:` blocks transpile to `.p('$')`; we collect them ourselves (the repl's
// collector is private) so a clip can use either a final expression or `$:`.
let collected: any[] | null = null

export function initStrudel(): Promise<void> {
  if (ready) return ready
  ready = (async () => {
    repl = await S.initStrudel({
      prebake: async () => {
        const maps = await Promise.all(
          SAMPLE_MAPS.map(async (url) => {
            try {
              const res = await fetch(url)
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              return await res.json()
            } catch (e) {
              console.warn('sample map failed', url, e)
              failedSampleMaps.push(url.split('/').pop()!)
              return null
            }
          }),
        )
        for (const map of maps) {
          if (!map) continue
          await S.samples(map, map._base)
          sampleMaps.push(map)
          for (const k of Object.keys(map)) if (k !== '_base') soundNames.push(k)
        }
      },
    })
    for (const s of SYNTHS) if (S.getSound(s)) soundNames.push(s)
    // the user's recorded takes (imported lazily: recordings.ts builds on this module)
    try {
      await (await import('./recordings')).loadRecordings()
    } catch (e) {
      console.warn('could not load recordings', e)
    }
    drumBanks.push(...new Set(soundNames.filter((n) => /^[A-Z].*_/.test(n)).map((n) => n.split('_')[0])))

    S.Pattern.prototype.p = function (id: string) {
      if (typeof id === 'string' && (id.startsWith('_') || id.endsWith('_'))) return S.silence
      collected?.push(this)
      return this
    }
    const tempoError = () => {
      throw new Error('Tempo is global in Pickup: do not call setcpm/setcps in clips (use the song brief bpm).')
    }
    Object.assign(globalThis, { setcpm: tempoError, setcps: tempoError, setCpm: tempoError, setCps: tempoError })
  })()
  return ready
}

/** `miniLocations` are [start, end] offsets of mini-notation leaves in the code, for highlighting. */
export type Compiled = { pattern: any; onsets: number; warnings: string[]; miniLocations: [number, number][] }

/** Evaluate clip code into a Pattern and sanity-check its first `bars` cycles. Throws on error. */
export async function compileClip(code: string, bars: number): Promise<Compiled> {
  await initStrudel()
  const { output, miniLocations } = S.transpiler(code, { emitWidgets: false })
  collected = []
  let result: any
  let blocks: any[]
  try {
    // The body runs synchronously up to its first await, so `$:` blocks are
    // collected before another compile can reset `collected`.
    const promise = Function(`"use strict";return (async ()=>{${output}})()`)()
    blocks = collected
    collected = null
    result = await promise
  } finally {
    collected = null
  }
  const pattern = blocks.length ? S.stack(...blocks) : result
  if (!S.isPattern(pattern)) {
    throw new Error('Clip code must evaluate to a pattern: end with a pattern expression, or use `$:` blocks.')
  }

  const haps = pattern.queryArc(0, bars).filter((h: any) => h.hasOnset())
  const warnings: string[] = []
  const unknown = new Set<string>()
  for (const h of haps) {
    const v = h.value
    if (!v || typeof v !== 'object' || typeof v.s !== 'string') continue
    const name = v.bank ? `${v.bank}_${v.s}` : v.s
    if (!S.getSound(name) && !S.getSound(name.toLowerCase())) unknown.add(name)
  }
  if (unknown.size) throw new Error(`Unknown sound(s): ${[...unknown].join(', ')}. Use list_sounds to find valid names.`)
  if (!haps.length) warnings.push(`No events in the first ${bars} bar(s): the clip is silent.`)
  return { pattern, onsets: haps.length, warnings, miniLocations }
}

export const silence = () => S.silence

export async function play(pattern: any) {
  await initStrudel()
  await repl.setPattern(pattern, true)
}

export function setPattern(pattern: any) {
  repl?.scheduler.setPattern(pattern, false)
}

export function stop() {
  repl?.stop()
}

export function setBpm(bpm: number) {
  // one cycle = one 4/4 bar
  repl?.setCps(bpm / 60 / 4)
}

/** Current position in cycles (bars), or null when stopped. */
export function now(): number | null {
  if (!repl?.scheduler?.started) return null
  return repl.scheduler.now()
}

// ---------------------------------------------------------------------------
// Arranging

/** A clip on the timeline: `pattern` plays from its own cycle 0 at song bar `at`, for `bars`. */
export type Item = { pattern: any; at: number; bars: number }

/**
 * Loop song bars [from, to) starting at cycle `anchor`. Each item restarts from
 * its own cycle 0 at its bar and is cut at its end (or the loop's); items that
 * overlap in time play together.
 */
export function arrange(items: Item[], from: number, to: number, anchor: number): any {
  const len = to - from
  if (len <= 0 || !items.length) return S.silence
  return new S.Pattern((state: any) => {
    const { begin, end } = state.span
    const out: any[] = []
    const first = Math.floor((begin.valueOf() - anchor) / len)
    const last = Math.floor((end.valueOf() - anchor) / len)
    for (let n = first; n <= last; n++) {
      // cycle = song bar + shift, for this pass of the loop
      const shift = anchor + n * len - from
      for (const it of items) {
        const s0 = Math.max(it.at, from)
        const s1 = Math.min(it.at + it.bars, to)
        if (s0 >= s1) continue
        const b = begin.max(S.Fraction(s0 + shift))
        const e = end.min(S.Fraction(s1 + shift))
        if (!b.lt(e)) continue
        // cycle = clip time + offset
        const offset = shift + it.at
        const span = new S.TimeSpan(b.sub(offset), e.sub(offset))
        for (const hap of it.pattern.query(state.setSpan(span))) {
          out.push(hap.withSpan((sp: any) => sp.withTime((t: any) => t.add(offset))))
        }
      }
    }
    return out
  })
}

/** Play `before` until cycle `at`, then `after`. */
export function switchAt(before: any, after: any, at: number): any {
  const t = S.Fraction(at)
  return new S.Pattern((state: any) => {
    const { begin, end } = state.span
    if (end.lte(t)) return before.query(state)
    if (begin.gte(t)) return after.query(state)
    return [
      ...before.query(state.setSpan(new S.TimeSpan(begin, t))),
      ...after.query(state.setSpan(new S.TimeSpan(t, end))),
    ]
  })
}
