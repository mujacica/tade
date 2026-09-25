import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { changelogFor, notesFor } from '../scripts/release/changelog.ts'
import { LIVE_RUN, liveTrouble, manifests, PUBLISHED } from '../scripts/release/repo.ts'
import { exportsFor, rewrite, stage } from '../scripts/release/stage.ts'

// What has to be true of the thing a stranger installs.
//
// Everything here is a way the published package could be wrong in a manner
// that shows up only on somebody else's machine — which is the one place
// nobody can debug it, and the one place `pnpm check` never runs. The staging
// asserts most of it itself and throws; this is what makes that run, and holds
// the handful of rules that are about the repository rather than the tarball.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const where = mkdtempSync(join(tmpdir(), 'tade-stage-'))

afterAll(() => rmSync(where, { recursive: true, force: true }))

/** Repo-relative paths of every `.ts` file git tracks under `packages/`. */
function sources(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'packages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path.endsWith('.ts'))
}

describe('the publish directory', () => {
  // `stage` checks itself — no TypeScript left, no second package.json, every
  // `exports` target on disk, every relative path and every `tade-sh/…`
  // specifier answered — and throws a list of what is wrong. Calling it is the
  // test; a green here is every one of those.
  const staged = stage({ out: join(where, 'package'), version: '9.9.9' })
  const manifest = JSON.parse(readFileSync(join(staged.out, 'package.json'), 'utf8')) as {
    name: string
    version: string
    bin: Record<string, string>
    engines: Record<string, string>
    dependencies: Record<string, string>
    scripts: Record<string, string>
  }

  it('is one package, under the name that was free on npm', () => {
    expect(manifest.name).toBe('tade-sh')
    expect(manifest.version).toBe('9.9.9')
  })

  it('installs the command people type, which is not that name', () => {
    expect(Object.keys(manifest.bin)).toEqual(['tade'])
  })

  it('says which Node it needs, because it is the Node that strips no types', () => {
    expect(manifest.engines.node).toBe('>=22.19')
  })

  it('runs nothing on install but the two things a user needs, and ships both', () => {
    // Both are node-pty's, which is the one thing in the tarball that is a
    // binary: what a Linux machine needs before it is compiled, and its
    // `spawn-helper`'s executable bit after. `install-hooks` is neither — it
    // points git at this repository's hooks, which on a contributor's machine
    // is the gate and on a user's is Tade reaching into a repository of theirs
    // that has nothing to do with Tade.
    expect(manifest.scripts).toEqual({
      preinstall: 'node scripts/check-build-tools.mjs',
      postinstall: 'node scripts/fix-pty-permissions.mjs',
    })
    for (const line of Object.values(manifest.scripts)) {
      const named = line.replace(/^node /, '')
      expect(existsSync(join(staged.out, named)), named).toBe(true)
    }
  })

  it('asks for vitest nowhere: the suites that import it do not ship', () => {
    expect(manifest.dependencies.vitest).toBeUndefined()
    expect(staged.left.some((one) => one.startsWith('vitest'))).toBe(true)
  })

  it('brings the native modules it cannot work without', () => {
    expect(manifest.dependencies['node-pty']).toBeDefined()
    expect(manifest.dependencies['better-sqlite3']).toBeDefined()
  })
})

describe('the exports map', () => {
  // The whole of how thirty-eight packages resolve as one. A subpath somebody
  // adds tomorrow is answered because the map is generated from each package's
  // own `exports` — and this is what says so when it is not.
  it('answers every @tade specifier this repository actually writes', () => {
    const map = exportsFor(manifests())
    const keys = Object.keys(map)
    const answered = (subpath: string): boolean =>
      keys.some((key) => {
        if (!key.includes('*')) return key === subpath
        const [before = '', after = ''] = key.split('*')
        return subpath.startsWith(before) && subpath.endsWith(after)
      })
    const missing = new Set<string>()
    for (const path of sources()) {
      const text = readFileSync(join(ROOT, path), 'utf8')
      for (const match of text.matchAll(/['"]@tade\/([^'"]+)['"]/g)) {
        const subpath = `./${match[1]}`
        // The conformance suites are the one thing that does not ship, so the
        // map does not answer for them and must not.
        if (subpath.endsWith('/conformance')) continue
        if (!answered(subpath)) missing.add(`@tade/${match[1]}`)
      }
    }
    expect([...missing]).toEqual([])
  })
})

