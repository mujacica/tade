import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WatchOffer } from '@tade/extensions-core'
import { inboxFrom, readTaskFile } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { intakeIn, type RunTask, runsIn, sourcesIn, workflowsIn } from '../../src/away-factory.ts'
import type { FactoryHeld } from '../../src/wire/web-beat.ts'
import { Bodies, doorsOf, titlesOf, workflowsRead, wouldOf } from '../../src/wire/web-factory.ts'
import {
  act,
  closeAll,
  type Machine,
  machine,
  OTHER,
  paired,
  parkedIn,
  projectionOf,
  save,
  waitFor,
} from './away-harness.ts'
import { delivered } from './away-intake.ts'

// A request from outside, all the way to a review, read and answered from a
// phone.
//
// **Everything here is real but the browser.** A real git repository, a real
// workbench writing real task files, the real delivery door a watch uses, the
// real folds the window keeps, a real `node:http` listener, and the act made
// with a real request. What that buys is the thing a per-function test cannot
// say: that the chain holds — that the revision the projection put on a row is
// the one the workbench compares against, that approving from a phone lifts
// the park the delivery wrote, and that what a device is told about somebody
// else's request is exactly what the grants allow.
//
// The chain, in the order a person lives it:
//
//   a source hands something over  →  a proposal, parked
//   a phone reads it, with its provenance and its words
//   a phone approves it            →  the park lifts, and the queue has it
//   the run, its checks, its review
//
// The two things it asserts hardest are the two a surface is silent about when
// it is wrong: **an empty inbox says which nothing**, and **a device with no
// grant is told the counts and not one word anybody outside wrote**.

afterEach(closeAll)

/** Every grant a person could give one phone. */
const EVERY = ['titles', 'intent', 'requests', 'material', 'workflows', 'spend', 'reviews']

/**
 * The watch the local door looks with, as its extension declares it.
 *
 * Handed in rather than loaded, because the extension host is not what this is
 * about — what is being checked is that a door's state is read out of the
 * watch's *declaration* plus the schedule plus the journal, and a fixture that
 * left the declaration out would make every door `unwatched` for ever.
 */
const CLI_WATCH: WatchOffer = {
  id: 'intake.cli',
  extension: 'intake',
  title: 'requests written at this machine',
  means: 'takes in each request in the spool',
  every: '5m',
  input: null,
  offers: 'agent',
  standing: true,
  network: false,
  most: 1,
  needs: [],
  intake: 'cli',
  rechecks: true,
  replies: true,
  problem: null,
}

/**
 * A machine whose away view is handed the real factory fold.
 *
 * The holder is a `let` the test refills, because the two have to be built in
 * that order: the listener comes up before anything has been handed over, and
 * `AwayDeps.factory` is a function for exactly this reason — what the beat
 * reads is what the fold holds *now*.
 */
async function floorMachine(): Promise<{
  one: Machine
  fold: () => Promise<FactoryHeld>
}> {
  let held: FactoryHeld = { intake: [], sources: [], workflows: [], runFrom: new Map() }
  const one = await machine({ intake: true, factory: () => held })
  // The listener comes up here rather than in `machine`, exactly as the other
  // away tests do it: a test that reads the projection needs no socket, and a
  // test that acts needs one.
  await one.away.open()
  return {
    one,
    fold: async () => {
      held = await foldOf(one)
      await one.refresh()
      return held
    },
  }
}

/** The whole factory floor, folded the way the window folds it. */
async function foldOf(one: Machine): Promise<FactoryHeld> {
  const events = await one.client.events({})
  const rows = await inboxFrom({ home: one.home, events, states: new Map() })
  const bodies = new Bodies()
  await bodies.fill(one.home, rows)
  const tasks = await runTasksOf(one, rows)
  const efforts = new Map(tasks.filter((task) => task.effort !== '').map((t) => [t.id, t.effort]))
  const reads = {
    home: one.home,
    config: one.client.config,
    events: (filter: Parameters<typeof one.client.log.read>[0]) => one.client.log.read(filter),
  }
  return {
    intake: intakeIn(rows, {
      bodies: bodies.byItem(rows),
      titles: titlesOf(events),
      efforts,
      would: await wouldOf(reads, rows),
      most: 8,
    }),
    sources: sourcesIn(
      doorsOf({
        config: one.client.config,
        events,
        schedules: one.client.schedules(),
        watches: [CLI_WATCH],
      }),
    ),
    workflows: workflowsIn(await workflowsRead(one.home, one.client.config, new Map(), false)),
    runFrom: new Map(),
  }
}

