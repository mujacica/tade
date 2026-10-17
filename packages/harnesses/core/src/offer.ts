// How a harness does what a person can ask of a running agent, and how that is
// offered to them: one rule for the window, the orchestrator's tools and voice.
//
// Its own file because it is its own subject — what a surface may offer — and
// the port is the agent's side of the conversation. Re-exported from
// `port.ts`, so nothing that imports it from there changes.

import type { WorkerCapabilities } from './port.ts'

/**
 * How a harness does something a person can ask of a running agent.
 *
 * - `live`: now, even in the middle of a turn.
 * - `idle`: only between turns, so Tade holds it until the turn ends.
 * - `restart`: by starting the agent again on the same conversation, which is
 *   kept; mid-turn, that waits for the turn to end too.
 * - `none`: not at all. Whatever would offer it is hidden, and whatever is
 *   asked for it anyway answers with the harness's `why`.
 */
export const SUPPORT = ['live', 'idle', 'restart', 'none'] as const
export type Support = (typeof SUPPORT)[number]

/**
 * How something a harness supports is offered to a person: shown or not, and
 * what to say beside it. One rule for the window, the orchestrator's tools
 * and voice, so no surface offers what another one hides.
 */
export interface Offer {
  shown: boolean
  /** How, for a surface with room for a word rather than a sentence. */
  support: Support
  /** Said beside it, or as the refusal when it is not shown. Null when there is nothing to add. */
  note: string | null
}

export function offer(
  capabilities: Pick<WorkerCapabilities, 'why'>,
  feature: HarnessFeature,
  support: Support,
): Offer {
  const why = capabilities.why[feature] ?? null
  switch (support) {
    case 'live':
      return { support: 'live', shown: true, note: null }
    case 'idle':
      return { support: 'idle', shown: true, note: why ?? 'waits for its turn to end' }
    case 'restart':
      return {
        support: 'restart',
        shown: true,
        note: why ?? 'starts it again, keeping the conversation',
      }
    case 'none':
      return { support: 'none', shown: false, note: why ?? 'this harness cannot do that' }
  }
}

/**
 * Whether an agent whose process has gone — a chat closed by accident, an
 * agent somebody stopped — can be brought back to its conversation: by
 * starting it again on the one its harness kept, or not at all, and then in
 * the harness's own words why. `resume` is a yes or a no, so this is the one
 * reading of it every surface goes through.
 */
export function resumeOffer(capabilities: Pick<WorkerCapabilities, 'resume' | 'why'>): Offer {
  return offer(capabilities, 'resume', capabilities.resume ? 'restart' : 'none')
}

/** How a picture reaches the agent: with the instruction, as a file it is told about, or not at all. */
export type ImageSupport = 'inline' | 'path' | 'none'

/** The things a harness may do only partly, each of which can carry a `why`. */
export type HarnessFeature =
  | 'permissionGate'
  | 'steer'
  | 'queue'
  | 'abort'
  | 'model'
  /** Saying which models it runs at all, which is what a picker offers. */
  | 'models'
  | 'thinking'
  | 'rename'
  | 'images'
  | 'done'
  | 'resume'
  | 'continues'
  | 'nativeExtensions'
  | 'skills'
  | 'tools'
  | 'mcp'
  | 'headless'
  | 'spend'
  | 'limits'
  | 'accounts'
  /** Summarising the conversation so far to free its context, keeping its session. */
  | 'compact'
  /** Coming back to a conversation declared what it was first told, not what it is told now. */
  | 'pins'
