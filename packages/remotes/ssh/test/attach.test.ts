import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Remote } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { attachThere, lineOk, serverOk } from '../src/attach.ts'
import { makeSshLink, pathsFor } from '../src/index.ts'

// A terminal here that is one of another machine's agents: the line that
// machine gave, run there over ssh -t or over mosh where both machines have
// it. The real run is the conformance suite's, against a real sshd; here an
// `ssh` that answers what a remote would and a `mosh` that is only there to be
// found, because what is held is this file's choosing between them.

const REMOTE: Remote = {
  name: 'vps',
  address: 'vps',
  tade: 'tade',
  session: { device: 'ab12cd34', cookie: 'ab12cd34.secret', csrf: 'token', host: 'localhost:7654' },
}

const LINE =
  "'tmux' '-L' 'tade' 'new-session' '-t' 'tade-1' ';' 'select-window' '-t' ':far-x-agent'"

/** A folder with an `ssh` that prints `answer` and counts its runs, and a `mosh` where asked for. */
async function bin(answer: { stdout: string; code: number }, mosh: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'tade-attach-bin-'))
  const ssh = join(dir, 'ssh')
  const runs = join(dir, 'runs')
  await writeFile(
    ssh,
    `#!/bin/sh\necho run >> '${runs}'\nprintf '%s' '${answer.stdout}'\nexit ${answer.code}\n`,
  )
  await chmod(ssh, 0o755)
  if (mosh) {
    await writeFile(join(dir, 'mosh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(dir, 'mosh'), 0o755)
  }
  const ran = async () => (await readFile(runs, 'utf8').catch(() => '')).split('\n').length - 1
  return { dir, ssh, ran }
}

describe('the line it hands a remote shell', () => {
  it('is one line of printable text, bounded, or nothing', () => {
    expect(lineOk(LINE)).toBe(true)
    for (const no of ['', 'echo a\necho b', 'echo \x1b[2J', 'echo é', 'x'.repeat(4097)])
      expect(lineOk(no), JSON.stringify(no)).toBe(false)
  })

  it('names mosh’s server only as a path a shell reads as itself', () => {
    expect(serverOk('/usr/bin/mosh-server')).toBe(true)
    for (const no of ['mosh-server', '/usr/bin/mosh server', '/x;reboot', '$(x)/mosh-server', ''])
      expect(serverOk(no), no).toBe(false)
  })
})

describe('the terminal it opens', () => {
  const at = {
    ssh: 'ssh',
    before: ['-F', '/tmp/cfg'],
    control: '/run/r-1.ctl',
    address: 'me@vps',
    line: LINE,
  }

  it('is ssh -t over the window’s master, ending in the line as the remote command', () => {
    const opened = attachThere({ ...at, mosh: null })
    expect(opened.command).toBe('ssh')
    expect(opened.by).toBe('ssh')
    expect(opened.args.slice(0, 3)).toEqual(['-F', '/tmp/cfg', '-t'])
    expect(opened.args).toContain('ServerAliveInterval=5')
    expect(opened.args).not.toContain('BatchMode=yes')
    expect(opened.args.slice(-5)).toEqual(['-S', '/run/r-1.ctl', '--', 'me@vps', LINE])
  })

  it('is mosh where both machines have it, over that same master, the line run by sh there', () => {
    const opened = attachThere({
      ...at,
      mosh: { here: '/opt/bin/mosh', there: '/usr/bin/mosh-server' },
    })
    expect(opened.command).toBe('/opt/bin/mosh')
    expect(opened.by).toBe('mosh')
    expect(opened.args).toEqual([
      "--ssh='ssh' '-F' '/tmp/cfg' '-S' '/run/r-1.ctl' '-o' 'ConnectTimeout=10'",
      '--server=/usr/bin/mosh-server',
      '--',
      'me@vps',
      'sh',
      '-c',
      LINE,
    ])
  })

  it('is ssh for a destination with a port of its own, which mosh cannot take', () => {
    const opened = attachThere({
      ...at,
      address: 'ssh://me@vps:2222',
      mosh: { here: '/opt/bin/mosh', there: '/usr/bin/mosh-server' },
    })
    expect(opened.by).toBe('ssh')
  })
})

describe('choosing mosh', () => {
  it('chooses it where this machine has mosh and the remote has its server, and asks once', async () => {
    const made = await bin({ stdout: '/usr/bin/mosh-server\n', code: 0 }, true)
    const link = makeSshLink({ home: '/h', ssh: made.ssh, env: { PATH: made.dir } })
    const opened = await link.attach(REMOTE, LINE)
    expect(opened?.by).toBe('mosh')
    expect(opened?.args).toContain('--server=/usr/bin/mosh-server')
    expect(opened?.args.join(' ')).toContain(pathsFor('/h', 'vps', 7654).control)
    await link.attach(REMOTE, LINE)
    expect(await made.ran()).toBe(1)
  })

  it('is ssh where the remote has no server, and where this machine has no mosh', async () => {
    const none = await bin({ stdout: '', code: 1 }, true)
    const without = makeSshLink({ home: '/h', ssh: none.ssh, env: { PATH: none.dir } })
    expect((await without.attach(REMOTE, LINE))?.by).toBe('ssh')
    const here = await bin({ stdout: '/usr/bin/mosh-server\n', code: 0 }, false)
    const noMosh = makeSshLink({ home: '/h', ssh: here.ssh, env: { PATH: here.dir } })
    expect((await noMosh.attach(REMOTE, LINE))?.by).toBe('ssh')
    // With no mosh here, the remote is not even asked.
    expect(await here.ran()).toBe(0)
  })

  it('takes a server path it would not hand mosh as no server', async () => {
    const made = await bin({ stdout: '/tmp/x;reboot\n', code: 0 }, true)
    const link = makeSshLink({ home: '/h', ssh: made.ssh, env: { PATH: made.dir } })
    expect((await link.attach(REMOTE, LINE))?.by).toBe('ssh')
  })

  it('refuses a line it would not hand a shell, before anything is run', async () => {
    const made = await bin({ stdout: '/usr/bin/mosh-server\n', code: 0 }, true)
    const link = makeSshLink({ home: '/h', ssh: made.ssh, env: { PATH: made.dir } })
    await expect(link.attach(REMOTE, 'tmux attach\nrm -rf ~')).rejects.toMatchObject({
      name: 'LinkError',
    })
    expect(await made.ran()).toBe(0)
  })
})
