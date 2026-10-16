import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { runProgram } from '@tade/core'

// A real SSH server for the ssh link to reach: OpenSSH's own `sshd`, run as
// whoever runs the suite, on a free loopback port, with keys made for this run
// and a client config naming them — so what the suite holds the link to is
// ssh, not a script that answers like it.
//
// Where there is no `sshd` to run, or it will not start as an ordinary user,
// the suite is skipped **and says which**: a check that cannot run here keeps
// its row with the reason, rather than passing for having looked at nothing.

export interface Sshd {
  /** The client config: `-F` this, and `far` is a Host in it. */
  config: string
  dir: string
  stop(): Promise<void>
}

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd', '/usr/local/sbin/sshd', '/opt/homebrew/sbin/sshd']

/** A port nothing is listening on, a moment ago. */
async function freePort(): Promise<number> {
  return new Promise((done, failed) => {
    const server = createServer()
    server.on('error', failed)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => done(port))
    })
  })
}

/** Whether anything answers a TCP connection there. */
function answers(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => done(false))
  })
}

/** An sshd up and taking this user's key, or why there cannot be one here. */
export async function startSshd(): Promise<Sshd | string> {
  const sshd = SSHD.find((path) => existsSync(path))
  if (sshd === undefined) return 'no sshd on this machine'
  const keygen = await runProgram('ssh-keygen', ['-?'], { timeoutMs: 5_000 })
  if (keygen.missing) return 'no ssh-keygen on this machine'
  // Short, because ssh's own sockets are capped near 104 bytes.
  const dir = await mkdtemp(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'tsd-'))
  for (const key of ['host', 'client']) {
    const made = await runProgram(
      'ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, key)],
      {
        timeoutMs: 10_000,
      },
    )
    if (made.code !== 0) return `ssh-keygen could not make a key: ${made.stderr.trim()}`
  }
  await writeFile(join(dir, 'authorized_keys'), await readFile(join(dir, 'client.pub'), 'utf8'))
  await chmod(join(dir, 'authorized_keys'), 0o600)
  const port = await freePort()
  await writeFile(
    join(dir, 'sshd_config'),
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${join(dir, 'host')}`,
      `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes',
      'StrictModes no',
      'UsePAM no',
      `PidFile ${join(dir, 'sshd.pid')}`,
      'AllowStreamLocalForwarding yes',
      'AllowTcpForwarding yes',
      '',
    ].join('\n'),
  )
  const config = join(dir, 'ssh_config')
  await writeFile(
    config,
    [
      'Host far',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      `  User ${userInfo().username}`,
      `  IdentityFile ${join(dir, 'client')}`,
      '  IdentitiesOnly yes',
      `  UserKnownHostsFile ${join(dir, 'known_hosts')}`,
      '  StrictHostKeyChecking accept-new',
      '  LogLevel ERROR',
      '',
    ].join('\n'),
  )
  const said: string[] = []
  const child: ChildProcess = spawn(sshd, ['-D', '-e', '-f', join(dir, 'sshd_config')], {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  })
  child.stderr?.on('data', (chunk: Buffer) => said.push(chunk.toString()))
  const stop = async () => {
    if (child.exitCode === null && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Gone already.
      }
    }
    await rm(dir, { recursive: true, force: true })
  }
  const deadline = Date.now() + 10_000
  while (!(await answers(port))) {
    if (child.exitCode !== null || Date.now() > deadline) {
      await stop()
      return `sshd would not start as ${userInfo().username}: ${said.join('').trim().split('\n').at(-1) ?? 'no reason given'}`
    }
    await new Promise((done) => setTimeout(done, 50))
  }
  // Up is not the same as taking this key: one real login, or the reason it was refused.
  const login = await runProgram('ssh', ['-F', config, '-o', 'BatchMode=yes', 'far', 'true'], {
    timeoutMs: 15_000,
  })
  if (login.code !== 0) {
    await stop()
    return `sshd would not take a key as ${userInfo().username}: ${login.stderr.trim().split('\n').at(-1) ?? ''}`
  }
  return { config, dir, stop }
}
