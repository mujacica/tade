import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BACKGROUNDED, RETIRED_TOOLS } from '../src/background.ts'

// Agents under Claude Code called TaskOutput after Claude Code had retired it,
// and the first guess was that something Tade tells them still named it. Nothing
// did — they had it from their own history. This holds it that way: nothing
// Tade ships, whether a skill, a prompt, a tool's description or an extension's
// words, may name a tool Claude Code has retired, except the one sentence that
// says it is gone. A recipe that teaches one again fails here, not in a lane.

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const HERE = 'packages/harnesses/claude/src/background.ts'

/** What could reach an agent: every tracked file but tests and their fixtures. */
function shipped(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((path) => path !== '' && path !== HERE)
    .filter((path) => !/(^|\/)test\//.test(path) && !/\.(png|jpg|gif|ico|lock)$/.test(path))
}

describe('the Claude Code tools Tade names', () => {
  it('names none that Claude Code has retired, outside the sentence saying so', () => {
    const named = new RegExp(`\\b(${RETIRED_TOOLS.join('|')})\\b`)
    const guilty: string[] = []
    for (const path of shipped()) {
      let text: string
      try {
        text = readFileSync(join(ROOT, path), 'utf8')
      } catch {
        // Tracked and not on disk: a deletion somebody has not committed yet.
        continue
      }
      const line = text.split('\n').findIndex((one) => named.test(one))
      if (line >= 0) guilty.push(`${path}:${line + 1}`)
    }
    expect(guilty).toEqual([])
  })

  it('says how the answer comes now, and names the retired one only to say so', () => {
    expect(BACKGROUNDED).toContain('task notification')
    expect(BACKGROUNDED).toContain('do not call TaskOutput')
  })
})
