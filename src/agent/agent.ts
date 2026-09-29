import { reactive, shallowRef } from 'vue'
import { createModels, Type, type AssistantMessage, type Model, type TSchema, type Usage } from '@earendil-works/pi-ai'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import { song, settings, ui, clips, songLength, songMeta, type LoopTarget } from '../state'
import { soundNames, drumBanks } from '../music/strudel'
import { regionOf, buildRegion, seek } from '../music/conductor'
import { renderPattern, analyze } from '../music/render'
import { writeFile, editFile, moveFile, removeFile, type WriteResult } from '../song/fs'
import { refOf } from '../song/format'
import { localModel, localStream, LOCAL_MODEL_ID } from './local'
import { SYSTEM_PROMPT, fullState, transportLine, lsListing } from './prompt'
import { userChanges, markSeen } from './changes'
import uiGuide from './ui.txt?raw'
import { browserModel } from './browserModel'

export const models = createModels()
models.setProvider(openrouterProvider())

/** Models offered for the band (chat + tools). */
const BAND_MODELS = [
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5.5',
  'openai/gpt-6-astra',
  'openai/gpt-6-sol',
  'openai/gpt-6-luna',
  'moonshotai/kimi-k3',
  'z-ai/glm-5.3',
  'deepseek/deepseek-v4.1-flash',
  'xiaomi/mimo-v2.6-pro',
]
export const DEFAULT_BAND_MODEL = 'anthropic/claude-sonnet-5.5'

/**
 * Models OpenRouter serves that pi's bundled catalog doesn't know yet, cloned
 * from a catalog sibling with the same API, pricing and limits.
 */
const NOT_IN_CATALOG: Record<string, { from: string; name: string }> = {
  'anthropic/claude-sonnet-5.5': { from: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5.5' },
}

function lookup(id: string): Model<any> | undefined {
  if (id === LOCAL_MODEL_ID) return localModel
  const m = models.getModel('openrouter', id)
  if (m) return browserModel(m)
  const extra = NOT_IN_CATALOG[id]
  const base = extra && models.getModel('openrouter', extra.from)
  return base ? browserModel({ ...base, id, name: extra.name }) : undefined
}

const resolve = (ids: string[]) => ids.map(lookup).filter((m): m is Model<any> => !!m)
export const bandModelOptions = [...resolve(BAND_MODELS), localModel]

export function getModel(id: string): Model<any> {
  const m = lookup(id)
  if (!m) throw new Error(`Unknown OpenRouter model: ${id}`)
  return m
}

// settings saved with a model we no longer offer fall back to the defaults
if (!BAND_MODELS.includes(settings.model) && settings.model !== LOCAL_MODEL_ID) settings.model = DEFAULT_BAND_MODEL

// ---------------------------------------------------------------------------
// Reactive chat + usage state for the UI

const CHAT_KEY = 'pickup.chat'

type Persisted = { messages: AgentMessage[]; cost: number }

function loadChat(): Persisted {
  try {
    const raw = localStorage.getItem(CHAT_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { messages: [], cost: 0 }
}

const saved = loadChat()

/** The agent transcript (replaced wholesale on each update). */
export const transcript = shallowRef<AgentMessage[]>(saved.messages)
/** The assistant message currently streaming, if any. */
export const streaming = shallowRef<AgentMessage | null>(null)

export const chat = reactive({
  busy: false,
  error: '',
  /** Tool calls currently executing. */
  running: {} as Record<string, string>,
  usage: {
    /** Total spend for this chat, USD. */
    cost: saved.cost,
    /** Tokens in the last request's context (prompt + output). */
    contextTokens: lastContextTokens(saved.messages),
  },
})

function lastContextTokens(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AssistantMessage
    if (m.role === 'assistant' && m.usage) return m.usage.input + m.usage.cacheRead + m.usage.cacheWrite + m.usage.output
  }
  return 0
}

function addCost(usage?: Usage) {
  if (usage?.cost) chat.usage.cost += usage.cost.total
}

/** Spectrograms are big: keep them in memory for the model, but not in localStorage. */
function withoutImages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m: any) =>
    m.role === 'toolResult' && m.details?.image
      ? {
          ...m,
          content: m.content.map((c: any) => (c.type === 'image' ? { type: 'text', text: '[image not kept]' } : c)),
          details: { ...m.details, image: undefined },
        }
      : m,
  )
}

