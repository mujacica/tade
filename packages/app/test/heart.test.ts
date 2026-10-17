import { readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSchema } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { AUTH_BYTES, appendPush, generateVapid, P256DH_BYTES, scriptedPusher } from '@tade/web'
import { readTaskFile, Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import {
  Heart,
  NOBODY_TO_TELL,
  type Said,
  saidLine,
  saidSince,
  WHILE_STARTING,
} from '../src/heart.ts'
import type { Entry, ThinkerEvent } from '../src/transcript.ts'
import type { AppOptions } from '../src/wire/context.ts'
import { COOKIE, DEVICE, freePort, paired } from './wire/away-harness.ts'
import { SPAWNING_MS, until } from './wire/harness.ts'

// The part of the window that runs with no screen (`heart.ts`), on its own:
// a real workbench over a real repository, and no terminal anywhere. What the
// window draws of the same work is held by the window's own tests — `queue`,
// `schedules`, `intake` under `test/wire` — which run through this part too.

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

/**
 * What loads a relative file: an import or a re-export that is not type-only,
 * and an import for its effect. One statement each, never across two — with no
 * semicolons to stop at, a pattern that may cross a line runs from one
 * statement into the next and follows a type-only import it was never in.
 */
const LOADS = [
  /^import (?!type )(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\* as [\w$]+|[\w$]+) from '(\.[^']+)'/gm,
  /^import '(\.[^']+)'/gm,
  /^export (?!type )(?:\{[^}]*\}|\*(?: as [\w$]+)?) from '(\.[^']+)'/gm,
]

/** Every file of this package the heart reaches, following relative imports from `heart.ts`. */
function reached(): Set<string> {
  const seen = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const loads of LOADS)
      for (const found of text.matchAll(loads)) walk(resolve(dirname(file), found[1] ?? ''))
  }
  walk(join(src, 'heart.ts'))
  return seen
}

describe('the heart reaches nothing that takes a terminal', () => {
  it('loads neither the window nor the screen it paints, and makes no terminal anywhere', () => {
    const files = reached()
    expect(files.has(join(src, 'heart.ts'))).toBe(true)
    // What it is there to run, so the walk is known to have walked.
    for (const one of [
      'live.ts',
      'wire/queue.ts',
      'wire/schedules.ts',
      'wire/intake.ts',
      'wire/orchestrator.ts',
      'wire/web.ts',
      'wire/web-push.ts',
      'wire/settings.ts',
    ])
      expect(files.has(join(src, one))).toBe(true)
    // The face, the files that take the terminal — the window and its paint —
    // and the screen a form borrows it for.
    for (const one of [
      'app.ts',
      'wire/paint.ts',
      'wire/keyboard.ts',
      'wire/mouse.ts',
      'wire/screens.ts',
      'screen.ts',
    ])
      expect(files.has(join(src, one))).toBe(false)
    const takes =
      /import \{[^}]*\b(ProcessTerminal|TuiAltScreen|TUI)\b[^}]*\} from '@earendil-works\/pi-tui'/
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toMatch(takes)
  })
})

