import { type InboxRow, inboxProvenance } from '@tade/core'
import { heldFor } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import type { Frame, IntakeOpenView } from '../src/frame.ts'
import { goElsewhere, machineOf, screenOf } from '../src/machines.ts'
import {
  focusTask,
  initialState,
  toggleSection,
  viewActions,
  withProjects,
  withTasks,
} from '../src/model.ts'
import { extensionViewPanel } from '../src/panels/extensions/setup.ts'
import { extensionsPanel } from '../src/panels/extensions/state.ts'
import { intakePanel } from '../src/panels/intake/state.ts'
import { notePanel } from '../src/panels/small/state.ts'
import { rowSummaryPanel } from '../src/panels/summary/state.ts'
import { windowTitle } from '../src/title.ts'
import {
  deviceSaid,
  emptyTranscript,
  fromThinker,
  problem,
  suggest,
  tadeDid,
  thinking,
  youSaid,
} from '../src/transcript.ts'
import { listsShown, summaryShown } from '../src/wire/rows.ts'
import { expectOnlyText, hostile, notText, see } from './outside-text.ts'
import { base, NOW } from './screens/scenarios/fixtures.ts'

// Text that arrives from outside, drawn as text: a ticket, an agent's own words,
// the conversation, what an extension keeps and says, and a note. The shared
// hostile string and the screen check are in `outside-text.ts`.

describe('intake, which is a stranger’s words from end to end', () => {
  const row = (over: Partial<InboxRow> = {}): InboxRow => ({
    item: 'github:acme/web#7',
    source: 'github',
    externalId: hostile('req7'),
    requester: hostile('mallory'),
    project: 'checkout',
    grant: 'surfaces.intake.sources.github',
    said: [],
    unsent: [{ saying: 'started', attempts: 2, problem: hostile('replyfailed') }],
    template: null,
    revision: hostile('rev2'),
    taken: '1',
    hash: 'sha256:9f2c',
    ref: hostile('nodeid'),
    url: `https://example.invalid/${hostile('page')}`,
    watch: 'intake.github',
    schedule: 'intake-github',
    mode: 'propose',
    tasks: [],
    work: [],
    state: 'failure',
    because: `carrying ${hostile('req7')} out failed: ${hostile('gone')}`,
    attempts: 3,
    tries: 3,
    replies: 0,
    at: NOW - 4 * 60_000,
    ...over,
  })

  it('draws the rows down the side as text', () => {
    expectOnlyText(see(base(), { intake: [row()] }), 'req7', 'mallory')
  })

  it('draws the page a row opens as text: the id, the facts, the reasons and the body', () => {
    const shown = row()
    const opened = (would: IntakeOpenView['would']): Partial<Frame> => ({
      intake: [shown],
      panel: {
        intake: {
          row: shown,
          facts: inboxProvenance(shown),
          material: {
            ref: shown.ref,
            hash: shown.hash,
            where: hostile('wherefile'),
            heading: 'What follows came from outside this machine.',
            body: `first ${hostile('para')}\n\n${hostile('second')} line\r\n\tindented ${hostile('third')}`,
            problem: null,
          },
          would,
          acts: [
            { act: 'approve', off: null },
            { act: 'refuse', off: null },
          ],
        },
      },
    })
    const page = {
      ...base(),
      panel: { ...intakePanel(shown.item, hostile('title')), said: hostile('saidback') },
    }
    const would = {
      row: shown,
      starts: [
        {
          task: 'checkout/github-req7',
          project: 'checkout',
          workspace: 'worktree' as const,
          done: 'said' as const,
          produces: null,
          touches: [],
          after: [{ task: 'checkout/first', why: hostile('becausewhy') }],
          parked: true,
        },
      ],
      grant: [hostile('grantline')],
      limits: [hostile('limitline')],
      problems: [],
      warnings: [hostile('warnline')],
    }
    expectOnlyText(
      see(page, { ...opened(would), height: 120 }),
      'req7',
      'mallory',
      'replyfailed',
      'nodeid',
      'wherefile',
      'para',
      'second',
      'third',
      'becausewhy',
      'grantline',
      'limitline',
      'warnline',
      'saidback',
    )
    expectOnlyText(
      see(page, { ...opened({ ...would, problems: [hostile('planproblem')] }), height: 120 }),
      'planproblem',
    )
  })
})

