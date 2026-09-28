import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { Speaker } from '@tade/voice-tts'
import { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { App } from '../../src/app.ts'
import { FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// An agent asked for, opened, told it is finished, and closed — and what its
// own page says about what it did.

describe('the window, starting and ending agents', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
  })

  it('starts a new agent from its button, asking nothing first', async () => {
    await start()
    await until('the first frame', () =>
      screenOf(terminal.written).some((row) => row.includes('AGENTS')),
    )
    // The + beside AGENTS: where agents are, not a button at the foot.
    const lines = screenOf(terminal.written)
    const row = lines.findIndex((line) => line.includes('AGENTS'))
    click(lines[row]?.indexOf('+') ?? 0, row)
    const deadline = Date.now() + 20_000
    while ((await client.events({ types: ['task_created'] })).length === 0) {
      if (Date.now() > deadline) throw new Error('no agent was made')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const [created] = await client.events({ types: ['task_created'] })
    // Named for nothing in particular, because nothing was said.
    expect(created?.task).toBe('app/agent-1')
  }, 30_000)

  it('closes the agents that have finished, from the X beside the +', async () => {
    await start()
    await until('the first frame', () =>
      screenOf(terminal.written).some((row) => row.includes('AGENTS')),
    )
    // One of the two is finished, so there is something to clean up.
    await client.markDone('app/refunds', { by: 'you' })
    const heading = () => {
      const lines = screenOf(terminal.written)
      const row = lines.findIndex((line) => line.includes('AGENTS'))
      return { row, text: lines[row] ?? '' }
    }
    // The X beside the + : `[X]` without colour, which is the whole chip.
    await until('the close button', () => heading().text.includes('[X]'), 20_000)
    const bar = heading()
    click(bar.text.indexOf('[X]') + 1, bar.row)
    // It asks first, and says how many it would close.
    await until('the question', () => terminal.written.includes('Close 1 finished agent?'))
    const answer = find('Close 1 ')
    terminal.written = ''
    click(answer.col, answer.row)
    await until(
      'the agent to be closed',
      () => repo.git('branch', '--list', 'tade/refunds').trim() === '',
      20_000,
    )
    // The other one is untouched: only what had finished went.
    expect(repo.git('branch', '--list', 'tade/search')).toContain('tade/search')
  }, 30_000)

  it('shows what an agent committed on its ACTIONS tab, and says nobody ran the checks', async () => {
    // A commit of its own, attributed the way every commit an agent makes is,
    // and one beside it that is somebody else's.
    const worktree = join(repo.root, '..', 'worktrees', 'app-refunds')
    repo.commit(
      'charge once on retry\n\nTade-Task: app/refunds',
      { 'refunds.ts': 'once' },
      worktree,
    )
    repo.commit('tidy the readme', { 'README.md': '# fixture\n\ntidy\n' }, worktree)
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tab = find('actions')
    terminal.written = ''
    click(tab.col, tab.row)
    await until('the page', () =>
      screenOf(terminal.written).some((row) => row.includes('THIS AGENT')),
    )
    const page = screenOf(terminal.written).join('\n')
    // Its own commit is under its own heading, with what it touched. The
    // other one is on the branch and not its work, so it is not counted here.
    expect(page).toContain('charge once on ret')
    expect(page).toContain('1 +7')
    expect(page).not.toContain('tidy the readme')
    // And a project that says nothing about what checking it means says so,
    // rather than looking fine.
    expect(page).toContain('CHECKS')
    expect(page).toContain('Nothing here says what checking')
  }, 30_000)

  it("opens an agent's menu with a right-click, listing what can be done", async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // With a space before it: the worktree's path under GIT can say refunds too.
    const task = find(' refunds')
    terminal.written = ''
    terminal.press(`\x1b[<2;${task.col + 2};${task.row + 1}M`)
    terminal.press(`\x1b[<2;${task.col + 2};${task.row + 1}m`)
    await until('the menu', () => terminal.written.includes('Remove agent'))
    expect(terminal.written).toContain('Copy branch name')
  })

  it('marks an agent finished from its menu, whatever its rule', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const task = find(' refunds')
    terminal.press(`\x1b[<2;${task.col + 2};${task.row + 1}M`)
    terminal.press(`\x1b[<2;${task.col + 2};${task.row + 1}m`)
    await until('the menu', () => terminal.written.includes('Mark finished'))
    const item = find('Mark finished')
    click(item.col + 1, item.row)
    await until(
      'it written down',
      async () => (await client.events({ types: ['task_done'] })).length === 1,
    )
    const [done] = await client.events({ types: ['task_done'] })
    expect(done).toMatchObject({ task: 'app/refunds', detail: { by: 'you' } })
    await until('finished on screen', () =>
      screenOf(terminal.written).some((row) => row.includes('✓ refunds')),
    )
  })

  it('opens how hard an agent thinks from the button beside its model', async () => {
    terminal.columns = 160
    await start()
    await until('the thinking button', () =>
      screenOf(terminal.written).some(
        (row) => row.includes('thinking ▾') || row.includes('think ▾'),
      ),
    )
    // Its own button, on its pane's header near the top — not the
    // orchestrator's, which is the same control at the foot of the window.
    const button = (() => {
      const lines = screenOf(terminal.written)
      for (let row = 0; row < lines.length; row++) {
        const col = (lines[row] ?? '').search(/think(ing)? ▾/)
        if (col >= 0) return { col, row }
      }
      throw new Error('no thinking button')
    })()
    terminal.written = ''
    click(button.col + 1, button.row)
    await until('the levels', () => {
      const shown = screenOf(terminal.written).join('\n')
      return shown.includes('Thinking') && shown.includes('xhigh') && shown.includes('max')
    })
  })

  it('closes an agent with its ×: stopped, and gone from the list', async () => {
    await start()
    await until('the agent', () =>
      screenOf(terminal.written).some((row) => row.includes('refunds')),
    )
    const agent = find('refunds')
    terminal.press(`\x1b[<35;${agent.col + 1};${agent.row + 1}M`)
    await until('its buttons', () => (screenOf(terminal.written)[agent.row] ?? '').includes('×'))
    click((screenOf(terminal.written)[agent.row] ?? '').indexOf('×'), agent.row)
    // Nothing of it unmerged, so nothing to ask: it goes.
    await until('it to be removed', async () =>
      (await client.events({ types: ['task_removed'] })).some(
        (event) => event.task === 'app/refunds',
      ),
    )
    await until('the list without it', () =>
      screenOf(terminal.written)
        .slice(0, 12)
        .every((row) => !row.includes('refunds')),
    )
  })

  it('asks before closing an agent whose worktree has work not merged', async () => {
    const worktree = repo.addTask('ledger', { project: 'app', intent: 'ledger rounding' })
    repo.commit('half the rounding fix', { 'ledger.ts': 'export const round = 2\n' }, worktree)
    await start()
    await until('the agent', () => screenOf(terminal.written).some((row) => row.includes('ledger')))
    const agent = find('ledger')
    terminal.press(`\x1b[<35;${agent.col + 1};${agent.row + 1}M`)
    await until('its buttons', () => (screenOf(terminal.written)[agent.row] ?? '').includes('×'))
    click((screenOf(terminal.written)[agent.row] ?? '').indexOf('×'), agent.row)
    // A commit that is nowhere else is asked about, not thrown away.
    await until('the question', () => terminal.written.includes('Remove ledger?'))
    expect(await client.events({ types: ['task_removed'] })).toEqual([])
  })
})

