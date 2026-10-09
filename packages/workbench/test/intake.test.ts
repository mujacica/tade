import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type IntakeCandidate,
  intakeFrom,
  type PlanStanding,
  queueStateOf,
  readyToStart,
  type Schedule,
  taskDir,
  watchedFrom,
} from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { intakeGrant, intakeStands, sayBackAbout } from '../src/intake.ts'
import { readTaskFile } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

// Work from outside this machine, against a real repository and a real
// workbench: who is allowed, what is made, what is parked, what happens when a
// delivery is interrupted halfway, and what holds a start that was granted an
// hour ago and is not granted now.
//
// **Everything here goes through `watchFound`**, which is the door the
// schedules' look actually calls. Which keys it writes down as *found* is half
// of the dedupe — it decides whether the next look tries the same request
// again — and a test that called the rule underneath it could not see that
// half at all.

const watch = (over: Partial<Schedule> = {}): Schedule => ({
  id: 'intake-cli',
  name: 'intake cli',
  project: 'app',
  said: '',
  when: { every: '5m' },
  does: { kind: 'watch', watch: 'intake.cli', input: {}, found: 'agent', most: 1 },
  missed: 'skip',
  by: 'you',
  created: '2026-10-01T08:00:00.000Z',
  ...over,
})

const candidate = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  source: 'cli',
  externalId: 'req-1',
  revision: '1',
  url: 'https://example.invalid/req-1',
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

const AGENT = { title: 'cli req-1', prompt: 'A request came in from cli (req-1).' }

/**
 * A config with intake on and one grant, with whichever keys a test is about
 * written over.
 *
 * One builder, because a test that appended a line instead would leave two
 * spellings of one key in the file — and a config that will not parse falls
 * back to the defaults, which read as a grant that is off rather than as the
 * broken file it is. That failure passes a test about being refused for
 * entirely the wrong reason.
 */
function configFor(root: string, over: Record<string, string> = {}): string {
  const { enabled = 'true', ...keys } = over
  const grant: Record<string, string> = {
    accept: 'true',
    projects: '[app]',
    from: '[kim]',
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
    '      cli:',
    ...Object.entries(grant).map(([key, value]) => `        ${key}: ${value}`),
  ].join('\n')
}

