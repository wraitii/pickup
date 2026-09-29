import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createModels } from '@earendil-works/pi-ai'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { browserModel } from '../src/agent/browserModel.ts'

test('Claude uses OpenRouter chat completions without Anthropic browser headers', async () => {
  const models = createModels()
  models.setProvider(openrouterProvider())
  const catalog = models.getModel('openrouter', 'anthropic/claude-sonnet-5')
  assert.ok(catalog)
  const model = browserModel({ ...catalog, id: 'anthropic/claude-sonnet-5.5' })
  assert.equal(model.api, 'openai-completions')
  let requests = 0
  const result = await models.streamSimple(model, {
    systemPrompt: 'Help with Pickup.',
    messages: [{ role: 'user', content: 'How do I loop?', timestamp: Date.now() }],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  }, {
    apiKey: 'test-key',
    reasoning: 'medium',
    fetch: async (url, init) => {
      requests++
      assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions')
      const headers = new Headers(init.headers)
      assert.equal(headers.has('anthropic-dangerous-direct-browser-access'), false)
      assert.equal(headers.get('authorization'), 'Bearer test-key')
      const body = JSON.parse(init.body)
      assert.equal(body.model, model.id)
      assert.equal(body.reasoning.effort, 'medium')
      assert.equal(body.tools[0].function.name, 'read')
      return new Response('data: ' + JSON.stringify({
        id: 'test', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"ui.txt"}' } }] }, finish_reason: 'tool_calls' }],
      }) + '\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    },
  }).result()
  assert.equal(requests, 1)
  assert.equal(result.stopReason, 'toolUse', result.errorMessage)
  assert.ok(result.content.some(c => c.type === 'toolCall' && c.name === 'read' && c.arguments.path === 'ui.txt'))
})

test('other model transports are preserved', () => {
  for (const model of [
    { provider: 'local', api: 'pickup-local' },
    { provider: 'openrouter', api: 'openai-completions' },
  ]) assert.equal(browserModel(model), model)
})
