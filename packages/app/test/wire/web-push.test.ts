import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attentionFor, type Config, ConfigSchema } from '@tade/core'
import {
  appendPush,
  generateVapid,
  readPushes,
  type ScriptedPusher,
  scriptedPusher,
  signingFrom,
  type TaskNow,
} from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { TRIES, WebPush } from '../../src/wire/web-push.ts'

// The window's half of notifications, driven against a push service that is
// not one.
//
// Every test here is a thing that would otherwise be found on somebody's
// phone: a window that came back and sent six notifications about last night,
// a dead endpoint posted to on every beat for an hour, a phone somebody signed
// out that went on being told, a notification sent twice because a beat
// arrived while the last one was in flight.
//
// **No sockets, and no credential anybody owns.** The key is generated here
// and written into the harness's own config; `scriptedPusher` records what
// would have gone out. `packages/web/test/push-out.test.ts` is where the
// protocol itself is checked, and real delivery to a real device is a manual
// step (`packages/web/test/browser-plan.ts`).

const DEVICE = '00112233445566aa'
const OTHER = '00112233445566bb'
const ENDPOINT = 'https://web.push.apple.com/QDzVM4rMVZ1l0bT8VvPaDQ'
const KEYS = { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) }

const homes: string[] = []

afterEach(() => {
  homes.length = 0
})

interface Over {
  /** What the config says. `push` on and a key already written, by default. */
  web?: Record<string, unknown>
  key?: string | null
  devices?: { id: string; revoked: string | null }[]
  titled?: boolean
  /** Which projects the device may read, or null for every one of them. */
  projects?: readonly string[] | null
  lastInputAt?: number | null
  localHour?: number
  answers?: number[]
  attention?: { budget?: number; quiet?: string }
  /** Devices that have already asked to be told, written **before** `open`. */
  asked?: readonly string[]
}

/**
 * The whole of the push half, with the world a test wants in front of it.
 *
 * `asked` is written **before** `open`, which is the order the window has: the
 * listener reads the subscriptions when it comes up, and a test that wrote one
 * afterwards would be testing a window that had not read its own file.
 */
async function made(over: Over = {}) {
  const home = await mkdtemp(join(tmpdir(), 'tade-push-'))
  homes.push(home)
  for (const device of over.asked ?? []) await subscribed(home, device)
  const key = over.key === undefined ? generateVapid().privateKey : over.key
  let config: Config = ConfigSchema.parse({
    surfaces: {
      web: {
        enabled: true,
        install: true,
        push: true,
        ...(key === null ? {} : { push_key: key }),
        ...(over.web ?? {}),
      },
      voice: { attention: over.attention ?? {} },
    },
  })
  const told: { type: string; detail: Record<string, string | number | boolean> }[] = []
  const written: { key: string; value: string }[] = []
  const pusher = scriptedPusher(over.answers ?? [])
  let tasks: readonly TaskNow[] = []
  let now = 1_000_000
  const push = new WebPush({
    home: () => home,
    config: () => config,
    attention: () => attentionFor('push', config.surfaces.voice.attention),
    tasks: () => tasks,
    devices: () => over.devices ?? [{ id: DEVICE, revoked: null }],
    reach: (device) =>
      (over.devices ?? [{ id: DEVICE, revoked: null }]).some(
        (one) => one.id === device && one.revoked === null,
      )
        ? {
            device,
            projects:
              over.projects === undefined || over.projects === null
                ? { kind: 'every' }
                : { kind: 'listed', names: [...over.projects] },
            granted: over.titled === true ? ['titles'] : [],
          }
        : null,
    lastInputAt: () => over.lastInputAt ?? null,
    writeKey: async (one, value) => {
      written.push({ key: one, value })
      // The real door reads the config back and hands it round, so the harness
      // does too: a key written and not visible would make the next beat mint
      // a second one, which is the worse failure.
      config = ConfigSchema.parse({
        ...JSON.parse(JSON.stringify(config)),
        surfaces: {
          ...JSON.parse(JSON.stringify(config.surfaces)),
          web: { ...JSON.parse(JSON.stringify(config.surfaces.web)), push_key: value },
        },
      })
    },
    tell: (one) => told.push(one),
    now: () => now,
    localHour: () => over.localHour ?? 14,
    pusher: () => pusher as ScriptedPusher,
  })
  return {
    push,
    home,
    told,
    written,
    pusher,
    config: () => config,
    /** The tasks this beat sees. */
    sees: (next: readonly TaskNow[]) => {
      tasks = next
    },
    /** Move the clock on, which is the only thing a beat reads it for. */
    at: (next: number) => {
      now = next
    },
    /**
     * Beat, and let whatever it started finish.
     *
     * `done` is what to wait **for** where a beat starts a file write: a fixed
     * number of ticks is a number about the runner, and this suite spawns real
     * processes, so on a loaded machine the tick that was enough yesterday is
     * not enough today. Paced by the thing being counted, which is the rule
     * everywhere else in this repository.
     */
    beat: async (done?: () => boolean | Promise<boolean>) => {
      push.beat()
      await settle(done)
    },
  }
}

