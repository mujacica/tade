import type { AccountStatus, PlanLimits, PlanLimitWindow } from '@tade/harnesses-core'

// What pays for an OpenCode agent's turns, and how much of a plan is left.
//
// OpenCode is a router: one account of it can be signed in to ChatGPT, GitHub
// Copilot and OpenCode Go at once, beside an API key or two, and every model
// is reached through one of them. Its record says which provider a step ran
// on and what it cost — and a plan's step costs nothing, exactly as a step it
// could not price does — so whether a plan paid is read off the provider and
// how this account reaches it, never off the figure. What OpenCode says it is
// signed in to is `opencode auth list --format json`: each integration, with
// its connections, each a stored credential (`key`, `oauth`, `external`) or
// an environment variable. Tade reads that list and never a credential.

type Json = Record<string, unknown>

/** One connection of an integration, as `auth list` says it. */
export interface Connection {
  type: 'credential' | 'env'
  /** For a stored credential: how it was given — a key, a sign-in, or a reference. */
  method: 'key' | 'oauth' | 'external' | null
  /** A stored credential's own id: what signing it out names. */
  id: string | null
  /** Its label, or the variable's name. */
  label: string
  /** What OpenCode says is wrong with it, if anything. */
  problem: string | null
}

/** An integration this account is connected to, as `auth list` says it. */
export interface Integration {
  id: string
  name: string
  connections: Connection[]
}

/** What `opencode auth list --format json` printed; an empty list for anything else. */
export function integrationsIn(text: string): Integration[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: Integration[] = []
  for (const raw of parsed) {
    const one = raw as Json | null
    if (typeof one?.id !== 'string') continue
    const connections: Connection[] = []
    for (const rawConnection of Array.isArray(one.connections) ? one.connections : []) {
      const c = rawConnection as Json | null
      if (c?.type !== 'credential' && c?.type !== 'env') continue
      const method = c.method === 'key' || c.method === 'oauth' || c.method === 'external'
      const status = c.status as Json | undefined
      connections.push({
        type: c.type,
        method: method ? (c.method as Connection['method']) : null,
        id: typeof c.id === 'string' ? c.id : null,
        label: String(c.type === 'credential' ? (c.label ?? '') : (c.name ?? '')),
        problem: typeof status?.message === 'string' ? status.message : null,
      })
    }
    out.push({ id: one.id, name: typeof one.name === 'string' ? one.name : one.id, connections })
  }
  return out
}

/**
 * The plans OpenCode reaches, by the provider a step names and what reaching
 * it through a plan takes: a Copilot subscription and OpenCode Go are plans
 * whatever signed them in, and OpenAI is the ChatGPT plan only where it was
 * signed in to (`oauth`) — with a key it is billed per token. Claude Agent
 * runs the person's own `claude` under its own login, and OpenCode shows a
 * subscription's turns there as costing nothing, so a step of it that cost
 * nothing is a plan's. Claude Pro and Max are not here: that sign-in was taken
 * out of OpenCode at Anthropic's request, and Tade does not offer it.
 */
const PLANS: Readonly<Record<string, { name: string; signedIn?: true; free?: true }>> = {
  'github-copilot': { name: 'GitHub Copilot' },
  'opencode-go': { name: 'OpenCode Go' },
  openai: { name: 'ChatGPT', signedIn: true },
  'claude-agent': { name: 'Claude', free: true },
}

/** Whether a plan paid for a step on `provider` that cost `usd`, for an account connected as `integrations` says. */
export function planPays(
  provider: string | null,
  usd: number,
  integrations: readonly Integration[],
): boolean {
  if (!provider) return false
  const plan = PLANS[provider]
  if (!plan) return false
  if (plan.free) return usd <= 0
  if (!plan.signedIn) return true
  const integration = integrations.find((one) => one.id === provider)
  return (
    integration?.connections.some((c) => c.type === 'credential' && c.method === 'oauth') ?? false
  )
}

/**
 * Who this account is signed in as, as OpenCode says: connected to anything
 * at all is signed in, since every model it runs is reached through one of
 * those; the plans among them are named, and so is how it reaches the rest.
 */
export function accountOf(integrations: readonly Integration[]): AccountStatus {
  const connected = integrations.filter((one) => one.connections.length > 0)
  if (connected.length === 0) {
    return {
      signedIn: false,
      who: null,
      plan: null,
      method: null,
      problem: 'not connected to any provider yet',
      until: null,
    }
  }
  const plans = connected
    .filter((one) => {
      const plan = PLANS[one.id]
      if (!plan || plan.free) return false
      return !plan.signedIn || one.connections.some((c) => c.method === 'oauth')
    })
    .map((one) => PLANS[one.id]?.name ?? one.name)
  const who = connected
    .flatMap((one) => one.connections)
    .find((c) => c.type === 'credential' && c.label)?.label
  const troubled = connected.flatMap((one) =>
    one.connections.filter((c) => c.problem).map((c) => `${one.name}: ${c.problem}`),
  )
  return {
    signedIn: true,
    who: who ?? null,
    plan: plans.length > 0 ? plans.join(', ') : null,
    method: connected.map((one) => one.name).join(', '),
    problem: troubled.length > 0 ? troubled.join('; ') : null,
    until: null,
  }
}

/** How long each of OpenCode Go's windows is, in minutes, as its docs say them. */
const GO_WINDOWS: ReadonlyArray<{ key: string; minutes: number }> = [
  // Five hours from the first use of the allowance.
  { key: 'rolling', minutes: 5 * 60 },
  // A week, from Monday 00:00 UTC.
  { key: 'weekly', minutes: 7 * 24 * 60 },
  // A paid period, which is a month: thirty days is how long one is said to be.
  { key: 'monthly', minutes: 30 * 24 * 60 },
]

/**
 * How much of OpenCode Go is used, out of what `GET /api/experimental/usage/
 * limits` answered (`opencode api experimental.usage.limits`): its rolling,
 * weekly and monthly meters, each a percentage and when it starts over. Null
 * where it said nothing of Go — no OpenCode account signed in, or no Go on
 * it — which is the honest answer for every other plan: OpenCode reads no
 * ChatGPT or Copilot limits at all.
 */
export function goLimitsIn(text: string, at: number): PlanLimits | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const data = (parsed as Json | null)?.data as Json | null | undefined
  const go = data?.go as Json | undefined
  if (!go || typeof go !== 'object') return null
  const windows: PlanLimitWindow[] = []
  for (const { key, minutes } of GO_WINDOWS) {
    const meter = go[key] as Json | undefined
    const used = meter?.percent
    if (typeof used !== 'number' || !Number.isFinite(used)) continue
    const resets = meter?.resetsAt
    windows.push({
      minutes,
      used: Math.max(0, Math.min(100, used)),
      resetsAt: typeof resets === 'number' && Number.isFinite(resets) ? resets : 0,
    })
  }
  return windows.length > 0 ? { at, windows } : null
}