describe('an agent’s own words', () => {
  const agents = () =>
    focusTask(
      withTasks(withProjects(initialState(), ['checkout']), [
        {
          task: 'checkout/stripe-v15',
          state: 'blocked',
          lane: 'checkout/stripe-v15/agent',
          waiting: true,
          title: hostile('stripetitle'),
          approval: { tool: hostile('bash'), summary: hostile('npmi') },
        },
        {
          task: 'checkout/refunds',
          state: 'working',
          lane: 'checkout/refunds/agent',
          title: hostile('refundstitle'),
          reason: hostile('editing'),
        },
        {
          task: 'checkout/emails',
          state: 'review',
          finished: { by: 'agent', summary: hostile('summarised') },
        },
      ]),
      'checkout/stripe-v15',
    )

  it('draws its title and what it is doing as text, in the side and over its pane', () => {
    expectOnlyText(see(agents()), 'stripetitle', 'npmi', 'refundstitle', 'editing', 'summarised')
  })

  it('never puts an escape in the terminal’s own title', () => {
    const title = windowTitle({
      working: 1,
      waiting: 0,
      failed: 0,
      agents: 1,
      orchestrator: 'quiet',
      where: `checkout › ${hostile('stripetitle')}`,
      now: NOW,
      looking: false,
    })
    expect(notText(title)).toEqual([])
    expect(title).toContain('stripetitle')
  })
})

describe('the conversation', () => {
  it('draws what was said, what ran and what failed as text', () => {
    const transcript = [
      (t: ReturnType<typeof emptyTranscript>) =>
        youSaid(t, hostile('mywords'), 0, [`/tmp/${hostile('shot')}.png`]),
      (t: ReturnType<typeof emptyTranscript>) =>
        deviceSaid(t, hostile('phonewords'), 0, hostile('phone')),
      (t: ReturnType<typeof emptyTranscript>) => thinking(t, 0),
      (t: ReturnType<typeof emptyTranscript>) =>
        fromThinker(
          t,
          { type: 'tool', id: '1', tool: hostile('tooly'), input: { ticket: hostile('arg') } },
          1,
        ),
      (t: ReturnType<typeof emptyTranscript>) =>
        fromThinker(t, { type: 'tool_done', id: '1', ok: true, text: hostile('toolresult') }, 2),
      (t: ReturnType<typeof emptyTranscript>) =>
        fromThinker(t, { type: 'tool', id: '2', tool: 'tade_status', input: {} }, 3),
      (t: ReturnType<typeof emptyTranscript>) =>
        fromThinker(t, { type: 'tool_done', id: '2', ok: false, text: hostile('toolfailed') }, 4),
      (t: ReturnType<typeof emptyTranscript>) =>
        fromThinker(
          t,
          { type: 'delta', text: `An **answer** ${hostile('answered')}\n\n- ${hostile('listed')}` },
          5,
        ),
      (t: ReturnType<typeof emptyTranscript>) => tadeDid(t, hostile('tadenotice'), 6),
      (t: ReturnType<typeof emptyTranscript>) => problem(t, hostile('itbroke'), 7),
      (t: ReturnType<typeof emptyTranscript>) => suggest(t, hostile('suggested'), 'why', 8),
    ].reduce((t, step) => step(t), emptyTranscript())
    const state = {
      ...focusTask(base(), 'checkout/refunds'),
      sizes: { stripHeight: 40 },
      transcript,
    }
    expectOnlyText(
      see(state, { screen: '', height: 80 }),
      'mywords',
      'shot',
      'phonewords',
      'tooly',
      'arg',
      'toolresult',
      'toolfailed',
      'answered',
      'listed',
      'tadenotice',
      'itbroke',
      'suggested',
    )
  })
})

