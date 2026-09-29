import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Tade is built by agents running in Tade, so this repository is the first one
// any mistake about its own files shows up in — twenty-six of them were
// committed here before anybody noticed.
//
// It used to be ignored: `/.tade/*` appended to this file, plus one exception,
// because Tade wrote its bookkeeping into the checkout and it had to be kept
// out of the history. Nothing is written there now — every task file, check
// run, lock and attachment is under `<TADE_HOME>/projects/<name>/` — so the
// question this asks is the one it always wanted to be: **is there anything of
// Tade's in here at all**, tracked or untracked, ignored or not.
//
// A rule is the wrong tool for that, because a rule can only hide it. What is
// asked instead is what `git status` says, which is what somebody pushing sees.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })

describe("Tade's own bookkeeping", () => {
  it('is not in this repository at all', () => {
    expect(git('ls-files', '--', '.tade').trim()).toBe('')
  })

  it('would be visible rather than hidden if anything ever wrote it again', () => {
    // The protection is not a rule that hides it — that was the old answer and
    // it is what let twenty-six files through. It is that nothing writes it and
    // nothing conceals it, so a `.tade/` appearing here is untracked in
    // `git status`, in front of whoever is about to commit.
    //
    // Asked of the rules rather than of the disk: an older Tade still running
    // on this machine writes its lock and its live run there while it runs, and
    // that is a fact about the machine, not about this repository.
    const ignored = (path: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: ROOT })
        return true
      } catch {
        return false
      }
    }
    for (const path of [
      '.tade',
      '.tade/task.yaml',
      '.tade/tasks/a/task.yaml',
      '.tade/checks.jsonl',
    ])
      expect(ignored(path), path).toBe(false)
  })

  it('needs no rule in .gitignore, and there is none', () => {
    // The undo is `removeOwnIgnore`, which takes the rule back out of every
    // project Tade had written it into — this one included. Nothing may put it
    // back: a rule for files nobody writes is a rule nobody can check.
    // `.tade-test-*/` stays: that is the suite's own scratch, and its own file.
    const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
    expect(ignore).not.toMatch(/\.tade\//)
  })
})
