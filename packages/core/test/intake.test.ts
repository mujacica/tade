import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/config.ts'
import type { TadeEvent } from '../src/events.ts'
import {
  INTAKE_SOURCES,
  type Intake,
  type IntakeCandidate,
  type IntakeGrantRead,
  type IntakeSaid,
  intakeContext,
  intakeDecision,
  intakeInputs,
  intakeItem,
  intakeKey,
  intakeMapped,
  intakePrompt,
  intakeSuffix,
  intakeSummary,
  newerRevision,
} from '../src/intake.ts'
import {
  INTAKE_ATTEMPTS,
  INTAKE_REPLY_CAP,
  intakeAgain,
  intakeFrom,
  intakeNext,
  intakeOf,
  intakeRepliesLeft,
} from '../src/intake-journal.ts'
import { namedBy, settingReach } from '../src/reach.ts'
import { settingsOf } from '../src/settings.ts'
import type { Template } from '../src/templates.ts'

// The rules that decide what an outside request may do here, against the cases
// they exist for. Pure: no filesystem, no clock, no window.

const grant = (over: Partial<IntakeGrantRead> = {}): IntakeGrantRead => ({
  path: 'surfaces.intake.sources.cli',
  on: true,
  accept: true,
  reply: false,
  projects: ['app'],
  from: ['kim'],
  mode: 'propose',
  template: '',
  document: '',
  ...over,
})

const candidate = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  source: 'cli',
  externalId: 'req-1',
  revision: '1',
  url: '',
  requester: { id: 'kim', label: 'Kim', bot: false },
  from: 'app',
  verbatim: 'the export button 500s when the selection is empty',
  material: { ref: 'req-1.0001.json', hash: 'sha256:aaa' },
  attachments: [],
  sourceAt: '2026-10-09T00:00:00.000Z',
  seenAt: '2026-10-09T00:01:00.000Z',
  correlation: 'req-1-1',
  ...over,
})

const envelope = (over: Partial<Intake> = {}): Intake => {
  const { from, ...rest } = candidate()
  return {
    ...rest,
    project: 'app',
    mapping: { from, by: 'surfaces.intake.sources.cli.projects' },
    grant: 'surfaces.intake.sources.cli',
    ...over,
  }
}

const event = (
  type: TadeEvent['type'],
  detail: Record<string, unknown>,
  over: Partial<TadeEvent> = {},
): TadeEvent => ({
  seq: 1,
  ts: '2026-10-09T00:00:00.000Z',
  type,
  urgency: 'notable',
  task: null,
  lane: null,
  run: null,
  detail,
  ...over,
})

describe('whether an outside request may make work here', () => {
  it('is decided by the owner’s grant, and names the key that decided it', () => {
    const one = grant()
    const decision = intakeDecision(candidate(), one, intakeMapped('app', one))
    expect(decision).toEqual({
      outcome: 'accepted',
      granted: { grant: 'surfaces.intake.sources.cli', mode: 'propose', template: '' },
    })
  })

  it('is ignored, and not written down, where nothing maps it to a project', () => {
    const one = grant({ projects: [] })
    // Deliberately not a refusal: a line per unaddressed issue per poll fills
    // the journal with the world, and the look's own counts already say how
    // much it saw.
    expect(intakeDecision(candidate(), one, intakeMapped('app', one))).toMatchObject({
      outcome: 'ignored',
    })
  })

  it('is ignored while the surface is off, whatever a source says', () => {
    const one = grant({ on: false })
    expect(intakeDecision(candidate(), one, intakeMapped('app', one)).outcome).toBe('ignored')
  })

  it('refuses a requester the owner never listed, and says which key to add them to', () => {
    const one = grant({ from: [] })
    const decision = intakeDecision(candidate(), one, intakeMapped('app', one))
    expect(decision).toMatchObject({ outcome: 'refused', why: 'not_allowed' })
    expect(decision.outcome === 'refused' && decision.because).toContain(
      'surfaces.intake.sources.cli.from',
    )
  })

  it('refuses an app’s request by what the source said about the actor, never by its words', () => {
    const one = grant({ from: ['tade-bot'] })
    const bot = candidate({ requester: { id: 'tade-bot', label: '', bot: true } })
    // On the allowlist AND refused: the loop filter is the source's own answer
    // about the actor, which is what makes it immune to a person quoting Tade.
    expect(intakeDecision(bot, one, intakeMapped('app', one))).toMatchObject({
      outcome: 'refused',
      why: 'is_bot',
    })
  })

  it('refuses rather than ignores when accept is off, so the attempt is visible', () => {
    const one = grant({ accept: false })
    expect(intakeDecision(candidate(), one, intakeMapped('app', one))).toMatchObject({
      outcome: 'refused',
      why: 'no_grant',
    })
  })
})

