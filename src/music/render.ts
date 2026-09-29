// Offline rendering for the band's `listen` tool: render a pattern to audio,
// then draw a spectrogram and summarize levels per bar.
//
// Audio is rendered by a separate copy of superdough in a throwaway iframe
// (render.html → renderFrame.ts). superdough keeps global state (the audio
// context, node pools that aren't tied to a context), so rendering with the
// live copy would steal notes from what the user hears, and reusing one copy
// across renders mixes nodes from different contexts.
import { sampleMaps } from './strudel'
import type { RenderEvent, RenderTimings } from './renderFrame'

const SAMPLE_RATE = 44100
/** Seconds rendered past the end so reverb/release tails are heard. */
const TAIL = 1

function loadFrame(): Promise<HTMLIFrameElement> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.style.display = 'none'
    frame.src = `${import.meta.env.BASE_URL}render.html`
    frame.onload = () => resolve(frame)
    frame.onerror = () => reject(new Error('could not load the renderer'))
    document.body.appendChild(frame)
  })
}

// one render at a time (they're CPU-heavy)
let queue: Promise<unknown> = Promise.resolve()

export type Rendered = { samples: Float32Array; channels: Float32Array[]; sampleRate: number; notes: number; timings: RenderTimings & { frame: number } }

/** Render `bars` cycles of `pattern` at `cps`. Returns a mono mix, with where the time went (ms). */
export function renderPattern(pattern: any, bars: number, cps: number): Promise<Rendered> {
  const job = queue.then(async () => {
    const events: RenderEvent[] = pattern
      .queryArc(0, bars, { _cps: cps })
      .filter((h: any) => h.hasOnset())
      .sort((a: any, b: any) => a.whole.begin.valueOf() - b.whole.begin.valueOf())
      .map((h: any) => {
        h.ensureObjectValue()
        return { value: h.value, t: h.whole.begin.valueOf() / cps, duration: h.duration / cps }
      })
    const t0 = performance.now()
    const frame = await loadFrame()
    const loaded = performance.now() - t0
    try {
      const render = (frame.contentWindow as any)?.pickupRender
      if (!render) throw new Error('renderer failed to start')
      const { samples, channels, timings } = await render(events, bars / cps + TAIL, cps, SAMPLE_RATE, sampleMaps)
      return { samples, channels, sampleRate: SAMPLE_RATE, notes: events.length, timings: { ...timings, frame: loaded } }
    } finally {
      frame.remove()
    }
  })
  queue = job.catch(() => {})
  return job
}

// ---------------------------------------------------------------------------
// Analysis

const FFT_SIZE = 4096
const F_MIN = 30
const F_MAX = 16000
const BANDS: { name: string; lo: number; hi: number }[] = [
  { name: 'sub', lo: 20, hi: 120 },
  { name: 'low', lo: 120, hi: 500 },
  { name: 'mid', lo: 500, hi: 2000 },
  { name: 'high', lo: 2000, hi: 6000 },
  { name: 'air', lo: 6000, hi: 20000 },
]

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

/** Power spectra at `columns` evenly spaced times (Hann-windowed). */
function stft(samples: Float32Array, columns: number): Float64Array[] {
  const win = new Float64Array(FFT_SIZE).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)))
  const out: Float64Array[] = []
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  for (let c = 0; c < columns; c++) {
    const center = Math.floor(((c + 0.5) / columns) * samples.length)
    const start = center - FFT_SIZE / 2
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = samples[start + i] ?? 0
      re[i] = s * win[i]
      im[i] = 0
    }
    fft(re, im)
    const p = new Float64Array(FFT_SIZE / 2)
    // scale so a full-scale sine reads ~0 dB
    const norm = 4 / (FFT_SIZE * FFT_SIZE)
    for (let k = 0; k < p.length; k++) p[k] = (re[k] * re[k] + im[k] * im[k]) * norm
    out.push(p)
  }
  return out
}

const db = (power: number) => (power > 1e-12 ? 10 * Math.log10(power) : -120)

// magma-ish
const STOPS = [
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
]
function color(t: number): [number, number, number] {
  t = Math.min(1, Math.max(0, t)) * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(t))
  const f = t - i
  const [a, b] = [STOPS[i], STOPS[i + 1]]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

export type Analysis = {
  /** PNG, base64 (no data: prefix). */
  png: string
  /** Plain-text per-bar levels, for every model. */
  table: string
}

