import { rm } from 'node:fs/promises'
import { IDLE_REASON, type InboxRow } from '@tade/core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedRemote } from '@tade/remotes-scripted'
import { SideAnswerSchema, type SideAsk } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import type { Target } from '../src/hits.ts'
import { goElsewhere, machineOf, type Place } from '../src/machines.ts'
import { type AppState, focusTask, initialState, withProjects, withTasks } from '../src/model.ts'
import { type SideFacts, sideAnswerOf, sideThere } from '../src/side.ts'
import { PLAIN } from '../src/skin.ts'
import { refOf } from '../src/there.ts'
import { draw } from '../src/view.ts'
import { frame, NOW, tasks } from './screens/scenarios/fixtures.ts'
import { queueSchedules, queueTasks } from './screens/scenarios/queue.ts'

// **The definition of an agent on another machine looking like one here.** The
// same project and the same agent are drawn twice: once as this machine's own,
// and once standing in that project on `ipax`, read through the scripted link
// from a real away view (`far.ts`) answering `/api/side` with what its window
// would draw the project from (`sideAnswerOf`). Everything below the row of
// tabs — the side with every section, the agent's header with its pickers, its
// lane, the strip and the foot — must be the same rows, character for
// character; only the tabs along the top, which name the machine, may differ.
// What a press there does is the ids in the hits, carried to `ipax`.

const LANE = 'remotes/ipax/1'

/** The project `checkout`, with every section a project has something in. */
function local(): { state: AppState; frame: Frame } {
  const state = focusTask(
    withTasks(withProjects(initialState(), ['checkout', 'search']), [
      ...tasks,
      ...queueTasks,
      {
        task: 'checkout/webhook-retries',
        state: 'blocked',
        reason: IDLE_REASON,
        finished: { by: 'agent', summary: 'Retries are idempotent now, with a test' },
      },
    ]),
    'checkout/stripe-v15',
  )
  const request: InboxRow = {
    item: 'github:acme/checkout#42',
    source: 'github',
    externalId: 'acme/checkout#42',
    requester: 'octo',
    project: 'checkout',
    grant: 'intake.github',
    template: null,
    revision: 'r1',
    taken: 'r1',
    hash: 'h',
    ref: 'ref',
    url: '',
    watch: 'github.issues',
    schedule: 'github-issues',
    mode: 'propose',
    tasks: [],
    work: [],
    state: 'proposed',
    because: 'waiting for you to approve it',
    attempts: 0,
    tries: 0,
    replies: 0,
    said: [],
    unsent: [],
    at: NOW - 60_000,
  } as InboxRow
  return {
    state: { ...state, folded: [], opened: ['schedules', 'intake', 'retired-notes', 'queue'] },
    frame: frame({
      skin: PLAIN,
      width: 160,
      height: 110,
      schedules: queueSchedules,
      intake: [request],
      intakeEmpty: { short: 'none', long: 'Nothing has been handed to this machine.' },
      retiredNotes: [
        {
          text: 'the old staging host',
          at: '2026-08-01T09:00:00.000Z',
          scope: 'checkout',
          by: 'window',
          retired: { by: 'you', at: '2026-08-02T09:00:00.000Z', because: 'moved' },
        },
      ],
      fileMarks: { 'src/webhooks.ts': 'M' },
      offers: {
        harness: 'pi',
        accounts: true,
        model: { shown: true, support: 'live', note: null },
        thinking: { shown: true, support: 'live', note: null },
        rename: { shown: true, support: 'live', note: null },
        levels: ['low', 'medium', 'high'],
      } as NonNullable<Frame['offers']>,
    }),
  }
}

/** What `ipax`'s window would answer about `checkout`: the values it draws it from. */
function answering(here: {
  state: AppState
  frame: Frame
}): (ask: SideAsk) => Promise<ReturnType<typeof sideAnswerOf>> {
  return async (ask) => {
    const f = here.frame
    const facts: SideFacts = {
      ask,
      panes: here.state.panes,
      looking: false,
      spent: f.spend?.byTask ?? null,
      here: {
        files: f.files ?? null,
        fileMarks: f.fileMarks ?? {},
        where: f.where ?? null,
        changes: f.changes ?? null,
        base: f.base ?? null,
      },
      notes: f.notes ?? [],
      retired: f.retiredNotes ?? [],
      schedules: f.schedules ?? [],
      intake: f.intake ?? [],
      intakeEmpty: f.intakeEmpty ?? { short: '', long: '' },
      agent:
        ask.agent === null || f.route === undefined
          ? null
          : { task: ask.agent, route: f.route, vitals: f.vitals ?? null, offers: f.offers ?? null },
    }
    return sideAnswerOf(facts)
  }
}

