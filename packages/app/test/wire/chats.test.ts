import { CHATS, isChatTask } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// Opening something in the lower pane from the `+` at the end of its tabs: a
// shell, or an agent with no task to talk to.

/**
 * The workbench, with every chat these tests open redirected to a folder of
 * its own.
 *
 * A chat opened by a person stands in their home directory, which is the
 * decision `chatCwd` carries and `workbench/test/chats.test.ts` asserts. A
 * suite may not start a real agent there, so the one argument that would put
 * it in somebody's home is replaced on the way through — and only for a chat,
 * so an agent on a task still goes to its worktree.
 */
function chatsIn(client: Workbench, cwd: string): Workbench {
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown
      if (typeof value !== 'function') return value
      if (key !== 'startAgent') return value.bind(target)
      return (req: { task: string }) =>
        target.startAgent({ ...req, ...(isChatTask(req.task) ? { cwd } : {}) } as never)
    },
  }) as Workbench
}

describe('the window, opening something in the lower pane', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })

  /** Open the `+` menu at the end of the lower pane's tabs. */
  async function openPlus(): Promise<void> {
    await until('the tabs', () =>
      screenOf(terminal.written).some((row) => row.includes('orchestrator')),
    )
    // The `+` on the tab row, found past the orchestrator's own tab: the ones
    // beside AGENTS and the projects are a different `+` on a different row.
    const rows = screenOf(terminal.written)
    const at = rows.findIndex((row) => row.includes('orchestrator') && row.includes('━'))
    const row = rows[at] ?? ''
    click(row.indexOf('+', row.indexOf('orchestrator')), at)
    await until('the menu', () =>
      screenOf(terminal.written).some((row) => row.includes('Terminal')),
    )
  }

  it('offers a terminal or an agent, and says ctrl+t still makes a terminal', async () => {
    await start()
    await openPlus()
    const rows = screenOf(terminal.written)
    const menu = rows.filter((row) => row.includes('Terminal') || row.includes('Claude Code'))
    expect(menu.length).toBeGreaterThan(1)
    expect(rows.some((row) => row.includes('ctrl+t'))).toBe(true)
    expect(rows.some((row) => row.includes('Codex'))).toBe(true)
  })

  it('opens a terminal when that is what was chosen', async () => {
    await start()
    await openPlus()
    // The first item, which is where a menu opens.
    terminal.press('\r')
    await until(
      'a terminal on the tabs',
      () => screenOf(terminal.written).some((row) => row.includes('terminal 1')),
      40_000,
    )
    expect(client.lanes().some((lane) => lane.kind === 'terminal' && lane.alive)).toBe(true)
  })

  it('opens a chat when a harness was chosen, and puts it in front', async () => {
    const somewhere = tmp('tade-chat-cwd-')
    await start({ client: chatsIn(client, somewhere) })
    await openPlus()
    // Down one from Terminal is the first harness.
    terminal.press('\x1b[B')
    terminal.press('\r')

    await until(
      'the chat on the tabs',
      () => screenOf(terminal.written).some((row) => row.includes('pi 1')),
      60_000,
    )
    // A real agent in a lane of its own, with no project and no worktree: it
    // stands where it was told to and nowhere a repository is.
    const lane = client.lanes().find((one) => one.id === `${CHATS}/1/agent`)
    expect(lane).toMatchObject({ task: `${CHATS}/1`, kind: 'agent', alive: true })
    expect(lane?.spec.cwd).toBe(somewhere)
  })

  it('opens one from the search box too, because the `+` is a menu', async () => {
    // Every clickable thing has to be something you could have typed, and the
    // `+` is now the only way to choose a harness: the typed path opens one in
    // the default harness.
    const somewhere = tmp('tade-chat-cwd-')
    await start({ client: chatsIn(client, somewhere) })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    for (const char of 'new chat') terminal.press(char)
    await until('the row', () => terminal.written.includes('New chat'))
    terminal.press('\r')

    await until(
      'the chat on the tabs',
      () => screenOf(terminal.written).some((row) => row.includes('pi 1')),
      60_000,
    )
  })

  it('stops the agent when its tab is closed, and takes its tab with it', async () => {
    const somewhere = tmp('tade-chat-cwd-')
    await start({ client: chatsIn(client, somewhere) })
    await openPlus()
    terminal.press('\x1b[B')
    terminal.press('\r')
    await until(
      'the chat on the tabs',
      () => screenOf(terminal.written).some((row) => row.includes('pi 1')),
      60_000,
    )

    // The × beside its tab, found as the first one past the tab's own columns.
    // Closing a chat is stopping its agent — there is no terminal to close —
    // and the conversation stays in its harness's store.
    const tab = find('pi 1')
    const line = screenOf(terminal.written)[tab.row] ?? ''
    const cross = line.indexOf('×', tab.col)
    expect(cross).toBeGreaterThan(tab.col)
    click(cross, tab.row)
    await until(
      'the agent stopped',
      () => client.lanes().find((one) => one.id === `${CHATS}/1/agent`)?.alive === false,
      40_000,
    )
    await until('the tab gone', () =>
      screenOf(terminal.written).every((row) => !row.includes('pi 1')),
    )
  })
})
