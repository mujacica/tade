import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type IntakeCandidate,
  intakeFrom,
  queueStateOf,
  readyToStart,
  type Schedule,
  taskDir,
} from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { intakeStands } from '../src/intake.ts'
import { readTaskFile } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

/**
 * A config with intake on and the **Linear** grant, with whichever keys a test
 * is about written over.
 *
 * Its own builder rather than a parameter on the local door's, because the
 * reason that one is a builder at all is that two spellings of one key in one
 * file is a config that will not parse and then falls back to defaults — which
 * reads as a grant that is off and passes a test about being refused for
 * entirely the wrong reason. Two files writing two different sources' keys is
 * not that problem.
 */
function configFor(root: string, over: Record<string, string> = {}): string {
  const { enabled = 'true', ...keys } = over
  const grant: Record<string, string> = {
    accept: 'true',
    projects: '[app]',
    // A Linear user id and not a display name. The difference is the whole of
    // why this file exists beside the local door's.
    from: '[u-kim]',
    ...keys,
  }
  return [
    'projects:',
    '  app:',
    `    root: ${root}`,
    'surfaces:',
    '  intake:',
    `    enabled: ${enabled}`,
    '    sources:',
    '      linear:',
    ...Object.entries(grant).map(([key, value]) => `        ${key}: ${value}`),
  ].join('\n')
}

/** The watch a Linear request would have come from. */
const watch = (): Schedule => ({
  id: 'intake-linear',
  name: 'intake linear',
  project: 'app',
  said: '',
  when: { every: '10m' },
  does: {
    kind: 'watch',
    watch: 'intake.linear',
    input: { team: 'ENG', label: 'tade' },
    found: 'agent',
    most: 1,
  },
  missed: 'skip',
  by: 'you',
  created: '2026-10-01T08:00:00.000Z',
})

