// File operations on the song, shared by the UI and the band's tools.
// Every write is validated first and rejected (file unchanged) if invalid, and
// the app keeps cross-file references (song.json, `from`) consistent.
import { reactive } from 'vue'
import { song, clips, songMeta, ui } from '../state'
import { compileClip } from '../music/strudel'
import {
  CLIP_PATH_HELP,
  CLIP_PATH_RE,
  SONG_FILE,
  formatClipFile,
  formatSongJson,
  parseClipFile,
  parseSongJson,
  pathOf,
  refOf,
  unifiedDiff,
  type ClipMeta,
  type SongMeta,
} from './format'

/** Previous versions per path, most recent last (in memory only). */
export const history = reactive<Record<string, string[]>>({})
const HISTORY_LIMIT = 30

function commit(path: string, content: string | undefined) {
  const prev = song.files[path]
  if (prev !== undefined) {
    const h = (history[path] ??= [])
    h.push(prev)
    if (h.length > HISTORY_LIMIT) h.shift()
  }
  if (content === undefined) delete song.files[path]
  else song.files[path] = content
}

export type WriteResult = { path: string; diff: string; warnings: string[] }

/** Validate and write a file. Throws (leaving the file untouched) if invalid. */
export async function writeFile(path: string, content: string): Promise<WriteResult> {
  path = path.replace(/^\.?\//, '')
  let warnings: string[] = []
  if (path === SONG_FILE) {
    content = formatSongJson(parseSongJson(content, (ref) => clips.value[ref]?.meta.bars))
  } else {
    if (!CLIP_PATH_RE.test(path)) throw new Error(`Invalid path "${path}". ${CLIP_PATH_HELP}`)
    const { meta, body } = parseClipFile(content)
    const ref = refOf(path)
    if (meta.from) {
      if (meta.from === ref) throw new Error('clip header: "from" cannot point to the clip itself')
      if (!clips.value[meta.from]) throw new Error(`clip header: "from" refers to missing clip "${meta.from}"`)
      // no lineage cycles
      for (let r: string | undefined = meta.from; r; r = clips.value[r]?.meta.from) {
        if (r === ref) throw new Error(`clip header: "from: ${meta.from}" would create a lineage cycle`)
      }
    }
    // a longer clip can collide with the next one on its track
    const old = clips.value[ref]
    if (old && old.meta.bars !== meta.bars && song.files[SONG_FILE] !== undefined) {
      try {
        parseSongJson(song.files[SONG_FILE], (r) => (r === ref ? meta.bars : clips.value[r]?.meta.bars))
      } catch (e: any) {
        throw new Error(`bars: ${meta.bars} doesn't fit where ${ref} is placed in the song. ${e.message}`)
      }
    }
    warnings = (await compileClip(body, meta.bars)).warnings
  }
  const diff = unifiedDiff(path, song.files[path], content)
  if (diff) commit(path, content)
  return { path, diff, warnings }
}

export type Edit = { oldText: string; newText: string }

/** Exact search/replace edits, applied in order; each oldText must match exactly once. */
export async function editFile(path: string, edits: Edit[]): Promise<WriteResult> {
  path = path.replace(/^\.?\//, '')
  const current = song.files[path]
  if (current === undefined) throw new Error(`File not found: ${path}`)
  let next = current
  edits.forEach(({ oldText, newText }, i) => {
    const count = oldText ? next.split(oldText).length - 1 : 0
    if (count === 0) {
      throw new Error(
        `edits[${i}]: oldText not found in ${path}. It must match exactly, including whitespace; read the file again if unsure.`,
      )
    }
    if (count > 1) throw new Error(`edits[${i}]: oldText matches ${count} times in ${path}; include more context to make it unique.`)
    next = next.replace(oldText, () => newText)
  })
  if (next === current) throw new Error('The edits made no change.')
  return writeFile(path, next)
}

/** Rename/move a clip; updates song.json, `from` links, the loop and the selection. */
export function moveFile(from: string, to: string): void {
  from = pathOf(refOf(from.replace(/^\.?\//, '')))
  to = pathOf(refOf(to.replace(/^\.?\//, '')))
  if (song.files[from] === undefined || !CLIP_PATH_RE.test(from)) throw new Error(`No clip file ${from}`)
  if (!CLIP_PATH_RE.test(to)) throw new Error(`Invalid path "${to}". ${CLIP_PATH_HELP}`)
  if (song.files[to] !== undefined) throw new Error(`${to} already exists`)
  const [oldRef, newRef] = [refOf(from), refOf(to)]

  for (const c of Object.values(clips.value)) {
    if (c.meta.from === oldRef) commit(c.path, formatClipFile({ ...c.meta, from: newRef }, c.body))
  }
  const meta = songMeta.value
  if (meta.placements.some((p) => p.clip === oldRef)) {
    const placements = meta.placements.map((p) => (p.clip === oldRef ? { ...p, clip: newRef } : p))
    commit(SONG_FILE, formatSongJson({ ...meta, placements }))
  }
  commit(to, song.files[from])
  if (history[from]) history[to] = history[from]
  delete history[from]
  commit(from, undefined)
  if (song.loop?.kind === 'clip' && song.loop.ref === oldRef) song.loop = { kind: 'clip', ref: newRef }
  if (ui.selected === oldRef) ui.selected = newRef
}

/** Delete a clip. Refused while it's placed in the song; children are re-linked to its parent. */
export function removeFile(path: string): void {
  path = pathOf(refOf(path.replace(/^\.?\//, '')))
  const ref = refOf(path)
  const clip = clips.value[ref]
  if (!clip) throw new Error(`No clip file ${path}`)
  if (songMeta.value.placements.some((p) => p.clip === ref)) {
    throw new Error(`${ref} is placed in song.json; remove its placements first.`)
  }
  for (const c of Object.values(clips.value)) {
    if (c.meta.from === ref) commit(c.path, formatClipFile({ ...c.meta, from: clip.meta.from }, c.body))
  }
  commit(path, undefined)
  if (song.loop?.kind === 'clip' && song.loop.ref === ref) song.loop = null
  if (ui.selected === ref) ui.selected = null
}

/** Restore the previous version of a file. */
export async function undo(path: string): Promise<void> {
  const h = history[path]
  const prev = h?.pop()
  if (prev === undefined) return
  const undone = song.files[path]
  try {
    await writeFile(path, prev)
    // writeFile pushed the version we just undid; undo isn't itself undoable
    if (h[h.length - 1] === undone) h.pop()
  } catch (e) {
    h.push(prev)
    throw e
  }
}

// ---------------------------------------------------------------------------
// Structured helpers for the UI (they go through the same validation)

export function updateSong(change: (s: SongMeta) => void): Promise<WriteResult> {
  const next = structuredClone({ ...songMeta.value, placements: songMeta.value.placements.map((p) => ({ ...p })) })
  change(next)
  return writeFile(SONG_FILE, formatSongJson(next))
}

export function updateClip(ref: string, change: { meta?: Partial<ClipMeta>; body?: string }): Promise<WriteResult> {
  const c = clips.value[ref]
  if (!c) throw new Error(`No clip ${ref}`)
  const meta = { ...c.meta, ...change.meta }
  if (!meta.note) delete meta.note
  return writeFile(c.path, formatClipFile(meta, change.body ?? c.body))
}
