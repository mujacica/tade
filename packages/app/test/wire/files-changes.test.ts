import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { Live } from '../../src/live.ts'
import { type AppState, initialState } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Files } from '../../src/wire/files.ts'
import { until } from './harness.ts'

// What the CHANGES section is about.
//
// The bug: it read `changes(state.focused)` — one *task's* changes — so with no
// agent in front of you it asked about nothing at all and drew "open an agent to
// see". The orchestrator edits files in a project's own checkout by hand, under
// no task, and every one of those edits was invisible: not a stale answer some
// later beat would have caught up with, but a question never asked. The section
// now reads the checkout it is already drawing the tree and the file marks of.
//
// Against a real repository and a real `Live`, because this is git and git is
// never mocked here — and because a `Live` with `changes` stubbed on it is a
// test of the stub, which is the part that was wrong. What is asserted is what
// `git status` says, which is the only form of this that could fail usefully.

const opened: { live: Live; client: Workbench }[] = []

afterEach(async () => {
  for (const one of opened.splice(0)) {
    await one.live.stop().catch(() => {})
    await one.client.close().catch(() => {})
  }
})

/**
 * A repository whose agents share its checkout, with one task in it.
 *
 * Written rather than `addTask`ed: a task shares the checkout only while it has
 * no worktree of its own (`sharedTasks`), so a fixture that made one would be
 * describing the other arrangement.
 */
function sharedCheckout(name = 'refunds') {
  const repo = mkrepo()
  repo.commit('first', { 'README.md': 'the original\n' })
  const dir = join(repo.home, 'projects', 'app', 'tasks', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'task.yaml'),
    stringify({
      id: `app/${name}`,
      project: 'app',
      intent_spoken: 'refunds double-charge on retries',
      created: '2026-09-11T09:14:22Z',
      workspace: 'checkout',
      parked: false,
    }),
  )
  return repo
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

/**
 * The FILES subject over a real `Live` over a real repository, with the agent
 * named in front of you — or with nobody, which is the case the orchestrator's
 * own edits fall into.
 */
async function world(
  root: string,
  home: string,
  focused: string | null,
  others: Record<string, string> = {},
) {
  const client = await Workbench.open({ home })
  const more = Object.entries(others).map(([name, at]) => [
    name,
    { root: at, workspace: 'checkout' },
  ])
  const config = ConfigSchema.parse({
    projects: { app: { root, workspace: 'checkout' }, ...Object.fromEntries(more) },
  })
  const live = await Live.start({
    client,
    config,
    home,
    tadeHome: home,
    cwd: root,
    // Far longer than the test: the refresh beat is not what is under test here,
    // and every read below asks for itself.
    pollMs: 600_000,
  })
  opened.push({ live, client })
  // One look, so the task the fixture wrote is one it knows where to find.
  await live.refresh()

  let state = {
    ...initialState(),
    project: 'app',
    ...(focused
      ? { focused, panes: [{ task: focused, name: focused.split('/')[1] ?? focused, lanes: [] }] }
      : {}),
  } as AppState
  const wire = {
    opts: { config, cwd: root, client },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    live,
    now: () => Date.now(),
    openedAt: 0,
    draw: () => {},
    note: () => {},
  } as unknown as Wiring
  const files = new Files(wire, deps())

  return {
    live,
    files,
    /** Change what the window shows, as a click would. */
    put: (next: (was: AppState) => AppState) => {
      state = next(state)
    },
    /**
     * What the section would draw now, and then the window's next look and
     * status's next beat. A read answers from the last look and only says one
     * is due — a frame never starts git — so a test asks until the answer
     * arrives, not once. The beat is the window's every two seconds, and it is
     * what says which files git does not track: status has just run `git
     * status` on the checkout, so the window does not run it again.
     */
    changed: () => {
      const changes = files.facts().changes ?? []
      live.lookAgain()
      void live.refresh(false)
      return changes.map((change) => change.path)
    },
    /** Where the view says it is looking, which is what the changes are about. */
    where: () => files.facts().where,
  }
}

