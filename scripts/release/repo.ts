import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// What the release scripts all need to know: where this checkout is, what it
// is called on npm, and what each package in it declares.
//
// Nothing here imports `@tade/*`. The root of the workspace has no links to
// its own packages, and a release script that cannot run until `pnpm install`
// has succeeded is a release script that cannot tell you why it failed.

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * The name on npm.
 *
 * Not `tade`, which belongs to somebody else. It is in exactly two places —
 * here, and `tadeRoot` in `packages/workbench/src/programs.ts`, which
 * recognises Tade's own tree by the CLI under it rather than by this name for
 * that reason.
 */
export const PUBLISHED = 'tade-sh'

/** The command the published package installs. Never `tade-sh`. */
export const COMMAND = 'tade'

export interface RootManifest {
  name: string
  version: string
  description: string
  license: string
  engines: Record<string, string>
  repository: { type: string; url: string }
  homepage: string
  bugs: { url: string }
  pnpm: { onlyBuiltDependencies: string[] }
  devDependencies: Record<string, string>
}

/** One workspace package, as it describes itself. */
export interface Manifest {
  /** `packages/mcp/core`, repo-relative and posix. */
  dir: string
  /** `@tade/mcp-core`. */
  name: string
  /** `mcp-core` — what it is called inside the published package. */
  short: string
  exports: Record<string, string>
  dependencies: Record<string, string>
}

export function git(args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync('git', args, {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd()
}

export function rootManifest(): RootManifest {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as RootManifest
}

/** `https://github.com/owner/repo`, out of the manifest so nothing depends on a remote's name. */
export function repoUrl(root: RootManifest = rootManifest()): string {
  return root.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
}

/**
 * Every package in the workspace, in a fixed order, read off disk.
 *
 * `pnpm-workspace.yaml` takes a package one deep and two deep, and so does
 * this: a package added tomorrow is in the tarball tomorrow, with no list
 * anywhere to update. `test/` is workspace-linked too and is left out — it is
 * the fixtures the suite builds repositories with, and it ships to nobody.
 */
export function manifests(): Manifest[] {
  const out: Manifest[] = []
  const packages = join(ROOT, 'packages')
  for (const entry of readdirSync(packages, { withFileTypes: true }).sort(byName)) {
    if (!entry.isDirectory()) continue
    const dir = join(packages, entry.name)
    const found = read(`packages/${entry.name}`, dir)
    if (found) {
      out.push(found)
      continue
    }
    for (const nested of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      if (!nested.isDirectory()) continue
      const deeper = read(`packages/${entry.name}/${nested.name}`, join(dir, nested.name))
      if (deeper) out.push(deeper)
    }
  }
  return out
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : 1)

function read(dir: string, at: string): Manifest | null {
  let text: string
  try {
    text = readFileSync(join(at, 'package.json'), 'utf8')
  } catch {
    return null
  }
  const parsed = JSON.parse(text) as {
    name: string
    exports?: Record<string, string>
    dependencies?: Record<string, string>
  }
  if (!parsed.name.startsWith('@tade/')) return null
  return {
    dir,
    name: parsed.name,
    short: parsed.name.slice('@tade/'.length),
    exports: parsed.exports ?? {},
    dependencies: parsed.dependencies ?? {},
  }
}

/** Where a green run of the live test left its evidence. */
export const LIVE = join(ROOT, '.tade', 'live.json')

/** The one command that asks a real model to choose from our descriptions. */
export const LIVE_RUN = 'TADE_LIVE=1 pnpm vitest run packages/orchestrator/test/live.test.ts'

/**
 * What is wrong with the live test's evidence for this tree, or `null`.
 *
 * `pnpm check` says nothing about whether a model can pick the right tool from
 * the descriptions we wrote: every other test in the repository tells a fake
 * model which tool to call, so all sixty descriptions could say the same thing
 * and the suite would still be green. The live test is the only one that asks,
 * it costs money, and it is skipped unless somebody asks for it — which is how
 * it came never to have been run at all, over three rewrites of those
 * descriptions.
 *
 * So it is held to what every other run is held to: a run is about a named
 * commit, a run against another commit is not a run against this one, and a
 * check nobody ran is not a check that passed. Pure, and given both the
 * receipt and the commit, because a refusal nobody can test is a refusal
 * nobody finds out is broken.
 */
export function liveTrouble(receipt: string, head: string): string | null {
  let ran: { commit?: unknown }
  try {
    ran = JSON.parse(readFileSync(receipt, 'utf8')) as { commit?: unknown }
  } catch {
    return (
      'the live test has not been run here. It is the only evidence that a model can pick the\n' +
      '  right tool from the descriptions we wrote, and nothing in `pnpm check` asks:\n' +
      `    ${LIVE_RUN}`
    )
  }
  if (ran.commit === head) return null
  return (
    `the live test last passed against ${String(ran.commit).slice(0, 8)}, and HEAD is ${head.slice(0, 8)}.\n` +
    '  The descriptions may have moved under it since:\n' +
    `    ${LIVE_RUN}`
  )
}