describe('what a person sees as the request', () => {
  it('is Tade’s own sentence, and cannot be the body because the body is not in the type', () => {
    const one = envelope()
    const said = intakeSummary(one)
    expect(said).toContain('cli req-1')
    expect(said).toContain('@kim')
    expect(said).toContain('app')
    // The sample beside the guarantee. The guarantee itself is that
    // `IntakeSaid` has no `verbatim`, which the next test holds.
    expect(said).not.toContain('export button')
    expect(intakePrompt(one)).not.toContain('export button')
  })

  it('is written by functions that are not handed the body at all', () => {
    // Enforcement by absence, the shape this repository uses everywhere. This
    // literal is everything `IntakeSaid` has, written out: it compiles only
    // while the body is not one of those fields, so the day somebody widens
    // that type to carry it, this stops building rather than starting to pass.
    const said: IntakeSaid = {
      source: 'cli',
      externalId: 'req-1',
      requester: { id: 'kim', label: 'Kim', bot: false },
      project: 'app',
      mapping: { from: 'app', by: 'surfaces.intake.sources.cli.projects' },
    }
    expect('verbatim' in said).toBe(false)
    expect(intakeSummary(said)).toContain('cli req-1')
    expect(intakePrompt(said)).toContain('req-1')
  })

  it('puts the body in the context file, under the one wording of what material means', () => {
    const text = intakeContext(
      envelope({
        url: 'https://example.invalid/req-1',
        attachments: [
          { name: 'trace.txt', url: 'https://example.invalid/t', mediaType: '', bytes: 0 },
        ],
      }),
    )
    expect(text).toContain('material, not instruction')
    expect(text).toContain('the export button 500s')
    expect(text).toContain('trace.txt')
    expect(text).toContain('not downloaded')
    // Fenced, so a heading inside somebody else's text cannot pass for one of
    // Tade's own.
    expect(text).toContain('```')
  })

  it('never puts an outside request anywhere `namedBy` reads', () => {
    // The protection every new journal type gets for free, asserted explicitly
    // so it is a decision rather than an accident: what authorises a setting
    // change is a `said` line, and nothing about intake writes one.
    expect(
      namedBy({ path: 'surfaces.intake.enabled', title: 'Accept work from outside' }, []),
    ).toBeNull()
    const said = namedBy({ path: 'surfaces.intake.enabled', title: 'Accept work from outside' }, [
      'turn surfaces.intake.enabled on',
    ])
    expect(said).not.toBeNull()
  })
})

