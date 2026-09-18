// Requests pi sends that a provider in between refuses.
//
// pi loads this file directly into every pi Tade starts — the orchestrator
// and each agent — so, like `tade.ts`, it imports nothing from the workspace.
//
// Anthropic's newest models take their reasoning effort as a message in the
// conversation rather than once per request, and pi's catalog marks them that
// way wherever they are offered. Only Anthropic's own API accepts it: through
// OpenRouter the very first request fails with "Mid-conversation reasoning
// effort (configuration_update) is not supported", and the model never says a
// word. Anywhere but Anthropic, the request is rewritten to the form every
// endpoint takes: one effort for the whole request, and no beta asking for
// the other.

const PER_MESSAGE_BETAS = new Set([
  'mid-conversation-output-config-2026-07-01',
  'thinking-binding-controls-2026-08-01',
])

interface Payload {
  messages?: unknown[]
  thinking?: Record<string, unknown>
  output_config?: Record<string, unknown>
  betas?: string[]
  [key: string]: unknown
}

function isEffortMessage(message: unknown): message is { output_config: { effort?: unknown } } {
  if (typeof message !== 'object' || message === null) return false
  const one = message as { role?: unknown; output_config?: unknown }
  return (
    one.role === 'system' && typeof one.output_config === 'object' && one.output_config !== null
  )
}

/**
 * The request with its reasoning effort said once, as the request's own, and
 * nothing that needs a beta a proxy will not route. Unchanged when it had
 * none of that.
 */
export function effortOnce(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload
  const request = payload as Payload
  const messages = Array.isArray(request.messages) ? request.messages : []
  const markers = messages.filter(isEffortMessage)
  const betas = Array.isArray(request.betas) ? request.betas : []
  const binding =
    typeof request.thinking === 'object' &&
    request.thinking !== null &&
    'block_binding' in request.thinking
  if (markers.length === 0 && !betas.some((beta) => PER_MESSAGE_BETAS.has(beta)) && !binding) {
    return payload
  }
  const out: Payload = { ...request, messages: messages.filter((one) => !isEffortMessage(one)) }
  const effort = markers.at(-1)?.output_config.effort
  if (typeof effort === 'string') out.output_config = { ...(request.output_config ?? {}), effort }
  if (binding && request.thinking) {
    const { block_binding: _, ...thinking } = request.thinking
    out.thinking = thinking
  }
  const kept = betas.filter((beta) => !PER_MESSAGE_BETAS.has(beta))
  if (kept.length > 0) out.betas = kept
  else delete out.betas
  return out
}

/** Whether a model is reached through Anthropic's own API, which takes effort either way. */
export function throughAnthropic(model: unknown): boolean {
  if (typeof model !== 'object' || model === null) return false
  const url = (model as { baseUrl?: unknown }).baseUrl
  if (typeof url !== 'string' || url === '') return true
  try {
    const host = new URL(url).hostname
    return host === 'anthropic.com' || host.endsWith('.anthropic.com')
  } catch {
    return false
  }
}

interface PiApi {
  on(event: string, handler: (event: unknown, ctx: { model?: unknown }) => unknown): void
}

export default function compat(pi: PiApi): void {
  pi.on('before_provider_request', (event, ctx) => {
    if (throughAnthropic(ctx.model)) return undefined
    const payload = (event as { payload?: unknown }).payload
    const rewritten = effortOnce(payload)
    return rewritten === payload ? undefined : rewritten
  })
}
