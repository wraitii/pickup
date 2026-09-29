// The song's file formats. A song is a tiny repo:
//
//   song.json            { title, bpm, placements: [{ at: 0, track: 0, clip: "intro/main" }, ...] }
//   <section>/<variant>.js
//
// Each clip file starts with a `clip({...})` header statement holding its
// metadata, followed by Strudel code. Everything here is strict on purpose:
// writes that don't parse are rejected, so the song can't get into a bad state.
import { parse } from 'acorn'
import { structuredPatch } from 'diff'

export const SONG_FILE = 'song.json'
export const CLIP_PATH_RE = /^([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)\.js$/

export const refOf = (path: string) => path.replace(/\.js$/, '')
export const pathOf = (ref: string) => (ref.endsWith('.js') ? ref : `${ref}.js`)

export const CLIP_PATH_HELP =
  'Clip files are named <section>/<variant>.js using lowercase letters, digits, - and _ (e.g. verse/busier.js). The only other file is song.json.'

// ---------------------------------------------------------------------------
// Clip files

export type ClipMeta = { bars: number; from?: string; note?: string }
export type ParsedClip = { meta: ClipMeta; body: string }

const HEADER_HELP = 'Clip files must start with a header like: clip({ bars: 4, from: "verse/main", note: "sparser hats" })'

export function parseClipFile(src: string): ParsedClip {
  let ast: any
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true })
  } catch (e: any) {
    throw new Error(`Syntax error: ${e.message}`)
  }
  const first = ast.body[0]
  const call = first?.type === 'ExpressionStatement' ? first.expression : undefined
  if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier' || call.callee.name !== 'clip') {
    throw new Error(`Missing clip header. ${HEADER_HELP}`)
  }
  if (call.arguments.length !== 1 || call.arguments[0].type !== 'ObjectExpression') {
    throw new Error(`clip() takes a single object literal. ${HEADER_HELP}`)
  }

  const meta: any = {}
  for (const prop of call.arguments[0].properties) {
    const key = prop.type === 'Property' && !prop.computed ? (prop.key.name ?? prop.key.value) : undefined
    if (!key) throw new Error(`clip header: only plain \`key: value\` entries are allowed. ${HEADER_HELP}`)
    if (!['bars', 'from', 'note'].includes(key)) throw new Error(`clip header: unknown key "${key}" (allowed: bars, from, note)`)
    if (prop.value.type !== 'Literal') throw new Error(`clip header: "${key}" must be a literal value`)
    meta[key] = prop.value.value
  }
  if (!Number.isInteger(meta.bars) || meta.bars < 1 || meta.bars > 64) {
    throw new Error('clip header: "bars" is required and must be an integer from 1 to 64')
  }
  for (const k of ['from', 'note']) {
    if (meta[k] !== undefined && typeof meta[k] !== 'string') throw new Error(`clip header: "${k}" must be a string`)
  }
  if (meta.from !== undefined) meta.from = refOf(meta.from)

  for (const stmt of ast.body.slice(1)) {
    const c = stmt.type === 'ExpressionStatement' ? stmt.expression : undefined
    if (c?.type === 'CallExpression' && c.callee.type === 'Identifier' && c.callee.name === 'clip') {
      throw new Error('Only one clip() header per file, as the first statement.')
    }
  }

  const body = src.slice(first.end).replace(/^[ \t]*;?[ \t]*\r?\n/, '').replace(/^\s*\n/, '')
  return { meta, body }
}

export function formatClipHeader(meta: ClipMeta): string {
  const parts = [`bars: ${meta.bars}`]
  if (meta.from) parts.push(`from: ${JSON.stringify(meta.from)}`)
  if (meta.note) parts.push(`note: ${JSON.stringify(meta.note)}`)
  return `clip({ ${parts.join(', ')} })`
}

export function formatClipFile(meta: ClipMeta, body: string): string {
  return `${formatClipHeader(meta)}\n\n${body.trim()}\n`
}

// ---------------------------------------------------------------------------
// song.json

/** A clip placed on the timeline: starting at bar `at` (0-based) on `track` (0-based). */
export type Placement = { at: number; track: number; clip: string }
export type SongMeta = { title: string; bpm: number; placements: Placement[] }

export const MAX_TRACKS = 16
export const MAX_BARS = 1024