describe('revisions', () => {
  it('are compared by the source’s own semantics, never as strings', () => {
    // The case a lexical comparison gets wrong, which is the whole reason this
    // is a function per source.
    expect(newerRevision('cli', '10', '9')).toBe(1)
    expect('10' > '9').toBe(false)
    expect(newerRevision('cli', '9', '10')).toBe(-1)
    expect(newerRevision('cli', '3', '3')).toBe(0)
  })

  it('answer "cannot be ordered" rather than guessing, for anything that is not one', () => {
    expect(newerRevision('cli', 'abc', '1')).toBeNull()
    expect(newerRevision('cli', '1', '')).toBeNull()
  })

  it('make an edit update what exists rather than spawn a second workflow', () => {
    const items = intakeFrom([
      event('intake_received', {
        item: 'cli:req-1',
        source: 'cli',
        external_id: 'req-1',
        revision: '1',
      }),
      event(
        'intake_accepted',
        {
          item: 'cli:req-1',
          source: 'cli',
          external_id: 'req-1',
          revision: '1',
          mode: 'propose',
          hash: 'sha256:aaa',
        },
        { task: 'app/cli-req-1', seq: 2 },
      ),
    ])
    const one = items.get('cli:req-1')
    expect(one?.tasks).toEqual(['app/cli-req-1'])
    const again = intakeAgain(one as never, {
      source: 'cli',
      revision: '2',
      material: { hash: 'sha256:bbb' },
    })
    expect(again.again).toBe('invalidate')
    expect(again.because).toContain('its text has changed')
  })

  it('ignore a comment on something already taken, and an older revision', () => {
    const items = intakeFrom([
      event(
        'intake_accepted',
        { item: 'cli:req-1', source: 'cli', external_id: 'req-1', revision: '3', mode: 'propose' },
        { task: 'app/cli-req-1' },
      ),
    ])
    const one = items.get('cli:req-1') as never
    expect(intakeAgain(one, { source: 'cli', revision: '3', material: { hash: '' } }).again).toBe(
      'ignore',
    )
    expect(intakeAgain(one, { source: 'cli', revision: '2', material: { hash: '' } }).again).toBe(
      'ignore',
    )
  })

  it('hold rather than assume an order nobody can work out', () => {
    const items = intakeFrom([
      event(
        'intake_accepted',
        {
          item: 'cli:req-1',
          source: 'cli',
          external_id: 'req-1',
          revision: 'first',
          mode: 'propose',
        },
        { task: 'app/cli-req-1' },
      ),
    ])
    const again = intakeAgain(items.get('cli:req-1') as never, {
      source: 'cli',
      revision: 'second',
      material: { hash: '' },
    })
    expect(again.again).toBe('hold')
    expect(again.because).toContain('somebody has to say')
  })
})

describe('the keys', () => {
  it('tell one revision apart from the thing itself', () => {
    expect(intakeKey({ source: 'cli', externalId: 'req-1', revision: '2' })).toBe('cli:req-1:2')
    // The item key carries no revision, which is what makes a retry find the
    // same request rather than a new one.
    expect(intakeItem({ source: 'cli', externalId: 'req-1' })).toBe('cli:req-1')
  })

  it('make a task name that a second attempt asks for again', () => {
    const name = intakeSuffix({ source: 'cli', externalId: 'REQ/1 fix' })
    expect(name).toBe(intakeSuffix({ source: 'cli', externalId: 'REQ/1 fix' }))
    expect(name).toMatch(/^[a-z0-9-]+$/)
  })
})

describe('trying again', () => {
  const held = (attempts: number, failedAt: number, gaveUp = false) =>
    intakeFrom(
      Array.from({ length: attempts }, (_, n) =>
        event(
          'intake_held',
          {
            item: 'cli:req-1',
            source: 'cli',
            external_id: 'req-1',
            problem: 'disk full',
            ...(gaveUp && n === attempts - 1 ? { gave_up: true } : {}),
          },
          { seq: n + 1, ts: new Date(failedAt).toISOString() },
        ),
      ),
    ).get('cli:req-1')

  it('tries a first delivery at once', () => {
    expect(intakeNext(undefined, 1_000_000)).toEqual({ next: 'retry', attempt: 1 })
  })

  it('waits before trying the same thing again, so a failing source is not hammered', () => {
    const one = held(1, 1_000_000)
    // Ten milliseconds after it failed: the same request, the same failure, and
    // nothing has changed in between.
    expect(intakeNext(one, 1_000_010).next).toBe('wait')
    expect(intakeNext(one, 1_000_000 + 60_001)).toEqual({ next: 'retry', attempt: 2 })
  })

  it('stops, and says so, rather than retrying for ever', () => {
    const next = intakeNext(held(INTAKE_ATTEMPTS, 1_000_000), 9_000_000)
    expect(next.next).toBe('give up')
    expect(next.next === 'give up' && next.because).toContain('disk full')
  })

  it('stays given up once it has given up', () => {
    expect(intakeNext(held(1, 1_000_000, true), 9_000_000).next).toBe('give up')
  })

  it('tries again rather than waiting for ever when the clock has moved backwards', () => {
    // A failure stamped later than now: the machine's clock changed, and the
    // one reading of that which does not strand the request is to try it.
    expect(intakeNext(held(1, 9_000_000), 1_000_000).next).toBe('retry')
  })

  it('forgets the failures once a delivery is carried out', () => {
    const items = intakeFrom([
      event('intake_held', {
        item: 'cli:req-1',
        source: 'cli',
        external_id: 'req-1',
        problem: 'disk full',
      }),
      event(
        'intake_accepted',
        { item: 'cli:req-1', source: 'cli', external_id: 'req-1', revision: '1', mode: 'propose' },
        { task: 'app/cli-req-1', seq: 2 },
      ),
    ])
    expect(items.get('cli:req-1')?.attempts).toBe(0)
    expect(intakeNext(items.get('cli:req-1'), 1).next).toBe('retry')
  })
})

