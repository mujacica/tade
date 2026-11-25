import { rm } from 'node:fs/promises'
import { type FarAgent, type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'
import { pressRow, standingThere } from './standing-there.ts'

// An agent on another machine, opened from this window — the whole of it
// through the window, drawn as an agent here is: its row pressed down the
// side, its screen read from that machine while it is looked at, a park from
// its menu and an answer from its card, and a terminal here that is the agent
// there, typed into as its lane. The far end is a real away view
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
  const fars: FarEnd[] = []
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
    client = one.client
  })

  afterEach(async () => {
    await Promise.all(fars.map((far) => far.close()))
    await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
    fars.length = 0
  })

  const rows = () => screenOf(terminal.written)
  const shown = (text: string) => rows().some((row) => row.includes(text))

  /** Click a label once the screen shows it, where the harness finds it. */
  async function press(label: string): Promise<void> {
    await until(`"${label}" on screen`, () => shown(label), 20_000)
    const at = wired.find(label)
    wired.click(at.col + 1, at.row)
  }

  const row = (label: string) => pressRow(wired, label)
  /** The pane's one header, as an agent here has it: its name, then its tabs. */
  const header = (name: string) =>
    rows().some((one) => one.includes(`│ ${name}`) && one.includes('actions'))

  /** The window, linked to a far end called `vps` with these agents, standing in its project. */
  async function linkedTo(agents: readonly FarAgent[]): Promise<FarEnd> {
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    far.show(['tade'], {}, agents)
    await standingThere(wired, far, { terminals: true })
    await until(
      () => `its agents down the side, where the screen shows:\n${rows().join('\n')}`,
      () => shown(agents[0]?.title ?? ''),
      20_000,
    )
    return far
  }

  /** Right-click a row down the side: its menu, as a right-click on an agent here opens it. */
  function menuOf(label: string): void {
    const at = wired.find(label)
    terminal.press(`\x1b[<2;${at.col + 2};${at.row + 1}M`)
    terminal.press(`\x1b[<2;${at.col + 2};${at.row + 1}m`)
  }

  it('shows the agent pressed as an agent here is: its header, its screen as that machine reads it, its card', async () => {
    await linkedTo([INTAKE, LINK])
    row('Doorbell')
    // Its newest rows: the card over it takes the room its command needs first.
    await until('its screen there', () => shown('Do you want to proceed?'), 20_000)
    // The one header an agent here has, and nothing of a pane of its own.
    expect(header('Doorbell')).toBe(true)
    expect(shown('its screen on vps')).toBe(false)
    // What it waits to run, whole, as that machine sent it: both of its lines.
    expect(shown('wants approval')).toBe(true)
    expect(shown('gh api repos/acme/x/hooks --method POST')).toBe(true)
    expect(shown('./scripts/ring.sh ~/.tade/doorbell')).toBe(true)
    // Another row is another agent's screen.
    row('Linking')
    await until('the other screen', () => shown('14 passed'), 20_000)
    expect(shown('Do you want to proceed?')).toBe(false)
    // The one in front, pressed again, is let go of: the project as it was.
    row('Linking')
    await until('the project again', () => !header('Linking'), 20_000)
  })

  it('carries a park from its menu and an answer from its card there, each with what this window last saw', async () => {
    const far = await linkedTo([INTAKE])
    row('Doorbell')
    await until('its card', () => shown('Allow once'), 20_000)

    menuOf('Doorbell')
    await until('its menu', () => shown('Remove agent…'), 20_000)
    await press('Park')
    await until('the park there', () => far.acted.some((one) => one.verb === 'park'), 20_000)
    await until('what came of that', () => shown('vps: park done there'), 20_000)
    expect(far.acted.find((one) => one.verb === 'park')?.call).toMatchObject({
      task: 'tade/intake-door',
      parked: true,
    })

    await press('Allow once')
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

  it('opens a terminal here that is the agent there on a press, live in the pane, typed into there, and the same one again', async () => {
    const far = await linkedTo([INTAKE])
    far.attachable.set('tade/intake-door', 'echo attached-to-the-door; exec cat')
    // A press opens it, as a click on an agent here does. Enter straight after
    // it, while it is asked for, is the same terminal rather than a second.
    row('Doorbell')
    terminal.press('\r')
    await until(
      'the terminal there',
      () => client.lanes().some((lane) => lane.id === 'remotes/vps/1' && lane.alive),
      20_000,
    )
    // In the pane, in place of the screen read over the link: its lane, live,
    // under the one header an agent here has.
    await until('what it printed', () => shown('attached-to-the-door'), 20_000)
    expect(header('Doorbell')).toBe(true)
    expect(shown('its lane on vps')).toBe(false)
    // An agent's lane, as one here is: never a tab below, and no terminal of
    // a project's — the orchestrator's tools never type into it.
    expect(shown('vps · intake-door')).toBe(false)
    expect(client.terminals().map((one) => one.id)).not.toContain('remotes/vps/1')
    // The keyboard is in it: what is typed is that lane's, echoed back into the pane.
    terminal.press('ring-the-bell')
    await until('what was typed, in the pane', () => shown('ring-the-bell'), 20_000)
    // Not on the orchestrator's line, which would have taken the words in
    // place of what it says while nothing is typed on it.
    expect(shown('Ask Tade anything')).toBe(true)
    // Let go of, and pressed again: the same one, live, and no second opened.
    row('Doorbell')
    await until('the project again', () => !header('Doorbell'), 20_000)
    row('Doorbell')
    await until('the same terminal, live', () => header('Doorbell'), 20_000)
    await until('what it had', () => shown('ring-the-bell'), 20_000)
    expect(client.lanes().filter((lane) => lane.id.startsWith('remotes/'))).toHaveLength(1)
  })

  it('keeps a terminal there that ended badly, with what it said, until enter closes it', async () => {
    const far = await linkedTo([INTAKE])
    far.attachable.set('tade/intake-door', "echo 'no session called tade-1 there' >&2; exit 1")
    row('Doorbell')
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
    // Pressed, it is asked for and refused: said, and its screen read stays.
    row('Doorbell')
    await until('why not', () => shown('its agent is not running there'), 20_000)
    await until('its screen there', () => shown('Do you want to proceed?'), 20_000)
    expect(client.lanes().some((lane) => lane.id.startsWith('remotes/'))).toBe(false)
  })
})
