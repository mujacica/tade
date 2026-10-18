import { writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { ConfigSchema, type TaskId } from '@tade/core'
import { readDevices } from '@tade/web'
import type { Workbench } from '@tade/workbench'
import type { PendingApproval } from '@tade/workbench/workers'
import { describe, expect, it } from 'vitest'
import { ASKING_FIRST, ASKING_OUT_OF_VIEW, BEHIND_THE_PANEL } from '../../src/panels/away/state.ts'
import { freePort } from './away-harness.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// The keys that answer a device at the door, the whole way through: a ticket
// read off the code the window drew, a phone presenting it on the window's own
// listener, and a yes or a no pressed as a terminal sends it — answered only
// while the device's card is on the screen.
//
// **Loopback, on a port the machine said was free**, as every away test is.

/** The words at the top of the card a device asking draws. */
const CARD = 'A DEVICE WANTS TO PAIR'

describe('a yes or a no to a device at the door', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
  })

  /** The screen as it stands, no taller than the terminal is now. */
  const shown = () => screenOf(terminal.written).slice(0, terminal.rows)
  const says = (said: string) => shown().some((line) => (line ?? '').includes(said))

  /** The window, listening on `port`, tall and wide enough for the code and its link. */
  async function listening(port: number): Promise<void> {
    const web = `surfaces:\n  web:\n    port: ${port}\n    enabled: true\n`
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n${web}`)
    terminal.columns = 160
    terminal.rows = 90
    await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        surfaces: { web: { port, enabled: true } },
      }),
    })
    await until('the first frame', () => says('Ask Tade anything'))
  }

  /** `/away` typed on the line, and the ticket in the link the panel draws. */
  async function ticketDrawn(): Promise<string> {
    const line = find('Ask Tade anything')
    click(line.col, line.row)
    await until('the line open', () => says('enter sends'))
    for (const char of '/away') terminal.press(char)
    await until('what was typed', () => says('/away'))
    terminal.press('\r')
    await until('the code’s link', () => linkOn(shown()) !== null)
    const ticket = (linkOn(shown()) ?? '').split('#t=')[1]
    if (ticket === undefined) throw new Error('the link carries no ticket')
    return ticket
  }

  it('answers only while the card is drawn, read from where the panel was drawn', async () => {
    const port = await freePort()
    await listening(port)
    const asked = pair(port, await ticketDrawn())
    await until('the card', () => says(CARD) || asked.settled())
    expect(asked.settled()).toBe(false)

    // Short enough that the question, the code and the devices do not fit,
    // and a notch of the wheel over the panel scrolls the card off its top.
    terminal.resize(160, 40)
    await until('the window redrawn short', () =>
      (shown()[terminal.rows - 1] ?? '').includes('Extensions'),
    )
    const card = find(CARD)
    terminal.press(`\x1b[<65;${card.col + 1};${card.row + 1}M`)
    await until('the card scrolled away', () => !says(CARD) && says('AWAY VIEW'))

    // Out of view, a yes is refused in words — and nobody is let in.
    terminal.press('a')
    await until('the refusal', () => says(ASKING_OUT_OF_VIEW.slice(0, 30)) || asked.settled())
    expect(asked.settled()).toBe(false)

    // `home` brings the card back, and the same key now means it.
    terminal.press('\x1b[H')
    await until('the card back', () => says(CARD) || asked.settled())
    expect(asked.settled()).toBe(false)
    terminal.press('a')
    expect(await asked.status).toBe(201)
    expect((await readDevices(home)).devices).toHaveLength(1)
  })

  it('with the panel shut, opens it on the device rather than answering one nobody can see', async () => {
    // An agent waiting on an approval in front, which is what makes `a` and
    // `d` the window's own keys at all — and whose card *is* on the screen.
    const decided = waitingAgent()
    const port = await freePort()
    await listening(port)
    const asked = pair(port, await ticketDrawn())
    await until('the card', () => says(CARD) || asked.settled())
    expect(asked.settled()).toBe(false)

    for (const key of ['d', 'a']) {
      // Shut, as escape shuts it, with the device still asking — and the line
      // the code was asked for on left too, so the key is the window's.
      terminal.press('\x1b')
      await until('the panel shut', () => !says('AWAY VIEW'))
      if (says('enter sends')) terminal.press('\x1b')
      await until('the agent’s card in front', () => says('Allow once') && !says('enter sends'))

      terminal.written = ''
      terminal.press(key)
      await until(`the panel opened on ${key}`, () => says(CARD) || asked.settled())
      expect(asked.settled(), key).toBe(false)
      // Said, so a press meant for the agent's card is not taken for one that answered it.
      expect(says(ASKING_FIRST), key).toBe(true)
      expect(decided, key).toEqual([])
    }

    // Looking at it, the same key lets it in.
    terminal.press('a')
    expect(await asked.status).toBe(201)
    expect((await readDevices(home)).devices).toHaveLength(1)
    expect(decided).toEqual([])
  })

  it('with nobody asking, answers no agent whose card is behind the open panel', async () => {
    const decided = waitingAgent()
    await listening(await freePort())
    await until('the agent’s card in front', () => says('Allow once'))
    // The panel open over it, and nobody at the door.
    await ticketDrawn()

    const refusal = () => says(BEHIND_THE_PANEL.slice(0, 30))
    for (const key of ['a', 'd']) {
      terminal.press(key)
      await until(`the refusal on ${key}`, () => refusal() || decided.length > 0)
      expect(decided, key).toEqual([])
      expect(says('AWAY VIEW'), key).toBe(true)
      // Any other key quiets it, so the next refusal is the next key's own.
      terminal.press('\x1b[H')
      await until('the refusal gone', () => !refusal())
    }

    // Closed, the card is in front again, and the same key answers it.
    terminal.press('\x1b')
    await until('the panel shut', () => !says('AWAY VIEW'))
    if (says('enter sends')) terminal.press('\x1b')
    await until('the agent’s card in front', () => says('Allow once') && !says('enter sends'))
    terminal.press('a')
    await until('the agent answered', () => decided.length > 0)
    expect(decided).toEqual([{ allow: true }])
  })

  /** An agent waiting on an approval in front, and what was decided about it. */
  function waitingAgent(): unknown[] {
    const pending: PendingApproval[] = [
      {
        run: 'run-1' as PendingApproval['run'],
        task: 'app/refunds' as TaskId,
        requestId: 'req-1',
        tool: 'bash',
        summary: 'rm -rf dist',
        tier: 'hard',
        rule: 'ask before deleting',
        reason: 'it deletes',
        at: 1,
      },
    ]
    client.pendingApprovals = ((task?: string) =>
      pending.filter(
        (one) => task === undefined || one.task === task,
      )) as typeof client.pendingApprovals
    const decided: unknown[] = []
    client.decideApproval = (async (_run, _request, decision) => {
      decided.push(decision)
    }) as typeof client.decideApproval
    return decided
  }
})

/** The pairing link drawn on a screen, or null. */
function linkOn(lines: readonly string[]): string | null {
  for (const line of lines) {
    const found = (line ?? '').match(/http:\/\/localhost:\d+\/pair#\S+/)
    if (found) return found[0]
  }
  return null
}

/**
 * A phone presenting a ticket on the window's own listener, as the page does:
 * the answer comes only once somebody at the machine has said yes or no.
 */
function pair(port: number, ticket: string): { status: Promise<number>; settled: () => boolean } {
  const host = `localhost:${port}`
  const body = JSON.stringify({ ticket, label: 'iPhone' })
  let settled = false
  const status = new Promise<number>((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/pair',
        method: 'POST',
        headers: {
          host,
          origin: `http://${host}`,
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          'content-length': String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        res.resume()
        res.on('end', () => {
          settled = true
          done(res.statusCode ?? 0)
        })
      },
    )
    req.on('error', (error) => {
      settled = true
      failed(error)
    })
    req.end(body)
  })
  // The window closing answers it too; nothing here waits on that.
  status.catch(() => {})
  return { status, settled: () => settled }
}
