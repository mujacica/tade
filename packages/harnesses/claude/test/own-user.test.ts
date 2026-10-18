import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter, runSocket, sandboxOf, TRUST_PATH } from '../src/adapter.ts'

// Claude Code's agents run as a user of their own (`agents.user`): what its
// launch is handed is that user's group's to read, its socket the group's to
// reach, its folder question answered as that user in the launch line, and
// its own sandbox on where Tade asks for it.

const spec = {
  run: 'app/refunds/agent',
  task: 'app/refunds',
  cwd: '/wt/refunds',
  prompt: '',
}

const made: ClaudeAdapter[] = []
afterEach(async () => {
  for (const one of made.splice(0)) await one.detach()
})

function asUser(home = tmp('tade-claude-home-')) {
  const runDir = tmp('tcc-')
  const one = new ClaudeAdapter({ runDir, socketDir: tmp('tcc-'), home, user: 'tade-agent' })
  made.push(one)
  return { one, home, runDir }
}

const settingsIn = (args: readonly string[]) =>
  JSON.parse(readFileSync(args[args.indexOf('--settings') + 1] ?? '', 'utf8'))

describe('Claude Code run as a user of its own', () => {
  it('hands the line the Node and the script that answer its folder question as that user', () => {
    const { one } = asUser()
    const args = one.launchSpec(spec).args
    expect(args.slice(7, 9)).toEqual([process.execPath, TRUST_PATH])
    // As Tade's own user, nothing: Tade answers it before the launch.
    const own = new ClaudeAdapter({ runDir: tmp('tcc-') })
    made.push(own)
    expect(own.launchSpec(spec).args.slice(7, 9)).toEqual(['', ''])
  })

  it('answers the folder question and the first-run ones as that user, in the folder it signed in to', () => {
    const home = tmp('tade-claude-home-')
    const folder = realpathSync(tmp('tade-claude-cwd-'))
    // An account's folder setup made in that user's home, signed in to and nothing more.
    const account = join(home, 'tade-accounts', 'work')
    mkdirSync(account, { recursive: true })
    for (const configDir of [join(home, '.claude'), account]) {
      const ran = spawnSync(process.execPath, [TRUST_PATH, folder, configDir], {
        encoding: 'utf8',
        env: { HOME: home, PATH: process.env.PATH ?? '' },
      })
      expect(ran.status, ran.stderr).toBe(0)
    }
    for (const state of [join(home, '.claude.json'), join(account, '.claude.json')]) {
      const said = JSON.parse(readFileSync(state, 'utf8'))
      expect(said.hasCompletedOnboarding).toBe(true)
      expect(said.projects[folder].hasTrustDialogAccepted).toBe(true)
    }
  })

  it('writes what the launch is handed for its group to read and nobody else', () => {
    const { one } = asUser()
    const args = one.launchSpec(spec).args
    const settings = args[args.indexOf('--settings') + 1] ?? ''
    expect(statSync(settings).mode & 0o777).toBe(0o640)
    // A folder the group can enter, whatever the test's own umask leaves of it.
    expect(statSync(join(settings, '..')).mode & 0o050).toBe(0o050)
    expect(statSync(join(settings, '..')).mode & 0o007).toBe(0)
  })

  it('puts its sandbox on only where asked: no way out, no start without one, and the folders it may write', () => {
    const { one } = asUser()
    expect(settingsIn(one.launchSpec(spec).args).sandbox).toBeUndefined()
    const held = settingsIn(
      one.launchSpec({ ...spec, sandbox: { writes: ['/src/app/.git', '/home/a/.npm'] } }).args,
    )
    expect(held.sandbox).toEqual({
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { allowWrite: ['/src/app/.git', '/home/a/.npm'] },
    })
    expect(sandboxOf({ writes: [] })).not.toHaveProperty('filesystem')
  })

  it('listens on a socket its group can reach, and leaves that user’s state file alone', async () => {
    const { one, home } = asUser()
    const cwd = tmp('tade-claude-work-')
    await one.supervise({ ...spec, cwd })
    const socket = runSocket(
      (one as unknown as { opts: { socketDir: string } }).opts.socketDir,
      spec.run,
    )
    expect(statSync(socket).mode & 0o777).toBe(0o660)
    expect(statSync(join(socket, '..')).mode & 0o777).toBe(0o770)
    // Tade cannot write in another user's home; the line answers it there.
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
  })

  it('has its launch line answer the folder question before Claude Code starts, as whoever runs it', () => {
    const { one, home } = asUser()
    const cwd = realpathSync(tmp('tade-claude-work-'))
    const bin = join(tmp('tade-claude-bin-'), 'claude')
    writeFileSync(bin, '#!/bin/sh\necho started\n')
    chmodSync(bin, 0o755)
    const line = one.launchSpec({ ...spec, cwd })
    const args = [...line.args]
    args[6] = bin
    const ran = spawnSync(line.command, args, {
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: home },
      encoding: 'utf8',
    })
    expect(ran.stdout.trim()).toBe('started')
    const state = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(state.projects[cwd].hasTrustDialogAccepted).toBe(true)
  })
})
