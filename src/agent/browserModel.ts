import type { Model } from '@earendil-works/pi-ai'

/** OpenRouter's native Anthropic route rejects the Anthropic SDK's browser headers. */
export function browserModel(model: Model<any>): Model<any> {
  if (model.provider !== 'openrouter' || model.api !== 'anthropic-messages') return model
  // Let pi infer OpenRouter's chat-completions compatibility settings for this API.
  return { ...model, api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', compat: undefined }
}