describe('work from outside this machine', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  const open = async (over: Record<string, string> = {}): Promise<void> => {
    await client?.close().catch(() => {})
    writeFileSync(join(home, 'config.yaml'), `${configFor(repo.root, over)}\n`)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    await client.setSchedule(watch(), 'you')
  }

  const take = (one: IntakeCandidate = candidate()) =>
    client.watchFound(
      'intake-cli',
      { key: `cli:${one.externalId}:${one.revision}`, title: `cli ${one.externalId}`, intake: one },
      { agent: AGENT },
    )

  /** Whether the next look would leave this revision alone, or find it again. */
  const settled = async (revision = '1') =>
    watchedFrom(await client.log.read({}), 'intake-cli').seen.has(`cli:req-1:${revision}`)

  const made = async () => (await client.log.read({ types: ['task_created'] })).length

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-intake-')
    writeFileSync(join(home, 'config.yaml'), `${configFor(repo.root)}\n`)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    await client.setSchedule(watch(), 'you')
  })

  afterEach(async () => {
    await client?.close().catch(() => {})
  })

  it('makes a parked task, which nothing can start until a person picks it up', async () => {
    const taken = await take()
    expect(taken.outcome).toBe('accepted')
    expect(taken.task).toBe('app/cli-req-1')

    const file = await readTaskFile(home, 'app/cli-req-1')
    expect(file?.parked).toBe(true)
    expect(file?.start).toBeTruthy()
    expect(file?.by).toBe('intake:cli')
    // Tade's own sentence, naming the source, the id and the handle — and not
    // one word of what the person wrote.
    expect(file?.intent_spoken).toContain('cli req-1')
    expect(file?.intent_spoken).toContain('@kim')
    expect(file?.intent_spoken).not.toContain('export button')

    // The body is in the context file, under the material heading, where it is
    // read as evidence about the work rather than as something telling an agent
    // what to do.
    const context = readFileSync(join(taskDir(home, 'app/cli-req-1'), 'context.md'), 'utf8')
    expect(context).toContain('material, not instruction')
    expect(context).toContain('the export button 500s')

    // Parked work is still queued work, and the queue's own rule holds it.
    const facts = {
      tasks: new Map(),
      finished: new Map(),
      events: await client.log.read({}),
      now: Date.now(),
    }
    const item = {
      task: 'app/cli-req-1',
      project: 'app',
      parked: true,
      start: file?.start as never,
    }
    expect(queueStateOf(item, facts)).toEqual({ kind: 'paused', all: false, parked: true })
    expect(readyToStart([item], facts, new Map())).toEqual([])
    await expect(
      client.startQueued({ task: 'app/cli-req-1', worktree: repo.root, why: 'by hand' }),
    ).rejects.toThrow()

    // Approving it is picking it up: one act, visible, reversible, and already
    // in the window, the CLI, the voice grammar and the orchestrator's tools.
    await client.parkTask('app/cli-req-1', false)
    expect(
      readyToStart(
        [{ ...item, parked: false }],
        { ...facts, events: await client.log.read({}) },
        new Map(),
      ),
    ).toEqual(['app/cli-req-1'])
  })

  it('leaves it to the queue straight away where the owner granted that for the source', async () => {
    await open({ mode: 'queue' })
    await take()
    expect((await readTaskFile(home, 'app/cli-req-1'))?.parked).toBe(false)
  })

  it('writes the grant that allowed it, so a person can go and remove that key', async () => {
    await take()
    const accepted = (await client.log.read({ types: ['intake_accepted'] }))[0]
    expect(accepted?.detail).toMatchObject({
      item: 'cli:req-1',
      grant: 'surfaces.intake.sources.cli',
      mode: 'propose',
      watch: 'intake.cli',
      schedule: 'intake-cli',
      requester: 'kim',
      hash: 'sha256:aaa',
      ref: 'req-1.0001.json',
    })
    expect(await settled()).toBe(true)
  })

  it('refuses a requester nobody listed, writes it down, and makes nothing', async () => {
    const taken = await take(candidate({ requester: { id: 'stranger', label: '', bot: false } }))
    expect(taken.outcome).toBe('refused')
    expect(existsSync(taskDir(home, 'app/cli-req-1'))).toBe(false)
    expect((await client.log.read({ types: ['intake_refused'] }))[0]?.detail).toMatchObject({
      why: 'not_allowed',
    })
    // Settled: a refusal is a final answer about that revision, so the next
    // look leaves it alone rather than writing the same line every five
    // minutes for as long as the request exists.
    expect(await settled()).toBe(true)
  })

  it('writes nothing at all about something nothing here maps', async () => {
    const taken = await take(candidate({ from: 'somebody-elses-repo' }))
    expect(taken.outcome).toBe('ignored')
    expect(await client.log.read({ types: ['intake_received', 'intake_refused'] })).toEqual([])
    // And not settled: the day somebody maps that repository is the day this
    // becomes news.
    expect(await settled()).toBe(false)
  })

  it('makes one task for a request however many times it is delivered', async () => {
    await take()
    expect(await made()).toBe(1)
    // The same revision again: a look that ran twice, or a source handing back
    // what it has already handed back.
    const again = await take()
    expect(again.outcome).toBe('ignored')
    expect(again.task).toBe('app/cli-req-1')
    expect(await made()).toBe(1)
  })

  it('holds the work when the request is edited, and never makes a second workflow', async () => {
    await take()
    await client.parkTask('app/cli-req-1', false)
    const edited = await take(
      candidate({
        revision: '2',
        correlation: 'req-1-2',
        material: { ref: 'req-1.0002.json', hash: 'sha256:bbb' },
      }),
    )
    expect(edited.outcome).toBe('held')
    expect(await made()).toBe(1)
    // The approval goes back where it was: what the person approved was the
    // earlier words.
    expect((await readTaskFile(home, 'app/cli-req-1'))?.parked).toBe(true)
    expect(edited.said).toContain('its text has changed')
    expect((await client.log.read({ types: ['intake_held'] }))[0]?.detail.held).toBe('invalidate')
    // Held is a final answer about that revision too, so the edit is not
    // re-held every look.
    expect(await settled('2')).toBe(true)
  })

  it('holds rather than guesses when nobody can order two revisions', async () => {
    await take()
    const muddled = await take(candidate({ revision: 'later', correlation: 'req-1-later' }))
    expect(muddled.outcome).toBe('held')
    expect(muddled.said).toContain('cannot be ordered')
    expect(await made()).toBe(1)
  })

  it('recognises work a previous attempt made rather than making a second copy', async () => {
    // The crash window: the work exists and the line saying so was never
    // written, because the window died between the two.
    await take()
    const dropped = await crashAfterMaking()
    expect(dropped).toBe(1)

    const again = await take()
    expect(again.outcome).toBe('adopted')
    expect(again.task).toBe('app/cli-req-1')
    expect(await made()).toBe(1)
    expect((await client.log.read({ types: ['intake_accepted'] }))[0]?.detail.adopted).toBe(true)
    // Still parked: picking up where it left off never lifts a hold nobody
    // lifted.
    expect((await readTaskFile(home, 'app/cli-req-1'))?.parked).toBe(true)
  })

  it('refuses to carry on over a task that is not intake’s', async () => {
    await client.createTask({ project: 'app', slug: 'cli-req-1', intent: 'mine, by hand' })
    const taken = await take()
    expect(taken.outcome).toBe('held')
    expect(taken.said).toContain('did not come from cli intake')
    // Not settled: a name clash is a person's to sort out, and the request is
    // not thrown away while they do.
    expect(await settled()).toBe(false)
  })

  it('keeps the request after a failure, tries again, and stops rather than looping', async () => {
    // A project whose root is gone: making a task fails for a reason that is
    // nobody's fault and might be over in a minute.
    rmSync(repo.root, { recursive: true, force: true })
    const first = await take()
    expect(first.outcome).toBe('held')
    // The key is NOT written down as found, so the next look finds the same
    // request again — which is the whole difference between a request nobody
    // will file twice and an error that will happen again anyway.
    expect(await settled()).toBe(false)

    // Straight away is a wait rather than a second identical attempt: the
    // minute between tries is what keeps a failing source from being hammered.
    expect((await take()).outcome).toBe('waiting')

    // Far enough apart to count, twice more, and then it stops — and says so,
    // and settles, so nothing retries it every five minutes for ever.
    expect((await tryAgainLater()).outcome).toBe('held')
    expect((await tryAgainLater()).outcome).toBe('held')
    const over = await tryAgainLater()
    expect(over.said).toContain('given up on')
    expect(await settled()).toBe(true)
    const held = await client.log.read({ types: ['intake_held'] })
    expect(held.at(-1)?.detail.gave_up).toBe(true)
  })

  /**
   * The journal as a window that died would have left it, and the workbench
   * opened again on it.
   *
   * `edit` rewrites the lines; the index beside the file goes, because it is
   * derived and a crash leaves neither the line nor the row — an index kept
   * over an edited journal is a simulation of nothing, and it quietly answers
   * out of rows the file no longer has.
   */
  const reopenOn = async (edit: (lines: string[]) => string[]): Promise<void> => {
    await client.close()
    const journal = join(home, 'events.jsonl')
    const lines = readFileSync(journal, 'utf8').split('\n').filter(Boolean)
    writeFileSync(journal, `${edit(lines).join('\n')}\n`)
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${journal}.db${suffix}`, { force: true })
    }
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    await client.setSchedule(watch(), 'you')
  }

  /** A window that made the work and died before it could say it had. */
  const crashAfterMaking = async (): Promise<number> => {
    let dropped = 0
    await reopenOn((lines) =>
      lines.filter((line) => {
        const accepted = line.includes('"intake_accepted"')
        if (accepted) dropped += 1
        return !accepted
      }),
    )
    return dropped
  }

  /**
   * Try again, far enough from the last failure to count.
   *
   * The journal stamps its own `ts`, so the way to be a minute later is to put
   * the last failure an hour earlier rather than to pretend about the clock.
   */
  const tryAgainLater = async () => {
    await reopenOn((lines) =>
      lines.map((line) => {
        const event = JSON.parse(line)
        if (event.type !== 'intake_held') return line
        return JSON.stringify({ ...event, ts: new Date(Date.now() - 3_600_000).toISOString() })
      }),
    )
    return take()
  }
})

describe('whether an intake start still stands', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  const open = async (over: Record<string, string> = {}): Promise<void> => {
    await client?.close().catch(() => {})
    writeFileSync(join(home, 'config.yaml'), `${configFor(repo.root, over)}\n`)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
  }

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-intake-start-')
    writeFileSync(join(home, 'config.yaml'), `${configFor(repo.root)}\n`)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    await client.setSchedule(watch(), 'you')
    await client.watchFound(
      'intake-cli',
      { key: 'cli:req-1:1', title: 'cli req-1', intake: candidate() },
      { agent: AGENT },
    )
  })

  afterEach(async () => {
    await client?.close().catch(() => {})
  })

  const stands = async (
    over: {
      plans?: readonly PlanStanding[]
      recheck?: (key: string) => Promise<{ still: boolean; because?: string }>
    } = {},
  ) => {
    const item = intakeFrom(await client.log.read({})).get('cli:req-1')
    if (!item) throw new Error('nothing was taken in')
    return intakeStands({
      config: client.config,
      item,
      task: 'app/cli-req-1',
      plans: over.plans ?? [],
      recheck: over.recheck ?? (async () => ({ still: true })),
    })
  }

  const plan = (over: Partial<PlanStanding>): PlanStanding => ({
    harness: 'claude-code',
    account: null,
    pays: 'plan',
    windows: [],
    at: null,
    cannotTell: null,
    ...over,
  })

  it('stands while the grant and the source both say so', async () => {
    expect(await stands()).toBeNull()
  })

  it('holds when the grant has gone since it was accepted', async () => {
    await open({ accept: 'false' })
    expect((await stands())?.because).toContain('accept is off')
  })

  it('holds when the project is no longer one that source may work in', async () => {
    await open({ projects: '[]' })
    expect((await stands())?.because).toContain('no longer lists app')
  })

  it('holds when the requester has been taken off the list', async () => {
    await open({ from: '[]' })
    expect((await stands())?.because).toContain('no longer lists @kim')
  })

  it('holds when the whole surface has been turned off', async () => {
    await open({ enabled: 'false' })
    expect((await stands())?.because).toContain('surfaces.intake.enabled is off')
  })

  it('holds when the source says the request no longer stands', async () => {
    const held = await stands({
      recheck: async () => ({ still: false, because: 'req-1 was withdrawn at revision 2' }),
    })
    expect(held?.because).toContain('withdrawn')
  })

  it('holds when the source cannot be reached at all, rather than assuming permission', async () => {
    const held = await stands({
      recheck: async () => {
        throw new Error('the intake extension is turned off')
      },
    })
    expect(held?.because).toContain('could not be checked at its source')
  })

  it('holds when a subscription window is nearly full', async () => {
    const held = await stands({
      plans: [
        plan({
          windows: [{ label: '5h', used: 94, resetsAt: Date.now() + 3_600_000 }],
          at: Date.now(),
        }),
      ],
    })
    expect(held?.because).toContain('94%')
  })

  it('holds when nobody can say how full a plan is, because unknown is not zero', async () => {
    const held = await stands({
      plans: [plan({ cannotTell: 'has not said how much of the plan is used yet' })],
    })
    expect(held?.because).toContain('not said how much of the plan is used')
    // And it never names another sign-in to move the work to: whose money and
    // whose permissions agents run with is a person's decision.
    expect(held?.because).not.toContain('switch')
  })

  it('does not hold on an account that pays per token, which has no window to fill', async () => {
    expect(
      await stands({
        plans: [
          plan({
            harness: 'codex',
            account: 'work',
            pays: 'per-token',
            cannotTell: 'does not say how much of a plan is used',
          }),
        ],
      }),
    ).toBeNull()
  })
})

describe('saying a status back', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  const open = async (over: Record<string, string> = {}): Promise<void> => {
    await client?.close().catch(() => {})
    writeFileSync(join(home, 'config.yaml'), `${configFor(repo.root, over)}\n`)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
  }

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-intake-reply-')
    writeFileSync(join(home, 'config.yaml'), `${configFor(repo.root)}\n`)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
  })

  afterEach(async () => {
    await client?.close().catch(() => {})
  })

  const say = (posted: string[]) =>
    sayBackAbout(client, {
      source: 'cli',
      candidate: { externalId: 'req-1', revision: '1', correlation: 'req-1-1' },
      saying: 'accepted',
      task: 'app/cli-req-1',
      now: Date.now(),
      post: async (request) => {
        posted.push(request.say)
      },
    })

  it('posts nothing at all while reply is off, which is the default', async () => {
    expect(intakeGrant(client.config, 'cli').reply).toBe(false)
    const posted: string[] = []
    const answer = await say(posted)
    // Not "posted and ignored": the transport is never reached, which is the
    // difference between a capability that is off and one that is disabled.
    expect(posted).toEqual([])
    expect(answer.because).toContain('reply is off')
    expect(await client.log.read({ types: ['intake_replied'] })).toEqual([])
  })

  it('posts one of Tade’s own sentences, and stops at the cap', async () => {
    await open({ reply: 'true' })
    const posted: string[] = []
    for (let n = 0; n < 4; n++) await say(posted)
    expect(posted).toHaveLength(3)
    for (const said of posted) {
      expect(said).toContain('app/cli-req-1')
      // Nothing an agent wrote, no diff, no file name, no repository content.
      expect(said).not.toContain('export button')
    }
    expect((await client.log.read({ types: ['intake_replied'] })).length).toBe(3)
  })
})