function persist() {
  localStorage.setItem(CHAT_KEY, JSON.stringify({ messages: withoutImages(transcript.value), cost: chat.usage.cost }))
}

// ---------------------------------------------------------------------------
// Tools: a small file-system over the song, plus transport and sound search

const text = (t: string, details?: any) => ({ content: [{ type: 'text' as const, text: t }], details })

/** Identity helper so each tool's params are typed from its schema. */
const tool = <T extends TSchema>(t: AgentTool<T>): AgentTool<any> => t

function writeReport(r: WriteResult): ReturnType<typeof text> {
  const what = r.diff ? `ok: wrote ${r.path}` : `ok: ${r.path} unchanged`
  return text(`${what}${r.warnings.length ? `\nwarnings: ${r.warnings.join('; ')}` : ''}`, { diff: r.diff })
}

const tools: AgentTool<any>[] = [
  tool({
    name: 'ls',
    label: 'List files',
    description: 'List song files with clip summaries, plus the read-only ui.txt guide.',
    parameters: Type.Object({}),
    execute: async () => text(lsListing()),
  }),
  tool({
    name: 'read',
    label: 'Read',
    description: 'Read a file: song.json, a clip like verse/main.js, or ui.txt for help using the Pickup interface.',
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, p) => {
      const path = p.path.replace(/^\.?\//, '')
      const content = path === 'ui.txt' ? uiGuide : song.files[path] ?? song.files[`${path}.js`]
      if (content === undefined) throw new Error(`File not found: ${path}. Use ls to see the files.`)
      return text(content)
    },
  }),
  tool({
    name: 'write',
    label: 'Write',
    description:
      'Create or overwrite a file with the complete content. Clip files: <section>/<variant>.js starting with a clip({...}) header. ' +
      'Validated first; if invalid the file is left unchanged and the error is returned.',
    parameters: Type.Object({
      path: Type.String({ description: 'e.g. verse/busier.js or song.json' }),
      content: Type.String(),
    }),
    execute: async (_id, p) => writeReport(await writeFile(p.path, p.content)),
  }),
  tool({
    name: 'edit',
    label: 'Edit',
    description:
      'Edit a file with exact text replacements, applied in order. Each oldText must appear exactly once in the file ' +
      '(include enough surrounding text to be unique). The result is validated like write.',
    parameters: Type.Object({
      path: Type.String(),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: 'Exact text to replace, including whitespace.' }),
          newText: Type.String(),
        }),
        { minItems: 1 },
      ),
    }),
    execute: async (_id, p) => writeReport(await editFile(p.path, p.edits)),
  }),
  tool({
    name: 'mv',
    label: 'Move',
    description: 'Rename or move a clip file (e.g. verse/b.js → chorus/main.js). song.json and from-links are updated.',
    parameters: Type.Object({ from: Type.String(), to: Type.String() }),
    execute: async (_id, p) => {
      moveFile(p.from, p.to)
      return text(`ok: moved ${p.from} → ${p.to}`)
    },
  }),
  tool({
    name: 'rm',
    label: 'Delete',
    description: "Delete a clip file. Refused while it's placed in song.json. Clips derived from it are re-linked to its parent.",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, p) => {
      removeFile(p.path)
      return text(`ok: deleted ${p.path}`)
    },
  }),
  tool({
    name: 'play',
    label: 'Play',
    description:
      'Choose what the user hears: a clip ref like "verse/busier" (on repeat, on its own), "song" for the whole timeline from the top, ' +
      'or a 1-based, inclusive bar range of the timeline like "9-16" (on repeat). Lands on the next bar.',
    parameters: Type.Object({ target: Type.String() }),
    execute: async (_id, p) => {
      const target = parseTarget(p.target)
      if (target) song.loop = target
      else seek(0)
      if (target?.kind === 'clip') ui.selected = target.ref
      return text(`ok: ${transportLine()}`)
    },
  }),
  tool({
    name: 'listen',
    label: 'Listen',
    description:
      'Render audio offline (the user hears nothing) and get back a spectrogram image (log frequency vs bars) plus a per-bar table of ' +
      'RMS/peak and energy in sub/low/mid/high/air bands, in dBFS. Use it to check a mix: masking, muddy lows, harsh highs, ' +
      'levels between sections, whether a build actually builds. target: a clip ref like "verse/main", "song", or a 1-based inclusive bar range like "9-16".',
    parameters: Type.Object({
      target: Type.String(),
      bars: Type.Optional(Type.Integer({ minimum: 1, maximum: 128, description: 'How many bars to render (default: the whole target).' })),
    }),
    execute: async (_id, p) => {
      const { pattern, bars, title } = await listenTarget(p.target)
      const n = Math.min(p.bars ?? bars, 128)
      const cps = songMeta.value.bpm / 60 / 4
      const { samples, sampleRate, notes, timings } = await renderPattern(pattern, n, cps)
      const t0 = performance.now()
      const { png, table } = analyze(samples, sampleRate, n, cps, title)
      const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
      const took =
        `render: ${secs(timings.frame)} frame, ${secs(timings.setup)} setup, ${secs(timings.schedule)} scheduling ${notes} notes, ` +
        `${secs(timings.audio)} audio (${secs((samples.length / sampleRate) * 1000)} long), ${secs(performance.now() - t0)} analysis`
      const seesImages = agent.state.model.input.includes('image')
      return {
        content: [
          { type: 'text' as const, text: `${title}, ${n} bars at ${songMeta.value.bpm} bpm\n${table}\n${took}` },
          ...(seesImages ? [{ type: 'image' as const, data: png, mimeType: 'image/png' }] : []),
        ],
        // for the chat panel, which shows it even when the model can't see images
        details: { image: png },
      }
    },
  }),
  tool({
    name: 'list_sounds',
    label: 'List sounds',
    description: 'Search available sound names (samples and synths). Empty query lists drum banks and other sounds.',
    parameters: Type.Object({ query: Type.Optional(Type.String({ description: 'Substring, e.g. "bass", "909", "piano".' })) }),
    execute: async (_id, p) => {
      const q = (p.query ?? '').toLowerCase()
      if (!q) {
        const plain = soundNames.filter((n) => !/^[A-Z].*_/.test(n))
        return text(`drum banks (use .bank(name) with bd sd hh oh cp rim lt mt ht cr rd...): ${drumBanks.join(' ')}\n\nother sounds: ${plain.join(' ')}`)
      }
      const hits = soundNames.filter((n) => n.toLowerCase().includes(q))
      return text(hits.length ? hits.slice(0, 300).join(' ') : 'no match')
    },
  }),
]

