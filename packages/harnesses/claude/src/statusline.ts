import { spawnSync } from 'node:child_process'
import { ask, readInput } from './ask.ts'

// Claude Code's status line, which it runs after every reply with everything
// it knows about the session on standard input: the model, what the session
// has cost, how full the context is, how much of a plan's limits are used.
// Nothing else says those, so this hands them to Tade and then draws the line.
//
// A person's own status line keeps working: when they had one, it is run with
// the same input and what it prints is what is shown.

const input = await readInput()
if (input) await ask({ kind: 'status', status: input }, 1_000)

const theirs = process.env.TADE_CLAUDE_STATUSLINE
if (theirs && input) {
  const drawn = spawnSync('/bin/sh', ['-c', theirs], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5_000,
  })
  process.stdout.write(drawn.stdout ?? '')
} else if (input) {
  const model = (input.model as { display_name?: unknown } | undefined)?.display_name
  const used = (input.context_window as { used_percentage?: unknown } | undefined)?.used_percentage
  const parts = [
    typeof model === 'string' ? model : null,
    typeof used === 'number' ? `${Math.round(used)}% of context` : null,
  ].filter(Boolean)
  process.stdout.write(`tade${parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}`)
}
process.exit(0)
