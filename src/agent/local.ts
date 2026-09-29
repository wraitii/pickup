// The "local" band model: instead of calling an LLM API, each turn goes to a
// relay on the user's machine (node scripts/band.mjs serve), where an outside
// driver (e.g. Claude Code in a terminal) plays the band. Works from any origin
// that may reach localhost: the relay sends CORS / private-network headers.
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai'

export const LOCAL_MODEL_ID = 'local/driver'
export const LOCAL_RELAY = 'http://localhost:7878'

export const localModel = {
  id: LOCAL_MODEL_ID,
  name: 'Local: driven from a terminal (node scripts/band.mjs)',
  api: 'pickup-local',
  provider: 'local',
  baseUrl: LOCAL_RELAY,
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 100_000,
} as unknown as Model<any>

type Action = { type: 'tool'; name: string; args: any } | { type: 'reply'; text: string }

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

const textOf = (content: any) =>
  typeof content === 'string' ? content : content.map((c: any) => (c.type === 'text' ? c.text : '')).join('')

/** Send the latest message to the relay; the response is the driver's next action. */
export function localStream(model: Model<any>, context: Context, options?: { signal?: AbortSignal }) {
  const stream = createAssistantMessageEventStream()
  const message = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'], errorMessage?: string): AssistantMessage => ({
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: USAGE,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  })
  stream.push({ type: 'start', partial: message([], 'stop') })

  const last: any = context.messages[context.messages.length - 1]
  const image = last?.role === 'toolResult' ? last.content.find((c: any) => c.type === 'image') : undefined
  const turn = {
    kind: last?.role === 'toolResult' ? 'toolResult' : 'user',
    text: textOf(last?.content ?? ''),
    image: image && { data: image.data, mimeType: image.mimeType },
    isError: last?.isError,
    system: context.systemPrompt ?? '',
  }

  fetch(`${LOCAL_RELAY}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(turn),
    signal: options?.signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(await res.text())
      const a: Action = await res.json()
      const m =
        a.type === 'tool'
          ? message([{ type: 'toolCall', id: `local-${Date.now()}`, name: a.name, arguments: a.args }], 'toolUse')
          : message([{ type: 'text', text: a.text }], 'stop')
      stream.push({ type: 'done', reason: m.stopReason as 'stop' | 'toolUse', message: m })
      stream.end(m)
    })
    .catch((e) => {
      const aborted = options?.signal?.aborted
      const m = message(
        [],
        aborted ? 'aborted' : 'error',
        aborted ? 'aborted' : `No band relay at ${LOCAL_RELAY} (${e?.message ?? e}). Run: node scripts/band.mjs serve`,
      )
      stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: m })
      stream.end(m)
    })
  return stream
}