/** A `play`/`listen` target: a clip ref, "song", or a 1-based inclusive bar range like "9-16". */
function parseTarget(target: string): LoopTarget {
  const t = target.trim()
  if (t === 'song') return null
  const range = t.match(/^(\d+)(?:\s*-\s*(\d+))?$/)
  if (range) {
    const n = songLength.value
    const from = +range[1]
    const to = +(range[2] ?? range[1])
    if (from < 1 || to < from || to > n) throw new Error(`Bar range must be within 1-${n} (the song is ${n} bars).`)
    return { kind: 'bars', from: from - 1, to }
  }
  const ref = refOf(t)
  if (!clips.value[ref]) throw new Error(`No clip ${ref}. Use ls to see the files.`)
  return { kind: 'clip', ref }
}

/** Resolve a `listen` target to a pattern starting at cycle 0. */
async function listenTarget(target: string): Promise<{ pattern: any; bars: number; title: string }> {
  const loop = parseTarget(target)
  const region = regionOf(loop)
  if (!region.entries.length) throw new Error('Nothing to render: nothing is placed there.')
  for (const e of region.entries) {
    if (ui.clipStatus[e.ref]?.error) throw new Error(`${e.ref} doesn't compile: ${ui.clipStatus[e.ref]!.error}`)
  }
  const title = !loop ? 'song' : loop.kind === 'clip' ? loop.ref : `bars ${loop.from + 1}-${loop.to}`
  return { pattern: await buildRegion(region, 0), bars: region.to - region.from, title }
}

