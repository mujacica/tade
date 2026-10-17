import type { ThinkingLevel } from '@tade/core'
import type { HarnessAccount, WorkerCapabilities } from '@tade/harnesses-core'

// What Claude Code can be asked to do, declared once: its own file so the
// adapter is the protocol and the hooks, and this is the promise about them.

/** The thinking levels Claude Code can be told, as its `--effort`. */
export const EFFORTS: readonly ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * What Claude Code can do, on this sign-in.
 *
 * `pins` is whether the Claude Code here takes `--system-prompt-snapshot`
 * (`optionsOf`): without it, a conversation it comes back to is declared the
 * system prompt it was first sent. Until it has been asked, the launch line
 * does not pass it either, so `true` is the honest answer then.
 *
 * Everything here is the same whoever is signed in but the money, and the
 * money is the whole of the difference: a subscription charges a flat fee, so
 * there is no price per turn to report and Claude Code's own running estimate
 * is a guess at what an API would have charged rather than a bill anybody
 * gets. Totalled as money it is a large number that means nothing. Against an
 * API key that same estimate is what the account will be charged.
 */
export function claudeCapabilities(
  account: HarnessAccount | undefined,
  pins: boolean,
): WorkerCapabilities {
  return {
    permissionGate: true,
    // Typed while a turn runs, Claude Code takes it at its next tool call and
    // answers it in the same turn: a real steer.
    steer: 'live',
    // Held until the turn's Stop hook, then typed.
    queue: 'live',
    abort: 'live',
    model: 'restart',
    thinking: 'restart',
    thinkingLevels: EFFORTS,
    rename: 'idle',
    visibleUi: true,
    resume: true,
    // A resumed session starts on whatever the account's default is, so the
    // model it was on has to be said again.
    resumeKeeps: false,
    // `API Error: Your computer went to sleep mid-response.` and back to the
    // prompt, with the session intact: it needs telling, not restarting.
    continues: true,
    images: 'path',
    done: true,
    nativeExtensions: false,
    skills: true,
    tools: true,
    mcp: true,
    // `-p --input-format stream-json`: a conversation over its own protocol,
    // which is how Tade draws the thing you talk to.
    headless: true,
    // A plan has no price per turn, so on a subscription there is no money
    // to report at all and the plan's windows are what is used up. Against an
    // API key the same estimate is a bill somebody gets, and is worth saying.
    spend: {
      usd: account?.kind === 'api-key' ? 'estimate' : 'none',
      tokens: true,
      limits: 'while-working',
    },
    accounts: true,
    // `/compact`, sent over the protocol between turns: the session and its
    // id stay, and it says what is left (`compact_boundary`).
    compact: 'idle',
    pins,
    // `sandbox.enabled` in the run's own settings: bubblewrap on Linux,
    // Seatbelt on a Mac, around its shell commands (`sandboxOf`).
    sandbox: true,
    why: {
      model:
        'takes a model only when it starts, so changing it starts the agent again, keeping the conversation',
      thinking:
        'takes how hard to think only when it starts, so changing it starts the agent again, keeping the conversation',
      rename: 'renames a session only between turns, so a new name waits for the turn to end',
      images: 'is shown a picture as a file it is told about, since its terminal cannot take one',
      nativeExtensions:
        'has no place for pi extensions: their tools and skills still reach it, their own code does not',
      spend:
        account?.kind === 'api-key'
          ? 'prices a session only as its own estimate, never against a catalog'
          : "is paid for by a plan, which has no price per turn: what is used up is the plan's windows",
      limits: 'reports it as one of its agents replies, so there is nothing to show until one has',
      compact:
        'compacts only between turns, and an agent in a lane only when /compact is typed into it',
      pins: 'records the system prompt at its first request and sends that record on every resume until it is compacted, where this version has no --system-prompt-snapshot',
    },
  }
}