/** Spectrogram image (log frequency, bar grid) plus a per-bar level table. */
export function analyze(samples: Float32Array, sampleRate: number, bars: number, cps: number, title: string): Analysis {
  const barSamples = sampleRate / cps
  const musical = Math.min(samples.length, Math.round(bars * barSamples))
  const plotW = Math.min(1400, Math.max(480, bars * 64))
  const plotH = 300
  const L = 46
  const T = 22
  const B = 20
  const R = 10

  const cols = stft(samples.subarray(0, musical), plotW)
  const binHz = sampleRate / FFT_SIZE
  // each image row covers a log-spaced frequency band; take the max bin power in it
  const rowBins: [number, number][] = []
  for (let y = 0; y < plotH; y++) {
    const f0 = F_MIN * Math.pow(F_MAX / F_MIN, (plotH - 1 - y) / plotH)
    const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (plotH - y) / plotH)
    const b0 = Math.max(1, Math.floor(f0 / binHz))
    rowBins.push([b0, Math.max(b0 + 1, Math.ceil(f1 / binHz))])
  }
  let peakDb = -120
  const grid = cols.map((p) =>
    rowBins.map(([b0, b1]) => {
      let m = 0
      for (let k = b0; k < b1 && k < p.length; k++) m = Math.max(m, p[k])
      const d = db(m)
      peakDb = Math.max(peakDb, d)
      return d
    }),
  )

  const canvas = document.createElement('canvas')
  canvas.width = L + plotW + R
  canvas.height = T + plotH + B
  const g = canvas.getContext('2d')!
  g.fillStyle = '#111'
  g.fillRect(0, 0, canvas.width, canvas.height)
  const img = g.createImageData(plotW, plotH)
  const RANGE = 80
  for (let x = 0; x < plotW; x++) {
    for (let y = 0; y < plotH; y++) {
      const [r, gr, b] = color((grid[x][y] - (peakDb - RANGE)) / RANGE)
      const i = (y * plotW + x) * 4
      img.data[i] = r
      img.data[i + 1] = gr
      img.data[i + 2] = b
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, L, T)

  g.font = '11px ui-monospace, Menlo, monospace'
  g.textBaseline = 'middle'
  // frequency axis
  g.textAlign = 'right'
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const y = T + plotH - (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * plotH
    g.fillStyle = 'rgba(255,255,255,0.18)'
    g.fillRect(L, Math.round(y), plotW, 1)
    g.fillStyle = '#aaa'
    g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), L - 4, y)
  }
  // bar grid
  g.textAlign = 'center'
  const every = Math.ceil(bars / (plotW / 28))
  for (let bar = 0; bar <= bars; bar++) {
    const x = L + (bar / bars) * plotW
    g.fillStyle = bar % 4 === 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)'
    g.fillRect(Math.round(x), T, 1, plotH)
    if (bar < bars && bar % every === 0) {
      g.fillStyle = '#ccc'
      g.fillText(String(bar + 1), x + plotW / bars / 2, T + plotH + B / 2)
    }
  }
  g.textAlign = 'left'
  g.fillStyle = '#eee'
  g.fillText(`${title}  ·  ${bars} bars  ·  Hz (log) vs bar  ·  ${RANGE} dB range`, L, T / 2)

  // per-bar levels: RMS/peak from samples, band energy from the STFT columns
  const lines = [`bar  rms   peak  | ${BANDS.map((b) => b.name.padStart(5)).join(' ')}   (dBFS)`]
  let clipped = false
  for (let bar = 0; bar < bars; bar++) {
    const s0 = Math.round(bar * barSamples)
    const s1 = Math.min(musical, Math.round((bar + 1) * barSamples))
    let sum = 0
    let peak = 0
    for (let i = s0; i < s1; i++) {
      sum += samples[i] * samples[i]
      peak = Math.max(peak, Math.abs(samples[i]))
    }
    if (peak >= 0.99) clipped = true
    const c0 = Math.floor((bar / bars) * plotW)
    const c1 = Math.max(c0 + 1, Math.floor(((bar + 1) / bars) * plotW))
    const bands = BANDS.map(({ lo, hi }) => {
      let e = 0
      for (let c = c0; c < c1; c++) {
        const p = cols[c]
        for (let k = Math.ceil(lo / binHz); k < Math.min(p.length, hi / binHz); k++) e += p[k]
      }
      return db(e / (c1 - c0)).toFixed(0).padStart(5)
    })
    const f = (x: number) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf').padStart(5)
    lines.push(`${String(bar + 1).padStart(3)}  ${f(Math.sqrt(sum / Math.max(1, s1 - s0)))} ${f(peak)} | ${bands.join(' ')}`)
  }
  if (clipped) lines.push('warning: peaks at or above 0 dBFS (clipping).')

  return { png: canvas.toDataURL('image/png').split(',')[1], table: lines.join('\n') }
}