describe('what an extension keeps and says', () => {
  /** A review, or a Sentry issue: a row whose every word is the forge's or the tracker's. */
  const lists = () =>
    listsShown([
      {
        id: 'review.open',
        extension: 'review',
        title: hostile('REVIEWS'),
        filters: [],
        filter: 'open',
        problem: null,
        summarises: true,
        at: NOW,
        rows: [
          {
            id: 'github.com/acme/checkout#418',
            label: hostile('#418'),
            title: hostile('prtitle'),
            note: hostile('acme'),
            marks: [{ text: hostile('draft'), tone: 'quiet' }],
            figures: [{ text: hostile('checkname'), tone: 'bad' }],
            age: { since: NOW - 3_600_000, says: hostile('open') },
            links: [{ title: hostile('linktitle'), url: 'https://example.invalid/418' }],
            task: 'checkout/stripe-v15',
          },
        ],
      },
      {
        id: 'sentry.issues',
        extension: 'sentry',
        title: 'SENTRY',
        filters: [],
        filter: 'new',
        problem: hostile('sentrydown'),
        summarises: false,
        at: NOW,
        rows: [],
      },
    ])

  it('draws a list’s rows as text, down the side and on the ACTIONS page', () => {
    for (const shown of [lists()]) {
      expectOnlyText(see(base(), { lists: shown }), 'prtitle', '#418', 'draft', 'checkname')
      expectOnlyText(see(viewActions(base(), 'checkout/stripe-v15'), { lists: shown }), 'prtitle')
    }
  })

  it('draws one row in full as text', () => {
    const summary = summaryShown({
      title: hostile('summarytitle'),
      marks: [{ text: hostile('markone'), tone: 'bad' }],
      groups: [
        {
          label: hostile('CHECKS'),
          note: hostile('groupnote'),
          marks: [{ text: hostile('checkmark') }],
        },
      ],
      facts: [{ label: hostile('factlabel'), value: hostile('factvalue') }],
      links: [{ title: 'pr', url: `https://example.invalid/${hostile('418')}` }],
    })
    const state = {
      ...base(),
      panel: {
        ...rowSummaryPanel('review.open', '418', hostile('asked'), 'https://example.invalid/418'),
        busy: false,
      },
    }
    expectOnlyText(
      see(state, { panel: { summary } }),
      'summarytitle',
      'markone',
      'CHECKS',
      'groupnote',
      'checkmark',
      'factlabel',
      'factvalue',
    )
    expectOnlyText(
      see({ ...state, panel: { ...state.panel, problem: hostile('noanswer') } }),
      'noanswer',
    )
  })

  it('draws a tool server’s page as text: its description, its tools, what went wrong', () => {
    const server = {
      name: 'mcp-evil',
      title: hostile('Evil'),
      description: hostile('describes itself'),
      workflow: [hostile('workflowline')],
      source: 'mcp' as const,
      state: 'needs setup' as const,
      problem: hostile('startfailed'),
      tools: [
        {
          name: 'mcp_evil_read',
          summary: hostile('toolsummary'),
          for: ['agent', 'orchestrator'] as const,
        },
      ],
      actions: [],
      options: [
        {
          key: 'key',
          label: hostile('optlabel'),
          value: hostile('optvalue'),
          have: '',
          secret: false,
        },
      ],
      unknownSettings: [],
      configurable: true,
      folder: null,
      watches: [],
      server: {
        name: 'evil',
        how: hostile('https://evil.invalid/mcp'),
        on: true,
        decided: true,
        install: null,
        note: hostile('servernote'),
        asked: null,
        dropped: [{ name: 'mcp_evil_write', why: hostile('droppedwhy') }],
        fetches: false,
        theirs: { mcp_evil_read: hostile('theirname') },
      },
    }
    const facts = { extensions: [server], written: [], harnessExtensions: [], servers: [] }
    expectOnlyText(
      see({ ...base(), panel: extensionsPanel('mcp-evil') }, { panel: facts, height: 80 }),
      'Evil',
      'describes itself',
      'workflowline',
      'startfailed',
      'toolsummary',
      'theirname',
      'optlabel',
      'optvalue',
      'servernote',
      'droppedwhy',
    )
  })

  it('draws a page an extension writes as text', () => {
    const page = {
      title: hostile('Jev'),
      markdown: `# ${hostile('heading')}\n\n${hostile('paragraph')}\n\n\t${hostile('indented')}\n`,
      tabs: [{ id: 'all', title: hostile('tabname') }],
      windowed: false,
    }
    expectOnlyText(
      see({ ...base(), panel: extensionViewPanel('jev') }, { panel: { extensionView: page } }),
      'Jev',
      'heading',
      'paragraph',
      'indented',
      'tabname',
    )
  })
})

describe('notes, which are kept word for word', () => {
  const note = {
    text: hostile('rotates on the first'),
    summary: hostile('Staging key'),
    at: '2026-09-01T09:00:00.000Z',
    scope: 'checkout',
    by: 'orchestrator' as const,
  }

  it('draws them as text down the side, and opened', () => {
    const side = toggleSection(base(), 'notes')
    expectOnlyText(see(side, { notes: [note] }), 'Staging key', 'rotates on the first')
    expectOnlyText(
      see({ ...base(), panel: { ...notePanel(note, note.text), error: hostile('nosave') } }),
      'Staging key',
      'rotates on the first',
      'nosave',
    )
  })
})

describe('an agent on another machine, opened here', () => {
  it('draws its title, what it is doing, what it waits on and its screen there as text', () => {
    const held = {
      ...heldFor('vps'),
      link: { kind: 'live' as const, since: NOW },
      heardAt: NOW,
      projection: {
        v: 1,
        fresh: { at: new Date(NOW).toISOString(), epoch: 'e1', rev: 3 },
        projects: [{ name: 'tade', open: true }],
        tasks: [
          {
            id: 'tade/door',
            project: 'tade',
            name: 'door',
            mark: 'needs-you',
            reason: hostile('waitsthere'),
            title: { words: hostile('doortitle'), more: false },
            rev: 'r1',
            lane: 'running',
            approval: { id: 'call-1', tool: hostile('ghapi') },
            can: [{ verb: 'answer' }],
          },
        ],
        queue: [],
      } as never,
    }
    const machines = { here: 'this Mac', remotes: [machineOf(held, 0)] }
    const remoteScreen = screenOf(
      'tade/door',
      { screen: { lines: [hostile('screenrow')], at: new Date(NOW).toISOString(), above: 0 } },
      0,
    )
    const looking = goElsewhere(withProjects(initialState(), ['checkout']), {
      machine: 'vps',
      project: 'tade',
      agent: 'tade/door',
    })
    expectOnlyText(
      see(looking, { machines, remoteScreen }),
      'doortitle',
      'waitsthere',
      'ghapi',
      'screenrow',
    )
  })
})