/**
 * Let what a beat started finish.
 *
 * With nothing to wait for it drains the microtasks and one turn of the loop,
 * which is what a beat that sends nothing needs. With a condition it waits for
 * that, up to a second — long enough for a starved machine and short enough
 * that a test which is wrong fails rather than hanging.
 */
async function settle(done?: () => boolean | Promise<boolean>): Promise<void> {
  for (let at = 0; at < 8; at++) await Promise.resolve()
  await new Promise((go) => setTimeout(go, 0))
  if (done === undefined) return
  for (let at = 0; at < 100; at++) {
    if (await done()) return
    await new Promise((go) => setTimeout(go, 10))
  }
}

function task(over: Partial<TaskNow> = {}): TaskNow {
  return {
    id: 'shop/refunds',
    project: 'shop',
    state: 'working',
    waiting: false,
    finished: false,
    queue: '',
    title: 'Make the refunds work',
    ...over,
  }
}

/** A device that has already asked to be told. */
async function subscribed(home: string, device = DEVICE): Promise<void> {
  await appendPush(home, {
    kind: 'subscribed',
    device,
    at: new Date(1_000).toISOString(),
    endpoint: ENDPOINT,
    ...KEYS,
  })
}

describe('what a beat costs when nobody turned it on', () => {
  it('does nothing at all with the setting off: no file, no clock, no key', async () => {
    const it_ = await made({ web: { push: false }, asked: [DEVICE] })
    await it_.push.open()
    it_.sees([task()])
    await it_.beat()
    await it_.beat()
    expect(it_.pusher.sent).toEqual([])
    expect(it_.written).toEqual([])
  })

  it('does nothing with notifications on and nothing subscribed', async () => {
    const it_ = await made()
    await it_.push.open()
    it_.sees([task()])
    await it_.beat()
    it_.sees([task({ waiting: true })])
    await it_.beat()
    expect(it_.pusher.sent).toEqual([])
  })

  it('offers no key to a page while the setting is off', async () => {
    const it_ = await made({ web: { push: false } })
    expect(it_.push.key()).toBe('')
  })
})

describe('nothing is caught up', () => {
  it('sends nothing on the first beat, whatever was already true', async () => {
    // A window that has just opened has no previous beat to differ from, which
    // is the whole of `PUSH_IS_WHILE_OPEN`'s *nothing is caught up*: a laptop
    // shut overnight does not wake up and send six notifications about last
    // night.
    const it_ = await made({ asked: [DEVICE] })
    await it_.push.open()
    it_.sees([task({ waiting: true }), task({ id: 'shop/two', state: 'failed' })])
    await it_.beat()
    expect(it_.pusher.sent).toEqual([])
    // And the beat after it sends only what has changed since.
    it_.sees([task({ waiting: true }), task({ id: 'shop/two', state: 'failed' })])
    await it_.beat()
    expect(it_.pusher.sent).toEqual([])
  })

  it('starts from now again after the setting is turned off and on', async () => {
    const it_ = await made({ asked: [DEVICE] })
    await it_.push.open()
    it_.sees([task()])
    await it_.beat()
    it_.sees([task({ waiting: true })])
    // Off, and the last beat's facts go with it.
    const was = it_.config()
    Object.assign(was.surfaces.web, { push: false })
    await it_.beat()
    Object.assign(was.surfaces.web, { push: true })
    // Back on: the transition that happened while it was off is not news.
    await it_.beat()
    expect(it_.pusher.sent).toEqual([])
  })
})

