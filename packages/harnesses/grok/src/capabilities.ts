import type { ThinkingLevel } from '@tade/core'
import type { HarnessAccount, WorkerCapabilities } from '@tade/harnesses-core'

// What Grok Build can be asked to do, declared once: its own file so the
// adapter is the protocol and the hooks, and this is the promise about them.
// Each was seen in Grok 1.0.92 itself, in a lane, against a scripted model.

/**
 * The thinking levels Grok can be told, least to most, as Tade spells them:
 * its `--reasoning-effort` has every one of Tade's, with `none` for `off`
 * (`effortOf`). A model takes only the levels its own menu lists.
 */
export const EFFORTS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/**
 * What Grok can do, on this account.
 *
 * Everything but the money is the same whoever is signed in. On a SuperGrok or
 * X Premium plan Grok stamps no price on a turn — its docs say a missing cost
 * is unknown, not free — so there is no money to report at all, and what those
 * turns would have cost at xAI's list price is worked out apart from any money
 * (`usdOnPlan`, from `core/src/prices.ts`). Against an API key it prices each
 * turn itself (`costUsdTicks`), which is what the key is billed.
 */
export function grokCapabilities(account: HarnessAccount | undefined): WorkerCapabilities {
  const keyed = account?.kind === 'api-key'
  return {
    permissionGate: true,
    // Typed while a turn runs, Grok queues it as the next prompt and sends it
    // once the turn ends: it never reaches the turn that is running.
    steer: 'idle',
    // The same queue, which is exactly a queue: typed at once, kept by Grok
    // in its own lane, and run when the turn ends.
    queue: 'live',
    // Ctrl+C, which stops the turn and keeps the session.
    abort: 'live',
    model: 'restart',
    thinking: 'restart',
    thinkingLevels: EFFORTS,
    // `/rename`, typed between turns.
    rename: 'idle',
    visibleUi: true,
    resume: true,
    // Not seen to keep them, so they are said again at every launch.
    resumeKeeps: false,
    continues: false,
    images: 'path',
    done: true,
    nativeExtensions: false,
    // Named in its instructions with where to read them: Grok finds skills
    // only in folders of its own and the project's, which Tade does not write.
    skills: true,
    tools: true,
    mcp: true,
    // `grok -p … --output-format streaming-json`, a process per turn on the
    // same session, which is how Tade draws the thing you talk to.
    headless: true,
    spend: {
      usd: keyed ? 'exact' : 'none',
      tokens: true,
      limits: 'none',
    },
    accounts: true,
    compact: 'none',
    pins: false,
    conversation: { replicate: false },
    why: {
      permissionGate:
        'holds a tool call through its PreToolUse hook, and Grok runs every hook fail-open: under approvals that hook is told to fail closed, but one switched off in Grok’s own /hooks, or skipped by an organization’s allow_managed_hooks_only, lets the call run without Tade being asked',
      steer:
        'takes what is typed during a turn as the next prompt, so a steer reaches it once the turn ends',
      model:
        'takes a model only when it starts, so changing it starts the agent again, keeping the conversation',
      thinking:
        'takes how hard to think only when it starts, so changing it starts the agent again, keeping the conversation',
      rename: 'renames a session only between turns, so a new name waits for the turn to end',
      continues:
        'has not been seen to pick a turn the machine cut off back up when told to, so Tade leaves it alone and says so',
      images: 'is shown a picture as a file it is told about, since its terminal cannot take one',
      nativeExtensions:
        'has no place for pi extensions: their tools and skills still reach it, their own code does not',
      skills:
        'is told the skills Tade’s extensions ship and where to read them, since Grok loads skills only from folders that are yours or the project’s',
      mcp: 'is given one tool server beside Tade’s own, through its account folder, since Grok takes no MCP server for a single run',
      spend: keyed
        ? 'prices each turn itself, which is what the key is billed'
        : 'is paid for by a plan, which stamps no price on a turn: what it would have cost at list is worked out apart',
      limits:
        'shows how much of a plan is used only in its own /usage, inside its terminal; grok usage answers only on its shared-daemon route, which Tade’s lanes do not run on',
      compact:
        'compacts only by itself, or when /compact is typed into its own terminal; it takes no compaction from Tade between turns',
      conversation:
        'keeps its conversation as ACP updates Tade cannot merge across machines yet, so each machine has its own',
    },
  }
}