describe('closing the last agent in a project', () => {
  it('leaves you in that project, on its own screen, and never in the next one', async () => {
    // The bug this is about: the window fell through to the first pane there
    // was, of any project, so emptying one moved you into another nobody had
    // asked to be in.
    const one = mkrepo()
    one.commit('first')
    one.addTask('rounding', { project: 'one', intent: 'ledger rounding' })
    const two = mkrepo()
    two.commit('first')
    two.addTask('retries', { project: 'two', intent: 'webhook retries' })
    const home = tmp('tade-app-')
    const client = await Workbench.open({ home })
    const terminal = new FakeTerminal()
    const speaker = await Speaker.create({
      soundDir: tmp('tade-app-sound-'),
      platform: 'darwin',
      run: async () => {},
    })
    const app = await App.start({
      client,
      config: ConfigSchema.parse({
        projects: { one: { root: one.root }, two: { root: two.root } },
        agents: { workspace: 'worktree' },
      }),
      home,
      cwd: two.root,
      terminal,
      speaker,
      frameMs: 50,
    })
    const shown = () => screenOf(terminal.written)
    // Down the side, never in the pane: the agent's name is in its own header
    // too, and the × that closes it is only on the row in the list.
    const at = (text: string, side = false) => {
      const rows = shown()
      const row = rows.findIndex((line) => {
        const col = line.indexOf(text)
        return col >= 0 && (!side || col < 26)
      })
      return row < 0 ? null : { row, col: rows[row]?.indexOf(text) ?? 0 }
    }
    try {
      await until('both projects', () => at('one') !== null && at('two') !== null, 20_000)
      // Stand in the second project, on its only agent.
      const tab = at('two') as { row: number; col: number }
      terminal.press(`\x1b[<0;${tab.col + 1};${tab.row + 1}M`)
      terminal.press(`\x1b[<0;${tab.col + 1};${tab.row + 1}m`)
      await until('its agent', () => at('retries', true) !== null, 20_000)
      // Close it with its ×.
      const agent = at('retries', true) as { row: number; col: number }
      terminal.press(`\x1b[<35;${agent.col + 1};${agent.row + 1}M`)
      await until('its buttons', () => (shown()[agent.row] ?? '').includes('×'), 20_000)
      const cross = (shown()[agent.row] ?? '').indexOf('×')
      terminal.press(`\x1b[<0;${cross + 1};${agent.row + 1}M`)
      terminal.press(`\x1b[<0;${cross + 1};${agent.row + 1}m`)
      await until(
        'it to be removed',
        async () =>
          (await client.events({ types: ['task_removed'] })).some(
            (event) => event.task === 'two/retries',
          ),
        20_000,
      )
      // What is on screen now is the empty project's own screen, in `two`,
      // and the agent of the project next door is nowhere near it.
      await until('the empty screen', () => shown().join('\n').includes('+ New agent'), 20_000)
      expect(shown().join('\n')).toContain('in two')
      expect(shown().join('\n')).not.toContain('rounding')
      // The wordmark, and nothing above the foot that takes what you type:
      // emptying a project does not move the orchestrator's line onto it.
      expect(shown().join('\n')).toContain('Ask Tade anything')

      // And typing from here goes to that line, which is where it always is.
      // The editor wraps at the width it is rendered at, so a sentence longer
      // than the window is where a wrong width would show: the tail of it
      // would be cut off rather than carried onto the next row.
      const said =
        'check every webhook retry path in the billing worker and say which ones are not idempotent'
      for (const key of said) terminal.press(key)
      await until('what was typed', () => shown().join('\n').includes('check every'), 20_000)
      const screen = shown().join('\n')
      expect(screen).toContain('idempotent')
    } finally {
      await app.stop().catch(() => {})
      await client.close().catch(() => {})
    }
  }, 60_000)
})

