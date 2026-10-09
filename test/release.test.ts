import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
// The server's own reader of the browser's files, pointed at the staged tree
// rather than at the checkout — which is the whole of what these two assert.
import { assetFor, readAssets } from '../packages/web/src/assets.ts'
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
    homepage: string
    repository: { url: string }
    bugs: { url: string }
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

  // The three links npm draws are three different claims, and only one of them
  // is about where somebody should be sent to read about Tade. `homepage` was
  // the README's own anchor, so every Homepage click on the npm page landed on
  // the forge; the site is the answer to that, and the forge keeps the two
  // fields that really are about the forge.
  it('sends its homepage to the site and keeps the forge links on the forge', () => {
    expect(manifest.homepage).toBe('https://tade.sh')
    expect(manifest.repository.url).toBe('git+https://github.com/mujacica/tade.git')
    expect(manifest.bugs.url).toBe('https://github.com/mujacica/tade/issues')
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

  it('ships the away view’s own files, under the names the page asks for', async () => {
    // `stage` copies what `git ls-files` prints and rewrites `.ts` to `.js`.
    // The away view's files are neither TypeScript nor imported by anything, so
    // nothing else in the staging would notice them going missing — and a
    // tarball whose stylesheet is absent is a page with no styles **everywhere
    // but here**. So this reads the staged tree the way the server does.
    const where = join(staged.out, 'packages/web/src/assets')
    const assets = await readAssets(where)
    expect(assets.size).toBeGreaterThan(5)
    const shell = assetFor('/', assets)
    expect(shell?.path).toBe('index.html')

    // Every `src=` and `href=` the shell names, resolved against the **staged**
    // files rather than the checkout's.
    const html = shell?.bytes.toString('utf8') ?? ''
    const named = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((one) => one[1] ?? '')
    expect(named.length).toBeGreaterThanOrEqual(3)
    for (const url of named) expect(assetFor(url, assets), url).not.toBeNull()

    // And every module one of those pulls in through another module, which is
    // in no HTML attribute at all.
    for (const [name, asset] of assets) {
      if (!name.endsWith('.js')) continue
      const text = asset.bytes.toString('utf8')
      for (const found of text.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g)) {
        const spec = (found[1] ?? '').replace(/^\.\//, '')
        expect(assetFor(`/assets/${spec}`, assets), `${name} imports ${spec}`).not.toBeNull()
      }
    }
  })

  it('leaves no TypeScript among the files a browser is served', async () => {
    // `stage` renames `.ts` to `.js`, so a `.ts` asset would be served under
    // one name here and another on somebody else's machine — a bug that
    // appears only after publishing.
    const assets = await readAssets(join(staged.out, 'packages/web/src/assets'))
    for (const name of assets.keys()) expect(name.endsWith('.ts'), name).toBe(false)
  })

  it('brings the native modules it cannot work without', () => {
    expect(manifest.dependencies['node-pty']).toBeDefined()
    expect(manifest.dependencies['better-sqlite3']).toBeDefined()
  })

  // `pnpm release` writes CHANGELOG.md *after* staging, so a tarball built out
  // of the checkout carries the previous release's notes — the dry run's
  // included, and that tarball is the one thing that proves what would go out.
  // Given the text, staging ships it; given nothing, the file on disk stands,
  // which is what the workflow wants, staging from the release commit itself.
  it('ships the changelog the release is generating, not the one still on disk', () => {
    const said = '# Changelog\n\nwhat this release says\n'
    const now = stage({ out: join(where, 'told'), version: '9.9.9', changelog: said })
    expect(readFileSync(join(now.out, 'CHANGELOG.md'), 'utf8')).toBe(said)
    expect(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')).not.toBe(said)
  })

  it('falls back to the changelog in the checkout when it is told none', () => {
    expect(readFileSync(join(staged.out, 'CHANGELOG.md'), 'utf8')).toBe(
      readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'),
    )
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

  it('says a first release is everything, instead of listing everything', () => {
    // 0.1.0 went out with 398 bullets on its page, back through the week this
    // was choosing its own name. There is no previous version anybody could
    // be coming from, so there is no difference to describe — and every
    // release after it is a difference and still lists itself.
    const first = { ...release, version: '0.1.0', since: null }
    const notes = notesFor(first, REPO)
    expect(notes).toContain('The first release')
    expect(notes).not.toContain('A pane that scrolls itself')
    expect(notes).not.toContain('/commit/')
    expect(notesFor(release, REPO)).toContain('A pane that scrolls itself')
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
  name: string
  on: Record<string, unknown>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: Record<
    string,
    {
      uses?: string
      if?: string
      permissions?: Record<string, string>
      steps?: {
        uses?: string
        run?: string
        with?: Record<string, unknown>
        env?: Record<string, string>
      }[]
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

  it('does not queue its own gate behind itself', () => {
    // The gate is `ci.yml` called as a reusable workflow, and a called
    // workflow computes `github.workflow` as the *caller's* name — so ci.yml's
    // own `${{ github.workflow }}-${{ github.ref }}` comes out as
    // `<this workflow's name>-<ref>`. Equal to the caller's group, the gate
    // queues behind the run that is waiting for it: the whole thing fails in
    // two seconds, with no gate job in it and everything after it skipped, and
    // nothing says why. It cost a rehearsal to find and costs a compare to
    // keep — and a rehearsal is the only thing that finds it, because no
    // release has ever been cut when it breaks.
    const ci = parse(readFileSync(join(ROOT, CI_PATH), 'utf8')) as Workflow
    const asCalled = ci.concurrency.group.replaceAll('${{ github.workflow }}', release.name)
    expect(release.concurrency.group).not.toBe(asCalled)
  })

  it('needs no package manager in any job but the gate', () => {
    // Staging reads the workspace off disk and runs `git ls-files`; packing
    // and smoking need nothing installed at all. That is the property that
    // says this repository still has no build step, and `setup-node@v5` broke
    // it by turning its cache on by default: it found the `pnpm-lock.yaml`
    // that `pack`'s checkout brings and failed the release with `Unable to
    // locate executable file: pnpm`. Nothing asked for pnpm there, so nothing
    // may quietly reintroduce it.
    for (const [name, job] of Object.entries(release.jobs)) {
      for (const step of job.steps ?? []) {
        if (!(step.uses ?? '').startsWith('actions/setup-node')) continue
        expect(step.with?.['package-manager-cache'], `${name} setup-node`).toBe(false)
      }
    }
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
