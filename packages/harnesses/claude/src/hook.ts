import { reach, readInput, SOCKET } from './ask.ts'
import { leave } from './missed.ts'
import { answerFor, isPrompt, promptOutput, WORKSPACE_ENV } from './prompt.ts'

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
// the agent carries on while the journal catches up from the transcript. A turn
// that ends meanwhile is left beside the socket for the window that comes back
// (`missed.ts`), since nothing else of ours is running to remember it.
//
// Claude Code's own permission prompt (`PermissionRequest`) is never left up
// for a person outside `policy`: Tade answers it by rule (`prompt.ts`), and
// where Tade cannot be asked — or took it and said nothing — this answers by
// the same rule itself. Under `policy` it is left to the person as it was,
// since nothing may widen what that mode holds.

const GATED = process.env.TADE_APPROVALS === 'policy'
/** How long a held tool call waits for a person: as long as Claude Code lets the hook run. */
const HELD_MS = 24 * 60 * 60_000

const event = await readInput()
// Nothing but a prompt for a person is answered (`isPrompt`), and the window
// is not even asked about Claude Code's earlier look: printing nothing is
// what it always was.
if (event && event.hook_event_name === 'PermissionRequest' && !isPrompt(event)) {
  process.exit(0)
}
if (event && SOCKET) {
  const name = event.hook_event_name
  const held = name === 'PreToolUse' && GATED
  const { reply, reached } = await reach({ kind: 'hook', event }, held ? HELD_MS : 5_000)
  if (!reached) leave(SOCKET, event)
  const output =
    reply && typeof reply === 'object' ? (reply as { output?: unknown }).output : undefined
  if (output && typeof output === 'object') {
    process.stdout.write(JSON.stringify(output))
  } else if (name === 'PermissionRequest' && !GATED) {
    const cwd = typeof event.cwd === 'string' ? event.cwd : null
    const workspace =
      process.env[WORKSPACE_ENV] || process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd()
    const tool = typeof event.tool_name === 'string' ? event.tool_name : ''
    const answer = await answerFor(tool, event.tool_input ?? {}, workspace, cwd)
    // The agent's own log is the one place left to say it: the journal is the window's.
    process.stderr.write(
      `tade: answered a permission prompt by rule with Tade away: ${answer.allow ? 'allowed' : 'refused'} (${answer.rule})\n`,
    )
    process.stdout.write(JSON.stringify(promptOutput(answer)))
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