describe('rewriting a specifier', () => {
  it('sends a sibling package through the published name', () => {
    expect(rewrite("import { x } from '@tade/core'")).toBe(`import { x } from '${PUBLISHED}/core'`)
    expect(rewrite("from '@tade/workbench/events'")).toBe(`from '${PUBLISHED}/workbench/events'`)
  })

  it('takes the extension off a relative path, imports and file names alike', () => {
    expect(rewrite("from './helper.ts'")).toBe("from './helper.js'")
    // Not an import: this is how a harness is told which file to run, and
    // Claude Code, Codex and pi are the ones that run it.
    expect(rewrite("new URL('./hook.ts', import.meta.url)")).toBe(
      "new URL('./hook.js', import.meta.url)",
    )
  })

  it("leaves somebody else's extension.ts alone", () => {
    // `~/.tade/extensions/<one>/extension.ts` is a file a person wrote, is not
    // in this tarball, and is not under node_modules — so Node strips its
    // types the ordinary way and renaming it here would break every one.
    expect(rewrite("join(folder, 'extension.ts')")).toBe("join(folder, 'extension.ts')")
  })

  it('is not fooled by a lane option that only looks like a package', () => {
    expect(rewrite("const LANE_OPTION = '@tade-lane'")).toBe("const LANE_OPTION = '@tade-lane'")
  })
})

const REPO = 'https://github.com/owner/repo'

describe('the changelog', () => {
  const release = {
    version: '0.2.0',
    date: '2026-01-02',
    since: '0.1.0',
    entries: [
      { sha: 'a'.repeat(40), subject: 'A pane that scrolls itself is marked, not barred' },
      { sha: 'b'.repeat(40), subject: 'Fix the thing' },
    ],
  }

  it('says each subject in the words it was written in', () => {
    const text = changelogFor([release], REPO)
    expect(text).toContain('- A pane that scrolls itself is marked, not barred (')
    expect(text).toContain('- Fix the thing (')
  })

  it('invents no conventional-commit prefix for a history that has none', () => {
    expect(changelogFor([release], REPO)).not.toMatch(/^[-*]?\s*(feat|fix|chore|refactor):/m)
  })

  it('links every commit, and the release to the one before it', () => {
    const text = changelogFor([release], REPO)
    expect(text).toContain(`[\`${'a'.repeat(7)}\`](${REPO}/commit/${'a'.repeat(40)})`)
    expect(text).toContain(`## [0.2.0](${REPO}/compare/v0.1.0...v0.2.0) — 2026-01-02`)
  })

  it('links the first release to itself, having nothing to compare it with', () => {
    const first = { ...release, version: '0.1.0', since: null }
    expect(changelogFor([first], REPO)).toContain(`## [0.1.0](${REPO}/releases/tag/v0.1.0)`)
  })

  it("makes a release's notes out of that release's own section", () => {
    const notes = notesFor(release, REPO)
    expect(notes.startsWith('- A pane that scrolls itself')).toBe(true)
    expect(notes).not.toContain('## ')
  })
})

describe('what a contributor gets and a user does not', () => {
  it('keeps the git hooks out of postinstall', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    // `prepare` runs for this repository and for a git install, and never for
    // somebody installing the published package.
    expect(root.scripts.postinstall).not.toContain('install-hooks')
    expect(root.scripts.prepare).toContain('install-hooks')
  })
})

// The release workflow is YAML and cannot be run here, so what is held is the
// handful of things about it that would be wrong quietly: a gate it no longer
// shares with CI, a script it names that nobody has, a trigger that turns a
// push into a publish, and a token where there should be none.

const RELEASE_PATH = '.github/workflows/release.yml'
const CI_PATH = '.github/workflows/ci.yml'

interface Workflow {
  on: Record<string, unknown>
  jobs: Record<
    string,
    {
      uses?: string
      if?: string
      permissions?: Record<string, string>
      steps?: { run?: string; env?: Record<string, string> }[]
    }
  >
}

const release = parse(readFileSync(join(ROOT, RELEASE_PATH), 'utf8')) as Workflow

