import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

// Every program Tade waits for is started by `runProgram` (`packages/core/src/run.ts`).
//
// Terminal.app names its window after the newest process in the terminal's
// foreground process group, so anything Tade starts there retitles the window
// for as long as it runs. For a long while five files started theirs with
// `execFile(…, { detached: true })` and a comment saying Node passed `detached`
// on — it does not, and the title flickered `osascript`, `ps`, `gh`, `git`.
// The comment survived because nothing asked which group a child was in; the
// first test here asks, and the second keeps the trap out of the source.
//
// `spawn` with `detached` stays allowed: it is what `runProgram` is made of,
// and what a long-lived child (an agent, a server, the recorder) needs. Tests
// and `scripts/` may use anything: they are not the window.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The ones that block, or drop `detached`, or both. */
const TRAPS = new Set(['exec', 'execFile', 'execSync', 'execFileSync'])
const ALLOWED = new Set(['packages/core/src/run.ts'])

/** Every `.ts` under a package's own `src`, nested packages included. */
function sources(): string[] {
  const out: string[] = []
  const packages = join(ROOT, 'packages')
  const look = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      const at = join(dir, entry.name)
      if (entry.name === 'src') {
        for (const file of readdirSync(at, { recursive: true, encoding: 'utf8' }))
          if (file.endsWith('.ts')) out.push(relative(ROOT, join(at, file)))
      } else if (depth < 2) look(at, depth + 1)
    }
  }
  look(packages, 0)
  return out
}

/** Which of the traps a file takes from `node:child_process`, however it imports it. */
function trapsIn(text: string): string[] {
  const found: string[] = []
  const from = String.raw`from\s+['"](?:node:)?child_process['"]`
  for (const named of text.matchAll(new RegExp(String.raw`import\s+\{([^}]*)\}\s*${from}`, 'g'))) {
    for (const name of (named[1] ?? '').split(',')) {
      const bare =
        name
          .replace(/^\s*type\s+/, '')
          .split(/\s+as\s+/)[0]
          ?.trim() ?? ''
      if (TRAPS.has(bare)) found.push(bare)
    }
  }
  const whole = String.raw`import\s+(?:\*\s+as\s+)?(\w+)\s*${from}`
  for (const module of text.matchAll(new RegExp(whole, 'g'))) {
    for (const call of text.matchAll(new RegExp(String.raw`\b${module[1]}\.(\w+)\s*\(`, 'g')))
      if (TRAPS.has(call[1] ?? '')) found.push(call[1] ?? '')
  }
  return found
}

describe('a program Tade waits for', () => {
  it('is not detached by execFile, whatever its options say', async () => {
    // Pinned so the reason for the rule below stays checkable. If this ever
    // fails, Node passes `detached` through now, and the rule may go.
    const run = promisify(execFile)
    const asked = await run('sh', ['-c', 'ps -o pgid= -p $$'], { detached: true } as object)
    const mine = await run('ps', ['-o', 'pgid=', '-p', String(process.pid)]).catch(() => null)
    if (!mine || !asked.stdout.trim()) return
    expect(asked.stdout.trim()).toBe(mine.stdout.trim())
  })

  it('reads every way of reaching the traps', () => {
    expect(trapsIn(`import { execFile, spawn } from 'node:child_process'`)).toEqual(['execFile'])
    expect(trapsIn(`import { exec as run } from "child_process"`)).toEqual(['exec'])
    expect(trapsIn(`import { type ChildProcess, spawn } from 'node:child_process'`)).toEqual([])
    expect(trapsIn(`import * as cp from 'node:child_process'\ncp.execFileSync('git')`)).toEqual([
      'execFileSync',
    ])
    expect(trapsIn(`import cp from 'node:child_process'\ncp.spawn('git')`)).toEqual([])
  })

  it('is started by runProgram, never by execFile or exec', () => {
    const files = sources()
    expect(files).toContain('packages/core/src/run.ts')
    const problems = files
      .filter((path) => !ALLOWED.has(path))
      .flatMap((path) => {
        const traps = trapsIn(readFileSync(join(ROOT, path), 'utf8'))
        return traps.length > 0 ? [`${path} uses ${[...new Set(traps)].join(', ')}`] : []
      })
    if (problems.length > 0)
      throw new Error(
        `\n\n${problems.join('\n')}\n\n` +
          '`execFile` hands `spawn` a fixed list of options and `detached` is not on it, so the\n' +
          "child sits in the terminal's foreground process group and Terminal.app retitles the\n" +
          'window after it; the Sync ones also block the thread that draws. Use `runProgram` from\n' +
          '`@tade/core` (`packages/core/src/run.ts`): its own group, an absolute path, a deadline\n' +
          'that kills the whole group, and never a throw. A file pi loads directly, which may not\n' +
          'import the workspace, uses `spawn` with `detached: true` (`tools-extension.ts`).\n',
      )
  })
})
