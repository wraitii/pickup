import { computed, reactive, watch } from 'vue'
import {
  CLIP_PATH_RE,
  SONG_FILE,
  formatSongJson,
  parseClipFile,
  parseSongJson,
  refOf,
  type ClipMeta,
  type Placement,
  type SongMeta,
} from './song/format'
import demoSong from './song/demo.json'

/** What's looping: one clip on its own, a range of song bars (0-based, `to` exclusive), or nothing (null: play through the song). */
export type LoopTarget = { kind: 'clip'; ref: string } | { kind: 'bars'; from: number; to: number } | null

export type Clip = {
  /** "verse/busier" */
  ref: string
  path: string
  section: string
  variant: string
  meta: ClipMeta
  /** Strudel code without the clip() header. */
  body: string
}

export type ClipStatus = { error?: string; warnings?: string[] }

const SONG_KEY = 'pickup.files'
const SETTINGS_KEY = 'pickup.settings'

/** The first-launch song: "Four on the Forum", a house track with a Greek flavour. */
function demoFiles(): Record<string, string> {
  return { ...demoSong }
}

export const newSongId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

function load<T>(key: string, fallback: () => T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return { ...fallback(), ...JSON.parse(raw) }
  } catch {}
  return fallback()
}

/**
 * The song: a map of file path → content (the single source of truth), plus
 * what's looping and the track mixer (mute/solo by track index), which are
 * playback settings rather than part of the song.
 */
export const song = reactive(
  load(SONG_KEY, () => ({
    /** Key of this song in the library (see song/library.ts). */
    id: newSongId(),
    files: demoFiles(),
    loop: null as LoopTarget,
    mix: { mute: [] as number[], solo: [] as number[] },
  })),
)

/** Whether a track is heard: soloed tracks only when any are soloed, otherwise all but the muted ones. */
export function trackAudible(track: number): boolean {
  return song.mix.solo.length ? song.mix.solo.includes(track) : !song.mix.mute.includes(track)
}

export const reasoningLevels = ['off', 'low', 'medium', 'high'] as const

export const settings = reactive(
  load(SETTINGS_KEY, () => ({
    apiKey: '',
    model: 'anthropic/claude-sonnet-5.5',
    openRouterModel: 'anthropic/claude-sonnet-5.5',
    reasoning: 'medium' as (typeof reasoningLevels)[number],
  })),
)

if (!reasoningLevels.includes(settings.reasoning)) settings.reasoning = 'medium'

/** Transient UI/playback state (not persisted). */
export const ui = reactive({
  /** Selected clip ref. */
  selected: null as string | null,
  playing: false,
  /**
   * Where playback is, in bars: the song position, or the position within the
   * clip when looping a lone clip (`clip` set). `sounding` are the clips heard now.
   */
  playhead: { pos: 0, clip: null as string | null, sounding: [] as string[] },
  /** Where the song plays from when not looping (song bars). */
  cursor: 0,
  /** A structural change is queued for the next bar. */
  pending: false,
  clipStatus: {} as Record<string, ClipStatus>,
})

// ---------------------------------------------------------------------------
// Derived views. Files are validated on write, so parse failures here only
// come from hand-edited localStorage; such clips are skipped.

export const clips = computed<Record<string, Clip>>(() => {
  const out: Record<string, Clip> = {}
  for (const [path, content] of Object.entries(song.files)) {
    const m = path.match(CLIP_PATH_RE)
    if (!m) continue
    try {
      const { meta, body } = parseClipFile(content)
      out[refOf(path)] = { ref: refOf(path), path, section: m[1], variant: m[2], meta, body }
    } catch (e) {
      console.warn(`skipping ${path}:`, e)
    }
  }
  return out
})

export const songMeta = computed<SongMeta>(() => {
  try {
    return parseSongJson(song.files[SONG_FILE] ?? '', (r) => clips.value[r]?.meta.bars)
  } catch {
    return { title: '', bpm: 120, placements: [] }
  }
})

export type PlacedClip = Placement & { bars: number; end: number }

/** The song's placements with their lengths (defensive against dangling refs). */
export const placements = computed<PlacedClip[]>(() =>
  songMeta.value.placements
    .filter((p) => clips.value[p.clip])
    .map((p) => {
      const bars = clips.value[p.clip].meta.bars
      return { ...p, bars, end: p.at + bars }
    }),
)

/** Song length in bars: where the last clip ends. */
export const songLength = computed(() => placements.value.reduce((n, p) => Math.max(n, p.end), 0))

/** Number of tracks in use (at least one). */
export const trackCount = computed(() => placements.value.reduce((n, p) => Math.max(n, p.track + 1), 1))

/** Variants in the same section folder, for flipping a slot between them. */
export function variantsOf(ref: string): Clip[] {
  const section = clips.value[ref]?.section
  return Object.values(clips.value)
    .filter((c) => c.section === section)
    .sort((a, b) => a.variant.localeCompare(b.variant))
}

/** Make `files` the working song, with fresh playback settings. */
export function loadSong(files: Record<string, string>, id = newSongId()) {
  song.id = id
  song.files = { ...files }
  song.loop = null
  song.mix = { mute: [], solo: [] }
  ui.cursor = 0
  ui.selected = null
  ui.clipStatus = {}
}

/** Files for a song from scratch: an empty song.json and no clips (the demo is only for first launch). */
export const emptySongFiles = () => ({ [SONG_FILE]: formatSongJson({ title: 'untitled jam', bpm: 100, placements: [] }) })

let saveTimer: number | undefined
watch(
  song,
  () => {
    clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => localStorage.setItem(SONG_KEY, JSON.stringify(song)), 300)
  },
  { deep: true },
)
watch(settings, () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)), { deep: true })
