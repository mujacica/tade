import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Tade is built by agents running in Tade, so its own `.tade/` fills up with
// task files, pasted screenshots and check runs the way any project's does —
// and twenty-six of them were committed here before anybody noticed. None of
// it means anything on another machine.
//
// There used to be one exception, `checks.yaml`, and the rule had two halves
// because of it. There is nothing to except now: what this project checks is
// read out of `.github/workflows/ci.yml` and `.githooks/pre-commit`, which are
// files it was always going to have. So the rule is a plain denial, and the
// question this test asks is the simple one it always wanted to be.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const lines = (...args: string[]): string[] =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '')

describe("Tade's own bookkeeping", () => {
  it('is not in this repository at all', () => {
    expect(lines('ls-files', '--', '.tade')).toEqual([])
  })

  it('is ignored, so nothing here can add it back by accident', () => {
    // `--no-index` so the answer is about the rules and not about what is
    // tracked today, which is the thing the rules are meant to decide.
    const ignored = (path: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: ROOT })
        return true
      } catch {
        return false
      }
    }
    for (const path of [
      '.tade/task.yaml',
      '.tade/context.md',
      '.tade/tasks/some-task/task.yaml',
      '.tade/tasks/some-task/design.md',
      '.tade/attachments/pasted.png',
      '.tade/checks.jsonl',
      '.tade/checks.running.json',
      '.tade/checks.lock',
      '.tade/tests.json',
      // The file that used to be the exception. Ignored like everything else
      // now: nothing reads it, so one left behind on somebody's machine is
      // bookkeeping and not a gate.
      '.tade/checks.yaml',
    ]) {
      expect(ignored(path), path).toBe(true)
    }
  })
})
