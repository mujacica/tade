import { ask, readInput, SOCKET } from './ask.ts'

// Every hook Tade gives a Claude Code agent: it tells Tade what happened and,
// for a tool call Tade holds, waits for the answer and says it back.
//
// Run by Claude Code as a process of its own for each hook, with the hook's
// JSON on standard input. Printing nothing and exiting 0 is "carry on", which
// is what every hook does unless Tade said otherwise.
//
// What to do when Tade cannot be asked was decided at launch
// (`TADE_APPROVALS`), never at the moment it went away: under `policy` a tool
// call nobody can approve is refused, because an agent running unsupervised is
// worse than one that stalls; otherwise nothing was ever going to be held, and
// the agent carries on while the journal catches up from the transcript.

const GATED = process.env.TADE_APPROVALS === 'policy'
/** How long a held tool call waits for a person: as long as Claude Code lets the hook run. */
const HELD_MS = 24 * 60 * 60_000

const event = await readInput()
if (event && SOCKET) {
  const name = event.hook_event_name
  const held = name === 'PreToolUse' && GATED
  const reply = await ask({ kind: 'hook', event }, held ? HELD_MS : 5_000)
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