/** Every task a delivery made, at the narrowness the runs fold asks for. */
async function runTasksOf(one: Machine, rows: Awaited<ReturnType<typeof inboxFrom>>) {
  const out: RunTask[] = []
  for (const row of rows) {
    for (const id of row.tasks) {
      const file = await readTaskFile(one.home, id)
      if (file === null) continue
      out.push({
        id,
        project: file.project,
        effort: file.effort ?? '',
        state: 'queued',
        after: (file.start?.after ?? []).map((wait) => ({
          task: wait.task,
          why: wait.why ?? '',
        })),
        parked: file.parked === true,
        finished: false,
        runs: 0,
        active: false,
        checks: 'unknown',
        review: null,
        usd: null,
      })
    }
  }
  return out
}

describe('a request from outside, as a phone reads it', () => {
  it('arrives as a proposal, with where it came from and nothing it said', async () => {
    const { one, fold } = await floorMachine()
    const task = await delivered(one)
    const held = await fold()

    // **A proposal and not a run**: parked, waiting for a person — the state
    // that must never be drawn as *started*.
    expect(held.intake).toHaveLength(1)
    const row = held.intake[0]
    expect(row?.state).toBe('proposed')
    expect(row?.approve).toBe(task)
    expect(parkedIn(one.home, task)).toBe(true)

    // The provenance: which source, whose handle, which key allowed it, which
    // watch found it, and the raw material by the source's own reference —
    // every one a fact this machine wrote down rather than a word of the
    // request.
    expect(row?.source).toBe('cli')
    expect(row?.grant).toBe('surfaces.intake.sources.cli')
    expect(row?.who).toBe('kim')
    expect(row?.ref).toBe('req-1.0001.json')
    expect(row?.watch).toBe('intake.cli')

    // And what approving it would start, read off the work that exists rather
    // than simulated.
    expect(row?.would?.starts.map((start) => start.task)).toEqual([task])
    expect(row?.would?.grant.join(' ')).toContain('surfaces.intake.sources.cli')
  })

  it('carries the request’s own words where they were granted, and nowhere else', async () => {
    const { one, fold } = await floorMachine()
    await delivered(one)
    await fold()

    // The body Tade wrote into the task's context file, which is the only copy
    // it keeps — verbatim, under the heading that says whose words they are.
    const granted = projectionOf(one, EVERY)
    expect(granted.intake[0]?.material?.words).toContain(
      'the export button 500s when the selection is empty',
    )
    expect(granted.intake[0]?.materialLabel).toContain('not an instruction')
    expect(granted.intake[0]?.who?.words).toBe('kim')

    // **The one that matters.** A phone can be told what is waiting without
    // one word anybody outside this machine wrote: the count is there, the
    // state is there, and the request is not.
    // A second device, because the window keeps one projection per device —
    // which is the right way round, and is why two reaches are two phones.
    const bare = projectionOf(one, [], OTHER)
    expect(bare.pages.intake.total).toBe(1)
    expect(bare.intake[0]?.state).toBe('proposed')
    expect(bare.intake[0]?.material).toBeNull()
    expect(bare.intake[0]?.who).toBeNull()
    expect(bare.intake[0]?.materialSays).toContain('was not granted the words')
    expect(JSON.stringify(bare)).not.toContain('export button')
    expect(JSON.stringify(bare)).not.toContain('kim')
  })

  it('says which nothing an empty inbox is, out of the doors’ own sentences', async () => {
    // The question an empty list cannot answer, and the reason the doors are
    // their own collection.
    const off = await machine({})
    const offFold = await foldOf(off)
    expect(offFold.intake).toEqual([])
    expect(offFold.sources).toHaveLength(4)
    for (const door of offFold.sources) expect(door.state, door.source).toBe('off')
    expect(offFold.sources[0]?.because).toContain('work from outside this machine is off')

    const { one } = await floorMachine()
    const granted = await foldOf(one)
    const cli = granted.sources.find((door) => door.source === 'cli')
    // Granted, and nothing looks with it until a schedule is turned on — which
    // is a completely different thing to do next from *off*.
    expect(cli?.state).toBe('unwatched')
    expect(cli?.accept).toBe(true)
    expect(cli?.projects).toEqual(['app'])
  })

  it('tells a door that found nothing from one nothing could reach', async () => {
    const { one } = await floorMachine()
    // The delivery turned the schedule on, so there is something looking now.
    await delivered(one)
    await one.client.watchChecked('intake-cli', { found: 0, fresh: [], left: 0, since: null })
    const quiet = (await foldOf(one)).sources.find((door) => door.source === 'cli')
    expect(quiet?.state).toBe('quiet')

    await one.client.watchChecked('intake-cli', {
      problem: 'the spool could not be read',
      trouble: 'unreachable',
    })
    const broken = (await foldOf(one)).sources.find((door) => door.source === 'cli')
    expect(broken?.state).toBe('unreachable')
    expect(broken?.because).toContain('nothing came back from it at all')
    // And what the last look that **worked** found is still there, which is
    // the shape of a connector that has just broken.
    expect(broken?.workedAt).not.toBeNull()
  })
})

