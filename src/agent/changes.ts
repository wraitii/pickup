// What the user changed by hand since the band last looked. We snapshot the
// files at the end of every agent turn and diff against it when the user next
// sends a message, so repeated tweaks collapse into their net effect and the
// band's own edits never show up as the user's.
import { shallowRef } from 'vue'
import { song } from '../state'
import { unifiedDiff } from '../song/format'

const SEEN_KEY = 'pickup.seen'

type Files = Record<string, string>

function loadSeen(): Files {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { ...song.files }
}

// a ref so UI computeds re-evaluate when the band catches up
const seen = shallowRef<Files>(loadSeen())

/** Call once the band has seen the current files (end of a turn, or a fresh chat). */
export function markSeen() {
  seen.value = { ...song.files }
  localStorage.setItem(SEEN_KEY, JSON.stringify(seen.value))
}

/** One entry per changed file: a unified diff, or a one-line note for moves/deletes. */
export function userChangeList(): string[] {
  const before = seen.value
  const now = song.files
  const out: string[] = []
  const added = Object.keys(now).filter((p) => before[p] === undefined)
  const removed = Object.keys(before).filter((p) => now[p] === undefined)

  for (const p of removed) {
    const movedTo = added.find((a) => now[a] === before[p])
    if (movedTo) {
      out.push(`moved ${p} → ${movedTo}`)
      added.splice(added.indexOf(movedTo), 1)
    } else out.push(`deleted ${p}`)
  }
  for (const p of Object.keys(now).sort()) {
    if (before[p] !== undefined && before[p] !== now[p]) out.push(unifiedDiff(p, before[p], now[p]))
  }
  for (const p of added.sort()) out.push(unifiedDiff(p, undefined, now[p]))
  return out
}

export function userChanges(): string {
  return userChangeList().join('\n\n')
}