describe('one notification, sent', () => {
  it('sends a generic payload to a subscribed device, and writes it down', async () => {
    const it_ = await made({ asked: [DEVICE] })
    await it_.push.open()
    it_.sees([task()])
    await it_.beat()
    it_.sees([task({ waiting: true })])
    await it_.beat(() => it_.pusher.sent.length === 1)
    expect(it_.pusher.sent).toHaveLength(1)
    const sent = it_.pusher.sent[0]
    expect(sent?.to).toEqual({ endpoint: ENDPOINT, ...KEYS })
    expect(sent?.notice.body).toBe('Work wants your answer')
    // Nothing of the work, and nothing of the work in the journal line either.
    const line = it_.told.find((one) => one.type === 'web_pushed')
    expect(line?.detail).toMatchObject({ device: DEVICE, about: 'wants', changes: 1, status: 201 })
    expect(JSON.stringify(it_.told)).not.toContain('refunds')
  })

  it('names the work only where the setting **and** the grant both say so', async () => {
    // Two halves, and the device's is the narrower one: a phone that may not
    // read what work is called never gets a name in a notification either.
    for (const [details, titled, body] of [
      [false, false, 'Work wants your answer'],
      [true, false, 'Work wants your answer'],
      [false, true, 'Work wants your answer'],
      [true, true, 'Make the refunds work wants your answer'],
    ] as const) {
      const it_ = await made({ web: { push_details: details }, titled, asked: [DEVICE] })
      await it_.push.open()
      it_.sees([task()])
      await it_.beat()
      it_.sees([task({ waiting: true })])
      await it_.beat(() => it_.pusher.sent.length === 1)
      expect(it_.pusher.sent[0]?.notice.body, `${details} ${titled}`).toBe(body)
    }
  })

  it('tells a device nothing about a project it may not read', async () => {
    // **Not even as a count.** The collections are the window's own and are
    // built once for every phone, so this narrowing happens at the send or
    // nowhere — and a device granted one project of two would otherwise be
    // told that something in the other one wants you.
    const it_ = await made({ asked: [DEVICE], projects: ['shop'] })
    await it_.push.open()
    const two = [task({ id: 'shop/one', project: 'shop' }), task({ id: 'ops/two', project: 'ops' })]
    it_.sees(two)
    await it_.beat()
    it_.sees([two[0] as TaskNow, { ...(two[1] as TaskNow), state: 'failed' }])
    await it_.beat()
    expect(it_.pusher.sent).toEqual([])
    // And the project it does read still reaches it.
    it_.sees([{ ...(two[0] as TaskNow), waiting: true }, two[1] as TaskNow])
    await it_.beat(() => it_.pusher.sent.length === 1)
    expect(it_.pusher.sent[0]?.notice.body).toBe('Work wants your answer')
  })

  it('sends one to each subscribed device, and none to a device that is not', async () => {
    const it_ = await made({
      devices: [
        { id: DEVICE, revoked: null },
        { id: OTHER, revoked: null },
      ],
      asked: [DEVICE, OTHER],
    })
    await it_.push.open()
    it_.sees([task()])
    await it_.beat()
    it_.sees([task({ state: 'failed' })])
    await it_.beat(() => it_.pusher.sent.length === 2)
    expect(it_.pusher.sent.map((one) => one.to.endpoint)).toHaveLength(2)
  })
})

