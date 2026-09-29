// Recorded sounds: takes from the mic, kept in IndexedDB (too big for
// localStorage) and registered as samples named `rec_<name>`, so any clip can
// play them with s("rec_<name>"). They belong to the browser, not to a song:
// an exported song carries the takes it uses (see song/library.ts).
import { reactive } from 'vue'
import { encodeWav } from './wav'
import * as S from '@strudel/web'
import { initStrudel, sampleMaps, soundNames } from './strudel'

export const REC_PREFIX = 'rec_'
export const REC_NAME_RE = /^rec_[a-z0-9_]+$/

export type Recording = { name: string; blob: Blob; seconds: number }

/** Bars a take spans on the timeline at `bpm` (clips are at most 64 bars). */
export const takeBars = (seconds: number, bpm: number) => Math.min(64, Math.max(1, Math.ceil((seconds * bpm) / 240 - 0.01)))

const DB_NAME = 'pickup'
const STORE = 'recordings'

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Every take in this browser, by sample name. */
export const recordings = reactive<Record<string, Recording>>({})

/** Map for the offline renderer, which registers the same sounds as live playback. */
const renderMap: Record<string, string[]> = {}

async function register(rec: Recording) {
  const url = URL.createObjectURL(rec.blob)
  await S.samples({ [rec.name]: [url] })
  renderMap[rec.name] = [url]
  if (!sampleMaps.includes(renderMap)) sampleMaps.push(renderMap)
  if (!soundNames.includes(rec.name)) soundNames.push(rec.name)
  recordings[rec.name] = rec
}

/** A blob URL for a take (for previews). */
export const recordingUrl = (name: string): string | undefined => renderMap[name]?.[0]

/** Forget a take. Its sample name stays registered until reload, but nothing lists or exports it. */
export async function deleteRecording(name: string) {
  await tx('readwrite', (s) => s.delete(name))
  delete recordings[name]
  const i = soundNames.indexOf(name)
  if (i >= 0) soundNames.splice(i, 1)
}

/** Register every stored take. Called while Strudel starts, so clips using takes compile from the first load. */
export async function loadRecordings() {
  const all = await tx<Recording[]>('readonly', (s) => s.getAll())
  for (let rec of all) {
    // takes from before mono conversion: convert once and keep the result
    if (rec.blob.type !== WAV) {
      try {
        rec = { ...rec, ...(await toMonoWav(rec.blob)) }
        await tx('readwrite', (s) => s.put(rec))
      } catch (e) {
        console.warn(`could not convert ${rec.name} to mono`, e)
      }
    }
    await register(rec)
  }
}

// ---------------------------------------------------------------------------
// Mono WAV: mics often deliver stereo with the sound on one side only (or
// slightly different sides), which plays hard-left. Takes are mono, centred.

const WAV = 'audio/wav'
const SAMPLE_RATE = 48000

async function toMonoWav(blob: Blob): Promise<{ blob: Blob; seconds: number }> {
  const buf = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await blob.arrayBuffer())
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i))
  const rms = chans.map((c) => Math.sqrt(c.reduce((a, x) => a + x * x, 0) / c.length))
  const loud = Math.max(...rms)
  // average only the channels that carry the sound, so a dead side doesn't halve the level
  const live = chans.filter((_, i) => rms[i] > loud * 0.1)
  const mono = new Float32Array(buf.length)
  for (const c of live) for (let i = 0; i < mono.length; i++) mono[i] += c[i] / live.length
  return { blob: encodeWav([mono], buf.sampleRate), seconds: buf.duration }
}

export async function saveRecording(rec: Recording) {
  await initStrudel()
  await tx('readwrite', (s) => s.put(rec))
  await register(rec)
}

/** A sample name from what the user typed: "Vox 1" → "rec_vox_1". */
export function recName(input: string): string {
  const slug = input.toLowerCase().replace(/^rec_/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return REC_PREFIX + (slug || 'take')
}

// ---------------------------------------------------------------------------
// Recording from the mic

export const recorder = reactive({ active: false, started: 0, error: '' })
let media: MediaRecorder | null = null

export async function startRecording() {
  recorder.error = ''
  try {
    // raw sound: the browser's voice-call processing ruins instruments
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    media = new MediaRecorder(stream)
    media.start()
    recorder.active = true
    recorder.started = performance.now()
  } catch (e: any) {
    recorder.error = `Could not record: ${e.message ?? e}`
  }
}

/** Stop and return the take (not yet saved), or null if nothing was recorded. */
export function stopRecording(): Promise<{ blob: Blob; seconds: number } | null> {
  const m = media
  media = null
  recorder.active = false
  if (!m) return Promise.resolve(null)
  return new Promise((resolve) => {
    const chunks: Blob[] = []
    m.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    m.onstop = async () => {
      m.stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunks, { type: m.mimeType })
      if (!blob.size) return resolve(null)
      try {
        resolve(await toMonoWav(blob))
      } catch (e: any) {
        recorder.error = `Could not read the recording: ${e.message ?? e}`
        resolve(null)
      }
    }
    m.stop()
  })
}

// ---------------------------------------------------------------------------
// Carrying takes in exported songs

export type PackedRecording = { name: string; type: string; seconds: number; data: string }

export async function packRecording(rec: Recording): Promise<PackedRecording> {
  const bytes = new Uint8Array(await rec.blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { name: rec.name, type: rec.blob.type, seconds: rec.seconds, data: btoa(bin) }
}

export function unpackRecording(p: PackedRecording): Recording {
  if (!REC_NAME_RE.test(p?.name ?? '') || typeof p.data !== 'string') throw new Error('invalid recording in song file')
  const bin = atob(p.data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { name: p.name, blob: new Blob([bytes], { type: p.type }), seconds: Number(p.seconds) || 0 }
}

/** Takes a song's files play (by sample name). */
export function recordingsUsedBy(files: Record<string, string>): Recording[] {
  const text = Object.values(files).join('\n')
  return Object.values(recordings).filter((r) => new RegExp(`\\b${r.name}\\b`).test(text))
}