describe('what the journal says about a delivery', () => {
  it('reads an interrupted one as received with nothing made', () => {
    // The crash window, as the fold sees it: a window that died between making
    // the work and writing down that it had.
    const items = intakeFrom([
      event('intake_received', {
        item: 'cli:req-1',
        source: 'cli',
        external_id: 'req-1',
        revision: '1',
      }),
    ])
    const one = items.get('cli:req-1')
    expect(one?.state).toBe('received')
    expect(one?.tasks).toEqual([])
  })

  it('finds which request a task belongs to, and answers null for everything else', () => {
    const items = intakeFrom([
      event(
        'intake_accepted',
        {
          item: 'cli:req-1',
          source: 'cli',
          external_id: 'req-1',
          revision: '1',
          mode: 'queue',
          tasks: ['app/b'],
        },
        { task: 'app/a' },
      ),
    ])
    expect(intakeOf(items, 'app/b')?.item).toBe('cli:req-1')
    expect(intakeOf(items, 'app/not-intake')).toBeNull()
  })

  it('folds to nothing over a journal written before intake existed', () => {
    expect(
      intakeFrom([
        event('task_created', { intent_spoken: 'do a thing' }, { task: 'app/a' }),
        event('watch_found', { schedule: 'sentry.new-errors', key: 'TADE-1' }),
      ]).size,
    ).toBe(0)
  })

  it('caps what may be said back, counted over a day', () => {
    const replies = Array.from({ length: INTAKE_REPLY_CAP }, (_, n) =>
      event(
        'intake_replied',
        { item: 'cli:req-1', source: 'cli', external_id: 'req-1' },
        { seq: n + 1, ts: new Date(1_000_000_000).toISOString() },
      ),
    )
    const items = intakeFrom(replies)
    expect(intakeRepliesLeft(items.get('cli:req-1'), 1_000_000_000)).toBe(0)
    // And a day later it is a day later.
    expect(intakeRepliesLeft(items.get('cli:req-1'), 1_000_000_000 + 25 * 3_600_000)).toBe(
      INTAKE_REPLY_CAP,
    )
  })
})