describe('what the CHANGES section is about', () => {
  it('shows a file the orchestrator changed, which is nobody’s task', async () => {
    const repo = sharedCheckout()
    const { changed, where } = await world(repo.root, repo.home, null)
    // No agent in front of you, and the checkout is still what is being shown.
    expect(where()?.path).toBe(repo.root)

    // What the orchestrator does: edits a file in the checkout itself, under no
    // task and through no lane. This is the change that was invisible.
    writeFileSync(join(repo.root, 'teapot.yaml'), 'short: and stout\n')

    await until('the orchestrator’s file in the changes', () => changed().includes('teapot.yaml'))
  })

  it('shows a file another agent changed while one of your own is in front of you', async () => {
    const repo = sharedCheckout()
    const { changed, where } = await world(repo.root, repo.home, 'app/refunds')
    // An agent sharing the checkout works where everyone else does.
    expect(where()?.path).toBe(repo.root)

    // In a shared checkout an uncommitted change is nobody's, so what the
    // section shows is the checkout and not the focused agent's own edits.
    writeFileSync(join(repo.root, 'ledger.ts'), 'export const rate = 1\n')

    await until('the other agent’s file in the changes', () => changed().includes('ledger.ts'))
  })

  it('stops showing a file once it is committed', async () => {
    const repo = sharedCheckout()
    const { changed } = await world(repo.root, repo.home, null)

    writeFileSync(join(repo.root, 'teapot.yaml'), 'short: and stout\n')
    await until('the file to show at all', () => changed().includes('teapot.yaml'))

    // Committed is not changed: with no agent in front of you the section is
    // measured from `HEAD`, so what has landed has left it.
    repo.git('add', 'teapot.yaml')
    repo.git('commit', '-q', '-m', 'the teapot')

    await until('the committed file to go', () => !changed().includes('teapot.yaml'))
  })

  it('answers about a clean checkout rather than about there being no agent', async () => {
    const repo = sharedCheckout()
    const { changed } = await world(repo.root, repo.home, null)
    // Nothing uncommitted and nobody in front of you: the answer is about the
    // checkout, and it is that there is nothing in it — which is what lets the
    // section say "nothing changed" instead of "open an agent to see".
    expect(changed()).toEqual([])
  })
})

describe('what the side asks about the checkout', () => {
  it('asks nothing about the tree while FILES is folded, and the beat asks what is open', async () => {
    const repo = sharedCheckout()
    const { live, files, put } = await world(repo.root, repo.home, null)
    // Who the tree and its marks were asked about, as `Live` was asked.
    const asked: (string | null)[] = []
    const marksAt = live.marksAt.bind(live)
    live.marksAt = (root) => {
      asked.push(root)
      return marksAt(root)
    }

    // Folded, nothing reads the tree or its marks, so nothing looks at them.
    put((was) => ({ ...was, folded: ['files'] }))
    expect(files.facts().files).toEqual([])
    expect(asked).toEqual([null])

    // Open, and asked again on the beat with no frame drawn at all: an idle
    // window draws nothing, and the tree it is showing must not go stale
    // behind it for that.
    put((was) => ({ ...was, folded: [] }))
    files.facts()
    asked.length = 0
    await live.refresh(false)
    expect(asked).toEqual([repo.root])
  })
})

describe('what the side draws before it has looked', () => {
  it('says it has not looked rather than that nothing changed, and holds the room it took', async () => {
    const repo = sharedCheckout()
    repo.write({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    const other = mkrepo()
    other.commit('first', { 'README.md': 'another project\n' })
    const { live, files, put } = await world(repo.root, repo.home, null, { other: other.root })

    // Nothing has been looked at yet: unknown, which the side draws as `…`,
    // and never as a clean checkout or an empty folder.
    expect(files.facts().changes).toBeNull()
    expect(files.facts().files).toBeNull()
    expect(files.facts().roomHeld).toEqual({ changes: 1, files: 1 })

    const looked = () => {
      const facts = files.facts()
      live.lookAgain()
      return facts
    }
    await until('both looked at', () => {
      const facts = looked()
      return facts.changes?.length === 2 && (facts.files?.length ?? 0) > 0
    })
    const listed = files.facts().files?.length ?? 0
    expect(files.facts().roomHeld).toEqual({ changes: 2, files: listed })

    // Another checkout, not looked at yet: unknown again, in the room the last
    // answer took — so NOTES, under both, does not jump up and back down.
    put((was) => ({ ...was, project: 'other' }))
    expect(files.facts().changes).toBeNull()
    expect(files.facts().files).toBeNull()
    expect(files.facts().roomHeld).toEqual({ changes: 2, files: listed })

    // And its answer, clean, is the room from then on.
    await until('the other checkout looked at', () => looked().changes?.length === 0)
    expect(files.facts().roomHeld?.changes).toBe(1)
  })
})
