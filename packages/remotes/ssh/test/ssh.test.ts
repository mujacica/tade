import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LinkError, type Remote } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import {
  commandOk,
  destinationOk,
  MOSH_PROGRAM,
  makeSshLink,
  masterArgs,
  pathsFor,
  quoted,
  SSH_PROGRAM,
  sessionIn,
} from '../src/index.ts'

// What the ssh link runs, and what it makes of what ssh said. The real
// connection is the conformance suite's; here an `ssh` that prints what a real
// one prints and exits as it does is enough, because what is held is this
// file's reading of it.

async function fakeSsh(stderr: string, code: number, stdout = ''): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tade-fake-ssh-'))
  const path = join(dir, 'ssh')
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s' '${stdout.replace(/'/g, `'\\''`)}'\nprintf '%s\\n' '${stderr.replace(/'/g, `'\\''`)}' >&2\nexit ${code}\n`,
  )
  await chmod(path, 0o755)
  return path
}

const REMOTE: Remote = {
  name: 'vps',
  address: 'vps',
  tade: 'tade',
  session: { device: 'ab12cd34', cookie: 'ab12cd34.secret', csrf: 'token', host: 'localhost:7654' },
}

async function pairWith(ssh: string): Promise<unknown> {
  try {
    return await makeSshLink({ home: '/nonexistent/home', ssh }).pair({
      address: 'vps',
      tade: 'tade',
      label: 'mac',
    })
  } catch (err) {
    return err
  }
}

describe('what it will run', () => {
  it('takes a destination and never an option', () => {
    for (const ok of ['vps', 'me@vps.example.com', 'ssh://me@10.0.0.2:2222', 'ssh://vps'])
      expect(destinationOk(ok), ok).toBe(true)
    for (const no of ['-oProxyCommand=sh', '', ' vps', 'vps;reboot', 'vps host', '$(x)'])
      expect(destinationOk(no), no).toBe(false)
  })

  it('takes one word as a remote command, and quotes what a remote shell reads', () => {
    for (const ok of ['tade', '~/.npm-global/bin/tade', '/usr/local/bin/tade'])
      expect(commandOk(ok), ok).toBe(true)
    for (const no of ['tade; reboot', 'tade web', '$(x)', '`x`', '-x', ''])
      expect(commandOk(no), no).toBe(false)
    expect(quoted("Amir's Mac")).toBe(`'Amir'\\''s Mac'`)
  })

  it('starts a master that never asks, forwards to a socket only you can open, and ends at the destination', () => {
    const paths = pathsFor('/home/a', 'vps', 7654)
    const args = masterArgs(paths, 7654, 'vps')
    expect(args.slice(0, 6)).toEqual(['-M', '-S', paths.control, '-f', '-N', '-T'])
    for (const option of [
      'BatchMode=yes',
      'ExitOnForwardFailure=yes',
      'StreamLocalBindUnlink=yes',
      'StreamLocalBindMask=0177',
      'ServerAliveInterval=5',
    ])
      expect(args).toContain(option)
    expect(args).toContain(`${paths.forward}:127.0.0.1:7654`)
    expect(args.slice(-2)).toEqual(['--', 'vps'])
  })

  it('keeps its sockets short, per home and per remote, with the port in the forward', () => {
    const one = pathsFor('/home/a', 'vps', 7654)
    expect(one.control.length).toBeLessThan(104)
    expect(one.forward.length).toBeLessThan(104)
    expect(pathsFor('/home/b', 'vps', 7654).control).not.toBe(one.control)
    expect(pathsFor('/home/a', 'box', 7654).control).not.toBe(one.control)
    expect(pathsFor('/home/a', 'vps', 7655).forward).not.toBe(one.forward)
    expect(pathsFor('/home/a', 'vps', 7655).control).toBe(one.control)
  })

  it('says what it needs of the machine, and what it uses where it is there', () => {
    expect(SSH_PROGRAM.command).toBe('ssh')
    expect(MOSH_PROGRAM.optional).toBe(true)
    expect(makeSshLink({ home: '/h' }).programs).toEqual([SSH_PROGRAM, MOSH_PROGRAM])
  })
})

