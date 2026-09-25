import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { installedPieces } from '../src/installed.ts'

// What pi loads by itself, whoever runs it: read and never adopted, so the
// window can list them beside Tade's own and nobody takes an agent's own
// extensions for ones Tade gave it.
//
// `claude` and `codex` have had this test since their readers went in; pi's
// never did, and pi is the harness every agent runs in by default.
//
// The rule it has to keep is the one every reader of somebody else's files
// keeps here: **anything unfamiliar is left out, and nothing throws.** These
// are pi's files, they may change shape under us, and the window folds this
// four times a second — a reader that throws on a settings file somebody
// hand-edited takes the whole page with it.

/** A home (or a project) with these files in it. */
function tree(files: Record<string, string>): string {
  const dir = tmp('tade-pi-own-')
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  return dir
}

describe('the extensions and skills pi loads by itself', () => {
  it('lists your own, with the folder you would look in', () => {
    const home = tree({
      '.pi/agent/extensions/linear.ts': '',
      '.pi/agent/extensions/notes.js': '',
      '.pi/agent/skills/cut-a-release/SKILL.md': '',
    })
    expect(installedPieces(home)).toEqual([
      { name: 'linear', where: '~/.pi/agent/extensions' },
      { name: 'notes', where: '~/.pi/agent/extensions' },
      { name: 'cut-a-release', where: '~/.pi/agent/skills' },
    ])
  })

  it('names an extension by what it is called and not by what it is written in', () => {
    // `.ts`, `.js` and `.mjs` are the same extension to a person, and the
    // window lists this beside Tade's own, which have no suffix at all.
    const home = tree({
      '.pi/agent/extensions/one.ts': '',
      '.pi/agent/extensions/two.mjs': '',
      '.pi/agent/extensions/three.js': '',
      '.pi/agent/extensions/four': '',
    })
    expect(installedPieces(home).map((piece) => piece.name)).toEqual([
      'four',
      'one',
      'three',
      'two',
    ])
  })

  it('lists the packages `pi install` put there, however that file spells one', () => {
    // pi has written both shapes; a reader that knows only one silently lists
    // half of what an agent can do.
    const home = tree({
      '.pi/agent/settings.json': JSON.stringify({
        packages: ['tade-sh/pack', { source: 'acme/tools', version: '2' }],
        other: true,
      }),
    })
    expect(installedPieces(home)).toEqual([
      { name: 'tade-sh/pack', where: 'pi install' },
      { name: 'acme/tools', where: 'pi install' },
    ])
  })

  it("lists the project's own beside yours, where it was asked about one", () => {
    const home = tree({ '.pi/agent/extensions/mine.ts': '' })
    const project = tree({ '.pi/extensions/house.ts': '', '.pi/skills/deploy/SKILL.md': '' })
    expect(installedPieces(home, project)).toEqual([
      { name: 'mine', where: '~/.pi/agent/extensions' },
      { name: 'house', where: `${project}/.pi/extensions` },
      { name: 'deploy', where: `${project}/.pi/skills` },
    ])
  })

  it("says nothing about a project's own where it was not asked about a project", () => {
    const home = tree({ '.pi/agent/extensions/mine.ts': '' })
    expect(installedPieces(home).map((piece) => piece.name)).toEqual(['mine'])
  })

  it('leaves out what it does not recognise, rather than throwing', () => {
    // Each of these is a real shape somebody's machine can be in, and every
    // one of them used to be a question nobody had asked.
    expect(installedPieces(tree({}))).toEqual([])
    expect(installedPieces(tree({ '.pi/agent/settings.json': 'not json' }))).toEqual([])
    expect(installedPieces(tree({ '.pi/agent/settings.json': '{"packages":"one"}' }))).toEqual([])
    expect(
      installedPieces(tree({ '.pi/agent/settings.json': '{"packages":[1,null,{}]}' })),
    ).toEqual([])
    expect(installedPieces(join(tmp('tade-pi-none-'), 'no-such-home'))).toEqual([])
    expect(installedPieces(tree({}), join(tmp('tade-pi-none-'), 'no-such-project'))).toEqual([])
  })

  it('leaves out the dotfiles a folder collects, which are nobody’s extension', () => {
    const home = tree({
      '.pi/agent/extensions/.DS_Store': '',
      '.pi/agent/extensions/real.ts': '',
      '.pi/agent/skills/.git/HEAD': '',
      '.pi/agent/skills/real-skill/SKILL.md': '',
    })
    expect(installedPieces(home).map((piece) => piece.name)).toEqual(['real', 'real-skill'])
  })
})