const PLACEMENT_HELP = 'Each placement is { "at": <bar, from 0>, "track": <0-15>, "clip": "<section>/<variant>" }.'

/**
 * Parse and validate song.json. `clipBars` gives a clip's length (undefined if
 * it doesn't exist), to check refs and that clips on one track don't overlap.
 */
export function parseSongJson(src: string, clipBars: (ref: string) => number | undefined): SongMeta {
  let data: any
  try {
    data = JSON.parse(src)
  } catch (e: any) {
    throw new Error(`song.json is not valid JSON: ${e.message}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('song.json must be an object')
  for (const k of Object.keys(data)) {
    if (!['title', 'bpm', 'placements'].includes(k)) {
      throw new Error(`song.json: unknown key "${k}" (allowed: title, bpm, placements)`)
    }
  }
  const title = data.title ?? ''
  if (typeof title !== 'string') throw new Error('song.json: "title" must be a string')
  if (typeof data.bpm !== 'number' || data.bpm < 30 || data.bpm > 300) throw new Error('song.json: "bpm" must be a number from 30 to 300')

  const raw = data.placements
  if (!Array.isArray(raw)) throw new Error(`song.json: "placements" must be an array. ${PLACEMENT_HELP}`)

  const placements: Placement[] = raw.map((p: any, i: number) => {
    if (!p || typeof p !== 'object') throw new Error(`song.json: placements[${i}] must be an object. ${PLACEMENT_HELP}`)
    for (const k of Object.keys(p)) {
      if (!['at', 'track', 'clip'].includes(k)) throw new Error(`song.json: placements[${i}]: unknown key "${k}". ${PLACEMENT_HELP}`)
    }
    if (!Number.isInteger(p.at) || p.at < 0 || p.at >= MAX_BARS) throw new Error(`song.json: placements[${i}].at must be a bar number from 0`)
    const track = p.track ?? 0
    if (!Number.isInteger(track) || track < 0 || track >= MAX_TRACKS) {
      throw new Error(`song.json: placements[${i}].track must be an integer from 0 to ${MAX_TRACKS - 1}`)
    }
    if (typeof p.clip !== 'string') throw new Error(`song.json: placements[${i}].clip must be a clip ref like "verse/main"`)
    const clip = refOf(p.clip)
    if (clipBars(clip) === undefined) throw new Error(`song.json: placements[${i}] refers to missing clip "${clip}"`)
    return { at: p.at, track, clip }
  })

  // no overlaps within a track: that's what tracks are for
  const sorted = sortPlacements(placements)
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = [sorted[i - 1], sorted[i]]
    if (a.track === b.track && a.at + clipBars(a.clip)! > b.at) {
      throw new Error(
        `song.json: ${b.clip} (at ${b.at}) overlaps ${a.clip} (at ${a.at}, ${clipBars(a.clip)} bars) on track ${b.track}. ` +
          'Move one of them, or put it on another track.',
      )
    }
  }
  return { title, bpm: data.bpm, placements: sorted }
}

export const sortPlacements = (ps: Placement[]) => [...ps].sort((a, b) => a.at - b.at || a.track - b.track)

/** One placement per line, in time order, so diffs and edits stay readable. */
export function formatSongJson(s: SongMeta): string {
  const ps = sortPlacements(s.placements).map((p) => `    { "at": ${p.at}, "track": ${p.track}, "clip": ${JSON.stringify(p.clip)} }`)
  return [
    '{',
    `  "title": ${JSON.stringify(s.title)},`,
    `  "bpm": ${s.bpm},`,
    ps.length ? `  "placements": [\n${ps.join(',\n')}\n  ]` : '  "placements": []',
    '}',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------

/** Compact unified diff with a/ b/ headers (empty string when identical). */
export function unifiedDiff(path: string, before: string | undefined, after: string | undefined): string {
  if (before === after) return ''
  const patch = structuredPatch(`a/${path}`, `b/${path}`, before ?? '', after ?? '', '', '', { context: 2 })
  const hunks = patch.hunks.map((h) =>
    [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'),
  )
  const from = before === undefined ? '/dev/null' : `a/${path}`
  const to = after === undefined ? '/dev/null' : `b/${path}`
  return [`--- ${from}`, `+++ ${to}`, ...hunks].join('\n')
}