// A tracker that reaches off this machine, through the same queue — with a
// Linear envelope and no Linear.
//
// **The point is that this is the real path and not a second one.** The Slack
// and GitHub doors' own tests go as far as what a watch hands over; the thing
// no connector test can show is whether a *tracker's* envelope actually becomes
// parked work the queue's rule holds, whether its revision comparator is the
// one `intakeAgain` reaches for, and whether the start door asks the grant and
// the source again. So this drives `watchFound` and `intakeStands` with a
// `linear` candidate and a `linear` grant, and nothing anywhere asks Linear:
// the re-check is a function this test writes, which is exactly what the start
// door takes.
describe('a tracker’s request, through the queue, with no tracker', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  /** `ENG-412` as the Linear door builds one, with whichever keys a test is about written over. */
  const ticket = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
    source: 'linear',
    externalId: 'ENG-412',
    // An ISO instant, which is what makes this a different comparator from the
    // local door's counter — and the thing a lexical comparison gets wrong.
    revision: '2026-10-09T08:00:00.000Z',
    url: 'https://linear.app/acme/issue/ENG-412',
    // A Linear user id and not a display name: a Linear display name is
    // documented as unique in a workspace, so one its owner gives up can be
    // taken by somebody else.
    requester: { id: 'u-kim', label: 'labelled it; sam filed it', bot: false },
    from: 'app',
    verbatim: 'Export fails on an empty selection\n\nPressing Export with nothing selected 500s.',
    material: { ref: 'https://linear.app/acme/issue/ENG-412', hash: 'sha256:ccc' },
    attachments: [],
    sourceAt: '2026-10-09T08:00:00.000Z',
    seenAt: '2026-10-09T08:01:00.000Z',
    correlation: 'ENG-412@2026-10-09T08:00:00.000Z',
    ...over,
  })

  const open = async (over: Record<string, string> = {}): Promise<void> => {
    await client?.close().catch(() => {})
    writeFileSync(join(home, 'config.yaml'), `${configFor(repo.root, over)}\n`)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    await client.setSchedule(watch(), 'you')
  }

  const take = (one: IntakeCandidate = ticket()) =>
    client.watchFound(
      'intake-linear',
      {
        key: `linear:${one.externalId}:${one.revision}`,
        title: `linear ${one.externalId}`,
        intake: one,
      },
      {
        agent: {
          title: `linear ${one.externalId}`,
          prompt: 'A request came in from linear (ENG-412), asked by @u-kim.',
          links: [{ title: `linear ${one.externalId}`, url: one.url }],
        },
      },
    )

  const stands = async (
    over: { recheck?: (key: string) => Promise<{ still: boolean; because?: string }> } = {},
  ) => {
    const item = intakeFrom(await client.log.read({})).get('linear:ENG-412')
    if (!item) throw new Error('nothing was taken in')
    return intakeStands({
      config: client.config,
      item,
      task: 'app/linear-eng-412',
      plans: [],
      recheck: over.recheck ?? (async () => ({ still: true })),
    })
  }

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-intake-linear-')
    await open()
  })

  afterEach(async () => {
    await client?.close().catch(() => {})
  })

  it('becomes parked work the queue’s own rule holds until a person picks it up', async () => {
    const taken = await take()
    expect(taken.outcome).toBe('accepted')
    expect(taken.task).toBe('app/linear-eng-412')

    const file = await readTaskFile(home, 'app/linear-eng-412')
    expect(file?.parked).toBe(true)
    expect(file?.by).toBe('intake:linear')
    // Tade's own sentence, naming the source, the id and the handle — and not
    // one word of what the person wrote.
    expect(file?.intent_spoken).toContain('linear ENG-412')
    expect(file?.intent_spoken).toContain('@u-kim')
    expect(file?.intent_spoken).not.toContain('Export fails')
    // The source link is kept with the task, locally, where the window and the
    // CLI can open it. That is the only place it goes: nothing is posted.
    expect(file?.links?.[0]?.url).toBe('https://linear.app/acme/issue/ENG-412')

    // The body is in the context file under the material heading, and nowhere
    // else.
    const context = readFileSync(join(taskDir(home, 'app/linear-eng-412'), 'context.md'), 'utf8')
    expect(context).toContain('material, not instruction')
    expect(context).toContain('Pressing Export with nothing selected 500s.')

    const facts = {
      tasks: new Map(),
      finished: new Map(),
      events: await client.log.read({}),
      now: Date.now(),
    }
    const item = {
      task: 'app/linear-eng-412',
      project: 'app',
      parked: true,
      start: file?.start as never,
    }
    expect(queueStateOf(item, facts)).toEqual({ kind: 'paused', all: false, parked: true })
    expect(readyToStart([item], facts, new Map())).toEqual([])

    await client.parkTask('app/linear-eng-412', false)
    expect(
      readyToStart(
        [{ ...item, parked: false }],
        { ...facts, events: await client.log.read({}) },
        new Map(),
      ),
    ).toEqual(['app/linear-eng-412'])
  })

  it('writes the grant that allowed it, which is the linear one and not another source’s', async () => {
    await take()
    expect((await client.log.read({ types: ['intake_accepted'] }))[0]?.detail).toMatchObject({
      item: 'linear:ENG-412',
      grant: 'surfaces.intake.sources.linear',
      mode: 'propose',
      watch: 'intake.linear',
      requester: 'u-kim',
    })
  })

  it('refuses a display name where the grant lists an id, and writes the refusal down', async () => {
    // The whole reason `from` is ids here: a Linear display name is its
    // owner's to give up and somebody else's to take.
    await open({ from: '[kim]' })
    const taken = await take()
    expect(taken.outcome).toBe('refused')
    expect(existsSync(taskDir(home, 'app/linear-eng-412'))).toBe(false)
    expect((await client.log.read({ types: ['intake_refused'] }))[0]?.detail).toMatchObject({
      why: 'not_allowed',
    })
  })

  it('reads a later instant as an edit, and never makes a second workflow', async () => {
    await take()
    await client.parkTask('app/linear-eng-412', false)
    const edited = await take(
      ticket({
        // An hour later, written with an offset: `09:00+02:00` is `07:00Z`,
        // which a lexical comparison reads as LATER than `08:00:00.000Z` and a
        // time comparison reads as earlier. This one is genuinely later.
        revision: '2026-10-09T11:00:00+02:00',
        correlation: 'ENG-412@2026-10-09T11:00:00+02:00',
        material: { ref: 'https://linear.app/acme/issue/ENG-412', hash: 'sha256:ddd' },
      }),
    )
    expect(edited.outcome).toBe('held')
    expect(edited.said).toContain('its text has changed')
    expect((await client.log.read({ types: ['task_created'] })).length).toBe(1)
    // The approval goes back where it was: what the person approved was the
    // earlier words.
    expect((await readTaskFile(home, 'app/linear-eng-412'))?.parked).toBe(true)
  })

  it('reads an earlier instant as nothing having happened, however it is written', async () => {
    await take()
    const older = await take(
      ticket({
        revision: '2026-10-09T09:00:00+02:00',
        correlation: 'ENG-412@2026-10-09T09:00:00+02:00',
      }),
    )
    // `09:00+02:00` is `07:00Z`. As text it sorts after `08:00:00.000Z`, and
    // reading it that way would re-park an approval for a revision that is an
    // hour OLDER than the one already taken.
    expect(older.outcome).toBe('ignored')
    expect((await readTaskFile(home, 'app/linear-eng-412'))?.parked).toBe(true)
  })

  it('holds rather than guessing when a revision is not an instant at all', async () => {
    await take()
    const muddled = await take(ticket({ revision: 'whenever', correlation: 'ENG-412@whenever' }))
    expect(muddled.outcome).toBe('held')
    expect(muddled.said).toContain('cannot be ordered')
  })

  it('asks the grant again at the moment of starting, not once when it was accepted', async () => {
    await take()
    expect(await stands()).toBeNull()
    await open({ accept: 'false' })
    expect((await stands())?.because).toContain('accept is off')
    await open({ from: '[]' })
    expect((await stands())?.because).toContain('no longer lists @u-kim')
    await open({ enabled: 'false' })
    expect((await stands())?.because).toContain('surfaces.intake.enabled is off')
  })

  it('asks the source again, and holds when it cannot be asked at all', async () => {
    await take()
    const closed = await stands({
      recheck: async () => ({ still: false, because: 'ENG-412 is completed' }),
    })
    expect(closed?.because).toContain('completed')
    // An inaccessible source is never permission, and that is the one
    // direction this must get right.
    const unreachable = await stands({
      recheck: async () => {
        throw new Error('api.linear.app did not answer')
      },
    })
    expect(unreachable?.because).toContain('could not be checked at its source')
  })

  it('never says anything back, because this source has no way back at all', async () => {
    await take()
    await client.parkTask('app/linear-eng-412', false)
    // Not "nothing was due": nothing can go, whatever the grant says, because
    // the watch implements no reply. Enforcement by absence.
    expect(await client.log.read({ types: ['intake_replied'] })).toEqual([])
  })
})
