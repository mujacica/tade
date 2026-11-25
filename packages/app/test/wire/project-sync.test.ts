import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { takeRunLock } from '@tade/checks-core'
import { mirrorDir, recordsDir, type ProjectSync as SyncMode, type TadeEvent } from '@tade/core'
import { gitLoad, resetGitLoad } from '@tade/status'
import { describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { emptyTranscript, problem, type Transcript, tadeDid } from '../../src/transcript.ts'
import {
  freshName,
  MERGE_NAMES_TRIED,
  openProposalIn,
  ProjectSync,
  type ProjectSyncDeps,
  SOON_MS,
  SYNC_EVERY_MS,
} from '../../src/wire/project-sync.ts'

// Each project's branch kept in step (`wire/project-sync.ts`): real
// repositories — a checkout with an origin, and another clone pushing to it as
// another machine would — and the subject's own decisions: the checks lock
// across a move, the journal, every agent in the checkout told, a parted
// branch made one proposal, and each reason said once.

/** A checkout with an origin, and a way to push work to origin from another clone. */
function twoMachines() {
  const here = mkrepo({ remote: true })
  const there = join(tmp('tade-there-'), 'repo')
  runGit(here.root, 'clone', '-q', here.remote as string, there)
  const pushThere = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(there, path), text)
    runGit(there, 'add', '-A')
    runGit(there, 'commit', '-q', '-m', 'work there')
    runGit(there, 'push', '-q', 'origin', 'main')
    return runGit(there, 'rev-parse', 'HEAD').trim()
  }
  return { here, there, pushThere }
}

function syncing(
  here: ReturnType<typeof mkrepo>,
  over: {
    mode?: SyncMode
    said?: string[]
    tasks?: { id: string; dir: string }[]
    pushes?: boolean
  } = {},
) {
  let now = Date.parse('2026-11-22T09:00:00Z')
  const journal: { type: string; detail: Record<string, unknown> }[] = []
  const created: TadeEvent[] = []
  const steered: { task: string; message: string }[] = []
  const proposed: {
    slug: string
    base: string
    title: string
    prompt?: string
    merges?: string
  }[] = []
  const news: string[] = []
  const told: string[] = []
  const said: string[] = []
  const noticed: string[] = []
  // The window's ledger, drawn the way `projectSyncFor` draws it: trouble a ✗, news a notice.
  let ledger: Transcript = emptyTranscript()
  const running = new Set(['app/one', 'app/two'])
  const deps: ProjectSyncDeps = {
    home: here.home,
    projects: () => [
      {
        name: 'app',
        root: here.root,
        tasks: over.tasks ?? [
          { id: 'app/one', dir: here.root },
          { id: 'app/two', dir: here.root },
          { id: 'app/idle', dir: here.root },
          { id: 'app/apart', dir: '/elsewhere/worktree' },
        ],
      },
    ],
    mode: () => over.mode ?? 'ff',
    now: () => now,
    append: async (line) => {
      journal.push(line)
    },
    steer: async (task, message) => {
      if (!running.has(task)) throw new Error(`no agent running on ${task}`)
      steered.push({ task, message })
    },
    openProposal: async (project, stems) => openProposalIn(created, project, stems),
    pushes: () => over.pushes ?? true,
    propose: async (req) => {
      proposed.push({
        slug: req.slug,
        base: req.base,
        title: req.title,
        prompt: req.prompt,
        merges: req.merges,
      })
      const task = `${req.project}/${req.slug}`
      created.push({
        seq: created.length,
        ts: new Date(now).toISOString(),
        type: 'task_created',
        urgency: 'notable',
        task,
        lane: null,
        run: null,
        detail: {},
      } as TadeEvent)
      return task
    },
    news: (text) => news.push(text),
    tell: (text) => told.push(text),
    say: (text) => {
      said.push(text)
      ledger = problem(ledger, text, now)
    },
    notice: (text) => {
      noticed.push(text)
      ledger = tadeDid(ledger, text, now)
    },
    saidLately: async () => over.said ?? [],
  }
  const sync = new ProjectSync(deps)
  return {
    sync,
    journal,
    created,
    steered,
    proposed,
    news,
    told,
    said,
    noticed,
    ledger: () => ledger.entries,
    later: (ms: number) => {
      now += ms
    },
  }
}