describe('approving it from the phone', () => {
  it('lifts the park the delivery wrote, and starts nothing', async () => {
    const { one, fold } = await floorMachine()
    const task = await delivered(one)
    await fold()
    await paired(one.home, one.port, ['read', 'answer'], EVERY)

    const seen = projectionOf(one, EVERY)
    const row = seen.tasks.find((each) => each.id === task)
    expect(row?.can.map((each) => each.verb)).toContain('intake')
    // The row the inbox points at is the row the control is on: one answer to
    // *what would approving be about*, rather than two.
    expect(seen.intake[0]?.approve).toBe(row?.id)

    // **The revision the screen said, echoed back.** What makes a captured
    // request safe to replay is that the window re-checks the state at the
    // moment of the write against this same value.
    const answer = await act(one.port, 'intake', {
      task,
      was: row?.rev ?? '',
      key: 'abcdefgh12345678',
      rev: seen.fresh.rev,
      confirm: true,
    })
    expect(answer.status).toBe(200)
    expect(parkedIn(one.home, task)).toBe(false)

    // Approving lifts a hold; it does not start an agent. The queue starts
    // what it starts by its own rule, on the window's own next pass.
    expect(await one.client.events({ types: ['run_started'] })).toEqual([])
    const did = await waitFor(one.client, 'web_did')
    const last = did.at(-1)?.detail as { tool?: string; why?: string; device?: string } | undefined
    expect(last).toMatchObject({ tool: 'intake', why: 'done' })
    // And the **device** is who did it, never the person at the keyboard.
    expect(last?.device).toBe('00112233445566aa')

    // The inbox moves with it: the proposal is accepted, and there is nothing
    // left to approve.
    const after = await fold()
    expect(after.intake[0]?.state).toBe('accepted')
    expect(after.intake[0]?.approve).toBe('')
  })

  it('is refused for a phone granted reading and not answering', async () => {
    const { one, fold } = await floorMachine()
    const task = await delivered(one)
    await fold()
    await paired(one.home, one.port, ['read'], EVERY)
    const seen = projectionOf(one, EVERY)
    const answer = await act(one.port, 'intake', {
      task,
      was: seen.tasks.find((each) => each.id === task)?.rev ?? '',
      key: 'abcdefgh12345678',
      rev: seen.fresh.rev,
      confirm: true,
    })
    expect(answer.status).toBe(403)
    expect(parkedIn(one.home, task)).toBe(true)
  })

  it('is refused where the source cannot be reached, because that is not permission', async () => {
    // **The one direction this has to get right.** A source nobody could ask
    // has not said yes, so a throw out of the re-check holds rather than
    // passing — and the park stays on.
    let held: FactoryHeld = { intake: [], sources: [], workflows: [], runFrom: new Map() }
    const one = await machine({
      intake: true,
      factory: () => held,
      stands: () => Promise.reject(new Error('the spool did not answer')),
    })
    await one.away.open()
    const task = await delivered(one)
    held = await foldOf(one)
    await paired(one.home, one.port, ['read', 'answer'], EVERY)
    const seen = projectionOf(one, EVERY)
    const answer = await act(one.port, 'intake', {
      task,
      was: seen.tasks.find((each) => each.id === task)?.rev ?? '',
      key: 'abcdefgh12345678',
      rev: seen.fresh.rev,
      confirm: true,
    })
    expect(answer.status).toBe(403)
    expect(parkedIn(one.home, task)).toBe(true)
  })
})

