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
async function world(root: string, home: string, focused: string | null) {
  const client = await Workbench.open({ home })
  const config = ConfigSchema.parse({ projects: { app: { root, workspace: 'checkout' } } })
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
    /**
     * What the section would draw now. The first read starts the look and
     * answers from the last one — the window draws four times a second and
     * never waits on git — so a test asks until the answer arrives, not once.
     */
    changed: () => (files.facts().changes ?? []).map((change) => change.path),
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
