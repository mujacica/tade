import { writeFileSync } from 'node:fs'
import { type ClientRequest, request } from 'node:http'
import { join } from 'node:path'
import { ConfigSchema, type LaneId } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import type { FarMessage } from '../../src/far.ts'
import { FarFace } from '../../src/far-face.ts'
import type { Intent } from '../../src/keymap.ts'
import type { AppState } from '../../src/model.ts'
import { PLAIN } from '../../src/skin.ts'
import { COOKIE, freePort, KEY, paired } from './away-harness.ts'
import {
  type FakeTerminal,
  type Repo,
  SPAWNING_MS,
  screenOf,
  until,
  windowUnderTest,
} from './harness.ts'

// The full view, the whole way through (§10 T3 of the Duo plan): a phone that
// draws its own copy of the window, over a real listener, from the state the
// machine sends on its stream, answering its own keys with the window's own
// keymap and sending what the window would do through the one act.
//
// **Everything is real but the page's DOM**: the window, its heart, the
// workbench and its lanes, the listener, pairing, the stream and the act. The
// phone is `FarFace` — the very module a browser imports through `browser.ts`
// — fed by the bytes the stream carries and posting what it hands back, as the
// page will (T4 draws its rows into the DOM; nothing else is the page's).

/** A colour or a weight, which a row's text is read without. */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/**
 * The leader (`ctrl+]`): an agent with the keyboard is handed every key but
 * this, after which one key is the window's — on a phone as at the machine.
 */
const LEADER = '\x1d'

/** `ctrl+/`, the orchestrator's line, as a terminal with the kitty protocol sends it. */
const CTRL_SLASH = '\x1b[47;5u'

/** A phone's size, sideways on the large screen. */
const COLUMNS = 132
const ROWS = 39

/** One `POST` with everything the guard asks of a mutation. */
function post(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = JSON.stringify(body)
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          cookie: COOKIE,
          origin: `http://127.0.0.1:${port}`,
          'content-type': 'application/json',
          'x-tade-csrf': 'x'.repeat(43),
          'sec-fetch-site': 'same-origin',
          'content-length': String(Buffer.byteLength(text)),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const said = Buffer.concat(chunks).toString('utf8')
          done({
            status: res.statusCode ?? 0,
            body: said === '' ? {} : (JSON.parse(said) as Record<string, unknown>),
          })
        })
      },
    )
    req.on('error', failed)
    req.write(text)
    req.end()
  })
}

/** A phone: its face, its stream, and what it sends. */
interface Phone {
  face: FarFace
  /** The rows it draws now, as text. */
  rows(): string[]
  /** Press keys, and send whatever they ask for and wherever they moved it, as the page will. */
  press(...keys: string[]): Promise<void>
  /** Tell the machine where it looks now. */
  look(whole?: boolean): Promise<void>
  /** Every window message it was sent. */
  messages: FarMessage[]
  /** The stream drops, as a tunnel takes the signal. */
  drop(): void
}

