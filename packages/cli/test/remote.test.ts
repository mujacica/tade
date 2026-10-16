import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDevices } from '@tade/web'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// `tade remote`, spawned for real, against a second home that stands for the
// other machine.
//
// What crosses between the two is the same as over SSH: `tade remote add`
// runs `tade web pair --owner --json` *there*, through `ssh`, and reads back
// what it printed. The `ssh` on PATH here does what ssh does with a command —
// runs it in a shell on the far side — and nothing else, because what is being
// held is this command's half: what it refuses, what it writes into
// `remotes.<name>`, what it never prints, and what `status` folds out of the
// journal with no window. The link itself, a real SSH connection included, is
// `@tade/remotes-ssh`'s conformance suite.

interface Result {
  code: number | null
  stdout: string
  stderr: string
}

describe('tade remote', () => {
  let home: string
  let far: string
  let env: Record<string, string>
  /** The command that is Tade on the far side: this CLI, in the far home. */
  let farTade: string

  const tade = (...args: string[]): Promise<Result> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        stdout += d
      })
      child.stderr.on('data', (d: string) => {
        stderr += d
      })
      child.on('exit', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
    })

  const config = (): string => {
    try {
      return readFileSync(join(home, 'config.yaml'), 'utf8')
    } catch {
      return ''
    }
  }

  beforeEach(() => {
    home = tmp('tade-cli-remote-')
    far = tmp('tade-cli-far-')
    // The far side, with its away view on, as a VPS that ran `tade web on` has it.
    writeFileSync(
      join(far, 'config.yaml'),
      'surfaces:\n  web:\n    enabled: true\n    port: 7699\n',
    )
    const tools = join(home, 'bin')
    mkdirSync(tools)
    farTade = join(tools, 'far-tade')
    writeFileSync(
      farTade,
      `#!/bin/sh\nTADE_HOME='${far}' exec '${process.execPath}' '${bin}' "$@"\n`,
    )
    chmodSync(farTade, 0o755)
    // ssh, as far as a command goes: skip the options, then the destination,
    // and run what is left in a shell over there.
    writeFileSync(
      join(tools, 'ssh'),
      '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift; shift\nexec /bin/sh -c "$*"\n',
    )
    chmodSync(join(tools, 'ssh'), 0o755)
    env = { TADE_HOME: home, TADE_NO_GH: '1', HOME: home, PATH: `${tools}:${process.env.PATH}` }
  })

  it('lists nothing and says how to add one, with no window and no config', async () => {
    for (const command of ['list', 'status']) {
      const said = await tade('remote', command)
      expect(said.code, said.stderr).toBe(0)
      expect(said.stdout).toContain('tade remote add <name> --ssh <host>')
    }
  })

  it('refuses a name, a destination or a command that is not its shape, before running anything', async () => {
    const name = await tade('remote', 'add', 'VPS', '--ssh', 'vps')
    expect(name.code).toBe(2)
    expect(name.stderr).toContain('a remote’s name')
    // An option dressed as a destination is the one that matters.
    const option = await tade('remote', 'add', 'vps', '--ssh', '-oProxyCommand=touch /tmp/x')
    expect(option.code).toBe(2)
    expect(option.stderr).toContain('--ssh')
    const command = await tade('remote', 'add', 'vps', '--ssh', 'vps', '--tade', 'tade; reboot')
    expect(command.code).toBe(2)
    expect(command.stderr).toContain('--tade')
    expect(config()).toBe('')
  })

  it('pairs as an owner there, keeps the session here, and never prints it', async () => {
    const said = await tade('remote', 'add', 'vps', '--ssh', 'far', '--tade', farTade, '--json')
    expect(said.code, said.stderr).toBe(0)
    const answer = JSON.parse(said.stdout) as Record<string, unknown>
    expect(answer).toMatchObject({ name: 'vps', ssh: 'far', host: 'localhost:7699', window: false })
    // What only the remote printed, kept here and nowhere on standard output.
    const there = (await readDevices(far)).devices
    expect(there).toHaveLength(1)
    expect(there[0]?.owner).toBe(true)
    const written = config()
    expect(written).toContain(`device: ${there[0]?.id}`)
    expect(written).toMatch(/session: [0-9a-f]+\.[A-Za-z0-9_-]+/)
    const session = /session: (\S+)/.exec(written)?.[1] ?? ''
    expect(said.stdout).not.toContain(session)
    expect(said.stdout).not.toContain('csrf')
    // Said every time, where the person deciding reads it.
    expect(said.stderr).toContain('kept in config.yaml')
    expect(said.stderr).toContain('An owner device is a session minted over SSH')

    const listed = await tade('remote', 'list', '--json')
    expect(JSON.parse(listed.stdout)).toEqual([
      { name: 'vps', ssh: 'far', tade: farTade, device: there[0]?.id, host: 'localhost:7699' },
    ])
    expect(listed.stdout).not.toContain(session)

    const again = await tade('remote', 'add', 'vps', '--ssh', 'far', '--tade', farTade)
    expect(again.code).toBe(2)
    expect(again.stderr).toContain('tade remote remove vps')
  })

  it('says how each link last stood, out of the journal, and that no window holds them', async () => {
    await tade('remote', 'add', 'vps', '--ssh', 'far', '--tade', farTade)
    await tade('remote', 'add', 'box', '--ssh', 'far', '--tade', farTade)
    const journal = [
      {
        seq: 1,
        ts: '2026-10-17T08:00:00.000Z',
        type: 'remote_linked',
        urgency: 'routine',
        detail: { remote: 'vps', epoch: 'e1' },
      },
      {
        seq: 2,
        ts: '2026-10-17T09:12:00.000Z',
        type: 'remote_unlinked',
        urgency: 'routine',
        detail: {
          remote: 'vps',
          state: 'down',
          problem: 'timed out',
          said: 'its stream went quiet',
        },
      },
      {
        seq: 3,
        ts: '2026-10-17T09:30:00.000Z',
        type: 'remote_linked',
        urgency: 'routine',
        detail: { remote: 'vps', epoch: 'e2' },
      },
    ]
    writeFileSync(
      join(home, 'events.jsonl'),
      `${journal.map((line) => JSON.stringify(line)).join('\n')}\n`,
    )
    const said = await tade('remote', 'status')
    expect(said.code, said.stderr).toBe(0)
    expect(said.stdout).toContain('vps  up since 2026-10-17 09:30')
    expect(said.stdout).toContain('box  not linked yet')
    expect(said.stdout).toContain('no window is open on this home')
    const one = JSON.parse((await tade('remote', 'status', 'vps', '--json')).stdout) as {
      window: boolean
      remotes: { name: string; link: { word: string } }[]
    }
    expect(one.window).toBe(false)
    expect(one.remotes.map((row) => [row.name, row.link.word])).toEqual([['vps', 'up']])
    expect((await tade('remote', 'status', 'nope')).code).toBe(2)
  })

  it('signs this machine out there when it removes one, and forgets it here', async () => {
    await tade('remote', 'add', 'vps', '--ssh', 'far', '--tade', farTade)
    const device = (await readDevices(far)).devices[0]?.id
    const said = await tade('remote', 'remove', 'vps')
    expect(said.code, said.stderr).toBe(0)
    expect(said.stdout).toContain('signed out there')
    expect(
      (await readDevices(far)).devices.find((one) => one.id === device)?.revoked,
    ).not.toBeNull()
    expect(config()).not.toContain('session:')
    expect((await tade('remote', 'remove', 'vps')).code).toBe(2)
  })

  it('forgets one here even where it cannot be signed out there, and says how to finish', async () => {
    await tade('remote', 'add', 'vps', '--ssh', 'far', '--tade', farTade)
    // The far side stops answering to that command: as a box that was rebuilt.
    writeFileSync(farTade, '#!/bin/sh\necho "no such box" >&2\nexit 1\n')
    const said = await tade('remote', 'remove', 'vps')
    expect(said.code, said.stderr).toBe(0)
    expect(said.stdout).toContain('forgotten here')
    expect(said.stderr).toContain('could not be signed out there')
    expect(said.stderr).toContain('web revoke')
    expect(config()).not.toContain('session:')
  })

  it('says what the far side said when pairing fails there', async () => {
    writeFileSync(join(far, 'config.yaml'), '')
    const said = await tade('remote', 'add', 'vps', '--ssh', 'far', '--tade', farTade)
    expect(said.code).toBe(1)
    expect(said.stderr).toContain('could not pair with far')
    expect(said.stderr).toContain('tade web on')
    expect(config()).toBe('')
  })
})
