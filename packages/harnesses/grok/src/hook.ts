import { reach, readInput, SOCKET } from './ask.ts'
import { leave } from './missed.ts'

// Every hook Tade gives a Grok agent: it tells Tade what happened and, for a
// tool call Tade holds, waits for the answer and says it back.
//
// Grok runs this as a process of its own for each hook, with the hook's JSON
// on standard input — the same fields Claude Code's hooks carry
// (`hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`), beside its own
// camel-cased ones. Printing nothing and exiting 0 is "carry on". An `allow`
// from a PreToolUse hook only means "not blocked" to Grok: it never approves a
// call Grok would have asked about, which under `bypassPermissions` is none.
//
// What to do when Tade cannot be asked was decided at launch
// (`TADE_APPROVALS`), never at the moment it went away: under `policy` a tool
// call nobody can approve is refused, because an agent running unsupervised is
// worse than one that stalls; otherwise nothing was ever going to be held, and
// the agent carries on while the journal catches up from its record. A turn
// that ends meanwhile is left beside the socket for the window that comes back
// (`missed.ts`), since nothing else of ours is running to remember it.
//
// Without `TADE_RUN_SOCKET` this is nothing at all: the account's folder holds
// these hooks for every run, and a `grok` started in it by hand, or the
// orchestrator's own headless turns, must behave as if Tade were not there.

const GATED = process.env.TADE_APPROVALS === 'policy'
/** How long a held tool call waits for a person: as long as the hook's timeout lets it run. */
const HELD_MS = 24 * 60 * 60_000

const event = await readInput()
if (event && SOCKET) {
  const name = event.hook_event_name
  const held = name === 'PreToolUse' && GATED
  const { reply, reached } = await reach({ kind: 'hook', event }, held ? HELD_MS : 5_000)
  if (!reached) leave(SOCKET, event)
  const output =
    reply && typeof reply === 'object' ? (reply as { output?: unknown }).output : undefined
  if (output && typeof output === 'object') {
    process.stdout.write(JSON.stringify(output))
  } else if (held) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Tade is not reachable, and approvals are on',
        },
      }),
    )
  }
}
process.exit(0)
