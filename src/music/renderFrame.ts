// Runs inside the throwaway renderer iframe (render.html): a fresh copy of
// superdough per render, so none of its global state (audio context, node
// pools) is shared with live playback or with earlier renders.
import * as SD from 'superdough'

export type RenderEvent = { value: any; t: number; duration: number }

export type RenderTimings = { setup: number; schedule: number; audio: number }

/** Seconds before each bar that its notes are scheduled. */
const LEAD = 0.05

async function render(events: RenderEvent[], seconds: number, cps: number, sampleRate: number, sampleMaps: any[]) {
  const t0 = performance.now()
  // quiet: it logs a deprecation warning per note
  SD.setLogger((msg: string, type?: string) => type === 'error' && console.warn('[render]', msg))
  await SD.registerSynthSounds()
  await SD.registerZZFXSounds?.()
  for (const map of sampleMaps) await SD.samples(map, map._base)

  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate)
  SD.setAudioContext(ctx)
  await SD.initAudio({ maxPolyphony: 256 })
  const t1 = performance.now()

  // Schedule notes just in time, a bar at a time, by suspending the render
  // shortly before each bar. Scheduling everything up front puts every note's
  // nodes in the graph for the whole render, so the cost grows with
  // notes × length; this way finished notes are gone before later ones exist.
  let scheduling = 0
  const schedule = async (batch: RenderEvent[]) => {
    const s = performance.now()
    // in onset order: controls like `cut` depend on what's already sounding
    for (const e of batch) {
      try {
        await SD.superdough(e.value, e.t, e.duration, cps, e.t)
      } catch (err) {
        console.warn('[render]', err)
      }
    }
    scheduling += performance.now() - s
  }
  const bar = 1 / cps
  const quantum = 128 / sampleRate
  const batches = new Map<number, RenderEvent[]>()
  for (const e of events) {
    const k = Math.floor(e.t / bar)
    batches.set(k, [...(batches.get(k) ?? []), e])
  }
  for (const [k, batch] of batches) {
    // suspend times snap to render quanta: stop a little early, never in the past
    const at = Math.floor((k * bar - LEAD) / quantum) * quantum
    if (k === 0 || at <= 0) await schedule(batch)
    else ctx.suspend(at).then(() => schedule(batch).then(() => ctx.resume()))
  }

  const buf = await ctx.startRendering()
  const t2 = performance.now()
  const l = buf.getChannelData(0)
  const r = buf.getChannelData(1)
  const mono = new Float32Array(l.length)
  for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2
  const timings: RenderTimings = { setup: t1 - t0, schedule: scheduling, audio: t2 - t1 - scheduling }
  return { samples: mono, timings }
}

;(window as any).pickupRender = render