describe('a template filled from a request', () => {
  const template = (over: Partial<Template> = {}): Template => ({
    template: 'bug',
    version: 2,
    title: 'A bug',
    about: '',
    project_input: 'project',
    said_input: 'request',
    name_suffix: 'slug',
    inputs: {
      project: { kind: 'project', about: '', required: true },
      request: { kind: 'text', about: '', required: true },
      slug: { kind: 'slug', about: '', required: true },
      body: { kind: 'document', about: '', required: true },
    },
    agents: [],
    ...over,
  })

  it('puts Tade’s sentence in the said input and the body in the document', () => {
    const filled = intakeInputs(envelope({ template: { name: 'bug', version: 2 } }), template())
    expect('ok' in filled && filled.inputs.request).toContain('bug@2')
    expect('ok' in filled && filled.inputs.request).not.toContain('export button')
    expect('ok' in filled && filled.inputs.body).toBe(
      'the export button 500s when the selection is empty',
    )
    expect('ok' in filled && filled.inputs.project).toBe('app')
  })

  it('is refused, naming the input, rather than stamped with an empty string', () => {
    const asks = template({
      inputs: { ...template().inputs, severity: { kind: 'text', about: '', required: true } },
    })
    const filled = intakeInputs(envelope(), asks)
    expect('problem' in filled && filled.problem).toContain('severity')
    expect('problem' in filled && filled.problem).toContain('refused')
  })

  it('fills the one document a template requires, and leaves an optional one out', () => {
    const asks = template({
      inputs: {
        ...template().inputs,
        body: { kind: 'document', about: '', required: true },
        extra: { kind: 'document', about: '', required: false },
      },
    })
    const filled = intakeInputs(envelope(), asks)
    expect('ok' in filled && filled.inputs.body).toContain('export button')
    // Left out rather than stamped with an empty string: `fillTemplate`'s own
    // answer for an input nobody filled in.
    expect('ok' in filled && 'extra' in filled.inputs).toBe(false)
  })

  it('asks the grant which document, where a template leaves the choice open', () => {
    const asks = template({
      inputs: {
        ...template().inputs,
        body: { kind: 'document', about: '', required: false },
        extra: { kind: 'document', about: '', required: false },
      },
    })
    // Never by declaration order, which is a rule that is right until somebody
    // reorders a file: the candidates are named and a person says which.
    const open = intakeInputs(envelope(), asks)
    expect('problem' in open && open.problem).toContain('say which takes it')
    expect('problem' in open && open.problem).toContain('extra')
    const said = intakeInputs(envelope(), asks, 'extra')
    expect('ok' in said && said.inputs.extra).toContain('export button')
    expect('ok' in said && 'body' in said.inputs).toBe(false)
  })

  it('refuses a document the grant names and the template does not have', () => {
    const named = intakeInputs(envelope(), template(), 'nowhere')
    expect('problem' in named && named.problem).toContain('"nowhere"')
    expect('problem' in named && named.problem).toContain('body')
  })

  it('leaves an optional input it cannot fill out, and refuses a required one', () => {
    const optional = template({
      inputs: { ...template().inputs, severity: { kind: 'text', about: '', required: false } },
    })
    expect(intakeInputs(envelope(), optional)).toMatchObject({ ok: true })
  })
})

describe('the shape of the settings', () => {
  const paths = (): string[] =>
    settingsOf(ConfigSchema.parse({}))
      .flatMap((group) => group.settings)
      .map((setting) => setting.path)
      .filter((path) => path.startsWith('surfaces.intake'))

  it('puts every key under surfaces.intake out of the orchestrator’s reach', () => {
    // Table-tested over every key the schema actually produces, so a key added
    // next month is refused on the day it is added rather than when somebody
    // remembers to think about it.
    const found = paths()
    expect(found.length).toBeGreaterThan(0)
    for (const path of found) expect(settingReach(path).reach).toBe('never')
    // And the subtree, so a key nothing offers yet is refused too.
    expect(settingReach('surfaces.intake.sources.cli.something-new').reach).toBe('never')
  })

  it('takes no path, file, directory, command or prompt from anybody', () => {
    // Enforcement by absence: there is no route that takes a path, so there is
    // nothing to contain and no sanitiser to get wrong.
    const parsed = ConfigSchema.parse({})
    const keys = JSON.stringify(parsed.surfaces.intake)
    for (const forbidden of ['path', 'file', 'dir', 'root', 'command', 'prompt']) {
      expect(keys).not.toContain(`"${forbidden}"`)
    }
  })

  it('is off, lists nobody, and proposes rather than queues, with nothing set', () => {
    const intake = ConfigSchema.parse({}).surfaces.intake
    expect(intake.enabled).toBe(false)
    for (const source of INTAKE_SOURCES) {
      expect(intake.sources[source]).toMatchObject({
        accept: false,
        reply: false,
        projects: [],
        from: [],
        mode: 'propose',
        template: '',
      })
    }
  })

  it('refuses a source nothing implements, rather than granting nothing quietly', () => {
    const read = ConfigSchema.safeParse({
      surfaces: { intake: { sources: { github: { accept: true } } } },
    })
    expect(read.success).toBe(false)
  })
})
