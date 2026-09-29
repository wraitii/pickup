// The song library: every song made in this browser, kept in localStorage.
// The working song (state.ts) autosaves into it under its id; opening another
// song swaps the working files. Songs also travel as .pickup.json files, which
// are validated on import like any write.
import { reactive, watch } from 'vue'
import { song, songMeta, loadSong, emptySongFiles } from '../state'
import { stop } from '../music/conductor'
import { resetChat } from '../agent/agent'
import { markSeen } from '../agent/changes'
import { CLIP_PATH_HELP, CLIP_PATH_RE, SONG_FILE, parseClipFile, parseSongJson, refOf } from './format'
import {
  recordings,
  recordingsUsedBy,
  packRecording,
  unpackRecording,
  saveRecording,
  type PackedRecording,
} from '../music/recordings'

const LIBRARY_KEY = 'pickup.library'
const FILE_FORMAT = 'pickup-song'

export type LibrarySong = { id: string; title: string; files: Record<string, string>; updated: number }

export const library = reactive<Record<string, LibrarySong>>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(LIBRARY_KEY) || '{}')
    } catch {
      return {}
    }
  })(),
)

function persist() {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library))
  } catch (e) {
    console.warn('could not save the song library', e)
  }
}

/** Copy the working song into the library (a no-op when nothing changed, so opening a song doesn't bump it). */
function save() {
  const title = songMeta.value.title || 'untitled'
  const prev = library[song.id]
  if (prev && prev.title === title && JSON.stringify(prev.files) === JSON.stringify(song.files)) return
  library[song.id] = { id: song.id, title, files: { ...song.files }, updated: Date.now() }
  persist()
}

let timer: number | undefined
/** Save pending edits now, before the working song is swapped out. */
function flush() {
  clearTimeout(timer)
  save()
}
save()
watch(
  () => song.files,
  () => {
    clearTimeout(timer)
    timer = window.setTimeout(save, 500)
  },
  { deep: true },
)

/** Swap in another song: playback stops and the band starts a fresh chat about it. */
function switchTo(files: Record<string, string>, id?: string) {
  flush()
  stop()
  loadSong(files, id)
  resetChat()
  markSeen()
  save()
}

export function openSong(id: string) {
  if (id !== song.id && library[id]) switchTo(library[id].files, id)
}

export function createSong() {
  switchTo(emptySongFiles())
}

/** Remove a song from the library (not the one that's open). */
export function deleteSong(id: string) {
  if (id === song.id) return
  delete library[id]
  persist()
}

// ---------------------------------------------------------------------------
// Files

/** Download a song as .pickup.json, with the recorded takes it uses. */
export async function exportSong(id: string) {
  if (id === song.id) flush()
  const s = library[id]
  if (!s) return
  const takes = await Promise.all(recordingsUsedBy(s.files).map(packRecording))
  const data = JSON.stringify({ format: FILE_FORMAT, version: 1, files: s.files, recordings: takes }, null, 2)
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'song'}.pickup.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Import a .pickup.json file as a new song and open it. Throws with a readable message if the file isn't valid. */
export async function importSong(file: File) {
  let data: any
  try {
    data = JSON.parse(await file.text())
  } catch {
    throw new Error(`${file.name} is not a Pickup song (not JSON)`)
  }
  const files = data?.format === FILE_FORMAT ? data.files : undefined
  if (!files || typeof files !== 'object') throw new Error(`${file.name} is not a Pickup song`)

  const bars: Record<string, number> = {}
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string') throw new Error(`${path}: content must be text`)
    if (path === SONG_FILE) continue
    if (!CLIP_PATH_RE.test(path)) throw new Error(`Invalid path "${path}". ${CLIP_PATH_HELP}`)
    try {
      bars[refOf(path)] = parseClipFile(content).meta.bars
    } catch (e: any) {
      throw new Error(`${path}: ${e.message}`)
    }
  }
  if (typeof files[SONG_FILE] !== 'string') throw new Error(`${file.name} has no ${SONG_FILE}`)
  parseSongJson(files[SONG_FILE], (ref) => bars[ref])

  // takes travel with the song; one already in this browser under the same name is kept as is
  const takes = (Array.isArray(data.recordings) ? data.recordings : []).map((p: PackedRecording) => unpackRecording(p))
  for (const t of takes) if (!recordings[t.name]) await saveRecording(t)
  switchTo(files)
}
