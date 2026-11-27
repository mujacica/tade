import { rm } from 'node:fs/promises'
import type { FarEnd } from '@tade/remotes-core/far'
import { afterEach, describe, expect, it } from 'vitest'
import { MACHINE } from '../../src/wire/web-panel.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'
import { linkedToIpax } from './linked.ts'

// The `+` with another machine linked, through the whole window: it asks
// where, this machine first so enter does what it always did, and a project
// on that machine starts an agent there through that machine's own tool host
// — its `task/create` and `worker/start`, asked over the link.

describe('the + with another machine linked', () => {
  let terminal: FakeTerminal
  const fars: FarEnd[] = []
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
  })

  afterEach(async () => {
    await Promise.all(fars.map((far) => far.close()))
    await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
    fars.length = 0
  })

  const rows = () => screenOf(terminal.written)
  const shown = (text: string) => rows().some((row) => row.includes(text))
  const said = (what: string) => () => `${what}, where the screen shows:\n${rows().join('\n')}`
  const linked = () => linkedToIpax(wired, (far) => fars.push(far))

  /** The `+` pinned to AGENTS' heading. */
  function pressAgentsPlus(): void {
    const heading = wired.headingRow('AGENTS')
    wired.click(heading.text.lastIndexOf('+'), heading.row)
  }

  it('asks which machine, this one first, then each project on the other', async () => {
    await linked()
    pressAgentsPlus()
    await until(said('where it asks'), () => shown('New agent on ipax'))
    const menu = rows().join('\n')
    // This machine by the name it has on this platform: `this Mac`, `this machine` on Linux.
    expect(menu).toContain(`▌ New agent on ${MACHINE}`)
    expect(menu).toContain('hello')
    expect(menu).toContain('tade')
  })

  it('starts an agent on that machine on the words given, and stands looking at it', async () => {
    const far = await linked()
    pressAgentsPlus()
    await until(said('where it asks'), () => shown('New agent on ipax'))
    // Down past this machine to ipax's first project, hello.
    terminal.press('\x1b[B')
    terminal.press('\r')
    await until(said('what it is for'), () => shown('New agent on ipax in hello'))
    terminal.press('ring the bell')
    terminal.press('\r')
    await until(
      () => `the agent asked of ipax, where it was asked: ${JSON.stringify(far.toolCalls)}`,
      () => far.toolCalls.some((one) => one.method === 'worker/start'),
      20_000,
    )
    expect(far.toolCalls.map((one) => [one.method, one.params])).toEqual([
      ['task/create', { project: 'hello', slug: 'ring-the-bell', intent: 'ring the bell' }],
      [
        'worker/start',
        {
          task: 'hello/ring-the-bell',
          cwd: expect.stringContaining('hello/ring-the-bell'),
          prompt: 'ring the bell',
        },
      ],
    ])
    // A press here is the person's own hand: nothing of what they typed here is carried as words.
    expect(far.toolCalls.every((one) => one.quoted.length === 0)).toBe(true)
    await until(said('the start said'), () => shown('hello/ring-the-bell is starting on ipax'))
  })

  it('opens the lower pane’s own menu with a terminal in each project there after it', async () => {
    await linked()
    const at = wired.find('[ + ]')
    wired.click(at.col + 2, at.row)
    await until(said('the menu below'), () => shown('Terminal on ipax'))
    const menu = rows().join('\n')
    // This machine's own items first, the terminal where enter lands.
    expect(menu).toMatch(/▌ Terminal/)
    expect(menu.indexOf('Terminal on ipax')).toBeGreaterThan(menu.indexOf('▌ Terminal'))
  })

  it('offers a terminal on the hub too, whose tab folds into the strip', async () => {
    // ipax is the hub by default, the one machine linked: no tab of its own
    // along the lower pane, and its projects take a terminal all the same.
    await linkedToIpax(wired, (far) => fars.push(far), [], { hub: true })
    const at = wired.find('[ + ]')
    wired.click(at.col + 2, at.row)
    await until(said('the menu below'), () => shown('Bring a chat back'))
    await until(said('the menu below'), () => shown('Terminal on ipax'))
  })
})