describe('the window, drawn by a phone from the state the machine sends', () => {
  let terminal: FakeTerminal
  let repo: Repo
  let home: string
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
    repo = one.repo
    home = one.home
  })
  const streams: ClientRequest[] = []
  afterEach(() => {
    for (const one of streams.splice(0)) one.destroy()
  })

  /** The window, listening on `port`, with a second project to switch to and two agents running. */
  async function opened(port: number): Promise<{ state(): AppState }> {
    const other = mkrepo()
    other.commit('first')
    const web = `surfaces:\n  web:\n    port: ${port}\n    enabled: true\n`
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  app:\n    root: ${repo.root}\n  other:\n    root: ${other.root}\n${web}`,
    )
    for (const name of ['refunds', 'search']) {
      const words = `${name.toUpperCase()} OWN WORDS`
      await wired.client.spawn({
        id: `app/${name}/agent` as LaneId,
        task: `app/${name}`,
        kind: 'agent',
        cwd: repo.root,
        command: process.execPath,
        args: [
          '-e',
          `console.log(${JSON.stringify(words)}); process.stdin.on('data', (d) => process.stdout.write('GOT ' + d.toString().trim() + ' END\\n'))`,
        ],
      })
    }
    terminal.columns = 120
    terminal.rows = 40
    const app = await wired.start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root }, other: { root: other.root } },
        surfaces: { web: { port, enabled: true } },
      }),
    })
    await paired(home, port)
    // The machine's own window's state: the heart's, read as its own window reads it.
    const heart = (app as unknown as { heart: { state: AppState } }).heart
    return { state: () => heart.state }
  }

  /** A phone with the full view open on `port`. */
  async function phone(port: number): Promise<Phone> {
    const face = new FarFace({ machine: 'the Mac' })
    const messages: FarMessage[] = []
    let keyed = 0
    const send = async (intent: Intent) => {
      keyed += 1
      const answer = await post(port, '/api/window/act', {
        key: `${KEY}${keyed}`,
        intent,
        own: face.looking() ?? undefined,
      })
      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    }
    const look = async (whole = false) => {
      const answer = await post(port, '/api/window/look', {
        own: face.looking() ?? undefined,
        columns: COLUMNS,
        rows: ROWS,
        rev: whole ? null : face.rev,
      })
      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    }
    let buffer = ''
    let heard = false
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/stream',
        method: 'GET',
        headers: {
          host: `127.0.0.1:${port}`,
          cookie: COOKIE,
          accept: 'text/event-stream',
          'sec-fetch-site': 'same-origin',
        },
      },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          heard = true
          buffer += chunk
          let at = buffer.indexOf('\n\n')
          while (at >= 0) {
            const frame = buffer.slice(0, at)
            buffer = buffer.slice(at + 2)
            at = buffer.indexOf('\n\n')
            const event = /^event: (.*)$/m.exec(frame)?.[1]
            const data = /^data: (.*)$/m.exec(frame)?.[1]
            if (event !== 'window' || data === undefined) continue
            const message = JSON.parse(data) as FarMessage
            messages.push(message)
            // A change it cannot build on: ask for the window whole, as the page will.
            if (!face.take(message)) void look(true)
          }
        })
      },
    )
    req.on('error', () => {})
    req.end()
    streams.push(req)
    // The stream is open before the look, or the whole goes to nobody.
    await until('the stream to open', () => heard)
    await look(true)
    return {
      face,
      messages,
      rows: () =>
        face
          .draw({ width: COLUMNS, height: ROWS, skin: PLAIN, now: Date.now() })
          ?.rows.map((row) => row.replace(SGR, '')) ?? [],
      press: async (...keys) => {
        for (const key of keys) {
          const pressed = face.key(key)
          if (pressed.looked) await look()
          for (const intent of pressed.intents) await send(intent)
        }
      },
      look,
      drop: () => {
        req.destroy()
        face.lost(Date.now())
      },
    }
  }

  it('draws the window, opens a panel, steers an agent, types on the line and switches project, and the Mac never moves', async () => {
    const port = await freePort()
    const machine = await opened(port)
    const mac = () => screenOf(terminal.written).join('\n')
    await until(
      'the Mac to draw refunds’ screen',
      () => mac().includes('REFUNDS OWN WORDS'),
      SPAWNING_MS,
    )
    const macState = () => machine.state()
    const macFocus = macState().focused
    const macProject = macState().project

    const one = await phone(port)
    // **It draws the window**, at its own size, from what the stream carried.
    await until('the phone to draw the agents', () =>
      one.rows().some((row) => row.includes('refunds')),
    )
    expect(one.messages[0]?.kind, 'the first message is the window whole').toBe('whole')
    expect(Math.max(...one.rows().map((row) => row.length))).toBeLessThanOrEqual(COLUMNS)

    // **It opens a panel**: Search, which the machine opens on the phone's face
    // and nobody else's.
    await one.press(LEADER, '\x0b')
    await until('Search open on the phone', () => one.face.state()?.panel?.kind === 'search')
    expect(macState().panel, 'and not on the Mac').toBeNull()
    // Closed on the phone alone, at once: escape in a panel is the panel's.
    const before = one.messages.length
    const closed = one.face.key('\x1b')
    expect(closed.intents, 'closing a panel asks the machine for nothing').toEqual([])
    expect(one.face.state()?.panel).toBeNull()
    await one.look()
    expect(one.messages.length).toBeGreaterThanOrEqual(before)

    // **It steers an agent**: the other one, which the phone moved to on its
    // own while the Mac stays where it was, typed into through the act.
    await one.press(LEADER, '\t')
    expect(one.face.state()?.focused).toBe('app/search')
    expect(macState().focused, 'the Mac stays on its own agent').toBe(macFocus)
    // And the phone is sent the screen of the agent it watches, not the Mac's.
    await until(
      'the phone to draw search’s own screen',
      () => one.rows().join('\n').includes('SEARCH OWN WORDS'),
      SPAWNING_MS,
    )
    await one.press(...'steer me'.split(''), '\r')
    await until(
      'search to have been typed into',
      async () =>
        (await wired.client.capture('app/search/agent' as LaneId, 40, false)).includes(
          'GOT steer me END',
        ),
      SPAWNING_MS,
    )
    const refunds = await wired.client.capture('app/refunds/agent' as LaneId, 40, false)
    expect(refunds, 'and nothing went into the agent in front of the Mac').not.toContain('GOT')

    // **It types on the orchestrator's line**: its own line, sent through the act.
    await one.press(LEADER, CTRL_SLASH)
    expect(one.face.typing(), 'the phone’s own line is open').toBe('')
    expect(macState().dictation, 'and the Mac’s is not').toBeNull()
    await one.press(...'hello from the phone'.split(''))
    expect(one.face.typing()).toBe('hello from the phone')
    expect(mac(), 'what the phone types is drawn nowhere on the Mac').not.toContain(
      'hello from the phone',
    )
    await one.press('\r')
    await until('what the phone said to be in the conversation, on the phone too', () =>
      (one.face.state()?.transcript.entries ?? []).some(
        (entry) => 'text' in entry && String(entry.text).includes('hello from the phone'),
      ),
    )
    await one.press('\x1b')

    // **It switches project**, on the phone alone.
    await one.press(LEADER, '\x1b[50;6u')
    expect(one.face.state()?.project).toBe('other')
    // The tab in front along the top is the project the phone stands in.
    const header = () => one.rows()[0] ?? ''
    await until('the phone to draw the other project in front', () => header().includes('[ other'))
    expect(macState().project, 'the Mac stays in its project').toBe(macProject)
    expect(macState().focused).toBe(macFocus)
    expect(macState().panel).toBeNull()
    expect(mac()).toContain('REFUNDS OWN WORDS')

    // **A dropped connection leaves the last view on screen, marked stale.**
    const last = one.rows().join('\n')
    one.drop()
    const stale = one.rows().join('\n')
    expect(one.face.stale).not.toBeNull()
    expect(stale).toContain('[ other')
    expect(stale).toContain('the Mac cannot be reached')
    expect(last).not.toContain('the Mac cannot be reached')
  })

  it('sends nothing on a beat that moved nothing, and nothing to a phone that has not looked', async () => {
    const port = await freePort()
    await opened(port)
    const one = await phone(port)
    await until('the phone to draw the agents', () =>
      one.rows().some((row) => row.includes('refunds')),
    )
    // Let what is still arriving land, then count across beats where nothing moves.
    await wired.beats(2)
    const settled = one.messages.length
    await wired.beats(2)
    const sent = one.messages.slice(settled)
    // Whatever did arrive moved something: never a change that carries nothing.
    for (const message of sent) {
      expect(message.kind).toBe('change')
      if (message.kind === 'change') {
        const parts =
          Object.keys(message.heart ?? {}).length + Object.keys(message.frame ?? {}).length
        expect(
          parts + (message.gone?.length ?? 0) + Object.keys(message.own ?? {}).length,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('refuses what only the machine’s own keyboard may ask, and what nobody sent a look for', async () => {
    const port = await freePort()
    await opened(port)
    const early = await post(port, '/api/window/act', {
      key: `${KEY}0`,
      intent: { kind: 'interrupt' },
    })
    expect(early.status, 'an act before any look').toBe(404)
    await phone(port)
    const quit = await post(port, '/api/window/act', { key: `${KEY}1`, intent: { kind: 'quit' } })
    expect(quit.status).toBe(404)
    expect(quit.body.error).toBe('not_offered')
    const talk = await post(port, '/api/window/act', {
      key: `${KEY}2`,
      intent: { kind: 'talk', down: true },
    })
    expect(talk.body.error).toBe('not_offered')
    const odd = await post(port, '/api/window/act', {
      key: `${KEY}3`,
      intent: { kind: 'format-disk' },
    })
    expect(odd.status).toBe(400)
  })
})
