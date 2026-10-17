import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { expandHome, runProgram } from '@tade/core'
import { repositoryAt } from '@tade/status'
import { inTime, type Open, type OpenAnswer, type WebOpening } from '@tade/web'
import { tilde, type Wiring, why } from './context.ts'
import type { Lifecycle } from './web-lifecycle.ts'

// This machine's half of a project another machine of the person's is moving
// here (`@tade/web`'s `opened.ts`, REMOTE-TADE.md §9.2): the repository found
// among this machine's projects, or checked out beside them — cloned with
// **this machine's own credentials**, never the other's — and opened through
// the window's own door (`Projects.openAt`), which writes the config and the
// `config_changed` line as `device <id>`, exactly as an opening from away does.
//
// **Nothing is written over.** A repository already open here under any name
// is answered with that name; a folder already where it would go is opened
// only where it is a checkout of that same repository; and a clone happens
// only where nothing at all is at the path. A clone that does not finish in
// time is killed, which takes its folder with it, and the answer says to clone
// it by hand — after which the same press opens it as it is.
//
// **Every git here has a deadline and never asks**, inside the one call the
// other machine makes (`CALL_MS`): `GIT_TERMINAL_PROMPT=0`, no terminal for
// ssh to ask on, and only the transports a URL was allowed to name
// (`GIT_ALLOW_PROTOCOL`).

/** How long a clone may take: inside the minute the other machine's call is given. */
const CLONE_MS = 45_000

/** How long asking a checkout what it is may take. */
const LOOK_MS = 5_000

function no(said: string): OpenAnswer {
  return { opened: false, said }
}

/** git's last word on why, on one line. */
function gitSaid(ran: { stderr: string; stdout: string; timedOut: boolean }): string {
  if (ran.timedOut) return `it did not finish within ${CLONE_MS / 1000}s`
  const lines = `${ran.stderr}\n${ran.stdout}`.split('\n').map((line) => line.trim())
  return lines.filter((line) => line !== '').at(-1) ?? 'git said nothing'
}

/** What is at a path: nothing, a folder, or something that is not one. */
async function whatIsThere(path: string): Promise<'nothing' | 'folder' | 'other'> {
  try {
    return (await stat(path)).isDirectory() ? 'folder' : 'other'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'nothing'
    throw err
  }
}

/** Beside the projects this machine already has, or in its home where it has none. */
function placeFor(roots: readonly string[]): string {
  const first = [...roots].sort()[0]
  return first === undefined ? homedir() : dirname(first)
}

/** The window's `WebOpening`, where the window handed the away view its lifecycle doors. */
export function openingFrom(
  wire: Wiring,
  lifecycle: Lifecycle | undefined,
): WebOpening | undefined {
  if (lifecycle === undefined) return undefined
  return async (open: Open, device: string): Promise<OpenAnswer> => {
    const projects = Object.entries(wire.opts.config.projects).map(([name, one]) => ({
      name,
      root: expandHome(one.root),
    }))
    for (const one of projects) {
      if ((await inTime(repositoryAt(one.root), LOOK_MS, null)) === open.repository) {
        return {
          opened: true,
          project: one.name,
          root: one.root,
          said: `${open.repository} is already open here, as ${one.name}.`,
        }
      }
    }
    if (projects.some((one) => one.name === open.name)) {
      return no(
        `There is already a project called ${open.name} here, and it is another repository.`,
      )
    }
    const path = join(placeFor(projects.map((one) => one.root)), open.name)
    const there = await whatIsThere(path)
    if (there === 'other') return no(`${tilde(path)} is already here, and it is not a folder.`)
    if (there === 'folder') {
      const named = await inTime(repositoryAt(path), LOOK_MS, null)
      if (named !== open.repository) {
        return no(
          `${tilde(path)} is already here and is not a checkout of ${open.repository}: move it, or open the project somewhere else by hand.`,
        )
      }
    } else {
      const cloned = await runProgram('git', ['clone', '--quiet', '--', open.clone, path], {
        timeoutMs: CLONE_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh' },
      })
      if (cloned.code !== 0) {
        return no(
          `This machine could not clone ${open.repository} with its own credentials: ${gitSaid(cloned)}. It clones and pushes with a key of its own, never the other machine's — give it one, or clone it to ${tilde(path)} by hand and ask again: a checkout of it there is opened as it is.`,
        )
      }
    }
    try {
      const said = await lifecycle
        .projects()
        .openAt({ path, name: open.name, create: false, by: `device ${device}` })
      const how =
        there === 'nothing'
          ? ` It was cloned from ${open.clone} with this machine's own credentials.`
          : ''
      return { opened: true, project: open.name, root: path, said: `${said}${how}` }
    } catch (err) {
      return no(
        `${open.repository} is at ${tilde(path)} here, and could not be opened: ${why(err)}.`,
      )
    }
  }
}