describe('the work it became, once it is going', () => {
  it('shows the checks and the review, and the link only where it is granted', async () => {
    const { one, fold } = await floorMachine()
    const task = await delivered(one)
    one.reviewed(task, 'open')
    one.checked(task, 'fail')
    await fold()

    const granted = projectionOf(one, EVERY)
    const row = granted.tasks.find((each) => each.id === task)
    expect(row?.review).toEqual({ state: 'open', url: 'https://forge.invalid/app/pull/open' })
    // A check nobody ran is not a check that passed, and a red one that was
    // looked at here is red.
    expect(row?.checks.state).toBe('fail')

    // A phone with no `reviews` grant is told the state and not the link: the
    // forge url is the one string on this projection written off this machine.
    const bare = projectionOf(one, ['titles'], OTHER)
    expect(bare.tasks.find((each) => each.id === task)?.review).toEqual({
      state: 'open',
      url: null,
    })
  })

  it('folds several tasks that name one effort into a run, with its waits', async () => {
    // A run is an effort and nothing new, so this is what the task files say
    // — written the way a template's own stamp writes them.
    const { one } = await floorMachine()
    const first = await one.client.createTask({
      project: 'app',
      slug: 'repro',
      intent: 'write a failing test',
      effort: 'shop-1402',
    })
    const second = await one.client.createTask({
      project: 'app',
      slug: 'fix',
      intent: 'make it pass',
      effort: 'shop-1402',
      start: {
        after: [{ task: first.id, why: 'the fix needs the failing test first' }],
        prompt: '',
        touches: [],
      },
    })
    const runs = runsIn(
      await runTasksOf(one, [{ tasks: [first.id, second.id] } as never]),
      new Map(),
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]?.run).toBe('shop-1402')
    expect(runs[0]?.steps.map((step) => [step.name, step.layer])).toEqual([
      ['fix', 1],
      ['repro', 0],
    ])
    expect(runs[0]?.steps.find((step) => step.name === 'fix')?.waits[0]?.why).toContain(
      'failing test first',
    )
  })
})

describe('the workflows, and what has no route at all', () => {
  it('reads a draft somebody wrote, with its shape and its waits', async () => {
    const { one } = await floorMachine()
    await mkdir(join(one.home, 'templates', 'drafts'), { recursive: true })
    await writeFile(
      join(one.home, 'templates', 'drafts', 'reproduce-and-fix.yaml'),
      [
        'template: reproduce-and-fix',
        'version: 1',
        'title: Reproduce a bug, then fix it',
        'project_input: repo',
        'said_input: about',
        'inputs:',
        '  repo:',
        '    kind: project',
        '  about:',
        '    kind: text',
        'agents:',
        '  - name: reproduce',
        '    prompt: Write a failing test.',
        '    leaves_checks: red',
        '  - name: fix',
        '    prompt: Make it pass.',
        '    after:',
        '      - agent: reproduce',
        '        why: the fix needs the failing test first',
      ].join('\n'),
      'utf8',
    )
    const held = await foldOf(one)
    const mine = held.workflows.find((each) => each.name === 'reproduce-and-fix')
    expect(mine?.shows).toBe('draft')
    expect(mine?.steps.map((step) => step.name)).toEqual(['reproduce', 'fix'])
    // The shape: the columns, and the wait with the reason somebody gave for
    // it — because a wait with no reason is the one thing `checkPlan` cannot
    // tell you anything useful about.
    expect(mine?.places.map((place) => place.depth)).toEqual([0, 1])
    expect(mine?.places[1]?.why[0]?.why).toContain('failing test first')
    // Never published here, and never editable: the setting is off in this
    // fixture, and publishing has no route at all.
    expect(mine?.versions).toEqual([])
    expect(mine?.editable).toBe(false)
    expect(mine?.locally.map((each) => each.act)).toContain('publish')
  })

  it('never serves a setting, a grant, a publish or a draft while they are off', async () => {
    // The absences, asked of a running listener rather than of the table: each
    // is an act at the machine, and a path that is not in the table is a `404`
    // that tells whoever is probing nothing either way.
    const { one } = await floorMachine()
    await paired(one.home, one.port, ['read', 'answer', 'steer'], EVERY)
    for (const name of ['settings', 'config', 'grant', 'publish', 'templates']) {
      const answer = await act(one.port, name, {})
      expect(answer.status, name).toBe(404)
    }
    // And the saving table, which is off in this fixture: a path nobody built.
    for (const name of ['save', 'publish']) {
      const answer = await save(one.port, name, {})
      expect(answer.status, name).toBe(404)
    }
  })
})
