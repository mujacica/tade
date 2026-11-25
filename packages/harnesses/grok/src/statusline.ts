import { spawnSync } from 'node:child_process'
import { ask, readInput } from './ask.ts'

// Grok's status line, which it runs whenever the session's state changes and
// continuously while a turn runs, with what it knows about the session on
// standard input: the model, how full the context is and how large it is, what
// the session has used. Nothing else says how full the context is, so this
// hands it to Tade and then draws the line.
//
// A status line somebody chose in this account's own config keeps working: it
// is run with the same input and what it prints is what is shown
// (`TADE_GROK_STATUSLINE`, written by the adapter when it finds one).

const input = await readInput()
if (input && process.env.TADE_RUN_SOCKET) await ask({ kind: 'status', status: input }, 1_000)

const theirs = process.env.TADE_GROK_STATUSLINE
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
