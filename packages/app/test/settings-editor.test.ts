import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type Setting, settingsOf } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import type { Ui } from '../src/screen.ts'
import { addProject, editSettings } from '../src/settings.ts'

// Changing what Tade has been told, from a screen rather than by editing YAML.
//
// It is the one settings surface with no drawing to golden, so nothing had
// ever run it — and every way it can go wrong loses somebody's file. The two
// that matter most are the ones asserted hardest here: **the rest of the file
// survives a change**, comments and key order included, because the config is
// something a person wrote and not something Tade owns; and **a value it will
// not accept is refused before it is written**, because a config that fails to
// load is a Tade that will not open at all.
//
// The `Ui` is scripted rather than drawn — `setup-machine.test.ts` does the
// same — because what has to be exact is what is asked, in what order, and
// what ends up in the file afterwards.

/** A Ui that answers what it is told to, in order, and writes down the rest. */
interface Recorder extends Ui {
  said: string[]
  asked: string[]
}

function recorder(answers: { choose?: number[]; ask?: string[]; confirm?: boolean[] }): Recorder {
  const said: string[] = []
  const asked: string[] = []
  const chooses = [...(answers.choose ?? [])]
  const asks = [...(answers.ask ?? [])]
  const confirms = [...(answers.confirm ?? [])]
  return {
    said,
    asked,
    say: (text: string) => said.push(text),
    context: () => {},
    async ask(question: string, fallback = '') {
      asked.push(question)
      return asks.shift() ?? fallback
    },
    async confirm(question: string, fallback: boolean) {
      asked.push(question)
      return confirms.shift() ?? fallback
    },
    async choose(question: string, options: readonly string[]) {
      asked.push(question)
      // Nothing left to say is "done", which is the last option and the only
      // way out of the loop: a test that runs out of answers ends rather than
      // spinning for ever.
      return chooses.shift() ?? options.length - 1
    },
    async pause() {},
    async run() {
      return 0
    },
  }
}

/** A config file with a comment and a key in it, as somebody would have written one. */
function configWith(body: string): string {
  const path = join(tmp('tade-settings-'), 'config.yaml')
  writeFileSync(path, body)
  return path
}

/** The settings in the order `editSettings` offers them. */
async function offered(path: string): Promise<Setting[]> {
  const loaded = await loadConfig(path)
  if (!loaded.ok) throw new Error('the fixture does not load')
  return settingsOf(loaded.config).flatMap((group) => group.settings)
}

/**
 * Where a setting sits in that list, which is what `choose` is answered with.
 *
 * Looked up rather than written down: the list is sixty-five long and grows
 * whenever somebody adds a setting, and a test pinned to index 31 would break
 * for the wrong reason and be fixed by changing the number.
 */
async function optionFor(path: string, key: string): Promise<number> {
  const at = (await offered(path)).findIndex((setting) => setting.path === key)
  if (at < 0) throw new Error(`no setting called ${key}`)
  return at
}

const read = (path: string): string => readFileSync(path, 'utf8')

