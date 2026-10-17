import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runModes } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { CodexAdapter, runSocket, sandboxOf } from '../src/adapter.ts'
import { leave, missedPath } from '../src/missed.ts'
import { rememberThread, threadFile } from '../src/sessions.ts'

// Codex's agents run as a user of their own (`agents.user`): its sandbox
// where Tade asks for it, and what its launch reads its group's to read.

const spec = { run: 'app/refunds/agent', task: 'app/refunds', cwd: '/wt/refunds', prompt: '' }

const made: CodexAdapter[] = []
afterEach(async () => {
  for (const one of made.splice(0)) await one.detach()
})

describe('Codex run as a user of its own', () => {
  it('keeps its own sandbox off unless asked, and on asks for the workspace and what else it writes', () => {
    expect(sandboxOf({})).toEqual(['--sandbox', 'danger-full-access'])
    expect(sandboxOf({ sandbox: { writes: ['/src/app/.git'] } })).toEqual([
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '--add-dir',
      '/src/app/.git',
    ])
    const one = new CodexAdapter({ runDir: tmp('tcx-'), user: 'tade-agent', home: tmp('tcx-') })
    made.push(one)
    const args = one.launchSpec({ ...spec, sandbox: { writes: [] } }).args
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write')
    expect(args).not.toContain('danger-full-access')
  })

  it('listens on a socket its group can reach', async () => {
    const socketDir = tmp('tcx-')
    const one = new CodexAdapter({
      runDir: tmp('tcx-'),
      socketDir,
      user: 'tade-agent',
      home: tmp('tcx-'),
    })
    made.push(one)
    await one.supervise({ ...spec, cwd: tmp('tcx-') })
    expect(statSync(runSocket(socketDir, spec.run)).mode & 0o777).toBe(0o660)
  })

  it('writes down the thread for its group to read, since the launch line reads it as that user', async () => {
    const runDir = tmp('tcx-')
    await rememberThread('app/refunds', runDir, 'thread-1', runModes(true))
    expect(statSync(threadFile('app/refunds', runDir)).mode & 0o777).toBe(0o640)
    expect(readFileSync(threadFile('app/refunds', runDir), 'utf8').trim()).toBe('thread-1')
  })

  it('leaves what a hook could not say for its folder’s group, and for nobody else where the folder is its own', () => {
    const shared = tmp('tcx-')
    mkdirSync(join(shared, 's'), { mode: 0o770 })
    const socket = join(shared, 's', 'c.sock')
    leave(socket, { hook_event_name: 'Stop' })
    // Group-readable however the umask trims it, and nobody else's.
    expect(statSync(missedPath(socket)).mode & 0o047).toBe(0o040)
    const own = tmp('tcx-')
    mkdirSync(join(own, 's'), { mode: 0o700 })
    const alone = join(own, 's', 'c.sock')
    leave(alone, { hook_event_name: 'Stop' })
    expect(statSync(missedPath(alone)).mode & 0o777).toBe(0o600)
  })
})