describe('what stops one', () => {
  const start = async (over: Over = {}) => {
    const it_ = await made({ asked: [DEVICE], ...over })
    await it_.push.open()
    it_.sees([task()])
    await it_.beat()
    it_.sees([task({ waiting: true })])
    return it_
  }

  it('sends nothing while somebody is at the keyboard', async () => {
    const it_ = await start({ lastInputAt: 1_000_000 - 1_000 })
    await it_.beat()
    expect(it_.pusher.sent).toEqual([])
  })

  it('sends nothing inside the quiet hours a person wrote for the earbud', async () => {
    const it_ = await start({ attention: { quiet: '09:00-17:00' }, localHour: 12 })
    await it_.beat()
    expect(it_.pusher.sent).toEqual([])
  })

  it('sends one thing once, however many beats it stays true for', async () => {
    const it_ = await start()
    await it_.beat(() => it_.pusher.sent.length === 1)
    await it_.beat()
    await it_.beat()
    expect(it_.pusher.sent).toHaveLength(1)
  })

  it('stops at the hourly budget, and sends again an hour later', async () => {
    const it_ = await start({ attention: { budget: 1 } })
    await it_.beat(() => it_.pusher.sent.length === 1)
    expect(it_.pusher.sent).toHaveLength(1)
    // A second, different transition inside the hour: over the budget.
    it_.sees([task({ waiting: true, state: 'failed' })])
    await it_.beat()
    expect(it_.pusher.sent).toHaveLength(1)
    // An hour on, the first one has fallen out of the window.
    it_.at(1_000_000 + 3_600_001)
    it_.sees([task({ waiting: true, state: 'failed', finished: true })])
    await it_.beat(() => it_.pusher.sent.length === 2)
    expect(it_.pusher.sent).toHaveLength(2)
  })

  it('sends nothing to a device that was signed out, and writes the row off', async () => {
    // **With no network.** What a phone holds is checked here, so one that is
    // off, lost or on another continent stops being told because of this.
    const it_ = await made({
      devices: [{ id: DEVICE, revoked: 'revoked at the machine' }],
      asked: [DEVICE],
    })
    await it_.push.open()
    it_.sees([task()])
    await it_.beat()
    it_.sees([task({ waiting: true })])
    await it_.beat(async () => (await readPushes(it_.home)).pushes[0]?.forgotten !== null)
    expect(it_.pusher.sent).toEqual([])
    const { pushes } = await readPushes(it_.home)
    expect(pushes[0]?.forgotten).toBe('signed out')
  })
})

describe('what a push service says back', () => {
  const start = async (answers: number[]) => {
    const it_ = await made({ answers, asked: [DEVICE] })
    await it_.push.open()
    it_.sees([task()])
    await it_.beat()
    return it_
  }

  it('forgets a subscription the service says is gone, and never posts to it again', async () => {
    const it_ = await start([410])
    it_.sees([task({ waiting: true })])
    await it_.beat(async () => (await readPushes(it_.home)).pushes[0]?.forgotten !== null)
    expect(it_.pusher.sent).toHaveLength(1)
    const { pushes } = await readPushes(it_.home)
    expect(pushes[0]?.forgotten).toBe('gone at the push service')
    // A dead endpoint must not be posted to on every beat until somebody
    // notices.
    it_.sees([task({ waiting: true, state: 'failed' })])
    await it_.beat()
    expect(it_.pusher.sent).toHaveLength(1)
  })

  it('retries by the next transition rather than by a timer, and stops after a few', async () => {
    // A `later` is dropped and its key is **not** marked, so the next
    // transition on that task notifies — a retry paced by what happens, which
    // is the only kind a window with no scheduler can honestly offer.
    const it_ = await start([503, 503, 503, 503])
    for (const [at, over] of [
      [1, { waiting: true }],
      [2, { waiting: true, state: 'failed' as const }],
      [3, { waiting: true, state: 'failed' as const, finished: true }],
      [4, { waiting: true, state: 'failed' as const, finished: true, queue: 'held' }],
    ] as const) {
      it_.sees([task(over)])
      await it_.beat(() => it_.pusher.sent.length >= Math.min(at, TRIES))
      expect(it_.pusher.sent.length, `beat ${at}`).toBe(Math.min(at, TRIES))
    }
  })

  it('says a refusal in a warning a person can act on, and never retries it', async () => {
    const it_ = await start([401])
    it_.sees([task({ waiting: true })])
    await it_.beat(() => it_.told.some((one) => one.type === 'warning'))
    const warning = it_.told.find((one) => one.type === 'warning')
    expect(String(warning?.detail.warning)).toContain('refused')
    expect(String(warning?.detail.warning)).toContain('signing key')
  })

  it('survives a sender that threw, and says so', async () => {
    const it_ = await start([])
    it_.pusher.throwOnce('the socket exploded')
    it_.sees([task({ waiting: true })])
    await it_.beat(() => it_.told.some((one) => one.type === 'warning'))
    const warning = it_.told.find((one) => one.type === 'warning')
    expect(String(warning?.detail.warning)).toContain('the socket exploded')
    // And a beat after it still works.
    it_.sees([task({ waiting: true, state: 'failed' })])
    await it_.beat(() => it_.pusher.sent.length === 1)
    expect(it_.pusher.sent).toHaveLength(1)
  })
})