describe('a project on another machine, drawn as one here', () => {
  const fars: FarEnd[] = []
  afterEach(async () => {
    await Promise.all(fars.map((far) => far.close()))
    await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
    fars.length = 0
  })

  /** Linked to `ipax`, whose window answers for `checkout` what `here` draws it from. */
  async function throughTheLink(
    here: { state: AppState; frame: Frame },
    place: Place,
  ): Promise<{ state: AppState; frame: Frame }> {
    const far = await startFarEnd({ projects: ['checkout'] })
    fars.push(far)
    far.show(['checkout'], {}, [])
    far.side = answering(here)
    const remotes = new Map<string, ScriptedRemote>([['far-0', far]])
    const link = makeScriptedLink({ home: far.home, remotes })
    try {
      const session = await link.pair({ address: 'far-0', tade: 'tade', label: 'mac' })
      link.open({ name: 'ipax', address: 'far-0', tade: 'tade', session })
      const deadline = Date.now() + 20_000
      while (link.held('ipax')?.link.kind !== 'live' || link.held('ipax')?.projection == null) {
        if (Date.now() > deadline) throw new Error('the link to ipax never came up')
        link.beat(Date.now())
        await new Promise((done) => setTimeout(done, 25))
      }
      const ask: SideAsk = {
        project: place.project,
        agent: place.agent ?? null,
        expanded: [],
        files: true,
      }
      const answer = await link.request('ipax', '/api/side', ask)
      expect(answer.status).toBe(200)
      const there = sideThere(SideAnswerSchema.parse(answer.body))
      const held = link.held('ipax')
      if (held === null) throw new Error('nothing held for ipax')
      // A window of its own here, with a project of its own, standing in `checkout` there.
      const mine = withTasks(withProjects(initialState(), ['hello']), [
        { task: 'hello/greeting', state: 'working', lane: 'hello/greeting/agent' },
      ])
      const state = {
        ...goElsewhere({ ...mine, folded: here.state.folded, opened: here.state.opened }, place),
        terminals: [{ id: LANE, project: '', name: 'ipax · stripe-v15', agentThere: true }],
      } as AppState
      return {
        state,
        frame: {
          ...here.frame,
          // None of this window's own: standing there, the side is that machine's.
          files: [],
          changes: [],
          notes: [],
          retiredNotes: [],
          schedules: [],
          intake: [],
          where: null,
          route: { harness: 'claude-code', model: 'elsewhere', provider: null },
          vitals: null,
          offers: null,
          machines: { here: 'this Mac', remotes: [machineOf(held, 0)] },
          side: { machine: 'ipax', project: 'checkout', there, said: null },
        },
      }
    } finally {
      await link.shutdown()
    }
  }

  it('draws an agent there exactly as the agent here: the side, its header, its lane', async () => {
    const here = local()
    const place: Place = {
      machine: 'ipax',
      project: 'checkout',
      agent: 'checkout/stripe-v15',
      lane: LANE,
    }
    const there = await throughTheLink(here, place)
    const ours = draw(here.state, here.frame)
    const theirs = draw(there.state, there.frame)
    // Below the tabs, nothing differs: not a section, not a count, not a control.
    expect(theirs.rows.slice(1)).toEqual(ours.rows.slice(1))
    const text = theirs.rows.join('\n')
    for (const heading of [
      'AGENTS',
      'SMART QUEUE',
      'SCHEDULES',
      'INTAKE',
      'CHANGES',
      'FILES',
      'NOTES',
      'RETIRED NOTES',
      'GIT',
    ]) {
      expect(text, heading).toContain(heading)
    }
    expect(text).toContain('checkout › stripe-v15')
    expect(text).toContain('pi ▾')
    expect(text).toContain('high ▾')
    expect(text).toContain('41%')
    // What a press on it is for is that machine's.
    const pressed = theirs.hits.map((hit) => hit.target)
    const task = (target: Target) => (target.kind === 'task' ? target.task : null)
    expect(pressed.map(task).filter((one) => one !== null)).toContain(
      '@ipax\u001fcheckout/stripe-v15',
    )
    const closes = pressed.flatMap((target) =>
      target.kind === 'action' && target.name.startsWith('close-task:') ? [target.name] : [],
    )
    expect(closes.length).toBeGreaterThan(0)
    for (const one of closes) expect(refOf(one.slice('close-task:'.length)).machine).toBe('ipax')
    expect(pressed).toContainEqual({ kind: 'action', name: 'model:@ipax\u001fcheckout/stripe-v15' })
  }, 30_000)

  it('draws the project there with no agent in front exactly as the project here', async () => {
    const here = local()
    const none = { ...here, state: { ...here.state, focused: null } as AppState }
    const there = await throughTheLink(none, { machine: 'ipax', project: 'checkout' })
    expect(draw(there.state, there.frame).rows.slice(1)).toEqual(
      draw(none.state, none.frame).rows.slice(1),
    )
  }, 30_000)
})
