import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The repository has to stay searchable.
//
// grep, ripgrep and every editor's find treat a file holding a control byte as
// binary and skip it in silence — no error, no warning, just no results. A
// separator written as `` in the source is fine; the same separator
// written as the byte itself makes the whole file invisible to every search in
// the repo.
//
// This is not hypothetical. `workers.ts` held one NUL inside a template string,
// and so answered nothing to every search that crossed it — including one that
// concluded an module wired up in that very file was dead code. A formatter
// that rewrites an escape into its byte will do it again, and nothing else
// here would notice.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Tab, newline and carriage return are the three that belong in a text file. */
const ALLOWED = new Set([9, 10, 13])

function tracked(): string[] {
  return execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.md', '*.json', '*.yaml'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line !== '')
}

describe('every source file stays searchable', () => {
  it('holds no control byte that would make grep call it binary', () => {
    const guilty: string[] = []
    for (const path of tracked()) {
      const bytes = readFileSync(new URL(path, new URL(ROOT, 'file:')))
      for (const byte of bytes) {
        if (byte < 32 && !ALLOWED.has(byte)) {
          guilty.push(`${path} (byte ${byte})`)
          break
        }
      }
    }
    // Write the separator as an escape — ``, or git's own `%x01` in a
    // format string — and the file stays text.
    expect(guilty).toEqual([])
  })
})