describe('what is said where nothing draws it', () => {
  const tade = (text: string, at = 0): Said => ({ kind: 'tade', text, at })

  it('is each line the conversation gained, once, and never what it already had', () => {
    const one = tade('one')
    const two = tade('two')
    const asked: Entry = { kind: 'you', text: 'hi', images: [], at: 0, from: 'device 00aa' }
    expect(saidSince([], [one])).toEqual([one])
    expect(saidSince([one], [one, asked, two])).toEqual([asked, two])
    const same = [one]
    expect(saidSince(same, same)).toEqual([])
    // The oldest falling off the front is not a line said.
    expect(saidSince([one, two], [two])).toEqual([])
  })

  it("is the orchestrator's words once they are whole, and a tool once it has answered", () => {
    const arriving: Entry = {
      kind: 'said',
      text: 'On i',
      streaming: true,
      by: 'orchestrator',
      at: 0,
    }
    const whole: Entry = { ...arriving, text: 'On it.', streaming: false }
    const running: Entry = {
      kind: 'tool',
      id: 'call_1',
      tool: 'tade_queue',
      detail: '',
      state: 'running',
      result: '',
      progress: null,
      at: 0,
    }
    const answered: Entry = { ...running, state: 'ok' }
    // Neither is said while it is still moving: a reply a word at a time, or a
    // tool that has not answered, would be a line per piece of it.
    expect(saidSince([], [arriving, running])).toEqual([])
    expect(saidSince([arriving, running], [whole, answered])).toEqual([whole, answered])
    // A suggestion is something to click, and there is nothing to click.
    const offer: Entry = { kind: 'suggestion', text: 'ask', ask: 'what did it find?', at: 0 }
    expect(saidSince([], [offer])).toEqual([])
  })

  it('is written with its time, trouble marked as the conversation marks it, and made printable', () => {
    const at = new Date(2026, 9, 17, 9, 5).getTime()
    expect(saidLine(tade('started app/refunds: it was ready', at))).toBe(
      '09:05 started app/refunds: it was ready',
    )
    expect(saidLine({ kind: 'problem', text: `a ticket \x1b[31mred\x1b[0m`, at })).toBe(
      '09:05 ✗ a ticket ␛red␛',
    )
  })

  it('says who said it where it was not Tade, on one line', () => {
    const at = new Date(2026, 9, 17, 9, 5).getTime()
    expect(
      saidLine({
        kind: 'said',
        text: 'Parked it.\nIt waits for you.',
        streaming: false,
        by: 'orchestrator',
        at,
      }),
    ).toBe('09:05 orchestrator: Parked it. It waits for you.')
    expect(
      saidLine({ kind: 'you', text: 'park the flaky one', images: [], at, from: 'device 00aa' }),
    ).toBe('09:05 device 00aa: park the flaky one')
    const tool = {
      kind: 'tool',
      id: 'call_1',
      tool: 'tade_proposal_decide',
      detail: 'app/bring-in-shed',
      result: '',
      progress: null,
      at,
    } as const
    expect(saidLine({ ...tool, state: 'ok' })).toBe(
      '09:05 orchestrator ran tade_proposal_decide app/bring-in-shed: done',
    )
    expect(saidLine({ ...tool, state: 'failed', result: 'not yours to start' })).toBe(
      '09:05 orchestrator ran tade_proposal_decide app/bring-in-shed: failed — not yours to start',
    )
  })
})

