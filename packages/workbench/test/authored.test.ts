import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { recordAuthored } from '../src/authored.ts'
import { Workbench } from '../src/workbench.ts'

// The history of what Tade wrote for itself.
//
// The question this exists to answer is not "what is active" — the directory
// says that — but "when did this appear, and what was going on when I agreed
// to it". Only a repository can answer that.

const log = (root: string) =>
  execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim().split('\n')

describe('recording what Tade wrote for itself', () => {
  it('starts a repository and records the first thing that appears', async () => {
    const root = tmp('tade-authored-')
    mkdirSync(join(root, 'proposed'), { recursive: true })
    writeFileSync(join(root, 'proposed', 'run-tests-first.md'), 'about: checkout\n')

    expect(await recordAuthored(root, 'lessons proposed')).toEqual({ recorded: true })
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(log(root)).toEqual(['lessons proposed'])
  })

  it('records the decision, not just the arrival', async () => {
    const root = tmp('tade-authored-')
    mkdirSync(join(root, 'proposed'), { recursive: true })
    writeFileSync(join(root, 'proposed', 'pin-majors.md'), 'Pin major versions.\n')
    await recordAuthored(root, 'lessons proposed')

    mkdirSync(join(root, 'active'), { recursive: true })
    writeFileSync(join(root, 'active', 'pin-majors.md'), 'Pin major versions.\n')
    await recordAuthored(root, 'activate lesson pin-majors')
    // Newest first: what a human agreed to, and when.
    expect(log(root)[0]).toBe('activate lesson pin-majors')
  })

  it('says nothing when nothing changed', async () => {
    const root = tmp('tade-authored-')
    writeFileSync(join(root, 'a.md'), 'x\n')
    await recordAuthored(root, 'first')
    // Opening Tade must not produce a commit a day saying nothing happened.
    expect(await recordAuthored(root, 'second')).toEqual({ recorded: false })
    expect(log(root)).toEqual(['first'])
  })

  it('asks git once when nothing changed, which is almost every open', async () => {
    const root = tmp('tade-authored-')
    writeFileSync(join(root, 'a.md'), 'x\n')
    await recordAuthored(root, 'first')
    // The real git, behind a script on PATH that writes down every time it is
    // asked: opening asks this of two folders, every time Tade opens.
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    const shim = tmp('tade-authored-shim-')
    const asked = join(shim, 'asked')
    writeFileSync(join(shim, 'git'), `#!/bin/sh\necho "$*" >> "${asked}"\nexec "${real}" "$@"\n`)
    chmodSync(join(shim, 'git'), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${shim}:${path}`
    try {
      expect(await recordAuthored(root, 'second')).toEqual({ recorded: false })
    } finally {
      process.env.PATH = path
    }
    expect(readFileSync(asked, 'utf8').trim().split('\n')).toEqual([
      'status --porcelain=v2 -z --untracked-files=all',
    ])
    expect(log(root)).toEqual(['first'])
  })

  it('records what was staged and never committed', async () => {
    const root = tmp('tade-authored-')
    writeFileSync(join(root, 'a.md'), 'x\n')
    await recordAuthored(root, 'first')
    // Somebody's `git add`, or a record that stopped between its add and its
    // commit: nothing is untracked or changed, and it is still not history.
    writeFileSync(join(root, 'b.md'), 'y\n')
    execFileSync('git', ['add', 'b.md'], { cwd: root })
    expect(await recordAuthored(root, 'second')).toEqual({ recorded: true })
    expect(log(root)).toEqual(['second', 'first'])
  })

  it('commits as Tade, never as you', async () => {
    const root = tmp('tade-authored-')
    writeFileSync(join(root, 'a.md'), 'x\n')
    await recordAuthored(root, 'first')
    const who = execFileSync('git', ['log', '--format=%an <%ae>'], { cwd: root, encoding: 'utf8' })
    expect(who.trim()).toBe('Tade <tade@localhost>')
  })

  it('never nests a repository inside one that already exists', async () => {
    const root = tmp('tade-authored-')
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'you@example.com'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'You'], { cwd: root })
    writeFileSync(join(root, 'a.md'), 'x\n')

    await recordAuthored(root, 'first')
    // It used the repository that was there rather than making a second one,
    // so somebody keeping these in their dotfiles keeps their own history.
    expect(log(root)).toEqual(['first'])
  })

  it('loses the history rather than the lesson when it cannot record', async () => {
    // A machine with no git still has to be able to accept a lesson: refusing
    // one because its history could not be written down would be absurd.
    const root = join(tmp('tade-authored-'), 'a-file-not-a-directory')
    writeFileSync(root, 'not a directory\n')
    expect(await recordAuthored(root, 'first')).toEqual({ recorded: false })
  })
})

describe("a home's own tools", () => {
  it('are recorded in that home, and nowhere else', async () => {
    // The config's default used to be `~/.tade/extensions` whatever the home,
    // so every workbench a test opened ran `git add -A` there.
    const home = tmp('tade-authored-home-')
    mkdirSync(join(home, 'extensions'), { recursive: true })
    writeFileSync(join(home, 'extensions', 'standup.ts'), 'export default {}\n')
    const client = await Workbench.open({ home })
    await client.close()
    expect(log(join(home, 'extensions'))).toEqual(['tools written since Tade was last open'])
    expect(existsSync(join(homedir(), '.tade', 'extensions'))).toBe(false)
  })
})
