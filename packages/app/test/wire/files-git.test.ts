import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { Live } from '../../src/live.ts'
import { type AppState, initialState } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Files } from '../../src/wire/files.ts'

// The two things the FILES subject does that cannot be undone: throwing away a
// file's uncommitted changes, and switching the checkout to another branch.
//
// Against a real repository, because both are git and git is never mocked
// here. Between them they were 191 uncovered lines, and they are the two
// buttons in the window whose cost is somebody's work — so what is asserted is
// not that git was called but **what is on disk afterwards**, which is the only
// form of this test that could fail usefully.
//
// The other half of the rule is that neither ever happens by accident: each
// runs only from the panel that asked, so a stray action name with no question
// behind it does nothing at all.

/** A repository with one commit in it, which is the least a checkout can be. */
function madeRepo() {
  const repo = mkrepo()
  repo.commit('first', { 'README.md': 'the original\n' })
  return repo
}

const gone = (path: string): boolean => {
  try {
    readFileSync(path)
    return false
  } catch {
    return true
  }
}

/** A window looking at this repository, with whatever git says about it. */
function wiring(root: string, over: { marks?: Record<string, string>; panel?: unknown } = {}) {
  let state: AppState = {
    ...initialState(),
    project: 'shop',
    panel: (over.panel ?? null) as AppState['panel'],
  }
  let refreshed = 0
  const wire = {
    opts: {
      config: ConfigSchema.parse({ projects: { shop: { root } } }),
      cwd: root,
      client: {},
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    live: {
      worktreeOf: () => null,
      marksAt: () => over.marks ?? {},
      changes: () => [],
      refresh: async () => {
        refreshed += 1
      },
    } as unknown as Live,
    now: () => 1_000,
    openedAt: 0,
    draw: () => {},
    note: () => {},
  } as unknown as Wiring
  return { wire, at: () => state, refreshed: () => refreshed }
}

const deps = () =>
  ({
    skin: { colour: false },
    size: () => ({ columns: 80, rows: 24 }),
    copy: async () => {},
    openSearch: () => {},
    onScreenWith: async () => {},
    paneSize: () => ({ cols: 80, rows: 20 }),
    applyPanel: () => {},
    selectedInFile: () => null,
    copySelection: async () => {},
  }) as never

const confirming = { kind: 'confirm', busy: true } as unknown
const branching = { kind: 'branch', busy: true } as unknown

describe('throwing away a change', () => {
  it('puts a tracked file back to the last commit', async () => {
    const repo = madeRepo()
    const file = join(repo.root, 'README.md')
    const committed = readFileSync(file, 'utf8')
    writeFileSync(file, 'something else entirely')

    const world = wiring(repo.root, { marks: { 'README.md': 'M' }, panel: confirming })
    await new Files(world.wire, deps()).discard(null, 'README.md')

    // What is on disk, not what git was asked: `restore --staged --worktree`
    // and `checkout --` differ in exactly the case somebody staged the change.
    expect(readFileSync(file, 'utf8')).toBe(committed)
    expect(world.at().panel).toBeNull()
    expect(world.at().notice).toBe('discarded README.md')
  })

  it('puts back a change that was already staged', async () => {
    const repo = madeRepo()
    const file = join(repo.root, 'README.md')
    const committed = readFileSync(file, 'utf8')
    writeFileSync(file, 'staged and wrong')
    repo.git('add', 'README.md')

    const world = wiring(repo.root, { marks: { 'README.md': 'M' }, panel: confirming })
    await new Files(world.wire, deps()).discard(null, 'README.md')

    expect(readFileSync(file, 'utf8')).toBe(committed)
    // And nothing of it is left in the index either, or the next commit takes
    // the change that was just thrown away.
    expect(repo.git('diff', '--cached', '--name-only')).toBe('')
  })

  it('takes away a file that was never committed, which has nothing to go back to', async () => {
    const repo = madeRepo()
    const file = join(repo.root, 'scratch.txt')
    writeFileSync(file, 'notes to self')

    const world = wiring(repo.root, { marks: { 'scratch.txt': 'U' }, panel: confirming })
    await new Files(world.wire, deps()).discard(null, 'scratch.txt')

    // `restore --source=HEAD` on a file HEAD has never heard of fails, so this
    // is the one case that has to be `clean` instead — and the file goes.
    expect(gone(file)).toBe(true)
  })

  it('leaves everything alone where nothing asked the question', async () => {
    const repo = madeRepo()
    const file = join(repo.root, 'README.md')
    writeFileSync(file, 'still mine')

    // No confirm panel open: the action name arrived from somewhere that never
    // asked, and work is not thrown away on the strength of a name.
    const world = wiring(repo.root, { marks: { 'README.md': 'M' } })
    await new Files(world.wire, deps()).discard(null, 'README.md')
    expect(readFileSync(file, 'utf8')).toBe('still mine')
  })

  it('says git’s own words on the panel rather than closing it', async () => {
    const repo = madeRepo()
    const world = wiring(repo.root, { marks: {}, panel: confirming })
    await new Files(world.wire, deps()).discard(null, 'no/such/file.ts')

    const panel = world.at().panel as { busy: boolean; error: string }
    expect(panel.busy).toBe(false)
    expect(panel.error).toBeTruthy()
    // Left open with the reason on it, and nothing said in the strip: a panel
    // that closes on a failure is a button that looks as though it worked.
    expect(world.at().notice).toBeNull()
  })
})

describe('switching the checkout to another branch', () => {
  it('switches to one that is already there', async () => {
    const repo = madeRepo()
    repo.git('branch', 'spike')

    const world = wiring(repo.root, { panel: branching })
    await new Files(world.wire, deps()).switchBranch('switch:spike')

    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('spike')
    expect(world.at().panel).toBeNull()
    expect(world.at().notice).toBe('on spike')
  })

  it('makes one that is not', async () => {
    const repo = madeRepo()
    const world = wiring(repo.root, { panel: branching })
    await new Files(world.wire, deps()).switchBranch('create:tade/refunds')

    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('tade/refunds')
  })

  it('says why git refused, in git’s words, and stays where it was', async () => {
    const repo = madeRepo()
    const was = repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim()

    const world = wiring(repo.root, { panel: branching })
    await new Files(world.wire, deps()).switchBranch('switch:never-made')

    const panel = world.at().panel as { busy: boolean; error: string }
    expect(panel.busy).toBe(false)
    // An unstaged change in the way is a reason worth reading, and it is one
    // only git can word.
    expect(panel.error).toBeTruthy()
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(was)
  })

  it('does nothing where the panel that asked is not open, or nothing was named', async () => {
    const repo = madeRepo()
    const was = repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim()
    const files = new Files(wiring(repo.root, { panel: branching }).wire, deps())

    await files.switchBranch('create:')
    await new Files(wiring(repo.root).wire, deps()).switchBranch('create:from-nowhere')

    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(was)
  })
})

describe('where a path somebody clicked is', () => {
  it('resolves a relative path against the project it is looking at', () => {
    const repo = madeRepo()
    const files = new Files(wiring(repo.root).wire, deps())
    expect(files.hereOnDisk()).toBe(repo.root)
    // Relative paths are the agent's, so they resolve where the work is and
    // not where Tade happens to have been started.
    expect(files.resolvePath('src/index.ts')).toBe(join(repo.root, 'src/index.ts'))
  })

  it('leaves an absolute path exactly as it was given', () => {
    const repo = madeRepo()
    const files = new Files(wiring(repo.root).wire, deps())
    expect(files.resolvePath('/etc/hosts')).toBe('/etc/hosts')
  })

  it('resolves against the agent’s worktree when one is in front of you', () => {
    const repo = madeRepo()
    const world = wiring(repo.root)
    const elsewhere = tmp('tade-files-worktree-')
    world.wire.put({
      ...world.at(),
      focused: 'shop/refunds',
      panes: [{ task: 'shop/refunds', name: 'refunds', lanes: [] }],
    } as unknown as AppState)
    ;(world.wire.live as unknown as { worktreeOf: () => string }).worktreeOf = () => elsewhere

    const files = new Files(world.wire, deps())
    expect(files.hereOnDisk()).toBe(elsewhere)
    expect(files.resolvePath('src/index.ts')).toBe(join(elsewhere, 'src/index.ts'))
  })
})

describe('asking git about the file you have open', () => {
  /** A `Live` that records what it was asked for a diff, and answers with this. */
  function asking(world: ReturnType<typeof wiring>, answer: string | null) {
    const asked: { root: string; base: string | null; path: string }[] = []
    Object.assign(world.wire.live as unknown as Record<string, unknown>, {
      baseOf: () => 'main',
      diffAt: async (root: string, base: string | null, path: string) => {
        asked.push({ root, base, path })
        return answer
      },
    })
    return asked
  }

  it('asks with the path relative to the checkout the file is in', async () => {
    const repo = madeRepo()
    const world = wiring(repo.root)
    const asked = asking(world, '')
    await new Files(world.wire, deps()).loadFileDiff(null, join(repo.root, 'README.md'))
    expect(asked).toEqual([{ root: repo.root, base: 'main', path: 'README.md' }])
  })

  it('asks nothing at all about a file that is not in it', async () => {
    // Search reaches into every worktree and a path in an agent's own words
    // reaches anywhere, so the file open is not always one this checkout can be
    // asked about. Asking anyway is asking about `../..`, and git's answer to
    // that would be drawn as "nothing changed" — a claim about a file nobody
    // ever looked at.
    const repo = madeRepo()
    const world = wiring(repo.root)
    const asked = asking(world, '')
    const elsewhere = join(tmp('tade-files-elsewhere-'), 'README.md')
    await new Files(world.wire, deps()).loadFileDiff(null, elsewhere)
    expect(asked).toEqual([])
  })

  it('tells the panel nothing when git could not look, and an empty diff when it could', async () => {
    // The two answers a panel must never confuse: `no changes` is something git
    // said, and a git that would not answer has said nothing at all.
    const repo = madeRepo()
    const path = join(repo.root, 'README.md')

    const failed = wiring(repo.root)
    asking(failed, null)
    const one = new Files(failed.wire, deps())
    one.openFile(path)
    await one.loadFileDiff(null, path)
    expect(one.panel(80)?.diff ?? null).toBe(null)

    const looked = wiring(repo.root)
    asking(looked, '')
    const two = new Files(looked.wire, deps())
    two.openFile(path)
    await two.loadFileDiff(null, path)
    expect(two.panel(80)?.diff).toMatchObject({ added: 0, removed: 0, binary: false })
  })
})

describe('a shell beside the agent', () => {
  it('refuses where there is no agent, saying where a shell would have started', async () => {
    const repo = madeRepo()
    const world = wiring(repo.root)
    await new Files(world.wire, deps()).openShell()
    expect(world.at().notice).toBe('open an agent first: a shell starts in its worktree')
  })
})
