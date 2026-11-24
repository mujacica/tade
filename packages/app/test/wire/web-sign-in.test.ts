import { ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { type AppState, initialState } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { CANCELLED, COLS, LANE, LOOK_MS, OrchestratorSignIn } from '../../src/wire/web-sign-in.ts'

// `/login` from the person's own phone, carried out: the orchestrator's
// harness's own sign-in for a machine nobody is at, run here in a lane, read
// while the phone looks, typed into from it, and the orchestrator started
// again once it ends signed in.
//
// Built by hand, as `machine.test.ts` beside it is: what this subject does is
// ask the client for a lane and write to it, and a real window answers that
// with a real PTY.

const LINK =
  'https://claude.ai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&state=xyz'

/** A window whose orchestrator runs on Claude Code as `work`, and every lane call it made. */
function world(over: { throws?: string; spawnFails?: string; thinker?: boolean } = {}) {
  const did: { what: string; with: unknown[] }[] = []
  const journal: unknown[] = []
  let state: AppState = initialState()
  let now = 1_000
  let lane: { alive: boolean; exitCode: number | null } | null = null
  let screen = `Browser didn't open? Use the url below to sign in:\n\n${LINK}\n\nPaste code here if prompted >`
  const client = {
    signInFor(harness: string, name: string | null, here: unknown) {
      did.push({ what: 'signInFor', with: [harness, name, here] })
      if (over.throws) throw new Error(over.throws)
      return {
        how: 'Claude Code prints a link.',
        launch: { command: 'claude', args: ['auth', 'login'], env: { CLAUDE_CONFIG_DIR: '/x' } },
      }
    },
    async spawn(spec: Record<string, unknown>) {
      did.push({ what: 'spawn', with: [spec] })
      if (over.spawnFails) throw new Error(over.spawnFails)
      lane = { alive: true, exitCode: null }
      return spec
    },
    lane: (id: string) => (id === LANE ? lane : null),
    async write(id: string, bytes: string) {
      did.push({ what: 'write', with: [id, bytes] })
    },
    async capture(id: string) {
      did.push({ what: 'capture', with: [id] })
      return screen
    },
    async closeLane(id: string) {
      did.push({ what: 'closeLane', with: [id] })
      if (lane) lane = { alive: false, exitCode: 129 }
    },
    log: {
      append: async (line: unknown) => {
        journal.push(line)
      },
    },
  }
  const wire = {
    opts: {
      config: ConfigSchema.parse({
        projects: { shop: { root: '/tmp/shop' } },
        accounts: { work: { harness: 'claude-code' } },
        orchestrator: { harness: 'claude-code', account: 'work' },
      }),
      home: '/tmp/home',
      client,
      ...(over.thinker === false ? {} : { restartThinker: async () => {} }),
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    now: () => now,
    draw: () => {},
    note: (err: unknown) => did.push({ what: 'note', with: [String(err)] }),
  } as unknown as Wiring
  const restarts: number[] = []
  const subject = new OrchestratorSignIn(wire, {
    restart: () => restarts.push(now),
    known: () => ['sk-ant-secret-0123456789'],
  })
  return {
    subject,
    did,
    journal,
    restarts,
    exit: (code: number) => {
      lane = { alive: false, exitCode: code }
    },
    show: (text: string) => {
      screen = text
    },
    later: (ms: number) => {
      now += ms
    },
    now: () => now,
  }
}

/** Every promise the subject left running, settled. */
const settle = () => new Promise((done) => setTimeout(done, 0))

describe('the orchestrator’s sign-in, from the person’s own phone', () => {
  it('runs the harness’s own sign-in for a machine nobody is at, in its lane, wide enough for its link', async () => {
    const { subject, did, journal } = world()
    const started = subject.start('phone1')
    expect(started).toMatchObject({
      state: 'running',
      who: 'work',
      how: 'Claude Code prints a link.',
    })
    await settle()
    expect(did[0]).toEqual({
      what: 'signInFor',
      with: ['claude-code', 'work', { browser: false }],
    })
    expect(did[1]?.with[0]).toMatchObject({
      id: LANE,
      command: 'claude',
      args: ['auth', 'login'],
      env: { CLAUDE_CONFIG_DIR: '/x' },
      cols: COLS,
    })
    expect(journal).toEqual([
      {
        type: 'web_did',
        detail: { device: 'phone1', verb: 'orchestrator sign-in', state: 'started' },
      },
    ])
    // A second start is the one running, never a second sign-in.
    subject.start('phone1')
    await settle()
    expect(did.filter((one) => one.what === 'spawn')).toHaveLength(1)
  })

  it('reads its screen on the beat only while somebody looks, cleaned, with the link it printed', async () => {
    const { subject, did, later, now, show } = world()
    subject.start('phone1')
    await settle()
    subject.beat(now())
    await settle()
    const looked = subject.look('phone1')
    expect(looked.link).toBe(LINK)
    expect(looked.rows.at(-1)).toBe('Paste code here if prompted >')
    // Nobody asked for a while: nothing is read.
    later(LOOK_MS + 1)
    const reads = did.filter((one) => one.what === 'capture').length
    subject.beat(now())
    await settle()
    expect(did.filter((one) => one.what === 'capture')).toHaveLength(reads)
    // A key it knows of never leaves the machine.
    show('token sk-ant-secret-0123456789 here')
    subject.look('phone1')
    subject.beat(now())
    await settle()
    expect(subject.look('phone1').rows.join('\n')).not.toContain('sk-ant-secret-0123456789')
  })

  it('types the code and then enter, and presses the keys a sign-in’s menu is moved with', async () => {
    const { subject, did } = world()
    // Nothing running: nothing is typed anywhere.
    subject.type('phone1', 'early')
    expect(did.filter((one) => one.what === 'write')).toEqual([])
    subject.start('phone1')
    await settle()
    subject.type('phone1', 'abc#def')
    subject.key('phone1', 'down')
    subject.key('phone1', 'escape')
    await settle()
    // The keys go at once; the enter after the code once the code is written.
    expect(did.filter((one) => one.what === 'write').map((one) => one.with[1])).toEqual([
      'abc#def',
      '\x1b[B',
      '\x1b',
      '\r',
    ])
  })

  it('starts the orchestrator again once it ends signed in, looked at or not', async () => {
    const { subject, restarts, exit, journal, later, now } = world()
    subject.start('phone1')
    await settle()
    later(LOOK_MS * 10)
    exit(0)
    subject.beat(now())
    expect(restarts).toHaveLength(1)
    expect(subject.look('phone1')).toMatchObject({
      state: 'ended',
      said: 'Signed in as work: the orchestrator starts again on it once any turn it is in is over.',
    })
    await settle()
    expect(journal.at(-1)).toMatchObject({ detail: { state: 'done' } })
    // Said once: the next beat finds nothing running.
    subject.beat(now())
    expect(restarts).toHaveLength(1)
  })

  it('leaves the orchestrator as it was when the sign-in fails or is cancelled', async () => {
    const failed = world()
    failed.subject.start('phone1')
    await settle()
    failed.exit(1)
    failed.subject.beat(failed.now())
    expect(failed.restarts).toEqual([])
    expect(failed.subject.look('phone1').said).toBe(
      "work's sign-in ended before it finished: the orchestrator is as it was.",
    )
    const ended = world()
    ended.subject.start('phone1')
    await settle()
    expect(ended.subject.cancel('phone1')).toMatchObject({ state: 'ended', said: CANCELLED })
    await settle()
    ended.subject.beat(ended.now())
    expect(ended.restarts).toEqual([])
    expect(ended.did.some((one) => one.what === 'closeLane')).toBe(true)
  })

  it('says why where it cannot start, and where nothing could start the orchestrator again', async () => {
    const keyed = world({ throws: 'work has nothing to sign in to: it is paid for with a key' })
    expect(keyed.subject.start('phone1')).toMatchObject({
      state: 'ended',
      said: 'The orchestrator cannot be signed in here: work has nothing to sign in to: it is paid for with a key',
    })
    const broken = world({ spawnFails: 'no driver' })
    broken.subject.start('phone1')
    await settle()
    expect(broken.subject.look('phone1')).toMatchObject({
      state: 'ended',
      said: "The orchestrator's sign-in could not start here: no driver",
    })
    const alone = world({ thinker: false })
    alone.subject.start('phone1')
    await settle()
    alone.exit(0)
    alone.subject.beat(alone.now())
    expect(alone.restarts).toEqual([])
    expect(alone.subject.look('phone1').said).toBe(
      'Signed in as work: the orchestrator runs on it the next time Tade starts.',
    )
  })
})