describe('a project with nothing in it', () => {
  it('starts agents in the checkout together, and in worktree mode names a branch at the first change', async () => {
    const repo = mkrepo()
    repo.commit('first')
    const home = tmp('tade-app-')
    const yaml = (workspace: string) =>
      `projects:\n  empty:\n    root: ${repo.root}\nagents:\n  workspace: ${workspace}\n`
    writeFileSync(join(home, 'config.yaml'), yaml('worktree'))
    const client = await Workbench.open({ home })
    const terminal = new FakeTerminal()
    const speaker = await Speaker.create({
      soundDir: tmp('tade-app-sound-'),
      platform: 'darwin',
      run: async () => {},
    })
    const app = await App.start({
      client,
      config: ConfigSchema.parse({
        projects: { empty: { root: repo.root } },
        agents: { workspace: 'worktree' },
      }),
      home,
      cwd: repo.root,
      terminal,
      speaker,
      frameMs: 50,
    })
    try {
      // Opening the window makes nothing: an agent is started when you ask for one.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await client.events({ types: ['task_created'] })).toEqual([])
      const button = () => {
        const lines = screenOf(terminal.written)
        for (let row = lines.length - 1; row >= 0; row--) {
          const col = lines[row]?.indexOf('+ New agent') ?? -1
          if (col >= 0) return { col, row }
        }
        return null
      }
      const deadline = Date.now() + 20_000
      while (!button()) {
        if (Date.now() > deadline) throw new Error('no New agent button')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const at = button() as { col: number; row: number }
      terminal.press(`\x1b[<0;${at.col + 3};${at.row + 1}M`)
      terminal.press(`\x1b[<0;${at.col + 3};${at.row + 1}m`)
      const made = async () => (await client.events({ types: ['task_created'] }))[0]
      while (!(await made())) {
        if (Date.now() > deadline) throw new Error('no agent was opened')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const created = await made()
      expect(created).toMatchObject({
        task: 'empty/agent-1',
        detail: { branch: '', workspace: 'worktree' },
      })

      // Its first change is what gives it a branch.
      const worktree = String(created?.detail.worktree)
      writeFileSync(join(worktree, 'refunds.ts'), 'export const once = true\n')
      const named = Date.now() + 20_000
      while ((await client.events({ types: ['task_named'] })).length === 0) {
        if (Date.now() > named) throw new Error('the branch was never named')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const [event] = await client.events({ types: ['task_named'] })
      expect(event).toMatchObject({ task: 'empty/agent-1', detail: { branch: 'tade/agent-1' } })
    } finally {
      await app.stop().catch(() => {})
      await client.close().catch(() => {})
    }
  }, 60_000)
})