describe('the heart, with no screen', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench
  let heart: Heart | null = null
  let said: Said[] = []

  beforeEach(async () => {
    repo = mkrepo()
    repo.commit('first')
    home = repo.home
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home })
    said = []
  })

  afterEach(async () => {
    const [was, workbench] = [heart, client]
    heart = null
    await was?.stop().catch(() => {})
    await workbench?.close().catch(() => {})
  })

  const alone = async (over: Partial<AppOptions> = {}): Promise<Heart> => {
    heart = await Heart.alone(
      {
        client,
        config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
        home,
        cwd: repo.root,
        ...over,
      },
      (line) => said.push(line),
    )
    return heart
  }
  const sayings = () => said.flatMap((line) => (line.kind === 'tool' ? [] : [line.text]))

  it('starts queued work by its own rule on the beat, and says why in the log', async () => {
    const running = await alone()
    await until('the first look', () => running.live?.hasLooked === true)
    const answer = await running.queueTools().plan({
      project: 'app',
      said: 'charge once, then give refunds back',
      agents: [
        { name: 'charge-once', said: 'charge once', prompt: '', after: [], touches: ['charge.ts'] },
        {
          name: 'refund-back',
          said: 'then give refunds back',
          prompt: '',
          after: [{ agent: 'charge-once', why: 'both change charge.ts' }],
          touches: ['charge.ts'],
        },
      ],
    })
    expect(answer).toContain('Started charge-once.')
    expect(answer).toContain('Queued refund-back (after app/charge-once).')

    // Nobody asks and nothing draws: the first finishing is what starts the second.
    await client.markDone('app/charge-once', { by: 'you' })
    await until(
      'the second started',
      () => client.runs().some((run) => run.task === 'app/refund-back'),
      SPAWNING_MS,
    )
    await until('it said so', () =>
      sayings().includes('started app/refund-back: app/charge-once has finished'),
    )
    // Said once, though it was news for an orchestrator as well: there is none
    // here, and the conversation already said it in the same words.
    expect(sayings().filter((text) => text.startsWith(NOBODY_TO_TELL))).toEqual([])
    expect(sayings().filter((text) => text.includes('refund-back: app/charge-once'))).toHaveLength(
      1,
    )
  })

  it('runs a schedule that came due, and says what was only for the orchestrator', async () => {
    let clock = Date.now()
    const running = await alone({ now: () => clock })
    await running.queueTools().schedule({
      name: 'Morning brief',
      project: 'app',
      said: 'in a moment, tell me what happened',
      when: { at: new Date(clock + 60_000).toISOString() },
      ask: 'Say what the agents did, and what needs the person first.',
    })
    clock += 61_000
    await until(
      'it ran',
      async () => (await client.events({ types: ['schedule_fired'] })).length === 1,
    )
    await until('the log says so', () =>
      sayings().includes('Morning brief ran: the orchestrator is asked'),
    )
    // There is no orchestrator here: what it would have been asked is not let
    // go in silence.
    await until('what it was asked, said', () =>
      sayings().some(
        (text) =>
          text.startsWith(NOBODY_TO_TELL) &&
          text.includes('Say what the agents did, and what needs the person first.'),
      ),
    )
  })

  it('looks with a watch on its clock and parks what it finds for the orchestrator', async () => {
    let clock = Date.now()
    const found: { key: string; title: string }[] = []
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          watches: [
            {
              id: 'rain',
              title: 'Rain',
              means: 'Looks for rain, and starts an agent to bring the washing in.',
              every: '1h',
              check: async () => ({ found }),
              agent: (finding) => ({
                title: `bring in ${finding.key}`,
                prompt: `It is raining: ${finding.title}.`,
              }),
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    await alone({ extensions, now: () => clock })
    // Turned on as a person's press turns it on: the orchestrator's tool would
    // need their words naming it (`mayWatch`), and there is nobody to say them.
    await client.setSchedule(
      {
        id: 'rain',
        name: 'Rain',
        project: 'app',
        said: 'watch for rain and bring the washing in',
        when: { every: '1h' },
        does: { kind: 'watch', watch: 'weather.rain', input: {}, found: 'agent', most: 2 },
        missed: 'once',
        by: 'you',
        created: new Date(clock).toISOString(),
      },
      'you',
    )
    found.push({ key: 'shed', title: 'rain over the shed' })
    clock += 3_600_000 + 1_000
    await until('it looked and made the work', async () =>
      (await client.events({ types: ['watch_checked'] })).some(
        (event) => (event.detail as { found?: number }).found === 1,
      ),
    )
    await until('the work parked', async () =>
      Boolean((await readTaskFile(home, 'app/bring-in-shed'))?.parked),
    )
    // Nothing starts what was made for somebody to decide, and nobody is here to.
    expect(client.runs()).toEqual([])
    await until('the log names it for the orchestrator', () =>
      sayings().some(
        (text) => text.startsWith(NOBODY_TO_TELL) && text.includes('app/bring-in-shed'),
      ),
    )
  })

  it('folds what was handed over from outside, with nothing drawing the inbox', async () => {
    repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge on retries' })
    const running = await alone()
    const where = {
      item: 'cli:req-1',
      source: 'cli',
      external_id: 'req-1',
      revision: '1',
      project: 'app',
      requester: 'kim',
      hash: 'sha256:aaa',
      ref: 'req-1.0001.json',
      url: 'https://example.invalid/req-1',
      watch: 'intake.cli',
      schedule: 'intake-cli',
    }
    await client.log.append({ type: 'intake_received', detail: where })
    await client.log.append({
      type: 'intake_accepted',
      task: 'app/refunds',
      detail: {
        ...where,
        grant: 'surfaces.intake.sources.cli',
        mode: 'propose',
        template: 'bug',
        version: 3,
      },
    })
    await until('the inbox folded on the beat', () =>
      (running.intake.facts().intake ?? []).some((row) => row.item === 'cli:req-1'),
    )
    // And the factory floor the away view reads is the same fold.
    await until('the floor rebuilt from it', () =>
      JSON.stringify(running.intake.factory()).includes('cli:req-1'),
    )
  })

  it('listens for a paired phone and tells it when work finishes, with nobody at a screen', async () => {
    repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge on retries' })
    const port = await freePort()
    await paired(home, port, [])
    // Written before the listener comes up, which is when a window reads them.
    await appendPush(home, {
      kind: 'subscribed',
      device: DEVICE,
      at: new Date().toISOString(),
      endpoint: 'https://web.push.apple.com/QDzVM4rMVZ1l0bT8VvPaDQ',
      p256dh: Buffer.alloc(P256DH_BYTES, 4).toString('base64url'),
      auth: Buffer.alloc(AUTH_BYTES, 7).toString('base64url'),
    })
    const pusher = scriptedPusher([])
    // Local midday: the quiet hours are the night's, and a phone told nothing
    // then is the right answer to a different question.
    const midday = new Date()
    midday.setHours(12, 0, 0, 0)
    const running = await alone({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        surfaces: {
          web: {
            enabled: true,
            port,
            install: true,
            push: true,
            push_key: generateVapid().privateKey,
          },
        },
      }),
      pusher: () => pusher,
      now: () => midday.getTime(),
    })
    // The listener came up with the heart: there is no window to have opened it.
    expect(running.away.facts().remote).toEqual({ on: true, devices: 0 })
    // A notification is a transition, so a beat has to have seen the work
    // first: the beat that puts it in the state is the one the push half
    // remembers it from, in the same turn.
    await until('a beat saw the work', () =>
      running.state.panes.some((pane) => pane.task === 'app/refunds'),
    )
    // And it answers the phone what a window would.
    const read = await get(port, '/api/snapshot')
    expect(read.status).toBe(200)
    expect(read.text).toContain('app/refunds')
    await client.markDone('app/refunds', { by: 'you' })
    await until('the phone was told', () => pusher.sent.length === 1, SPAWNING_MS)
    expect(pusher.sent[0]?.notice.body).toBe('Work has finished')
  })

  it('tells the orchestrator what came due once it runs, and writes down what it said and did', async () => {
    let clock = Date.now()
    const running = await alone({ now: () => clock })
    const schedule = (name: string, ask: string) =>
      running.queueTools().schedule({
        name,
        project: 'app',
        said: `in a moment, ${ask.toLowerCase()}`,
        when: { at: new Date(clock + 60_000).toISOString() },
        ask,
      })

    // Before it runs, what a schedule asks of it is written down — and kept
    // for it, so that one coming up hears it.
    await schedule('Morning brief', 'Say what the agents did.')
    clock += 61_000
    await until('said for an orchestrator that is not running', () =>
      sayings().some(
        (text) => text.startsWith(NOBODY_TO_TELL) && text.includes('Say what the agents did.'),
      ),
    )

    // Now one runs: told after its turn as the real one is, and answering
    // through its events, which is all a window ever reads of it.
    const told: string[] = []
    const listeners: ((event: ThinkerEvent) => void)[] = []
    running.attachThinker({
      ask: async () => '',
      tell: async (text) => {
        told.push(text)
        for (const heard of listeners) {
          heard({ type: 'tool', id: 'call_1', tool: 'tade_queue', input: {} })
          heard({ type: 'tool_done', id: 'call_1', ok: true, text: 'nothing is queued' })
          heard({ type: 'message', text: 'Nothing is waiting on you.' })
          heard({ type: 'idle' })
        }
      },
      onEvent: (listener) => {
        listeners.push(listener)
        return () => {}
      },
    })
    expect(sayings()).toContain('orchestrator ready')
    // Nobody types here to carry what it missed with their next words, so it
    // is told at once, with what came while it was starting as its news.
    await until('told what it missed', () => told.length === 1)
    expect(told[0]).toContain(WHILE_STARTING)
    expect(told[0]).toContain('Say what the agents did.')
    // And what it did and said is the log's, where a window would have drawn it.
    await until('its words in the log', () =>
      said.some((line) => line.kind === 'said' && line.text === 'Nothing is waiting on you.'),
    )
    const lines = said.map(saidLine)
    expect(lines.some((line) => line.endsWith('orchestrator ran tade_queue: done'))).toBe(true)
    expect(lines.some((line) => line.endsWith('orchestrator: Nothing is waiting on you.'))).toBe(
      true,
    )

    // Running, what comes due is told it then and there.
    const before = said.length
    await schedule('Evening brief', 'Say what is left.')
    clock += 61_000
    await until('it was told', () => told.some((text) => text.includes('Say what is left.')))
    expect(told).toHaveLength(2)
    // Running, nothing more is said as being for one that is not.
    expect(said.slice(before).filter((line) => saidLine(line).includes(NOBODY_TO_TELL))).toEqual([])
  })
})

/** One read, as a paired phone makes it. */
function get(port: number, path: string): Promise<{ status: number; text: string }> {
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          host: `127.0.0.1:${port}`,
          cookie: COOKIE,
          'sec-fetch-site': 'same-origin',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', failed)
    req.end()
  })
}
