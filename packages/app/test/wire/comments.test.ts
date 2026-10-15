import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { THEIR_WORDS } from '../../src/inbox.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// A comment on a line of a change, from the window all the way to who it was
// for: written in the editor a changed file opens in, kept, and sent — to Tade
// as the person's own turn, or straight to an agent.
//
// Against a real repository and a real workbench, so the hunk a comment
// carries is what git said, and what is written down as `said` is read back
// out of the journal rather than out of a fake.

const BEFORE = ['export const rate = 1', 'export const other = 2', ''].join('\n')
const AFTER = ['export const rate = 2', 'export const other = 2', 'export const vat = 0', ''].join(
  '\n',
)

describe('the window, and a comment on a line of a change', () => {
  let terminal: FakeTerminal
  let repo: Repo
  let client: Workbench
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    repo = wired.repo
    client = wired.client
  })

  /** A task that changed `ledger.ts`, opened from CHANGES with its diff drawn in — or read as a patch. */
  async function openChange(asked: string[], patch = false): Promise<void> {
    repo.commit('a ledger', { 'ledger.ts': BEFORE })
    const worktree = repo.addTask('ledger', { project: 'app', intent: 'the rate is wrong' })
    writeFileSync(join(worktree, 'ledger.ts'), AFTER)
    terminal.rows = 44
    terminal.columns = 120
    await start({
      thinker: {
        ask: async (text: string) => {
          asked.push(text)
          return ''
        },
      },
    })
    await until('its changed file in CHANGES', () =>
      screenOf(terminal.written).some((row) => row.includes('ledger.ts') && row.includes('+2 −1')),
    )
    const row = find('+2 −1')
    if (!patch) {
      click(row.col, row.row)
      await until('the diff drawn in the file', () =>
        screenOf(terminal.written).some((one) => one.includes('−') && one.includes('rate = 1')),
      )
      return
    }
    // Its menu, and the patch reader out of it.
    terminal.press(`\x1b[<2;${row.col + 1};${row.row + 1}M`)
    terminal.press(`\x1b[<2;${row.col + 1};${row.row + 1}m`)
    await until('the menu', () => terminal.written.includes('Read as a patch'))
    const item = find('Read as a patch')
    click(item.col, item.row)
    await until('the patch', () =>
      screenOf(terminal.written).some((one) => one.includes('- export const rate = 1')),
    )
  }

  /** Type into whatever has the keyboard, a character at a time, as a terminal sends it. */
  function type(text: string): void {
    for (const char of text) terminal.press(char)
  }

  it('sends a comment to Tade as their words, with the line and its hunk above them', async () => {
    const asked: string[] = []
    await openChange(asked)

    // `c` writes on the first line added in view — the rate.
    terminal.press('c')
    await until('the box, on line 1', () => terminal.written.includes('On line 1'))
    type('why two?  check the  VAT')
    terminal.press('\r')
    await until('it kept', () => terminal.written.includes('Send 1'))

    // And a second, on a line whose number is pressed, so both go together.
    const vat = find('export const vat = 0')
    click(vat.col - 4, vat.row)
    await until('the box, on line 3', () => terminal.written.includes('On line 3'))
    type('zero for now?')
    terminal.press('\r')
    await until('two kept', () => terminal.written.includes('Send 2'))

    terminal.press('s')
    await until('the orchestrator asked', () => asked.length === 1)
    const message = asked[0] ?? ''
    const [above, words] = message.split(`\n${THEIR_WORDS}\n`)
    // Their words, exactly as typed, and nothing an agent wrote among them.
    expect(words).toBe('[1] why two?  check the  VAT\n[2] zero for now?')
    expect(above).toContain('[1] ledger.ts:1 — on app/ledger’s change')
    expect(above).toContain('-export const rate = 1\n+export const rate = 2')
    expect(above).toContain('[2] ledger.ts:3')
    expect(above).toContain('+export const vat = 0')

    // What is written down as said is the words and only the words.
    const said = async () =>
      (await client.events({ types: ['said'] })).map((event) => event.detail.text)
    await until('it written down', async () => (await said()).length === 2)
    expect(await said()).toEqual(['why two?  check the  VAT', 'zero for now?'])
    await until('it says so', () => terminal.written.includes('sent 2 comments to Tade'))
    // Sent is sent: nothing is left to send.
    await until('nothing kept', () => !screenOf(terminal.written).some((r) => r.includes('Send 2')))
  })

  it('sends one straight to the agent whose change it is, chosen on the comment', async () => {
    const asked: string[] = []
    const steered: { task: string; message: string }[] = []
    client.steerAgent = async (task: string, message: string) => {
      steered.push({ task, message })
    }
    await openChange(asked)

    terminal.press('c')
    await until('the box', () => terminal.written.includes('On line 1'))
    type('use the constant')
    // Tab says who: the agent whose change this is comes first after Tade.
    terminal.press('\t')
    await until('to the agent', () =>
      screenOf(terminal.written).some((row) => row.includes('On line 1') && row.includes('ledger')),
    )
    terminal.press('\r')
    await until('it kept', () => terminal.written.includes('Send 1'))
    terminal.press('s')

    await until('the agent told', () => steered.length === 1)
    expect(steered[0]?.task).toBe('app/ledger')
    expect(steered[0]?.message).toContain('ledger.ts:1\n```diff')
    expect(steered[0]?.message).toContain('```\nuse the constant')
    // Nothing went to Tade, and nothing was written down as said.
    expect(asked).toEqual([])
    expect(await client.events({ types: ['said'] })).toEqual([])
  })

  it('keeps a comment an agent could not be told, and says why', async () => {
    const asked: string[] = []
    client.steerAgent = async (task: string) => {
      throw new Error(`no agent running on ${task}`)
    }
    await openChange(asked)
    terminal.press('c')
    await until('the box', () => terminal.written.includes('On line 1'))
    type('later')
    terminal.press('\t')
    terminal.press('\r')
    await until('it kept', () => terminal.written.includes('Send 1'))
    terminal.press('s')
    // The reason in the conversation, which the panel was over.
    terminal.press('\x1b')
    await until('the reason', () =>
      screenOf(terminal.written).some((row) => row.includes('no agent running on app/ledger')),
    )
    // And still there to send, because nothing typed is lost to an agent that
    // stopped: the change opened again has it.
    expect(screenOf(terminal.written).some((one) => one.includes('Send 1'))).toBe(false)
    const row = find('+2 −1')
    click(row.col, row.row)
    await until('it still kept', () =>
      screenOf(terminal.written).some((one) => one.includes('Send 1')),
    )
  })

  it('writes on a line of the patch reader too, and sends it the same way', async () => {
    const asked: string[] = []
    await openChange(asked, true)

    // ↓ puts the keyboard on the first change, the line taken out; ↓ again on the new one.
    terminal.press('\x1b[B')
    terminal.press('\x1b[B')
    terminal.press('c')
    await until('the box, on the new line 1', () => terminal.written.includes('On line 1'))
    type('two, really?')
    terminal.press('\r')
    await until('it kept', () => terminal.written.includes('Send 1'))
    terminal.press('s')

    await until('the orchestrator asked', () => asked.length === 1)
    const [above, words] = (asked[0] ?? '').split(`\n${THEIR_WORDS}\n`)
    expect(words).toBe('two, really?')
    expect(above).toContain('ledger.ts:1 — on app/ledger’s change')
    expect(above).toContain('-export const rate = 1\n+export const rate = 2')
  })
})
