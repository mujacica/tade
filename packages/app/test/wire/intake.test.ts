import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, taskDir } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// Work that arrived from outside this machine, in the window: the section down
// the side, the page one row opens, and the three things a person does about
// one — approve it, refuse it, try it again.
//
// Driven the way a person drives it: the key or the click, on the rebuilt
// screen, against a real workbench. What is asserted afterwards is the *task
// file* and the *journal*, because what matters about approving is that the
// park is actually lifted, not that a sentence appeared.

/** One delivery, written into the journal the way the delivery path writes it. */
async function handedOver(
  client: Workbench,
  over: { task?: string; mode?: string } = {},
): Promise<void> {
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
    task: over.task ?? 'app/refunds',
    detail: {
      ...where,
      grant: 'surfaces.intake.sources.cli',
      mode: over.mode ?? 'propose',
      template: 'bug',
      version: 3,
    },
  })
}

describe('the window, and work handed to it from outside', () => {
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

  /**
   * The task the delivery made, parked, which is what a proposal is.
   *
   * The key is *replaced* rather than appended: the file ends inside the
   * `start:` block, so a line added at the end is indented under it and the
   * whole task file stops parsing — which the window draws as a warning and
   * nothing else, so the test would fail about the wrong thing.
   */
  const park = async (task = 'app/refunds') => {
    const file = join(taskDir(home, task), 'task.yaml')
    const text = readFileSync(file, 'utf8')
    writeFileSync(
      file,
      /^parked:/m.test(text)
        ? text.replace(/^parked: .*$/m, 'parked: true')
        : `parked: true\n${text}`,
    )
  }

  const parked = (task = 'app/refunds') =>
    /^parked: true$/m.test(readFileSync(join(taskDir(home, task), 'task.yaml'), 'utf8'))

  /**
   * A terminal with room for the whole side.
   *
   * INTAKE sits under AGENTS, the queue and the clockwork, and on
   * twenty-four rows its own rows are below the fold — drawn, and scrolled
   * past. A test that pressed a row it cannot see would be a test about the
   * scroll offset rather than about the inbox.
   */
  const tall = () => {
    terminal.rows = 60
  }

  /**
   * The window with the local door granted, which approving reads again at the
   * press.
   *
   * A grant is permission at the moment of acting, not permission once: with
   * no grant in the config, approving is refused and says which key — which is
   * right, and is its own test rather than the state every other one starts in.
   */
  const granted = () =>
    start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        surfaces: {
          intake: {
            enabled: true,
            sources: { cli: { accept: true, projects: ['app'], from: ['kim'] } },
          },
        },
      }),
    })

  it('says why the section is empty in the words of the reason it is', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('INTAKE'))
    // Off is the default, and the section says that rather than "nothing yet":
    // one sentence over all three cases reads as a bug the moment one is
    // untrue.
    await until('the reason it is empty', () =>
      screenOf(terminal.written).join('\n').includes('off'),
    )
  })

  it('lists a request with its state and who asked, and opening it is not approving it', async () => {
    tall()
    await park()
    await handedOver(client)
    await start()
    await until('the request down the side', () => terminal.written.includes('req-1'))
    const screen = screenOf(terminal.written).join('\n')
    expect(screen).toContain('req-1')
    expect(screen).toContain('proposed')
    // Who asked, in the room a side twenty-odd columns wide has. What it is
    // stamped from is on the page a click opens, where there are columns for it.
    expect(screen).toContain('@kim')

    const at = find('req-1')
    click(at.col, at.row)
    await until('the page it opens', () => terminal.written.includes('WHERE IT CAME FROM'))
    const page = screenOf(terminal.written).join('\n')
    // The grant as the key somebody can go and remove, and the published
    // version resolved when it was accepted.
    expect(page).toContain('surfaces.intake.sources.cli')
    expect(page).toContain('bug@3')
    // The request itself, under the label saying whose words it is.
    expect(page).toContain('THE REQUEST ITSELF')
    // And looking at it has started nothing.
    expect(parked()).toBe(true)
    expect(client.runs()).toEqual([])
  })

  it('asks before approving, because it starts agents on somebody else’s words', async () => {
    tall()
    await park()
    await handedOver(client)
    await start()
    await until('the request down the side', () => terminal.written.includes('req-1'))
    const at = find('req-1')
    click(at.col, at.row)
    await until('the page', () => terminal.written.includes('WHERE IT CAME FROM'))

    terminal.press('a')
    await until('the question', () => terminal.written.includes('Approve it?'))
    expect(screenOf(terminal.written).join('\n')).toContain('somebody else’s words')
    // Escape is no, and it is always exactly one thing: it answers the
    // question rather than also closing the page.
    terminal.press('\x1b')
    await until('the question gone', () => {
      const page = screenOf(terminal.written).join('\n')
      return page.includes('WHERE IT CAME FROM') && !page.includes('Approve it?')
    })
    expect(parked()).toBe(true)
  })

  it('approving lifts the park, through the same door the CLI calls', async () => {
    tall()
    await park()
    await handedOver(client)
    await granted()
    await until('the request down the side', () => terminal.written.includes('req-1'))
    const at = find('req-1')
    click(at.col, at.row)
    await until('the page', () => terminal.written.includes('WHERE IT CAME FROM'))
    terminal.press('a')
    await until('the question', () => terminal.written.includes('Approve it?'))
    terminal.press('y')
    await until('the park lifted', () => !parked())
    // Said in the conversation rather than as a notice the next notice
    // overwrites: an act on an outside request is what somebody comes back to.
    await until('said in the conversation', () =>
      screenOf(terminal.written).join('\n').includes('is approved'),
    )
  })

  it('refuses to approve under a grant nobody has given, naming the key', async () => {
    tall()
    await park()
    await handedOver(client)
    await start()
    await until('the request down the side', () => terminal.written.includes('req-1'))
    const at = find('req-1')
    click(at.col, at.row)
    await until('the page', () => terminal.written.includes('WHERE IT CAME FROM'))
    terminal.press('a')
    await until('the question', () => terminal.written.includes('Approve it?'))
    terminal.press('y')
    await until('the key named', () =>
      screenOf(terminal.written).join('\n').includes('surfaces.intake.enabled is off'),
    )
    expect(parked()).toBe(true)
  })

  it('shows what approving would start, and starts none of it', async () => {
    tall()
    await park()
    await handedOver(client)
    await start()
    await until('the request down the side', () => terminal.written.includes('req-1'))
    const at = find('req-1')
    click(at.col, at.row)
    await until('the dry run', () => terminal.written.includes('WHAT APPROVING IT STARTS'))
    const page = screenOf(terminal.written).join('\n')
    expect(page).toContain('refunds')
    expect(page).toContain('It grants nothing')
    expect(parked()).toBe(true)
  })

  it('refusing parks it, writes it down, and posts nothing', async () => {
    tall()
    await handedOver(client)
    await start()
    await until('the request down the side', () => terminal.written.includes('req-1'))
    const at = find('req-1')
    click(at.col, at.row)
    await until('the page', () => terminal.written.includes('WHERE IT CAME FROM'))
    terminal.press('r')
    await until('the question', () => terminal.written.includes('Refuse it?'))
    terminal.press('y')
    await until(
      'the refusal written down',
      async () => (await client.events({ types: ['intake_refused'] })).length === 1,
    )
    const [refused] = await client.events({ types: ['intake_refused'] })
    expect(refused?.detail.why).toBe('by_hand')
    expect(await client.events({ types: ['intake_replied'] })).toEqual([])
    expect(parked()).toBe(true)
  })

  it('tries a delivery that failed again by asking its own watch, and says when it cannot', async () => {
    await handedOver(client)
    await client.log.append({
      type: 'intake_held',
      detail: {
        item: 'cli:req-1',
        source: 'cli',
        external_id: 'req-1',
        revision: '1',
        project: 'app',
        problem: 'the source would not answer',
        gave_up: true,
      },
    })
    tall()
    await start()
    await until('the request down the side', () => terminal.written.includes('req-1'))
    expect(screenOf(terminal.written).join('\n')).toContain('failure')
    const at = find('req-1')
    click(at.col, at.row)
    await until('the page', () => terminal.written.includes('WHERE IT CAME FROM'))
    // The retry goes through the watch's own look, and this window runs no
    // extensions — which is said, rather than quietly doing nothing or
    // pretending to have asked.
    terminal.press('t')
    await until('why it could not', () =>
      screenOf(terminal.written).join('\n').includes('runs no extensions'),
    )
  })
})
