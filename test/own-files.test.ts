import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MANIFEST_PATH } from '@tade/checks-core'
import { describe, expect, it } from 'vitest'

// Tade is built by agents running in Tade, so its own `.tade/` fills up with
// task files, pasted screenshots and check runs the way any project's does —
// and twenty-six of them were committed here before anybody noticed. None of
// it means anything on another machine.
//
// The manifest is the one exception, and the reason this is a test rather
// than a line in `.gitignore` nobody reads again: the rule has two halves, and
// the half that quietly stops working is the exception. `/.tade/` instead of
// `/.tade/*` looks identical and silently takes `checks.yaml` with it, because
// git never descends into an ignored folder — and then CI is generated from a
// file that is not in the repository.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const lines = (...args: string[]): string[] =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '')

describe("Tade's own bookkeeping", () => {
  it('is not in this repository, except the checks manifest', () => {
    expect(lines('ls-files', '--', '.tade')).toEqual([MANIFEST_PATH])
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
    ]) {
      expect(ignored(path), path).toBe(true)
    }
    expect(ignored(MANIFEST_PATH), MANIFEST_PATH).toBe(false)
  })
})
