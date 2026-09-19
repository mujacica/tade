import { makeGithubForge } from '@tade/forge-github'
import { makeScriptedForge } from '@tade/forge-scripted'
import type { ExecResult, Forge, ForgeOptions } from '@tade/forges-core'
import { hostOf } from '@tade/forges-core'
import { execa } from 'execa'

// The forges there are, by name: the one registry every call site goes
// through, so adding GitLab is an implementation and a line here — never a
// `new` somewhere that assumed there was only ever GitHub.
//
// It lives here rather than beside the port because the port must not import
// its own implementations, and `packages/status` is the lowest thing that
// needs one: a task's `merged` state is decided by what the forge says, and
// status answers with the window closed. Everything above — the review
// extension, the window, the CLI — reaches a forge through this.
//
// `scripted` is registered and never chosen for anybody: a forge that answers
// from a table is what tests and demos use, so whoever wants it names it.

export const FORGES: Readonly<Record<string, (opts: ForgeOptions) => Forge>> = {
  github: makeGithubForge,
  scripted: makeScriptedForge,
}

export interface ForgeChoice extends ForgeOptions {
  /** Which forge serves a host, for an enterprise install: `git.acme.com=github`. */
  hostForges?: Readonly<Record<string, string>>
}

/**
 * The forge for a remote: the one the config names for its host, else the
 * first registered one that says it serves it. Null when nothing does — a
 * remote with no forge is not an error, it is a repository Tade only reads
 * git from.
 */
export function forgeFor(remote: string, options: ForgeChoice): Forge | null {
  const host = hostOf(remote)
  if (!host) return null
  const named = options.hostForges?.[host]
  if (named) {
    const make = FORGES[named]
    // A host pointed at a forge nobody registered is a config mistake, and a
    // silent fall back to GitHub would be the wrong kind of helpful.
    return make ? make({ ...options, hosts: [host, ...(options.hosts ?? [])] }) : null
  }
  for (const make of Object.values(FORGES)) {
    const forge = make(options)
    if (forge.serves(remote)) return forge
  }
  return null
}

/**
 * Running a program the way the rest of status does: detached, so the
 * terminal Tade runs in is never retitled after `gh`, and never throwing.
 */
export async function forgeExec(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const r = await execa(command, [...args], {
    reject: false,
    detached: true,
    timeout: options.timeoutMs ?? 10_000,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  })
  return {
    code: typeof r.exitCode === 'number' ? r.exitCode : 1,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
  }
}
