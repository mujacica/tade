import type { UpdateLook } from '@tade/workbench/programs'
import { type AppState, FOCUS_GUARD_MS } from './model.ts'

// Moving what Tade runs forward: which of it can move, the line typed to move
// one, and reading how that line ended out of what the terminal printed.
//
// Pure: a look in, steps out; what a terminal printed in, an ending out. What
// it costs to run one is `wire/machine.ts`'s, which types the line into a
// terminal somebody is looking at — the only way anything here installs
// anything.

/** One thing that can move forward, and the exact command that moves it. */
export interface Step {
  /** `tade` for Tade itself, or the program's command: what the orchestrator names it by. */
  about: string
  /** As a person reads it: `Tade`, `GitHub CLI`. */
  title: string
  /** Exactly what Settings › Updates draws before anything runs it. */
  command: string
  /** What is here now, and what is newer, as far as the last look could say. */
  from: string | null
  to: string | null
}

/**
 * Everything the last look says is behind and has a command that would move
 * it: what the strip's chip counts and what pressing it runs. Tade first,
 * because it is the one a reload follows.
 *
 * Behind with no command is not a step — Tade cannot type what it does not
 * know — and stays a row on the Updates page, which says why.
 */
export function behindIn(look: UpdateLook | null): Step[] {
  if (!look?.asked) return []
  const steps: Step[] = []
  const tade = look.tade
  if (tade.newer && 'command' in tade.update) {
    steps.push({
      about: 'tade',
      title: 'Tade',
      command: tade.update.command,
      from: tade.commit ?? tade.version,
      to: tade.newer,
    })
  }
  for (const program of look.programs) {
    if (!program.behind || !('command' in program.update)) continue
    steps.push(stepOf(program, program.update.command))
  }
  return steps
}

/**
 * The steps somebody named, whether or not the last look said they were
 * behind — the Settings page offers every command it knows, and so does this.
 * Named by the program's command, its title, or `tade`, any case; nothing
 * named is everything behind.
 */
export function stepsNamed(look: UpdateLook | null, names: readonly string[]): Step[] {
  const wanted = names.map((name) => name.trim().toLowerCase()).filter(Boolean)
  if (wanted.length === 0) return behindIn(look)
  if (!look) return []
  const named = (...words: string[]) => words.some((word) => wanted.includes(word.toLowerCase()))
  const steps: Step[] = []
  const tade = look.tade
  if (named('tade') && 'command' in tade.update) {
    steps.push({
      about: 'tade',
      title: 'Tade',
      command: tade.update.command,
      from: tade.commit ?? tade.version,
      to: tade.newer,
    })
  }
  for (const program of look.programs) {
    if (!named(program.need.command, program.need.title)) continue
    if ('command' in program.update) steps.push(stepOf(program, program.update.command))
  }
  return steps
}

function stepOf(program: UpdateLook['programs'][number], command: string): Step {
  return {
    about: program.need.command,
    title: program.need.title,
    command,
    from: program.version ?? program.install?.version ?? null,
    to: program.latest,
  }
}

/** The tag a step's ending is printed under: its own, so no other run's ending is read as this one's. */
const tagOf = (nonce: string) => `tade-update-${nonce}`

/**
 * The line typed into the terminal: the command exactly as the page drew it,
 * then how it ended, printed so that it can be read back.
 *
 * The ending is assembled by `printf` from two words, so the line the shell
 * echoes — `tade-update-ab12 ok` — is never the line it prints,
 * `tade-update-ab12-ok`: the word that comes out is never a word that went in,
 * which is `proveALane`'s rule for the same reason. `&&` and `||` because they
 * read the same in sh, bash, zsh and fish, where `$?` does not.
 */
export function typedFor(command: string, nonce: string): string {
  const tag = tagOf(nonce)
  return `${command} && printf '%s-%s\\n' ${tag} ok || printf '%s-%s\\n' ${tag} failed`
}

/** How a step ended, read off what the terminal printed, or null while it has not. */
export function endedIn(printed: string, nonce: string): 'ok' | 'failed' | null {
  const tag = tagOf(nonce)
  if (printed.includes(`${tag}-ok`)) return 'ok'
  if (printed.includes(`${tag}-failed`)) return 'failed'
  return null
}

/**
 * The last lines a failed step printed, for the conversation: what came out
 * before its ending, at most `most` of them — the end of an error is where the
 * reason is. The line typed is left out wherever the terminal wrapped it, by
 * what only it has in it: the tag, and the `printf` that prints it.
 */
export function failureLines(screen: string, nonce: string, most = 4): string[] {
  const tag = tagOf(nonce)
  const lines = screen.split('\n').map((line) => line.trim())
  const typed = (line: string) => line.includes(tag) || line.includes("printf '%s-%s")
  const found = lines.findIndex((line) => line.includes(`${tag}-failed`))
  const end = found >= 0 ? found : lines.length
  // After the last of the line typed, so what an earlier command left in the
  // scrollback above it is never read as this one's reason.
  const from = lines.slice(0, end).findLastIndex(typed) + 1
  return lines
    .slice(from, end)
    .filter((line) => line !== '' && !typed(line))
    .slice(-most)
}

/** How one step came out. */
export interface Outcome {
  step: Step
  /** `closed`: the terminal went before it said; `waited`: it outlasted the deadline. */
  ended: 'ok' | 'failed' | 'closed' | 'waited'
  /** For one that failed: the last lines it printed. */
  lines: readonly string[]
}

/**
 * A run, said in the conversation in words somebody can act on: what moved,
 * and for what did not, the command, the last of what it printed and where the
 * rest of it is. Tade's own line, so it is said once and plainly.
 */
export function outcomeSays(outcomes: readonly Outcome[], where: string): string {
  const moved = outcomes.filter((one) => one.ended === 'ok')
  const parts: string[] = []
  if (moved.length > 0) {
    parts.push(`Updated ${moved.map((one) => movedSays(one.step)).join(', ')}.`)
  }
  for (const one of outcomes) {
    if (one.ended === 'ok') continue
    const how =
      one.ended === 'closed'
        ? 'stopped: the terminal it ran in was closed before it finished'
        : one.ended === 'waited'
          ? `was still running when Tade stopped waiting — ${where} has it`
          : `failed${one.lines.length > 0 ? `: ${one.lines.join(' · ')}` : ''}`
    parts.push(`${one.step.title} (\`${one.step.command}\`) ${how}.`)
  }
  const failed = outcomes.some((one) => one.ended === 'failed')
  if (failed) parts.push(`The whole of what it printed is in ${where}.`)
  return parts.join(' ')
}

/** A step that moved, with where it moved to where the look could say. */
function movedSays(step: Step): string {
  return step.about !== 'tade' && step.to ? `${step.title} to ${step.to}` : step.title
}

/**
 * Whether the reload may be offered on a panel of its own now: nothing steals
 * the screen while somebody is typing (`shouldRaise`'s rule for the same
 * reason), and nothing is put over a panel somebody has open. Where it may
 * not, the chip still says `reload Tade` until it is taken.
 */
export function mayOffer(state: Pick<AppState, 'panel' | 'lastInputAt'>, now: number): boolean {
  if (state.panel !== null) return false
  return state.lastInputAt === null || now - state.lastInputAt >= FOCUS_GUARD_MS
}