describe('the release workflow', () => {
  it('runs the gate by calling CI, rather than keeping a copy of it', () => {
    // A second description of what this project checks is a second thing to
    // drift. `ci.yml` is the one list — Tade reads it rather than generating
    // it — and this calls that file.
    expect(release.jobs.gate?.uses).toBe('./.github/workflows/ci.yml')
  })

  it('is calling a workflow that can be called', () => {
    // Without `workflow_call` in its triggers, `uses:` above fails at the
    // moment of a release and at no earlier moment.
    const ci = parse(readFileSync(join(ROOT, CI_PATH), 'utf8')) as Workflow
    expect(Object.keys(ci.on)).toContain('workflow_call')
  })

  it('publishes nothing until the gate and the smoke have both passed', () => {
    const publish = release.jobs.publish
    expect(publish?.if).toContain("github.event_name == 'push'")
    const steps = (publish?.steps ?? []).map((step) => step.run ?? '').join('\n')
    expect(steps).toContain('npm publish')
  })

  it('is started by a tag and never by a push to main', () => {
    // The whole of "deliberate": `on.push` names tags and no branches.
    const push = release.on.push as { tags?: string[]; branches?: string[] }
    expect(push.tags).toEqual(['v*'])
    expect(push.branches).toBeUndefined()
  })

  it('takes a short-lived token from GitHub and reads no secret of its own', () => {
    // Trusted publishing: npm exchanges this for a token good for one publish
    // of this package from this workflow. A secret read here would be a
    // long-lived credential in a repository that needs none — so the rule is
    // that the file reads no secret at all, rather than not that one.
    expect(release.jobs.publish?.permissions?.['id-token']).toBe('write')
    expect(readFileSync(join(ROOT, RELEASE_PATH), 'utf8')).not.toMatch(/secrets\./)
  })

  it('writes nothing from the event into a shell line', () => {
    // A `run:` block with an expression in it is somebody's text becoming the
    // script. Through the environment it stays an argument.
    const runs = Object.values(release.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? '')
    for (const run of runs) expect(run).not.toMatch(/\$\{\{/)
  })

  it('names only scripts this repository has', () => {
    const runs = Object.values(release.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? '')
      .join('\n')
    const named = [...runs.matchAll(/\bnode (scripts\/[\w/.-]+)/g)].map((match) => match[1] ?? '')
    expect(named.length).toBeGreaterThan(0)
    for (const script of named) expect(existsSync(join(ROOT, script)), script).toBe(true)
  })
})

describe('the live test, which a release may not go out without', () => {
  const receipt = join(where, 'live.json')

  it('refuses a release that has no evidence at all', () => {
    // The state this repository was actually in: a test skipped by default,
    // never once run, and nothing anywhere that would have said so.
    const trouble = liveTrouble(join(where, 'nothing.json'), 'a'.repeat(40))
    expect(trouble).toContain('has not been run')
    expect(trouble).toContain(LIVE_RUN)
  })

  it('refuses evidence from another commit, and says which', () => {
    writeFileSync(receipt, JSON.stringify({ commit: 'b'.repeat(40), cases: 13 }))
    const trouble = liveTrouble(receipt, 'a'.repeat(40))
    expect(trouble).toContain('bbbbbbbb')
    expect(trouble).toContain('aaaaaaaa')
    expect(trouble).toContain(LIVE_RUN)
  })

  it('refuses a receipt that will not parse, rather than reading a value out of it', () => {
    writeFileSync(receipt, 'half a file')
    expect(liveTrouble(receipt, 'a'.repeat(40))).toContain('has not been run')
  })

  it('is satisfied only by a green run against this very commit', () => {
    writeFileSync(receipt, JSON.stringify({ commit: 'a'.repeat(40), cases: 13 }))
    expect(liveTrouble(receipt, 'a'.repeat(40))).toBeNull()
  })

  it('names a command that runs the test this repository has', () => {
    const file = LIVE_RUN.split(' ').at(-1) ?? ''
    expect(existsSync(join(ROOT, file))).toBe(true)
    // Gated, so a release is the only thing that pays for it and `pnpm check`
    // never does.
    expect(LIVE_RUN).toContain('TADE_LIVE=1')
    expect(readFileSync(join(ROOT, file), 'utf8')).toContain("process.env.TADE_LIVE === '1'")
  })
})
