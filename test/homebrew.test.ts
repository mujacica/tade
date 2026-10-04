import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  className,
  descFor,
  FORMULA,
  formulaFor,
  SCRATCH,
  scratchTapAt,
  tarballUrl,
} from '../scripts/release/homebrew.ts'
import { COMMAND, PUBLISHED, rootManifest } from '../scripts/release/repo.ts'

// What has to be true of the second way in.
//
// Homebrew installs the npm package — the formula's `url` is the tarball
// `npm i -g tade-sh` downloads — so almost nothing about it can be wrong in a
// way this repository is responsible for. What is left is quiet, every bit of
// it, which is why there is a test rather than a careful read:
//
// - **Homebrew's audit refuses a `desc` with an article on the front**, the
//   formula's own name inside it, or over 80 characters. A submission that
//   fails the audit fails in somebody else's review queue, days later.
// - **The class name has to match the filename.** Ruby does not care; Homebrew
//   does, at load, on the machine of whoever typed `brew install`.
// - **`ignore_scripts: false` is the one decision in the file**, and the only
//   one that reads as tidying up. Take it out and the install is green and
//   produces a `tade` whose every lane dies with `posix_spawnp failed.`,
//   because node-pty's `spawn-helper` never got its executable bit back.
// - **`rewrite_shebang` names a file by path.** Rename the CLI's entry point
//   and it rewrites nothing, with no error anywhere: `tade` then runs under
//   whatever node is first on a user's PATH, which is a `nodeTooOld` or a
//   `nativeTrouble` for a module compiled against another major.
// - **The workflow waits for a workflow by name.** Rename `release` and the
//   `workflow_run` trigger matches nothing for ever, silently — the one
//   failure here that no release would ever report.
//
// None of it needs the network or Homebrew installed. That the formula builds
// is proved by building it, which is a job on macOS in the workflow and
// `pnpm homebrew --try` on a machine — not something a test does in a second.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The formula as it is checked in. */
const checkedIn = readFileSync(join(ROOT, FORMULA), 'utf8')

/** `url "…"`, `sha256 "…"` — the two lines that change per version. */
function field(name: string): string {
  return new RegExp(`^\\s*${name} "([^"]+)"`, 'm').exec(checkedIn)?.[1] ?? ''
}

/** The version out of the URL the formula names, which is the only place it says one. */
function versionInUrl(): string {
  return field('url')
    .split(`${PUBLISHED}-`)
    .at(-1)
    ?.replace(/\.tgz$/, '') as string
}

describe('the description Homebrew will audit', () => {
  const desc = descFor()

  it('has no article on the front and no full stop on the end', () => {
    // `brew audit`: "Description shouldn't start with an indefinite article"
    // and "Description shouldn't end with a full stop". The manifest's own
    // description has both, which is why this is narrowed and not copied.
    expect(rootManifest().description).toMatch(/^(?:an?|the)\s/i)
    expect(desc).not.toMatch(/^(?:an?|the)\s/i)
    expect(desc).not.toMatch(/\.$/)
    expect(desc[0]).toBe(desc[0]?.toUpperCase())
  })

  it('is within the 80 characters the audit allows', () => {
    expect(desc.length, desc).toBeLessThanOrEqual(80)
  })

  it('does not contain the formula name, which the audit also refuses', () => {
    expect(desc.toLowerCase()).not.toContain(COMMAND)
  })
})

