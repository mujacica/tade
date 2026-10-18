import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, type LaneId } from '@tade/core'
import { type FarAgent, type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedOptions, type ScriptedRemote } from '@tade/remotes-scripted'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { endedOf } from '../../src/wire/remote-terminals.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// A terminal here that is an agent on another machine, kept up
// (REMOTE-TADE.md §3.5): run again in its own tab when its connection is back
// — and only one that lost it — and moved off a way that does not get
// through. The far end is a real away view (`far.ts`), and the link the
// scripted one, which runs that machine's line in a shell here, where it is:
// a line that exits 255 is a connection lost, as ssh's own exit is.

const agent = (name: string, title: string): FarAgent => ({
  task: `tade/${name}`,
  title,
  screen: `> ${title}`,
})

const DOOR = agent('intake-door', 'Doorbell')
const LINK = agent('remote-link', 'Linking')
const SUITE = agent('suite-run', 'Suite')
const GONE = agent('gone-soon', 'Leaving')

describe('a terminal to an agent on another machine, kept up', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let home: string
  let root: string
  const fars: FarEnd[] = []
  const dirs: string[] = []
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
    client = one.client
    home = one.home
    root = one.repo.root
  })

  afterEach(async () => {
    await Promise.all(fars.map((far) => far.close()))
    await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
    fars.length = 0
    dirs.length = 0
  })

  const rows = () => screenOf(terminal.written)
  const shown = (text: string) => rows().some((row) => row.includes(text))
  const alive = (id: string) => client.lanes().some((lane) => lane.id === id && lane.alive)

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
  async function linkedTo(
    agents: readonly FarAgent[],
    link: Pick<ScriptedOptions, 'hesitant'> = {},
  ): Promise<FarEnd> {
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
        ssh: (options) =>
          makeScriptedLink({ ...options, remotes: table, terminals: true, ...link }),
      },
    })
    await until('vps along the top', () => (rows()[0] ?? '').includes('vps'), 20_000)
    const top = rows()[0] ?? ''
    wired.click(top.indexOf('vps') + 1, 0)
    await until(
      'its projects',
      () =>
        rows()
          .slice(1)
          .some((one) => one.includes('tade')),
      20_000,
    )
    terminal.press('\r')
    await until('its agents down the side', () => shown(agents[0]?.title ?? ''), 20_000)
    // Room for the side's rows under a terminal in front, and for the lower pane's controls.
    terminal.resize(160, 40)
    await until('the window, wider', () => (rows()[0] ?? '').length >= 160, 20_000)
    return far
  }

  /**
   * A line for an agent there that counts its runs, prints which run it is,
   * and ends as the connection going does — 255 — once `drop` is there.
   */
  async function dropping(name: string) {
    const dir = await mkdtemp(join(tmpdir(), 'tade-drop-'))
    dirs.push(dir)
    const runs = join(dir, 'runs')
    const drop = join(dir, 'drop')
    return {
      line: `echo run >> ${runs}; echo ${name}-run-$(wc -l < ${runs} | tr -d ' '); while [ ! -e ${drop} ]; do sleep 0.1; done; exit 255`,
      runs: async () =>
        (await readFile(runs, 'utf8').catch(() => '')).split('\n').filter(Boolean).length,
      drop: () => writeFile(drop, ''),
      mend: () => rm(drop, { force: true }),
      /** The same line, ending there instead — its agent let go of — with status 1. */
      ending: `echo run >> ${runs}; echo ${name}-ended-there; exit 1`,
    }
  }

  /**
   * Open a terminal to an agent there by its row and enter, and wait for what
   * it printed. A terminal opened before takes the window's room, so the side
   * is given it back first, with the lower pane's own control.
   */
  async function attach(title: string, lane: string, printed: string): Promise<void> {
    const tabs = rows().findIndex((one) => one.includes('orchestrator') && one.includes('↓'))
    if (tabs >= 0 && !shown(`▌ ⡆ ${title}`) && !shown(`  ${title}`)) {
      wired.click((rows()[tabs] ?? '').indexOf('↓') + 1, tabs)
    }
    await until(`${title}'s row`, () => {
      try {
        return rows().some((one, at) => at > 1 && one.slice(0, one.indexOf('│')).includes(title))
      } catch {
        return false
      }
    })
    row(title)
    // Its own pane, with its controls: the keyboard may be in a terminal, so the control is pressed.
    await until(
      `${title}'s pane`,
      () =>
        rows().some((one) => one.slice(one.indexOf('│') + 1).includes(title)) &&
        shown('type into it'),
      20_000,
    )
    const lines = rows()
    const at = lines.findIndex((one) => one.includes('type into it'))
    wired.click((lines[at] ?? '').indexOf('type into it') + 1, at)
    await until(`the terminal to ${title}`, () => alive(lane), 20_000)
    await until(`what ${title}'s terminal printed`, () => shown(printed), 20_000)
  }

  it('runs a terminal that lost its connection again when the link comes back, in its own tab', async () => {
    const far = await linkedTo([DOOR])
    // Which lanes the window watches as they print, so what one prints is
    // drawn at once rather than at the next look.
    const watched: string[] = []
    const watch = client.watch.bind(client)
    client.watch = (lane, ...rest) => {
      watched.push(lane)
      return watch(lane, ...rest)
    }
    const door = await dropping('door')
    far.attachable.set(DOOR.task, door.line)
    await attach('Doorbell', 'remotes/vps/1', 'door-run-1')
    const before = client.lanes().find((lane) => lane.id === 'remotes/vps/1')
    expect(watched.filter((lane) => lane === 'remotes/vps/1')).toHaveLength(1)

    // The lid closes: the link goes down, and the terminal's connection with it.
    await far.close()
    await door.drop()
    await until('it said its connection dropped', () => shown('[the connection to vps dropped'))
    expect(await door.runs()).toBe(1)

    // The lid opens: the link comes back, and the terminal runs again where it was.
    await door.mend()
    await far.reopen()
    await until('the terminal, run again', () => shown('door-run-2'), 30_000)
    await until('said once', () => shown('intake-door on vps: connected again, over scripted'))
    const after = client.lanes().find((lane) => lane.id === 'remotes/vps/1')
    expect(after?.alive).toBe(true)
    expect(after?.startedAt).not.toBe(before?.startedAt)
    // The same tab: one terminal to that agent, at the size the old one had, in front.
    expect(
      client.lanes().filter((lane) => lane.id.startsWith('remotes/') && lane.alive),
    ).toHaveLength(1)
    expect(after?.spec.rows).toBe(before?.spec.rows)
    expect(shown('vps · intake-door')).toBe(true)
    expect(await door.runs()).toBe(2)
    // Another lane under the same name, watched afresh: the old one's watch
    // hears nothing the new one prints.
    await until(
      'the new lane watched',
      () => watched.filter((lane) => lane === 'remotes/vps/1').length === 2,
    )
  })

  it('keeps a terminal run again where its tab was, before one opened after it', async () => {
    const far = await linkedTo([DOOR, LINK])
    const door = await dropping('door')
    far.attachable.set(DOOR.task, door.line)
    // One that keeps its connection, as a terminal to another machine whose link never went does.
    far.attachable.set(LINK.task, 'echo link-kept; exec sleep 60')
    await attach('Doorbell', 'remotes/vps/1', 'door-run-1')
    await attach('Linking', 'remotes/vps/2', 'link-kept')
    const before = client.lane('remotes/vps/1' as LaneId)

    await far.close()
    await door.drop()
    await until(
      'it lost its connection',
      async () => (await endedOf(home, 'remotes/vps/1')) === 'lost',
    )
    await door.mend()
    await far.reopen()
    await until(
      'said once',
      () => shown('intake-door on vps: connected again, over scripted'),
      30_000,
    )
    const after = client.lane('remotes/vps/1' as LaneId)
    expect(after?.alive).toBe(true)
    expect(after?.startedAt).not.toBe(before?.startedAt)
    await until('it ran again', async () => (await door.runs()) === 2)

    // A start of its own, and its tab where it was along the row.
    const tabs = rows().find(
      (one) => one.includes('vps · intake-door') && one.includes('vps · remote-link'),
    )
    expect(tabs).toBeDefined()
    expect(tabs?.indexOf('vps · intake-door')).toBeLessThan(
      tabs?.indexOf('vps · remote-link') ?? -1,
    )
  })

  it('leaves one the person closed, one that ended there and one whose agent has gone as they are', async () => {
    const far = await linkedTo([DOOR, LINK, GONE, SUITE])
    const ended = await dropping('door')
    far.attachable.set(DOOR.task, ended.ending)
    const closed = await dropping('closed')
    const gone = await dropping('gone')
    const witness = await dropping('suite')
    far.attachable.set(LINK.task, closed.line)
    far.attachable.set(GONE.task, gone.line)
    far.attachable.set(SUITE.task, witness.line)

    await attach('Doorbell', 'remotes/vps/1', 'door-ended-there')
    await until('that it ended there', () => shown('[it ended (1): press enter to close]'))
    await attach('Linking', 'remotes/vps/2', 'closed-run-1')
    await attach('Leaving', 'remotes/vps/3', 'gone-run-1')
    await attach('Suite', 'remotes/vps/4', 'suite-run-1')
    // Closed by the person before anything dropped: a lane no more.
    await client.closeLane('remotes/vps/2' as LaneId)

    await far.close()
    await Promise.all([gone.drop(), witness.drop(), closed.drop()])
    await until('both lost their connection, as their wrappers wrote it', async () =>
      (await Promise.all(['remotes/vps/3', 'remotes/vps/4'].map((id) => endedOf(home, id)))).every(
        (ended) => ended === 'lost',
      ),
    )
    expect(await endedOf(home, 'remotes/vps/1')).toBe(1)
    await until('the terminal in front said so', () => shown('[the connection to vps dropped'))
    // Its agent is not running there any more by the time the link is back.
    far.attachable.delete(GONE.task)
    await Promise.all([gone.mend(), witness.mend()])
    await far.reopen()

    // The newest is run again last, so by then every other one has been looked at.
    await until('the one that lost it, run again', async () => (await witness.runs()) === 2, 30_000)
    // And put back in front: running again is not the end of it, because the
    // window brings a terminal that was in front back there if the orchestrator
    // took its place meanwhile (`replace`), and a press on that tab before then
    // is read as the gap having moved it. Said once it has.
    await until('it, in front again', () => shown('suite-run on vps: connected again'), 30_000)
    // Said in the conversation, which is the orchestrator's tab: pressed once
    // the lower pane's row of tabs is on screen, never at a row read off a
    // frame that had not drawn it.
    const tabs = () =>
      rows().findLastIndex((one) => one.startsWith('━') && one.includes('orchestrator'))
    await until('the orchestrator tab', () => tabs() >= 0)
    const at = tabs()
    wired.click((rows()[at] ?? '').indexOf(' orchestrator ') + 1, at)
    await until('why the gone one was not', () => shown('gone-soon on vps was not opened again'))
    expect(await gone.runs()).toBe(1)
    expect(alive('remotes/vps/3')).toBe(true)
    expect(await closed.runs()).toBe(1)
    expect(alive('remotes/vps/2')).toBe(false)
    expect(await ended.runs()).toBe(1)
    expect(alive('remotes/vps/1')).toBe(true)
  })

  it('moves a terminal off a way that does not get through, says which it uses, and remembers', async () => {
    const far = await linkedTo([DOOR, LINK], {
      hesitant: {
        by: 'mosh',
        line: "echo 'mosh: Nothing received from server on UDP port 60001.'; exec sleep 60",
        within: 300,
        waiting: 'Nothing received from server on UDP port',
      },
    })
    far.attachable.set(DOOR.task, 'echo over-the-plain-way; exec sleep 60')
    far.attachable.set(LINK.task, 'echo link-over-the-plain-way; exec sleep 60')
    await attach('Doorbell', 'remotes/vps/1', 'Nothing received from server')

    // Past its while, on the window's beat: the plain way, in the same tab, said.
    await until('the plain way', () => shown('over-the-plain-way'), 30_000)
    await until('which it uses', () =>
      shown('intake-door on vps, over scripted — mosh did not get through there'),
    )
    expect(
      client.lanes().filter((lane) => lane.id.startsWith('remotes/') && lane.alive),
    ).toHaveLength(1)

    // The next terminal to that machine goes the plain way at once.
    await attach('Linking', 'remotes/vps/2', 'link-over-the-plain-way')
    await until('said at once', () => shown('tade/remote-link on vps, over scripted'))
  })
})
