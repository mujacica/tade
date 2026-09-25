import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ui } from '@tade/app'
import { readSchedules } from '@tade/workbench/schedules'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { setUpWatches } from '../src/commands/setup-watches.ts'

// The first minute, where it offers the watches.
//
// The rule about which of them are ticked is pure and is held in core. What is
// held here is that the question actually reaches somebody — that it says what
// each one costs before anybody answers, and that saying yes writes a schedule
// the window and the Extensions page will both recognise.

/** A screen that remembers what it said and answers the way a test tells it to. */
class Answers implements Ui {
  readonly said: string[] = []
  readonly asked: string[] = []
  /** Which option to take, by the text it starts with. */
  private readonly choice: string
  private readonly confirms: (question: string) => boolean

  constructor(choice: string, confirms: (question: string) => boolean = () => true) {
    this.choice = choice
    this.confirms = confirms
  }
  say(text: string): void {
    this.said.push(text)
  }
  context(): void {}
  async ask(): Promise<string> {
    return ''
  }
  async confirm(question: string): Promise<boolean> {
    this.asked.push(question)
    return this.confirms(question)
  }
  async choose(question: string, options: readonly string[]): Promise<number> {
    this.asked.push(question)
    const at = options.findIndex((one) => one.startsWith(this.choice))
    return at < 0 ? options.length - 1 : at
  }
  async pause(): Promise<void> {}
  async run(): Promise<number> {
    return 0
  }
}

describe('the watches setting up offers', () => {
  let home: string
  let was: string | undefined

  beforeEach(() => {
    home = tmp('tade-setup-watches-')
    const repo = mkrepo()
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`, 'utf8')
    was = process.env.TADE_HOME
    process.env.TADE_HOME = home
  })

  afterEach(() => {
    if (was === undefined) delete process.env.TADE_HOME
    else process.env.TADE_HOME = was
  })

  it('says what each watch costs before anybody answers, and writes nothing on "none"', async () => {
    const ui = new Answers('none for now')
    await setUpWatches(ui, home)
    const said = ui.said.join('\n')
    // Tade's own extensions are on unless somebody turns them off, so this is
    // the real list rather than a made-up one. The dependency watch is the
    // honest case: it is useful and it starts agents, and it says so.
    expect(said).toContain('Vulnerable dependencies')
    expect(said).toContain('starts an agent on each thing it finds')
    expect(said).toContain('every day')
    expect(ui.asked.some((one) => one.startsWith('Which should Tade watch for in app?'))).toBe(true)
    expect(readSchedules(home)).toEqual([])
  })

  it('writes what was picked, under the id the Extensions page turns off', async () => {
    const ui = new Answers('let me pick', (question) => question.includes('vulnerable'))
    await setUpWatches(ui, home)
    const written = readSchedules(home)
    expect(written).toMatchObject([
      {
        id: 'vulnerable-dependencies',
        name: 'Vulnerable dependencies',
        project: 'app',
        by: 'you',
        when: { every: '1d' },
        does: { kind: 'watch', watch: 'deps.vulnerabilities', found: 'agent' },
      },
    ])
    // Its own sentence is said where the question is asked, not only in the
    // one-line list above it.
    expect(ui.said.join('\n')).toContain('checks against OSV')
  })

  it('asks nothing twice: with every watch already on there is no question', async () => {
    await setUpWatches(new Answers('let me pick'), home)
    const again = new Answers('let me pick')
    await setUpWatches(again, home)
    expect(again.asked.filter((one) => one.includes('vulnerable'))).toEqual([])
  })
})