describe('the formula', () => {
  it('is named the class Homebrew expects of its filename', () => {
    // `tade.rb` must hold `class Tade`. Homebrew resolves one from the other at
    // load, so a mismatch is an error on a stranger's machine and nowhere else.
    const file = FORMULA.split('/').at(-1)?.replace(/\.rb$/, '') ?? ''
    expect(file).toBe(COMMAND)
    expect(checkedIn).toContain(`class ${className(file)} < Formula`)
  })

  it('points at the registry, which is also what livecheck reads', () => {
    // Homebrew's own `Npm` livecheck strategy matches
    // `registry.npmjs.org/<package>/-/…`, and that is what lets a tap — or
    // homebrew-core's own bot — notice a new version without being told. A
    // mirror, or the host a registry proxy answers with, is a URL that works
    // for whoever generated it and for nobody else.
    expect(field('url')).toBe(tarballUrl(versionInUrl()))
    expect(field('sha256')).toMatch(/^[0-9a-f]{64}$/)
    expect(field('license')).toBe(rootManifest().license)
  })

  it('runs the tarball install scripts, which is the whole of whether it works', () => {
    // Homebrew's default is `--ignore-scripts`. Under it node-pty is never
    // built and never gets its executable bit back, so the install succeeds and
    // the thing it installed cannot open a terminal.
    expect(checkedIn).toContain('std_npm_args(ignore_scripts: false)')
  })

  it('rewrites a shebang that is really there, on a file that is really there', () => {
    // Both halves fail silently. `rewrite_shebang` matches
    // `#!/usr/bin/env node` and does nothing at all to a file that says
    // something else or is not where it was named, and `detected_node_shebang`
    // needs both the mixin and the node dependency.
    expect(checkedIn).toContain('include Language::Node::Shebang')
    expect(checkedIn).toContain('depends_on "node"')
    expect(existsSync(join(ROOT, 'packages/cli/src/bin.ts'))).toBe(true)
    expect(readFileSync(join(ROOT, 'packages/cli/src/bin.ts'), 'utf8')).toMatch(
      /^#!\/usr\/bin\/env node\n/,
    )
    // `.ts` here, `.js` there: staging's second rewrite rule, by hand, because
    // a Ruby string is not something that pass can reach.
    expect(checkedIn).toContain(`libexec/"lib/node_modules/${PUBLISHED}/packages/cli/src/bin.js"`)
  })

  it('is generated, and has not been edited by hand', () => {
    // The whole file comes out of `formulaFor`, so the licence, the homepage and
    // the description cannot drift from the manifest and a comment cannot go
    // stale against the code it describes. Re-rendered from its own two version
    // lines: anything else that differs was typed into the file.
    expect(checkedIn).toBe(formulaFor({ version: versionInUrl(), sha256: field('sha256') }))
  })
})

describe('what the generator is asked for', () => {
  it('builds the registry URL for a version', () => {
    expect(tarballUrl('0.2.0', 'tade-sh')).toBe(
      'https://registry.npmjs.org/tade-sh/-/tade-sh-0.2.0.tgz',
    )
    expect(tarballUrl('0.2.0-rc.1', 'tade-sh')).toContain('tade-sh-0.2.0-rc.1.tgz')
  })

  it('camel-cases a hyphenated command, because Ruby will not load `Tade-sh`', () => {
    expect(className('tade')).toBe('Tade')
    expect(className('tade-sh')).toBe('TadeSh')
  })

  it('narrows whatever description the manifest holds', () => {
    expect(descFor('An example of a thing.')).toBe('Example of a thing')
    expect(descFor('The thing')).toBe('Thing')
    expect(descFor('Already fine')).toBe('Already fine')
  })

  it('can only ever name the scratch tap, whatever Homebrew answers', () => {
    // The one path in here built out of a value from outside the program, and
    // the one that is removed again — so what it may name is proved rather
    // than argued about. Everything after the prefix is a constant, which is
    // what makes a traversal out of it impossible; the refusals are about the
    // prefix being a prefix at all.
    const leaf = `/Library/Taps/${SCRATCH.split('/')[0]}/homebrew-${SCRATCH.split('/')[1]}`
    expect(scratchTapAt('/opt/homebrew')).toBe(`/opt/homebrew${leaf}`)
    expect(scratchTapAt('  /home/linuxbrew/.linuxbrew/Homebrew\n')).toBe(
      `/home/linuxbrew/.linuxbrew/Homebrew${leaf}`,
    )
    // `..` in the prefix normalises away and still cannot reach past the leaf.
    expect(scratchTapAt('/opt/homebrew/../elsewhere').endsWith(leaf)).toBe(true)
    // A relative answer would hang the removal off the working directory, and
    // one with a line break in it is Homebrew having said something as well as
    // answered.
    for (const answered of ['', '   ', 'homebrew', './homebrew', '/opt/a\n/opt/b'])
      expect(() => scratchTapAt(answered), JSON.stringify(answered)).toThrow('not a path')
  })

  it('is a command this repository has', () => {
    const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(scripts.homebrew).toBe('node scripts/release/homebrew.ts')
  })
})

