import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { type FarAgent, type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedRemote } from '@tade/remotes-scripted'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// An agent on another machine, opened from this window (REMOTE-TADE.md §3.4,
// §9.4) — the whole of it through the window: its row pressed down the side,
// its screen read from that machine while it is looked at, a sentence sent as
// its `steer`, a press that parks it or answers what it is held on, and a
// terminal here that is the agent there. The far end is a real away view
// (`far.ts`) and the link the scripted one, which opens a terminal there by
// running that machine's own line in a shell here, where it is.

const INTAKE: FarAgent = {
  task: 'tade/intake-door',
  title: 'Doorbell',
  screen:
    '> wire the hook to the doorbell\n● Bash(gh api repos/acme/x/hooks)\n  Do you want to proceed?',
  approval: {
    id: 'call-7',
    tool: 'Bash',
    command: 'gh api repos/acme/x/hooks --method POST\n./scripts/ring.sh ~/.tade/doorbell',
  },
}

const LINK: FarAgent = {
  task: 'tade/remote-link',
  title: 'Linking',
  reason: 'running the suite',
  screen: '> running the suite\n  14 passed',
}

describe('an agent on another machine, from this window', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let home: string
  let root: string
  const fars: FarEnd[] = []
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
    client = one.client
    home = one.home
    root = one.repo.root
  })

  afterEach(async () => {
    await Promise.all(fars.map((far) => far.close()))
    await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
    fars.length = 0
  })

  const rows = () => screenOf(terminal.written)
  const shown = (text: string) => rows().some((row) => row.includes(text))

  /** Click the first place a label is drawn on the last frame, top down. */
  function press(label: string): void {
    const lines = rows()
    for (let row = 0; row < lines.length; row++) {
      const col = lines[row]?.indexOf(label) ?? -1
      if (col >= 0) {
        wired.click(col + 1, row)
        return
      }
    }
    throw new Error(`"${label}" is not on screen`)
  }

  /** Press an agent's row down the side, where the pane beside it may say its name too. */
  function row(label: string): void {
    const lines = rows()
    for (let at = 1; at < lines.length; at++) {
      const line = lines[at] ?? ''
      const edge = Math.max(line.indexOf('│'), line.indexOf('┃'))
      const col = line.indexOf(label)
      if (col >= 0 && (edge < 0 || col < edge)) {
        wired.click(col + 1, at)
        return
      }
    }
    throw new Error(`no row says "${label}"`)
  }

  /** The window, linked to a far end called `vps` with these agents, standing in its project. */
  async function linkedTo(agents: readonly FarAgent[]): Promise<FarEnd> {
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    far.show(['tade'], {}, agents)
    const table = new Map<string, ScriptedRemote>([['vps', far]])
    const session = await far.pair('mac')
    const vps = {
      ssh: 'vps',
      tade: 'tade',
      device: session.device,
      session: session.cookie,
      csrf: session.csrf,
      host: session.host,
    }
    // In the file too, so the window's own reading of it finds the same remote.
    await writeFile(
      join(home, 'config.yaml'),
      [
        `projects:\n  app:\n    root: ${root}`,
        'remotes:\n  vps:',
        ...Object.entries(vps).map(([key, value]) => `    ${key}: ${value}`),
        '',
      ].join('\n'),
    )
    await wired.start({
      config: ConfigSchema.parse({ projects: { app: { root } }, remotes: { vps } }),
      remoteLinks: {
        ssh: (options) => makeScriptedLink({ ...options, remotes: table, terminals: true }),
      },
    })
    // Eighty columns fold a machine's projects into its chip: its menu is them.
    await until('vps along the top', () => (rows()[0] ?? '').includes('vps'), 20_000)
    const top = rows()[0] ?? ''
    wired.click(top.indexOf('vps') + 1, 0)
    await until(
      'its projects',
      () =>
        rows()
          .slice(1)
          .some((row) => row.includes('tade')),
      20_000,
    )
    terminal.press('\r')
    await until('its agents down the side', () => shown(agents[0]?.title ?? ''), 20_000)
    return far
  }

  it('shows the screen of the agent pressed, as that machine reads it, and lets go of it', async () => {
    await linkedTo([INTAKE, LINK])
    row('Doorbell')
    // Its newest rows: the card over it takes the room its command needs first.
    await until('its screen there', () => shown('Do you want to proceed?'), 20_000)
    expect(shown('its screen on vps · read-only')).toBe(true)
    // What it waits to run, whole, as that machine sent it: both of its lines.
    expect(shown('wants approval')).toBe(true)
    expect(shown('Bash  gh api repos/acme/x/hooks --method POST')).toBe(true)
    expect(shown('./scripts/ring.sh ~/.tade/doorbell')).toBe(true)
    // Another row is another agent's screen.
    row('Linking')
    await until('the other screen', () => shown('14 passed'), 20_000)
    expect(shown('Do you want to proceed?')).toBe(false)
    // The one in front, pressed again, is let go of: the project as it was.
    row('Linking')
    await until('the project again', () => !shown('its screen on vps'), 20_000)
  })

  it('carries a sentence, a park and an answer there, each with what this window last saw', async () => {
    const far = await linkedTo([INTAKE])
    row('Doorbell')
    await until('its controls', () => shown('steer…'), 20_000)

    press('steer…')
    await until('the line to say it on', () => shown('Tell Doorbell on vps'))
    terminal.press('check the signature first')
    terminal.press('\r')
    await until('the sentence there', () => far.acted.some((one) => one.verb === 'steer'), 20_000)
    expect(far.acted.find((one) => one.verb === 'steer')?.call).toMatchObject({
      task: 'tade/intake-door',
      said: 'check the signature first',
    })
    // The line goes once that machine has answered, and what it said is said here.
    await until('what came of it', () => shown('vps: steer done there'), 20_000)

    press('[ park ]')
    await until('the park there', () => far.acted.some((one) => one.verb === 'park'), 20_000)
    await until('what came of that', () => shown('vps: park done there'), 20_000)
    expect(far.acted.find((one) => one.verb === 'park')?.call).toMatchObject({
      task: 'tade/intake-door',
      parked: true,
    })

    press('[ allow ]')
    await until('the answer there', () => far.acted.some((one) => one.verb === 'answer'), 20_000)
    expect(far.acted.find((one) => one.verb === 'answer')?.call).toMatchObject({
      task: 'tade/intake-door',
      approval: 'call-7',
      allow: true,
    })
    // What that machine said came of it is said here.
    await until('what it said', () => shown('vps: answer done there'), 20_000)
    // Each act named the row as this window last saw it, which is what makes
    // a press against a screen out of date that machine's to refuse.
    for (const act of far.acted) expect(typeof act.call.was).toBe('string')
  })

  it('opens a terminal here that is the agent there on enter, in front of the lower pane, and the same one again', async () => {
    const far = await linkedTo([INTAKE])
    far.attachable.set('tade/intake-door', 'echo attached-to-the-door; exec sleep 60')
    row('Doorbell')
    await until('its controls', () => shown('type into it'), 20_000)
    // Enter, with nothing typed on the line: the key the pane's first control names.
    terminal.press('\r')
    await until(
      'the terminal there',
      () => client.lanes().some((lane) => lane.id === 'remotes/vps/1' && lane.alive),
      20_000,
    )
    await until('what it printed, in the lower pane', () => shown('attached-to-the-door'), 20_000)
    expect(shown('vps · intake-door')).toBe(true)
    // It is no terminal of a project's: the orchestrator's tools never type into it.
    expect(client.terminals().map((one) => one.id)).not.toContain('remotes/vps/1')
    // Asked again, the one already open comes to the front; no second is opened.
    press('type into it')
    await until('the same terminal', () => shown('attached-to-the-door'), 20_000)
    expect(client.lanes().filter((lane) => lane.id.startsWith('remotes/'))).toHaveLength(1)
  })

  it('keeps a terminal there that ended badly, with what it said, until enter closes it', async () => {
    const far = await linkedTo([INTAKE])
    far.attachable.set('tade/intake-door', "echo 'no session called tade-1 there' >&2; exit 1")
    row('Doorbell')
    await until('its controls', () => shown('type into it'), 20_000)
    press('type into it')
    // Its tab stays, saying what the far end said, rather than vanishing in silence.
    await until('what it said', () => shown('no session called tade-1 there'), 20_000)
    await until('that it ended', () => shown('[it ended (1): press enter to close]'), 20_000)
    expect(client.lanes().some((lane) => lane.id === 'remotes/vps/1' && lane.alive)).toBe(true)
    terminal.press('\r')
    await until(
      'its tab closed',
      () => !client.lanes().some((lane) => lane.id === 'remotes/vps/1' && lane.alive),
      20_000,
    )
  })

  it('says why where that machine has no terminal for its agent, and opens nothing', async () => {
    await linkedTo([INTAKE])
    row('Doorbell')
    await until('its controls', () => shown('type into it'), 20_000)
    press('type into it')
    await until('why not', () => shown('its agent is not running there'), 20_000)
    expect(client.lanes().some((lane) => lane.id.startsWith('remotes/'))).toBe(false)
  })
})