// ---------------------------------------------------------------------------
// The agent

// Context blocks the app prepends to user messages.
const CONTEXT_RE = /^(?:<(song-state|user-changes|transport)>[\s\S]*?<\/\1>\s*)+/
const CHANGES_RE = /<user-changes>\n?([\s\S]*?)\n?<\/user-changes>/

function rawText(m: AgentMessage): string {
  const c = (m as any).content
  return typeof c === 'string' ? c : c.map((b: any) => b.text ?? '').join('')
}

/** The user's own words, without the context blocks we prepend. */
export function userText(m: AgentMessage): string {
  return rawText(m).replace(CONTEXT_RE, '')
}

/** The hand-made changes that were attached to a user message, if any. */
export function attachedChanges(m: AgentMessage): string {
  return rawText(m).match(CONTEXT_RE)?.[0].match(CHANGES_RE)?.[1] ?? ''
}

function createAgent(messages: AgentMessage[]) {
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      thinkingLevel: settings.reasoning,
      model: getModel(settings.model),
      tools,
      messages,
    },
    streamFn: (model, context, options) =>
      model.provider === 'local' ? localStream(model, context, options) : models.streamSimple(model, context, options),
    getApiKey: () => settings.apiKey,
    toolExecution: 'sequential',
  })
  agent.subscribe((event) => onEvent(agent, event))
  return agent
}

let agent = createAgent(saved.messages)

function onEvent(agent: Agent, event: AgentEvent) {
  switch (event.type) {
    case 'message_start':
    case 'message_update':
      if (event.message.role === 'assistant') streaming.value = { ...event.message }
      break
    case 'message_end': {
      streaming.value = null
      transcript.value = [...agent.state.messages]
      const m = event.message as AssistantMessage
      if (m.role === 'assistant') {
        addCost(m.usage)
        chat.usage.contextTokens = lastContextTokens([m])
        if (m.stopReason === 'error') chat.error = m.errorMessage ?? 'model error'
      }
      break
    }
    case 'tool_execution_start':
      chat.running[event.toolCallId] = event.toolName
      break
    case 'tool_execution_end':
      delete chat.running[event.toolCallId]
      break
    case 'agent_end':
      transcript.value = [...agent.state.messages]
      persist()
      break
  }
}

/**
 * Send a user message. The first message of a conversation carries the full
 * song state; later ones only carry the user's hand edits (as diffs) and the
 * transport line: everything else the band did itself and sees in its history.
 */
export async function send(input: string) {
  if (!settings.apiKey && settings.model !== LOCAL_MODEL_ID) {
    chat.error = 'Paste an OpenRouter API key in settings first.'
    return
  }
  chat.error = ''
  chat.busy = true
  try {
    agent.state.model = getModel(settings.model)
    agent.state.thinkingLevel = settings.reasoning
    const first = !agent.state.messages.some((m) => m.role === 'user')
    const changes = first ? '' : userChanges()
    const blocks = [
      first ? fullState() : '',
      changes ? `<user-changes>\n${changes}\n</user-changes>` : '',
      transportLine(),
    ].filter(Boolean)
    markSeen()
    await agent.prompt(`${blocks.join('\n')}\n\n${input}`)
  } catch (e: any) {
    chat.error = e?.message ?? String(e)
  } finally {
    // the band has seen (and made) everything up to here
    markSeen()
    chat.busy = false
    streaming.value = null
    transcript.value = [...agent.state.messages]
    persist()
  }
}

export function abort() {
  agent.abort()
}

export function resetChat() {
  agent.abort()
  agent = createAgent([])
  transcript.value = []
  chat.usage.contextTokens = 0
  chat.error = ''
  persist()
}