describe('the signing key', () => {
  it('generates one the first time it is needed, and writes it where keys live', async () => {
    const it_ = await made({ key: null, asked: [DEVICE] })
    await it_.push.open()
    it_.sees([task()])
    // The beat that finds no key mints one and sends nothing; the next one
    // sends.
    await it_.beat(() => it_.written.length === 1)
    expect(it_.written).toHaveLength(1)
    expect(it_.written[0]?.key).toBe('surfaces.web.push_key')
    expect(() => signingFrom(it_.written[0]?.value ?? '')).not.toThrow()
    expect(it_.pusher.sent).toEqual([])
    // And the key the page is offered is the **public** half, derived.
    expect(it_.push.key()).toBe(signingFrom(it_.written[0]?.value ?? '').publicKey)
  })

  it('mints one and only one, however many beats go by before it lands', async () => {
    // Two keys would be the worse failure: the second makes every
    // subscription the first signed unusable.
    const it_ = await made({ key: null, asked: [DEVICE] })
    await it_.push.open()
    it_.sees([task()])
    it_.push.beat()
    it_.push.beat()
    it_.push.beat()
    await settle(() => it_.written.length > 0)
    expect(it_.written).toHaveLength(1)
  })

  it('says a key somebody pasted is unusable, once, and mints nothing over it', async () => {
    // A key that is set and unreadable is not a key to replace behind
    // somebody's back: they pasted something, they are told, and clearing it
    // is theirs.
    const it_ = await made({ key: 'not-a-key', asked: [DEVICE] })
    await it_.push.open()
    it_.sees([task()])
    await it_.beat(() => it_.told.length > 0)
    await it_.beat()
    expect(it_.written).toEqual([])
    const said = it_.told.filter((one) => String(one.detail.warning ?? '').includes('not a usable'))
    expect(said).toHaveLength(1)
    expect(String(said[0]?.detail.warning)).toContain('surfaces.web.push_key')
    expect(it_.push.key()).toBe('')
  })

  it('never puts the key in anything it writes down', async () => {
    const it_ = await made({ key: null, asked: [DEVICE] })
    await it_.push.open()
    it_.sees([task()])
    await it_.beat(() => it_.written.length === 1)
    const key = it_.written[0]?.value ?? 'nothing'
    expect(JSON.stringify(it_.told)).not.toContain(key)
  })

  it('reads the environment over the config, like every other key', async () => {
    const mine = generateVapid()
    const had = process.env.TADE_PUSH_KEY
    process.env.TADE_PUSH_KEY = mine.privateKey
    try {
      const it_ = await made({ key: generateVapid().privateKey })
      expect(it_.push.key()).toBe(mine.publicKey)
    } finally {
      if (had === undefined) delete process.env.TADE_PUSH_KEY
      else process.env.TADE_PUSH_KEY = had
    }
  })
})