interface Workflow {
  name: string
  on: Record<string, { workflows?: string[] }>
  jobs: Record<
    string,
    {
      if?: string
      needs?: string | string[]
      'runs-on'?: string
      steps?: { uses?: string; run?: string; with?: Record<string, unknown> }[]
    }
  >
}

const HOMEBREW_PATH = '.github/workflows/homebrew.yml'
const text = readFileSync(join(ROOT, HOMEBREW_PATH), 'utf8')
const workflow = parse(text) as Workflow
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])

describe('the workflow that keeps the tap current', () => {
  it('waits for the release workflow by the name that workflow has', () => {
    // The quiet one. `workflow_run` matches on a workflow's `name`, not its
    // filename — rename the release and this trigger matches nothing, for ever,
    // and no release ever says so because a release that publishes is still a
    // release that worked.
    const release = parse(
      readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8'),
    ) as Workflow
    expect(workflow.on.workflow_run?.workflows).toContain(release.name)
  })

  it('is never started by a push', () => {
    // It can only run after a publish, because a formula may only name a hash
    // of bytes the registry already has.
    expect(workflow.on.push).toBeUndefined()
    expect(Object.keys(workflow.on)).toEqual(['workflow_run', 'workflow_dispatch'])
  })

  it('reaches the tap only for a release that really published', () => {
    // `release` also runs from the Actions tab as a rehearsal: it publishes
    // nothing and is green all the same. A tag whose gate went red, or whose
    // publish a reviewer declined, is not a success and does not reach here
    // either.
    const gate = Object.values(workflow.jobs)
      .map((job) => job.if ?? '')
      .join('\n')
    expect(gate).toContain("workflow_run.event == 'push'")
    expect(gate).toContain("workflow_run.conclusion == 'success'")
  })

  it('offers nothing to anybody that was not built first', () => {
    // The tap has no CI of its own, so this job is the only thing between a
    // formula that does not build and a pull request asking somebody to merge
    // it. On macOS, from source, running the formula's own test block — and
    // the pull request waits for it.
    expect(workflow.jobs.build?.['runs-on']).toBe('macos-latest')
    expect(workflow.jobs.tap?.needs).toContain('build')
    const built = (workflow.jobs.build?.steps ?? []).map((step) => step.run ?? '').join('\n')
    expect(built).toContain('--try')
  })

  it('reads one credential and names it', () => {
    // Not "no secret", which is `release.yml`'s rule and the reason this is a
    // separate file: opening a pull request on another repository takes a token
    // that can write to it. One, named here, so a second cannot arrive quietly.
    const read = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1])
    expect([...new Set(read)]).toEqual(['HOMEBREW_TAP_TOKEN'])
  })

  it('writes nothing from the event into a shell line', () => {
    // Same rule as `release.yml`: an input and a ref name are somebody's text,
    // and a `run:` block with an expression in it is that text becoming the
    // script. Through the environment it stays an argument.
    for (const step of steps) expect(step.run ?? '').not.toMatch(/\$\{\{/)
  })

  it('needs no package manager', () => {
    for (const step of steps) {
      if (!(step.uses ?? '').startsWith('actions/setup-node')) continue
      expect(step.with?.['package-manager-cache']).toBe(false)
    }
  })

  it('names only scripts and files this repository has', () => {
    const runs = steps.map((step) => step.run ?? '').join('\n')
    const named = [...runs.matchAll(/\bnode (scripts\/[\w/.-]+)/g)].map((match) => match[1] ?? '')
    expect(named.length).toBeGreaterThan(0)
    for (const script of named) expect(existsSync(join(ROOT, script)), script).toBe(true)
    // And the formula it uploads and copies is the one this repository writes.
    expect(runs).toContain(FORMULA)
  })
})