describe('changing a setting from the screen', () => {
  it('writes the one line it changed and leaves the rest of the file alone', async () => {
    const path = configWith(
      '# my own note about this file\nagents:\n  workspace: checkout\n  commit: own-files\nprojects:\n  shop:\n    root: /tmp/shop\n',
    )
    const ui = recorder({ choose: [await optionFor(path, 'agents.workspace'), 1] })
    await editSettings(ui, path)

    const after = read(path)
    expect(after).toContain('workspace: worktree')
    // The file is somebody else's. A settings screen that reformats it, drops
    // their comment or reorders their keys has taken something from them that
    // it was never asked to touch.
    expect(after).toContain('# my own note about this file')
    expect(after).toContain('commit: own-files')
    expect(after).toContain('root: /tmp/shop')
  })

  it('says what the setting is now, so nobody has to open the file to find out', async () => {
    const path = configWith('agents:\n  commit: own-files\n')
    const ui = recorder({ choose: [await optionFor(path, 'agents.commit'), 0] })
    await editSettings(ui, path)
    expect(ui.said).toContain('When agents commit is now when-done')
    expect(read(path)).toContain('commit: when-done')
  })

  it('leaves a choice as it was when that is what was chosen', async () => {
    const path = configWith('agents:\n  workspace: worktree\n')
    const before = read(path)
    // The last option of a choice is `leave it (…)`, which is never mind.
    const at = await optionFor(path, 'agents.workspace')
    const ui = recorder({ choose: [at, 2] })
    await editSettings(ui, path)
    expect(read(path)).toBe(before)
    expect(ui.said.some((line) => line.includes('is now'))).toBe(false)
  })

  it('asks a flag as a yes or no, and writes the answer', async () => {
    const path = configWith('workspace:\n  adopt: true\n')
    const ui = recorder({ choose: [await optionFor(path, 'workspace.adopt')], confirm: [false] })
    await editSettings(ui, path)
    expect(read(path)).toContain('adopt: false')
  })

  it('refuses a value of the wrong shape, says what shape, and writes nothing', async () => {
    const path = configWith('journal:\n  max_mb: 16\n')
    const ui = recorder({ choose: [await optionFor(path, 'journal.max_mb')], ask: ['ten-ish'] })
    await editSettings(ui, path)

    // The whole point of asking here rather than writing and finding out: the
    // schema would refuse this on the next load, and a config Tade cannot load
    // is a Tade that will not open.
    expect(read(path)).toContain('max_mb: 16')
    expect(ui.said.some((line) => line.includes('a whole number above zero'))).toBe(true)
  })

  it('puts a setting back to its default when the answer is blank', async () => {
    const path = configWith('journal:\n  max_mb: 64\n')
    const ui = recorder({ choose: [await optionFor(path, 'journal.max_mb')], ask: [''] })
    await editSettings(ui, path)

    expect(read(path)).not.toContain('max_mb')
    expect(ui.said).toContain('Journal size back to its default (16 MB)')
  })

  it('takes a blank answer as never mind where nothing was set', async () => {
    const path = configWith('agents:\n  workspace: checkout\n')
    const before = read(path)
    const ui = recorder({ choose: [await optionFor(path, 'agents.instructions')], ask: [''] })
    await editSettings(ui, path)
    // Nothing was set and nothing was typed, so there is nothing to say and
    // nothing to write — not "back to its default", which sounds like an act.
    expect(read(path)).toBe(before)
    expect(ui.said.some((line) => line.includes('back to its default'))).toBe(false)
  })

  it('goes round again, so several settings change in one sitting', async () => {
    const path = configWith('agents:\n  workspace: checkout\n  commit: own-files\n')
    const ui = recorder({
      choose: [
        await optionFor(path, 'agents.workspace'),
        1,
        await optionFor(path, 'agents.commit'),
        3,
      ],
    })
    await editSettings(ui, path)
    const after = read(path)
    expect(after).toContain('workspace: worktree')
    expect(after).toContain('commit: never')
  })

  it('says what a setting means before asking what it should be', async () => {
    const path = configWith('agents:\n  workspace: checkout\n')
    const ui = recorder({ choose: [await optionFor(path, 'agents.workspace'), 0] })
    await editSettings(ui, path)
    // A settings list is names; the consequence is said where somebody is
    // about to change one, which is here and nowhere else on this screen.
    expect(ui.said.some((line) => line.startsWith('Where agents work: '))).toBe(true)
  })

  it('ends when nothing more is chosen, and never asks again after that', async () => {
    const path = configWith('agents:\n  workspace: checkout\n')
    const ui = recorder({})
    await editSettings(ui, path)
    expect(ui.asked).toEqual(['What would you like to change?'])
  })

  it('refuses to edit a config it cannot load rather than writing over it', async () => {
    const path = configWith('agents:\n  workspace: neither one nor the other\n')
    await expect(editSettings(recorder({}), path)).rejects.toThrow('invalid config')
  })
})

describe('adding a project', () => {
  it('writes the root under its name, keeping every other project', async () => {
    const path = configWith('# mine\nprojects:\n  shop:\n    root: /tmp/shop\n')
    addProject(path, 'till', '/tmp/till')

    const loaded = await loadConfig(path)
    expect(loaded.ok).toBe(true)
    // A project is two values that only mean something together; half of one
    // written down is a config that fails to load, which is why this is its
    // own function rather than a dotted write at the call site.
    expect(read(path)).toContain('# mine')
    expect(read(path)).toContain('root: /tmp/shop')
    expect(read(path)).toContain('root: /tmp/till')
  })
})