describe('reading what pairing printed', () => {
  it('takes the credential and nothing else, with or without the cookie’s name', () => {
    const printed = {
      device: 'ab12cd34',
      cookie: 'tade_away=ab12cd34.s3cret',
      csrf: 't0ken',
      host: 'localhost:7654',
      until: '',
    }
    expect(sessionIn(JSON.stringify(printed), 'vps')).toEqual({
      device: 'ab12cd34',
      cookie: 'ab12cd34.s3cret',
      csrf: 't0ken',
      host: 'localhost:7654',
    })
    expect(sessionIn(JSON.stringify({ ...printed, cookie: 'ab12cd34.s3cret' }), 'vps').cookie).toBe(
      'ab12cd34.s3cret',
    )
  })

  it.each([
    ['not JSON', 'usage: tade web pair', 'tade web pair --owner'],
    [
      'bound somewhere public',
      JSON.stringify({ device: 'a', cookie: 'a.b', csrf: 'c', host: 'tade.example.com' }),
      'not an owner session',
    ],
    [
      'another device’s cookie',
      JSON.stringify({ device: 'a', cookie: 'b.c', csrf: 'c', host: 'localhost:1' }),
      'not an owner session',
    ],
  ])('refuses one that is %s', (_what, stdout, says) => {
    expect(() => sessionIn(stdout, 'vps')).toThrow(says)
  })
})

describe('what ssh said, as something to do', () => {
  it.each([
    ['Host key verification failed.', 255, 'failed', 'shows its key and asks'],
    [
      '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.',
      255,
      'failed',
      'a different host key from the one this machine met',
    ],
    ['me@vps: Permission denied (publickey).', 255, 'failed', 'without asking'],
    [
      'ssh: Could not resolve hostname vps: nodename nor servname provided',
      255,
      'failed',
      'Could not resolve hostname',
    ],
    ['zsh:1: command not found: tade', 127, 'missing', '--tade'],
    ['the away view is off: `tade web on` first', 1, 'failed', 'there: the away view is off'],
  ])('%s (exit %i) is %s', async (stderr, code, problem, says) => {
    const err = await pairWith(await fakeSsh(stderr, code))
    expect(err).toBeInstanceOf(LinkError)
    expect((err as LinkError).problem).toBe(problem)
    expect((err as LinkError).message).toContain(says)
  })

  it('says what the remote printed as text, whatever it printed', async () => {
    // A shell there writes this line, and the window and the CLI both say it.
    const err = await pairWith(await fakeSsh('\x1b]0;pwned\x07no\x1b[2J \u009b6naway view', 1))
    expect((err as LinkError).message).toBe('there: ␛no␛ ␛away view')
  })

  it('says there is no ssh where there is none', async () => {
    const err = await pairWith('/nonexistent/ssh')
    expect((err as LinkError).problem).toBe('missing')
  })

  it('pairs through what ssh printed', async () => {
    const printed = JSON.stringify({
      device: 'ab12cd34',
      cookie: 'tade_away=ab12cd34.s',
      csrf: 't',
      host: 'localhost:7654',
    })
    expect(await pairWith(await fakeSsh('', 0, printed))).toMatchObject({
      device: 'ab12cd34',
      host: 'localhost:7654',
    })
  })

  it('refuses to run a destination or a command that is not its shape, before ssh is asked', async () => {
    const link = makeSshLink({ home: '/h', ssh: '/nonexistent/ssh' })
    await expect(
      link.pair({ address: '-oProxyCommand=x', tade: 'tade', label: 'm' }),
    ).rejects.toThrow('not an SSH destination')
    await expect(link.pair({ address: 'vps', tade: 'tade;x', label: 'm' })).rejects.toThrow(
      'one word',
    )
    await expect(
      link.unpair({ ...REMOTE, session: { ...REMOTE.session, device: 'x; rm' } }),
    ).rejects.toThrow('device id')
  })

  it('says a session bound anywhere but a remote’s own listener cannot be linked', async () => {
    const link = makeSshLink({ home: '/h', ssh: await fakeSsh('', 0) })
    link.open({ ...REMOTE, session: { ...REMOTE.session, host: 'tade.example.com' } })
    link.beat(Date.now())
    await new Promise((done) => setTimeout(done, 50))
    expect(link.held('vps')?.link).toMatchObject({ kind: 'down', problem: 'failed' })
    await link.shutdown()
  })
})