describe('a device asking to be told', () => {
  const half = async (over: Over = {}) => {
    const it_ = await made(over)
    await it_.push.open()
    return { ...it_, half: it_.push.half() }
  }

  it('writes the row under the session’s own device, and says the host', async () => {
    const it_ = await half()
    const out = await it_.half.subscribe(
      { endpoint: ENDPOINT, ...KEYS },
      { how: 'remote', device: DEVICE },
    )
    expect(out.did).toBe(true)
    expect(out.said).toContain('web.push.apple.com')
    const text = await readFile(join(it_.home, 'web-pushes.jsonl'), 'utf8')
    expect(JSON.parse(text.trim())).toMatchObject({ kind: 'subscribed', device: DEVICE })
  })

  it('refuses a device that is no longer paired', async () => {
    const it_ = await half({ devices: [] })
    await expect(
      it_.half.subscribe({ endpoint: ENDPOINT, ...KEYS }, { how: 'remote', device: DEVICE }),
    ).rejects.toThrow('no longer paired')
  })

  it('refuses a turn at the keyboard, which has no device to write a row under', async () => {
    // There is no control at the machine that subscribes a phone, so a local
    // `From` has no device id — and `paired` then refuses it, rather than a
    // row being written under an empty one.
    const it_ = await half()
    await expect(
      it_.half.subscribe({ endpoint: ENDPOINT, ...KEYS }, { how: 'local' }),
    ).rejects.toThrow('no longer paired')
  })

  it('refuses an endpoint the sender would refuse, at the moment of the write', async () => {
    const it_ = await half()
    await expect(
      it_.half.subscribe(
        { endpoint: 'https://127.0.0.1/x', ...KEYS },
        { how: 'remote', device: DEVICE },
      ),
    ).rejects.toThrow('endpoint')
  })

  it('replaces whatever that device said before', async () => {
    const it_ = await half()
    const from = { how: 'remote', device: DEVICE } as const
    await it_.half.subscribe({ endpoint: ENDPOINT, ...KEYS }, from)
    await it_.half.subscribe({ endpoint: `${ENDPOINT}-new`, ...KEYS }, from)
    const { pushes } = await readPushes(it_.home)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.endpoint).toBe(`${ENDPOINT}-new`)
  })

  it('forgets its own, and says so where there was nothing to forget', async () => {
    const it_ = await half()
    const from = { how: 'remote', device: DEVICE } as const
    expect((await it_.half.forget(from)).did).toBe(false)
    await it_.half.subscribe({ endpoint: ENDPOINT, ...KEYS }, from)
    expect((await it_.half.forget(from)).did).toBe(true)
    const { pushes } = await readPushes(it_.home)
    expect(pushes[0]?.forgotten).toBe('taken back on the device')
  })

  it('reads the setting at the call rather than when the listener came up', async () => {
    const it_ = await half()
    expect(it_.half.unlocked()).toBe(true)
    Object.assign(it_.config().surfaces.web, { push: false })
    expect(it_.half.unlocked()).toBe(false)
  })

  it('says how many lines of the list could not be read', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tade-push-'))
    homes.push(home)
    await writeFile(join(home, 'web-pushes.jsonl'), 'not json\n{"kind":"nope"}\n')
    const it_ = await made()
    homes.push(it_.home)
    const second = new WebPush({
      home: () => home,
      config: it_.config,
      attention: () => attentionFor('push', {}),
      tasks: () => [],
      devices: () => [],
      reach: () => null,
      lastInputAt: () => null,
      writeKey: () => Promise.resolve(),
      tell: (one) => it_.told.push(one),
      now: () => 1_000,
    })
    await second.open()
    expect(String(it_.told[0]?.detail.warning)).toContain('2 line(s)')
  })
})
