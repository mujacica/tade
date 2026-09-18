import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { recordAuthored } from '../src/authored.ts'

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
