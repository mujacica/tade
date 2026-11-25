import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { carrying, outgoing, pushedOf, verdict } from '../scripts/push-guard.ts'
import { gitEnv, runGit, tmp } from './fixtures/mkrepo.ts'

// A push carrying this machine's host name is refused before it leaves
// (`.githooks/pre-push`, `scripts/push-guard.ts`). The host here is a
// placeholder the shape of a real one, as in `hostname.test.ts`: the real one
// is never written in this repository.

const HOST = 'SERIAL7Q2X.laptop.example'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ZERO = '0'.repeat(40)

/** A repository with one clean commit, pushed to a bare remote called origin. */
function pushedRepo(): { dir: string; remote: string; base: string } {
  const remote = tmp('tade-guard-remote-')
  runGit(remote, 'init', '--bare', '-q', '-b', 'main')
  const dir = tmp('tade-guard-')
  runGit(dir, 'init', '-q', '-b', 'main')
  runGit(dir, 'remote', 'add', 'origin', remote)
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  runGit(dir, 'add', 'a.txt')
  runGit(dir, 'commit', '-q', '-m', 'A first commit')
  runGit(dir, 'push', '-q', 'origin', 'main')
  return { dir, remote, base: runGit(dir, 'rev-parse', 'HEAD').trim() }
}

function commit(dir: string, file: string, text: string, message: string): string {
  writeFileSync(join(dir, file), text)
  runGit(dir, 'add', file)
  runGit(dir, 'commit', '-q', '-m', message)
  return runGit(dir, 'rev-parse', 'HEAD').trim()
}

const line = (local: string, remote: string) =>
  `refs/heads/main ${local} refs/heads/main ${remote}\n`

describe('the pre-push guard', () => {
  it('reads what git hands the hook, and passes over a deletion', () => {
    const one = 'a'.repeat(40)
    expect(
      pushedOf(`${line(one, ZERO)}(delete) ${ZERO} refs/heads/gone ${'b'.repeat(40)}\n`),
    ).toEqual([{ ref: 'refs/heads/main', local: one, remote: ZERO }])
    expect(pushedOf('')).toEqual([])
  })

  it('refuses the host name in a message, a trailer and a diff, in each of its forms', () => {
    const { dir, base } = pushedRepo()
    const clean = commit(dir, 'b.txt', 'two\n', 'A clean commit')
    const inMessage = commit(dir, 'c.txt', 'three\n', 'Seen on SERIAL7Q2X.laptop.example')
    const inTrailer = commit(
      dir,
      'd.txt',
      'four\n',
      'Renamed\n\nTade-Task: tade/serial7q2x-laptop-example',
    )
    const inDiff = commit(dir, 'e.txt', "label: 'SERIAL7Q2X'\n", 'A fixture')
    const head = runGit(dir, 'rev-parse', 'HEAD').trim()

    const commits = outgoing(dir, 'origin', { ref: 'refs/heads/main', local: head, remote: base })
    expect(commits).toHaveLength(4)
    expect(commits).not.toContain(base)
    expect(carrying(dir, commits, HOST).sort()).toEqual([inMessage, inTrailer, inDiff].sort())
    expect(carrying(dir, [clean], HOST)).toEqual([])

    const said = verdict(dir, 'origin', line(head, base), HOST)
    expect(said).toContain('3 commit(s)')
    expect(said).toContain(inDiff.slice(0, 12))
    expect(said?.toLowerCase()).not.toContain('serial7q2x')
  })

  it('lets a clean push go, and reads only what the remote does not have yet', () => {
    const { dir, base } = pushedRepo()
    const clean = commit(dir, 'b.txt', 'two\n', 'A clean commit')
    expect(verdict(dir, 'origin', line(clean, base), HOST)).toBeNull()

    // Already on the remote, so not this push's to publish.
    commit(dir, 'c.txt', 'three\n', 'Seen on SERIAL7Q2X')
    runGit(dir, 'push', '-q', '--no-verify', 'origin', 'main')
    const old = runGit(dir, 'rev-parse', 'HEAD').trim()
    const next = commit(dir, 'd.txt', 'four\n', 'Another clean one')
    expect(verdict(dir, 'origin', line(next, old), HOST)).toBeNull()

    // A new branch is read against everything fetched from the remote.
    runGit(dir, 'fetch', '-q', 'origin')
    expect(outgoing(dir, 'origin', { ref: 'refs/heads/side', local: next, remote: ZERO })).toEqual([
      next,
    ])
  })

  it('does not count a host name too short to be one', () => {
    const { dir, base } = pushedRepo()
    const head = commit(dir, 'b.txt', 'main work\n', 'Some main work')
    expect(verdict(dir, 'origin', line(head, base), 'main')).toBeNull()
  })

  it('stops a real git push through the committed hook, with the name read from hostname', () => {
    const { dir, remote, base } = pushedRepo()
    const bin = tmp('tade-guard-bin-')
    writeFileSync(join(bin, 'hostname'), `#!/bin/sh\necho ${HOST}\n`)
    chmodSync(join(bin, 'hostname'), 0o755)
    commit(dir, 'b.txt', 'two\n', 'Seen on serial7q2x-laptop-example')
    // Only now, so the commits above are not held to this repository's pre-commit.
    runGit(dir, 'config', 'core.hooksPath', join(ROOT, '.githooks'))
    const env = gitEnv({ PATH: `${bin}:${process.env.PATH ?? ''}` })

    const refused = spawnSync('git', ['push', 'origin', 'main'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('pre-push: refused')
    const there = execFileSync('git', ['rev-parse', 'main'], {
      cwd: remote,
      encoding: 'utf8',
    }).trim()
    expect(there).toBe(base)

    runGit(dir, 'commit', '-q', '--amend', '--no-verify', '-m', 'Seen on this laptop')
    const passed = spawnSync('git', ['push', 'origin', 'main'], { cwd: dir, env, encoding: 'utf8' })
    expect(passed.stderr).not.toContain('refused')
    expect(passed.status).toBe(0)
  })
})
