import { readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { type FarAgent, type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import type { AgentPane } from '../../src/model.ts'
import { sideAnswerOf } from '../../src/side.ts'
import { diskOf } from '../../src/wire/web-disk.ts'
import { actions } from '../screens/scenarios/fixtures.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'
import { pressRow, standingThere } from './standing-there.ts'

// The controls a project here has, pressed while standing in a project on
// another machine, through the whole window — the side's `+` (a new agent
// there), NOTES' `+` (a note there), the header's `+` (a shell there), X (its
// finished agents closed there) and the queue's all/next — and what is on its
// disk: a file in its FILES and a change in its CHANGES opened in the viewer
// here, and its branch's menu with its own branches. The far end is a real
// away view (`far.ts`), its disk a real repository read by the real far half
// (`web-disk.ts`), and the link the scripted one.

const DONE: FarAgent = { task: 'tade/old-fix', title: 'Oldfix', finished: true, lane: 'stopped' }
const NEXT: FarAgent = { task: 'tade/next-up', title: 'Nextup', queued: true }
const LATER: FarAgent = { task: 'tade/later-on', title: 'Lateron', queued: true }
const WORKING: FarAgent = {
  task: 'tade/door',
  title: 'Doorbell',
  screen: '> ringing',
  lane: 'running',
}

describe('a project on another machine, pressed as a project here', () => {
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
  const said = (what: string) => () => `${what}, where the screen shows:\n${rows().join('\n')}`

  async function linkedTo(agents: readonly FarAgent[]): Promise<FarEnd> {
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    far.show(['tade'], {}, agents)
    await standingThere(wired, far, { terminals: true })
    await until(said('its agents'), () => shown(agents[0]?.title ?? ''), 20_000)
    return far
  }

  /** The control pinned to a heading's right, by its label. */
  function pressOnHeading(heading: string, label: string): void {
    const at = wired.headingRow(heading)
    wired.click(at.text.lastIndexOf(label), at.row)
  }

  it('starts a new agent there from the side’s +, on the words given', async () => {
    const far = await linkedTo([WORKING])
    pressOnHeading('AGENTS', '+')
    await until(said('what it is for'), () => shown('New agent on vps in tade'), 20_000)
    terminal.press('ring the bell')
    terminal.press('\r')
    await until(
      said('the agent started there'),
      () => far.toolCalls.some((one) => one.method === 'worker/start'),
      20_000,
    )
    expect(far.toolCalls.find((one) => one.method === 'task/create')?.params).toMatchObject({
      project: 'tade',
      intent: 'ring the bell',
    })
  })

  it('keeps a note there from NOTES’ +, about that project', async () => {
    const far = await linkedTo([WORKING])
    // Tall enough that NOTES is on screen under the rest of the side.
    terminal.resize(100, 60)
    await until(said('NOTES'), () => wired.sidebar().includes('NOTES'), 20_000)
    pressOnHeading('NOTES', '+')
    await until(said('the note’s line'), () => shown('NOTE ABOUT TADE'), 20_000)
    terminal.press('the door is on the left')
    terminal.press('\r')
    await until(
      said('the note there'),
      () => far.toolCalls.some((one) => one.method === 'memory/remember'),
      20_000,
    )
    expect(far.toolCalls.find((one) => one.method === 'memory/remember')?.params).toMatchObject({
      text: 'the door is on the left',
      scope: 'tade',
    })
  })

  it('opens a shell there from the header’s +, as a tab below', async () => {
    const far = await linkedTo([WORKING])
    const root = mkrepo().root
    far.repositories = [
      { project: 'tade', root, repository: 'github.com/acme/tade', base: 'main', branches: [] },
    ]
    pressRow(wired, 'Doorbell')
    await until(said('its header'), () => shown('actions'), 20_000)
    const at = wired.find('actions')
    const line = rows()[at.row] ?? ''
    wired.click(line.indexOf('+', at.col), at.row)
    await until(
      said('the shell there'),
      () =>
        client.lanes().some((lane) => lane.id.startsWith('remotes/vps/') && lane.title === 'tade'),
      20_000,
    )
    // A shell in that project is a terminal below, as one here is.
    await until(said('its tab below'), () => shown('vps · tade'), 20_000)
  })

  it('closes its finished agents there from X, once asked', async () => {
    const far = await linkedTo([WORKING, DONE])
    pressOnHeading('AGENTS', 'X')
    await until(said('what it asks'), () => shown('old-fix') && shown('[ Close 1 ]'), 20_000)
    const close = wired.find('[ Close 1 ]')
    wired.click(close.col + 2, close.row)
    await until(
      said('the close there'),
      () => far.acted.some((one) => one.verb === 'remove'),
      20_000,
    )
    expect(far.acted.find((one) => one.verb === 'remove')?.call).toMatchObject({
      task: 'tade/old-fix',
    })
  })

  it('shows all of its queue or what is next, from the queue’s own row', async () => {
    await linkedTo([NEXT, LATER])
    const rowOf = () => wired.headingRow('SMART QUEUE').row + 1
    await until(said('the queue there'), () => (rows()[rowOf()] ?? '').includes('next'), 20_000)
    const row = rowOf()
    wired.click((rows()[row] ?? '').indexOf('next'), row)
    await until(said('next showing'), () => (rows()[rowOf()] ?? '').includes('<next>'), 20_000)
    const all = rowOf()
    wired.click((rows()[all] ?? '').indexOf('all'), all)
    await until(said('all showing'), () => (rows()[rowOf()] ?? '').includes('<all>'), 20_000)
  })

  /** A project there with one change in it, its disk a real repository read and written by the real far half. */
  async function standingInChange(): Promise<{ there: ReturnType<typeof mkrepo>; far: FarEnd }> {
    const there = mkrepo()
    there.commit('the hook', { 'hook.ts': 'export const ring = 1\n' })
    there.git('branch', 'tade/elsewhere-only')
    writeFileSync(join(there.root, 'hook.ts'), 'export const ring = 2\n')
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    far.show(['tade'], {}, [])
    // Its window's side, as it would draw the project: one change, one file.
    far.side = async (ask) =>
      sideAnswerOf({
        ask,
        panes: [],
        looking: false,
        spent: null,
        here: {
          files: [{ path: 'hook.ts', name: 'hook.ts', depth: 0, folder: false, open: false }],
          fileMarks: { 'hook.ts': 'M' },
          where: {
            repo: there.root,
            branch: 'main',
            base: null,
            worktree: null,
            path: there.root,
            shownPath: there.root,
            links: [],
            servers: [],
          },
          changes: [{ path: 'hook.ts', mark: 'M', added: 1, removed: 1 }],
          base: null,
        },
        notes: [],
        retired: [],
        schedules: [],
        intake: [],
        intakeEmpty: { short: 'none', long: 'Nothing.' },
        agent: null,
        actions: null,
      })
    // Its disk, read by the very half its window answers with.
    far.disk = diskOf({
      config: () => ConfigSchema.parse({ projects: { tade: { root: there.root } } }),
      panes: () => [],
      live: () => null,
    })
    await standingThere(wired, far)
    // Tall enough that GIT is on screen under CHANGES and FILES.
    terminal.resize(100, 60)
    await until(said('its changes'), () => wired.sidebar().includes('hook.ts'), 20_000)
    return { there, far }
  }

  /** The change there, pressed: read there, opened in the viewer with git there drawn in. */
  async function openTheChange(): Promise<void> {
    const changes = wired.headingRow('CHANGES').row + 1
    wired.click((rows()[changes] ?? '').indexOf('hook.ts') + 1, changes)
    await until(said('the change there'), () => shown('export const ring = 2'), 20_000)
  }

  it('opens a change and a file there in the viewer, and its branch’s menu with its own branches', async () => {
    const { far } = await standingInChange()
    await openTheChange()
    await until(said('the line it replaced'), () => shown('export const ring = 1'), 5_000)
    expect(far.diskAsked.at(-1)).toMatchObject({ project: 'tade', what: 'file', path: 'hook.ts' })
    // Another machine's file: typed into here and saved there, never in this machine's editor.
    expect(shown('Open in editor')).toBe(false)
    expect(shown('click to edit')).toBe(true)
    terminal.press('\x1b')
    await until(said('the viewer closed'), () => !shown('export const ring = 2'), 20_000)
    // Its branch: its menu, all of it carried there, and Switch branch… with that machine's branches.
    openTheBranchMenu()
    await until(said('the branch’s menu'), () => shown('Switch branch'), 20_000)
    expect(shown('New branch')).toBe(true)
    expect(shown('not from here')).toBe(false)
    terminal.press('\r')
    await until(said('its branches'), () => shown('tade/elsewhere-only'), 20_000)
    expect(far.diskAsked.at(-1)).toMatchObject({ project: 'tade', what: 'branches' })
  })

  /** The branch under GIT, pressed: its menu. */
  function openTheBranchMenu(): void {
    const git = wired.headingRow('GIT').row
    const on = rows().findIndex((line, at) => at > git && line.slice(0, 26).includes('main'))
    wired.click((rows()[on] ?? '').indexOf('main') + 1, on)
  }

  it('switches its checkout to one of its branches there, and never this machine’s', async () => {
    const { there, far } = await standingInChange()
    const mine = wired.repo.git('branch', '--show-current').trim()
    openTheBranchMenu()
    await until(said('the branch’s menu'), () => shown('Switch branch'), 20_000)
    terminal.press('\r')
    await until(said('its branches'), () => shown('Switch branch on vps'), 20_000)
    await until(said('the branch there'), () => shown('tade/elsewhere-only'), 20_000)
    const row = wired.find('tade/elsewhere-only')
    wired.click(row.col + 2, row.row)
    await until(
      said('the checkout there switched'),
      () => there.git('branch', '--show-current').trim() === 'tade/elsewhere-only',
      20_000,
    )
    expect(far.diskAsked.at(-1)).toMatchObject({
      project: 'tade',
      what: 'switch',
      name: 'tade/elsewhere-only',
      create: false,
    })
    await until(said('it said so'), () => shown('on tade/elsewhere-only on vps'), 20_000)
    expect(wired.repo.git('branch', '--show-current').trim()).toBe(mine)
  })

  it('makes a branch there from New branch…, named there', async () => {
    const { there } = await standingInChange()
    openTheBranchMenu()
    await until(said('the branch’s menu'), () => shown('New branch'), 20_000)
    const made = wired.find('New branch')
    wired.click(made.col + 1, made.row)
    await until(said('the name’s line'), () => shown('New branch on vps'), 20_000)
    for (const char of 'tade/bell') terminal.press(char)
    terminal.press('\r')
    await until(
      said('the branch there'),
      () => there.git('branch', '--show-current').trim() === 'tade/bell',
      20_000,
    )
  })

  it('saves a file typed into there, there, and discards a change there', async () => {
    const { there, far } = await standingInChange()
    const hook = join(there.root, 'hook.ts')
    // The file under FILES, pressed: opened to read, as one here is.
    const files = wired.headingRow('FILES').row + 1
    wired.click((rows()[files] ?? '').indexOf('hook.ts') + 1, files)
    await until(said('the file there'), () => shown('export const ring = 2'), 20_000)
    const line = wired.find('export const ring = 2')
    wired.click(line.col + 'export const ring = 2'.length, line.row)
    terminal.press('0')
    await until(said('what was typed'), () => shown('export const ring = 20'), 20_000)
    expect(readFileSync(hook, 'utf8')).toBe('export const ring = 2\n')
    terminal.press('\x13')
    await until(
      said('the file saved there'),
      () => readFileSync(hook, 'utf8') === 'export const ring = 20\n',
      20_000,
    )
    await until(said('it said so'), () => shown('Saved hook.ts on vps'), 20_000)
    expect(far.diskAsked.at(-1)).toMatchObject({ what: 'save', text: 'export const ring = 20\n' })
    terminal.press('\x1b')
    await until(said('the viewer closed'), () => !shown('export const ring = 20'), 20_000)
    // The change, right-pressed: Discard changes…, asked, and thrown away there.
    const changes = wired.headingRow('CHANGES').row + 1
    const col = (rows()[changes] ?? '').indexOf('hook.ts')
    terminal.press(`\x1b[<2;${col + 2};${changes + 1}M`)
    terminal.press(`\x1b[<2;${col + 2};${changes + 1}m`)
    await until(said('the change’s menu'), () => shown('Discard changes'), 20_000)
    const discard = wired.find('Discard changes')
    wired.click(discard.col + 2, discard.row)
    await until(said('the question'), () => shown('Discard changes on vps?'), 20_000)
    const go = wired.find('Discard ')
    const button = rows()[go.row]?.lastIndexOf('Discard') ?? -1
    wired.click(button + 1, go.row)
    await until(
      said('the change thrown away there'),
      () => readFileSync(hook, 'utf8') === 'export const ring = 1\n',
      20_000,
    )
    expect(far.diskAsked.at(-1)).toMatchObject({ what: 'discard', path: 'hook.ts' })
  })

  it('opens its shell tab there as a terminal here to that lane, in the pane under the tab', async () => {
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    far.show(['tade'], {}, [WORKING])
    far.attachable.set('tade/door', 'echo the-agent-there; exec cat')
    far.attachable.set('tade/door/shell', 'echo the-shell-there; exec cat')
    const pane = {
      task: 'tade/door',
      project: 'tade',
      name: 'door',
      title: 'Doorbell',
      branch: 'tade/door',
      lane: 'tade/door/agent',
      state: 'working',
      waiting: false,
      approval: null,
      lanes: [
        { id: 'tade/door/agent', kind: 'agent' },
        { id: 'tade/door/shell', kind: 'shell', title: 'shell' },
      ],
    } as AgentPane
    far.side = async (ask) =>
      sideAnswerOf({
        ask,
        panes: [pane],
        looking: false,
        spent: null,
        here: { files: null, fileMarks: {}, where: null, changes: null, base: null },
        notes: [],
        retired: [],
        schedules: [],
        intake: [],
        intakeEmpty: { short: 'none', long: 'Nothing.' },
        agent: null,
        actions: null,
      })
    await standingThere(wired, far, { terminals: true })
    await until(said('its agent'), () => shown('Doorbell'), 20_000)
    pressRow(wired, 'Doorbell')
    await until(said('the agent’s own lane'), () => shown('the-agent-there'), 20_000)
    // Its tabs as that machine's window draws them: the agent's, and its shell's.
    await until(said('its shell’s tab'), () => (rows()[2] ?? '').includes('shell'), 20_000)
    const tab = wired.find('shell')
    wired.click(tab.col + 1, tab.row)
    await until(said('its shell there'), () => shown('the-shell-there'), 20_000)
    expect(
      client.lanes().filter((lane) => lane.alive && lane.id.startsWith('remotes/vps/')),
    ).toHaveLength(2)
    expect(client.lanes().some((lane) => lane.title === 'tade/door/shell')).toBe(true)
    // An agent's lane there, as its own is: never a tab below.
    expect(shown('vps · door/shell')).toBe(false)
    // Its own tab brings its own lane back, the same terminal and no third.
    const header = rows()[2] ?? ''
    wired.click(header.indexOf('agent', header.indexOf('│')) + 1, 2)
    await until(said('its own lane again'), () => shown('the-agent-there'), 20_000)
    expect(
      client.lanes().filter((lane) => lane.alive && lane.id.startsWith('remotes/vps/')),
    ).toHaveLength(2)
  })

  it('draws its ACTIONS tab from that machine, and runs its checks there from Run all', async () => {
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    far.show(['tade'], {}, [WORKING])
    const pane = {
      task: 'tade/door',
      project: 'tade',
      name: 'door',
      title: 'Doorbell',
      branch: 'tade/door',
      lane: null,
      state: 'working',
      waiting: false,
      approval: null,
      lanes: [],
    } as AgentPane
    far.side = async (ask) =>
      sideAnswerOf({
        ask,
        panes: [pane],
        looking: false,
        spent: null,
        here: { files: null, fileMarks: {}, where: null, changes: null, base: null },
        notes: [],
        retired: [],
        schedules: [],
        intake: [],
        intakeEmpty: { short: 'none', long: 'Nothing.' },
        agent: null,
        actions: { ...actions(), task: 'tade/door' },
      })
    await standingThere(wired, far)
    terminal.resize(120, 60)
    await until(said('its agent'), () => shown('Doorbell'), 20_000)
    pressRow(wired, 'Doorbell')
    await until(said('its tabs'), () => shown('actions'), 20_000)
    const tab = wired.find('actions')
    wired.click(tab.col + 1, tab.row)
    // What its window draws there: its own commits, and its checks with Run all.
    await until(said('its work there'), () => shown('keep the old webhook shape'), 20_000)
    expect(far.sideAsked.at(-1)).toMatchObject({ agent: 'tade/door', actions: true })
    await until(said('Run all'), () => shown('Run all'), 20_000)
    const run = wired.find('Run all')
    wired.click(run.col + 2, run.row)
    await until(
      said('its checks run there'),
      () => far.toolCalls.some((one) => one.method === 'extension/call'),
      20_000,
    )
    expect(far.toolCalls.find((one) => one.method === 'extension/call')?.params).toMatchObject({
      tool: 'checks_run',
      input: { project: 'tade' },
    })
  })
})