describe('the name a merge proposal is made under', () => {
  it('is the next one never used, where one before it was finished or put away', async () => {
    const used = new Set(['app/merge-main-abc1234', 'app/merge-main-abc1234-2'])
    const tried: string[] = []
    const made = await freshName('merge-main-abc1234', async (slug) => {
      tried.push(slug)
      if (used.has(`app/${slug}`)) {
        const err = new Error(`app/${slug} was used before`)
        err.name = 'NameUsed'
        throw err
      }
      return slug
    })
    expect(made).toBe('merge-main-abc1234-3')
    expect(tried).toEqual(['merge-main-abc1234', 'merge-main-abc1234-2', 'merge-main-abc1234-3'])
  })

  it('says any other refusal as it is, and stops trying after a few', async () => {
    await expect(
      freshName('merge-main-abc1234', async () => {
        throw new Error('unknown project "app"')
      }),
    ).rejects.toThrow('unknown project')
    let tries = 0
    const always = async (): Promise<string> => {
      tries++
      const err = new Error('used')
      err.name = 'NameUsedElsewhere'
      throw err
    }
    await expect(freshName('merge-main-abc1234', always)).rejects.toThrow('used')
    expect(tries).toBe(MERGE_NAMES_TRIED)
  })
})

describe('keeping a project in step', () => {
  it('fast-forwards a clean checkout, writes it down, and tells every agent working in it', async () => {
    const { here, pushThere } = twoMachines()
    const was = here.head()
    const theirs = pushThere({ 'README.md': 'from the other machine\n', 'added.ts': 'x\n' })
    const one = syncing(here)
    await one.sync.beat()
    expect(here.head()).toBe(theirs)
    expect(readFileSync(join(here.root, 'README.md'), 'utf8')).toBe('from the other machine\n')
    expect(one.journal).toEqual([
      {
        type: 'project_synced',
        detail: {
          project: 'app',
          branch: 'main',
          from: 'origin',
          was,
          now: theirs,
          files: ['README.md', 'added.ts'],
          told: ['app/one', 'app/two'],
          // Not running, so not told — and that is written down rather than dropped.
          untold: ['app/idle: no agent running on app/idle'],
          byRef: false,
        },
      },
    ])
    // Every running agent in the checkout, and none elsewhere or not running.
    expect(one.steered.map((s) => s.task)).toEqual(['app/one', 'app/two'])
    const message = one.steered[0]?.message ?? ''
    expect(message).toContain(`HEAD moved from ${was.slice(0, 7)} to ${theirs.slice(0, 7)}`)
    expect(message).toContain('README.md, added.ts')
    expect(one.news[0]).toContain('app/one and app/two were told')
    expect(one.said).toEqual([])
  })

  it('refuses rather than touch a dirty file the move changes, names it, and says it once', async () => {
    const { here, pushThere } = twoMachines()
    const was = here.head()
    pushThere({ 'README.md': 'from the other machine\n' })
    writeFileSync(join(here.root, 'README.md'), 'an agent is editing this\n')
    const one = syncing(here)
    await one.sync.beat()
    expect(here.head()).toBe(was)
    expect(readFileSync(join(here.root, 'README.md'), 'utf8')).toBe('an agent is editing this\n')
    expect(one.journal).toEqual([
      {
        type: 'project_sync_held',
        detail: expect.objectContaining({ held: 'refused', paths: ['README.md'] }),
      },
    ])
    expect(one.said).toHaveLength(1)
    expect(one.said[0]).toContain('README.md')
    expect(one.steered).toEqual([])
    // The same reason, looked at again, is not said or written again.
    one.later(SYNC_EVERY_MS)
    await one.sync.beat()
    expect(one.journal).toHaveLength(1)
    expect(one.said).toHaveLength(1)
  })

  it('waits while a checks run holds the tree, and moves once it has gone', async () => {
    const { here, pushThere } = twoMachines()
    const was = here.head()
    const theirs = pushThere({ 'README.md': 'from the other machine\n' })
    const lock = await takeRunLock(recordsDir(here.home, 'app'), 'tests')
    if ('held' in lock) throw new Error('the lock was already held')
    const one = syncing(here)
    const waited = await one.sync.run('app', { fetchOrigin: true, mode: 'ff', asked: true })
    expect(waited.verdict?.kind).toBe('wait')
    expect(waited.said).toContain('checks are running')
    expect(here.head()).toBe(was)
    expect(one.journal).toEqual([])
    await lock.release()
    // A wait is looked at again soon, not a minute later.
    one.later(SOON_MS)
    await one.sync.beat()
    expect(here.head()).toBe(theirs)
  })

  it('waits while something is staged, and writes nothing', async () => {
    const { here, pushThere } = twoMachines()
    const was = here.head()
    pushThere({ 'README.md': 'from the other machine\n' })
    writeFileSync(join(here.root, 'mine.ts'), 'half a commit\n')
    here.git('add', 'mine.ts')
    const one = syncing(here)
    await one.sync.beat()
    expect(here.head()).toBe(was)
    expect(one.journal).toEqual([])
    expect(one.said).toEqual([])
  })

  it('writes nothing for a diverged branch and parks one proposal, worked from the branch here', async () => {
    const { here, pushThere } = twoMachines()
    const theirs = pushThere({ 'theirs.ts': 'theirs\n' })
    const mine = here.commit('work here', { 'mine.ts': 'mine\n' })
    const one = syncing(here)
    await one.sync.beat()
    expect(here.head()).toBe(mine)
    expect(here.git('status', '--porcelain')).toBe('')
    expect(one.proposed).toEqual([
      {
        slug: `merge-main-${theirs.slice(0, 7)}`,
        base: 'main',
        title: "Merge origin's main into main here",
        prompt: expect.stringContaining('git push origin HEAD:main'),
        merges: 'main',
      },
    ])
    expect(one.journal).toEqual([
      {
        type: 'project_sync_held',
        detail: expect.objectContaining({
          held: 'diverged',
          proposal: `app/merge-main-${theirs.slice(0, 7)}`,
        }),
      },
    ])
    // More work on the other side is not another proposal while that one is open.
    pushThere({ 'more.ts': 'more\n' })
    one.later(SYNC_EVERY_MS)
    await one.sync.beat()
    expect(one.proposed).toHaveLength(1)
  })

  it('says two machines parting once, as a notice, and again only when a new merge is needed', async () => {
    const { here, there } = twoMachines()
    // ipax's main, handed into this home's mirror the way ipax's Tade hands it.
    const mirror = mirrorDir(here.home, 'app')
    runGit(here.home, 'init', '-q', '--bare', mirror)
    const commitThere = (path: string) => {
      writeFileSync(join(there, path), `${path}\n`)
      runGit(there, 'add', '-A')
      runGit(there, 'commit', '-q', '-m', `${path} there`)
      runGit(there, 'push', '-q', '--force', mirror, '+refs/heads/*:refs/remotes/ipax/*')
      return runGit(there, 'rev-parse', 'HEAD').trim()
    }
    commitThere('theirs.ts')
    here.commit('work here', { 'mine.ts': 'mine\n' })
    const one = syncing(here)
    await one.sync.beat()
    expect(one.proposed).toHaveLength(1)
    expect(one.proposed[0]?.slug).toMatch(/^merge-main-[0-9a-f]{7}$/)
    expect(one.proposed[0]?.title).toBe("Merge ipax's main into main here")

    // Both sides go on committing, so the counts move on every look: nothing more is said.
    for (const n of [1, 2, 3]) {
      commitThere(`theirs-${n}.ts`)
      here.commit(`more here ${n}`, { [`mine-${n}.ts`]: `${n}\n` })
      one.later(SYNC_EVERY_MS)
      await one.sync.beat()
    }
    const kinds = () => one.ledger().map((entry) => entry.kind)
    expect(kinds()).toEqual(['tade'])
    expect(one.said).toEqual([])
    expect(one.noticed[0]).toContain("app's main has parted from ipax's")
    expect(one.noticed[0]).toContain(`Proposed app/${one.proposed[0]?.slug}`)
    expect(one.journal.filter((line) => line.type === 'project_sync_held')).toHaveLength(1)
    expect(one.proposed).toHaveLength(1)

    // That merge finished and they have parted again: a new proposal, said once more.
    one.created.push({
      ...(one.created[0] as TadeEvent),
      seq: one.created.length,
      type: 'task_done',
    } as TadeEvent)
    commitThere('theirs-4.ts')
    one.later(SYNC_EVERY_MS)
    await one.sync.beat()
    expect(one.proposed).toHaveLength(2)
    expect(kinds()).toEqual(['tade', 'tade'])
  })

  it('counts a merge proposed under its old name, with the source in it, as still open', async () => {
    const { here, pushThere } = twoMachines()
    pushThere({ 'theirs.ts': 'theirs\n' })
    here.commit('work here', { 'mine.ts': 'mine\n' })
    const one = syncing(here)
    one.created.push({
      seq: 0,
      ts: new Date().toISOString(),
      type: 'task_created',
      urgency: 'notable',
      task: 'app/merge-origin-main-by-hand',
      lane: null,
      run: null,
      detail: {},
    } as TadeEvent)
    await one.sync.beat()
    expect(one.proposed).toEqual([])
    expect(one.noticed).toEqual([
      expect.stringContaining('app/merge-origin-main-by-hand is already proposed for it'),
    ])
  })

  it('under ask, tells the orchestrator once and moves only on a line of the person’s naming it', async () => {
    const { here, pushThere } = twoMachines()
    const was = here.head()
    const theirs = pushThere({ 'README.md': 'from the other machine\n' })
    const asked = syncing(here, { mode: 'ask', said: ['bring app up to date with the vps'] })
    await asked.sync.beat()
    expect(here.head()).toBe(was)
    expect(asked.told).toHaveLength(1)
    expect(asked.told[0]).toContain('tade_project_sync')
    asked.later(SYNC_EVERY_MS)
    await asked.sync.beat()
    expect(asked.told).toHaveLength(1)
    await expect(asked.sync.now({ project: 'app' })).rejects.toThrow(/Pass what they said/)
    await expect(
      asked.sync.now({ project: 'app', said: 'bring app up to date with the vps' }),
    ).resolves.toContain('fast-forwarded')
    expect(here.head()).toBe(theirs)

    const unasked = syncing(here, { mode: 'off', said: ['how is the weather'] })
    await expect(unasked.sync.now({ project: 'app', said: 'how is the weather' })).rejects.toThrow(
      /Nothing they have said names app/,
    )
  })

  it('under origin, moves to origin’s commits by itself and from the tool with nothing said', async () => {
    const { here, pushThere } = twoMachines()
    const first = pushThere({ 'README.md': 'from origin\n' })
    const one = syncing(here, { mode: 'origin' })
    await one.sync.beat()
    expect(here.head()).toBe(first)
    expect(one.told).toEqual([])
    const second = pushThere({ 'README.md': 'from origin again\n' })
    await expect(one.sync.now({ project: 'app' })).resolves.toContain('fast-forwarded')
    expect(here.head()).toBe(second)
  })

  it('says in the tool’s answer that a project in step is in step', async () => {
    const { here } = twoMachines()
    const one = syncing(here)
    expect(await one.sync.now({ project: 'app' })).toContain('main is in step')
    await expect(one.sync.now({ project: 'nope' })).rejects.toThrow(/no project called nope/)
  })

  it('asks git for no status, diff or merge on a look at a quiet project', async () => {
    const { here } = twoMachines()
    const one = syncing(here)
    await one.sync.beat()
    resetGitLoad()
    one.later(SYNC_EVERY_MS)
    await one.sync.beat()
    const asked = gitLoad().commands
    // Its branch, where it is checked out, its head, origin's: five small questions a minute.
    expect(gitLoad().started).toBeLessThanOrEqual(5)
    expect(asked.status ?? 0).toBe(0)
    expect(asked.diff ?? 0).toBe(0)
    expect(asked.merge ?? 0).toBe(0)
    // Origin is fetched no oftener than its own clock: not on this look.
    expect(asked.fetch ?? 0).toBe(0)
    // Nothing is due before a minute has passed.
    resetGitLoad()
    one.later(SYNC_EVERY_MS / 2)
    await one.sync.beat()
    expect(gitLoad().started).toBe(0)
  })
})
