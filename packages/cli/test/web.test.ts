import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeDevices } from '@tade/web'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// `tade web`, spawned for real.
//
// The two claims only a real invocation can make: that **none of these opens
// the workbench** — every one of them runs with no window and answers, which
// is the rule that questions never need the window — and that `off` is two
// acts rather than one word, because a setting turned back on next week must
// not let every phone that was ever paired straight back in.

describe('tade web', () => {
  let home: string
  let env: Record<string, string>

  interface Result {
    code: number | null
    stdout: string
    stderr: string
  }

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

  const paired = async (over: { device: string; label: string }) =>
    writeDevices(home, [
      {
        kind: 'paired',
        device: over.device,
        at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        label: over.label,
        digest: 'a'.repeat(64),
        host: '127.0.0.1:7654',
        csrf: 'x'.repeat(43),
        until: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: ['read'],
        projects: null,
        granted: ['notes'],
        from: '192.168.1.42',
      },
    ])

  beforeEach(() => {
    home = tmp('tade-cli-web-')
    env = { TADE_HOME: home, TADE_NO_GH: '1', HOME: home }
  })

  it('is off before anybody turns it on, and says what would turn it on', async () => {
    const said = await tade('web')
    expect(said.code).toBe(0)
    expect(said.stdout).toContain('off — nothing is listening')
    expect(said.stdout).toContain('tade web on')
  })

  it('says the away view dies with the window, rather than papering over it', async () => {
    await tade('web', 'on')
    const said = await tade('web', 'status')
    // The honest half: the setting says yes and nothing is listening, because
    // there is no window. A phone that taps its bookmark now gets the
    // browser's own error, which it cannot tell from a sleeping laptop.
    expect(said.stdout).toContain('no window is open')
    expect(said.stdout).toContain('dies with it')
  })

  it('turns on, on this machine alone, and says when it takes effect', async () => {
    const said = await tade('web', 'on')
    expect(said.code).toBe(0)
    expect(said.stdout).toContain('on this machine alone')
    expect(said.stdout).toContain('takes effect the next time Tade starts')
    expect(config()).toContain('enabled: true')
    // **`--lan` is a second act and was not asked for**, so it did not happen.
    expect(said.stdout).not.toContain('same wifi')
  })

  it('says what a LAN bind means on the act that turns one on', async () => {
    const said = await tade('web', 'on', '--lan')
    expect(said.stdout).toContain('listening on the network')
    expect(said.stdout).toContain('plain HTTP')
    expect(said.stdout).toContain('same wifi')
    // And the way out, in the same breath: a warning with nothing to do about
    // it is one people learn to scroll past.
    expect(said.stdout).toContain('tailscale serve')
  })

  it('off is two acts: the setting, and every credential', async () => {
    await tade('web', 'on')
    await paired({ device: '00112233445566aa', label: 'iPhone' })
    const said = await tade('web', 'off')
    expect(said.stdout).toContain('off')
    expect(said.stdout).toContain('1 device(s) disconnected')
    expect(config()).toContain('enabled: false')
    const after = await tade('web', 'devices')
    expect(after.stdout).toBe('no device is paired')
  })

  it('lists devices with what each may read, and says an agent could add one', async () => {
    await paired({ device: '00112233445566aa', label: 'iPhone' })
    const said = await tade('web', 'devices')
    expect(said.stdout).toContain('iPhone')
    expect(said.stdout).toContain('00112233445566aa')
    expect(said.stdout).toContain('notes')
    expect(said.stdout).toContain('2d ago')
    // Said where somebody is reading the list, because the list is the
    // mitigation: an agent on this machine can append a line to that file.
    expect(said.stdout).toContain('an agent is not another person')
    expect(said.stdout).toContain('Disconnect everything')
  })

  it('answers --json with the same facts the lines are made of', async () => {
    await tade('web', 'on')
    await paired({ device: '00112233445566aa', label: 'iPhone' })
    const said = await tade('web', 'status', '--json')
    const got = JSON.parse(said.stdout) as Record<string, unknown>
    expect(got.enabled).toBe(true)
    expect(got.bind).toBe('loopback')
    expect(got.port).toBe(7654)
    expect(got.windowOpen).toBe(false)
    expect(got.devices).toHaveLength(1)
  })

  it('revokes one device by its id, with no network and no window', async () => {
    await paired({ device: '00112233445566aa', label: 'iPhone' })
    const said = await tade('web', 'revoke', '00112233445566aa')
    expect(said.code).toBe(0)
    expect(said.stdout).toContain('iPhone disconnected')
    expect((await tade('web', 'devices')).stdout).toBe('no device is paired')
  })

  it('refuses a device it has never heard of, rather than writing a line about it', async () => {
    const said = await tade('web', 'revoke', 'ffffffffffffffff')
    expect(said.code).toBe(2)
    expect(said.stderr).toContain('no paired device')
  })

  it('asks which device, rather than guessing, when none is named', async () => {
    const said = await tade('web', 'revoke')
    expect(said.code).toBe(2)
    expect(said.stderr).toContain('--all')
  })

  it('will not pair without a window, because the window is what lets a device in', async () => {
    await tade('web', 'on')
    const said = await tade('web', 'pair')
    expect(said.code).toBe(1)
    expect(said.stderr).toContain('no window is open')
  })

  it('says it could not read the config rather than printing the defaults as answers', async () => {
    // A broken file is not a reason to refuse to answer — the device list is
    // still readable and `revoke` still works — but "off" read off a file
    // nothing could parse is a guess, and somebody whose config is broken
    // would otherwise be told the away view is off while a window serves it.
    writeFileSync(join(home, 'config.yaml'), 'surfaces:\n  web:\n    port: "not a port"\n')
    const said = await tade('web', 'status')
    expect(said.code).toBe(0)
    expect(said.stdout).toContain('could not be read')
    expect(said.stdout).toContain('cannot say what is set')
    expect(said.stdout).toContain('tade config --check')
    const json = JSON.parse((await tade('web', 'status', '--json')).stdout) as { read: boolean }
    expect(json.read).toBe(false)
  })

  it('says it read the config when it could', async () => {
    await tade('web', 'on')
    const json = JSON.parse((await tade('web', 'status', '--json')).stdout) as { read: boolean }
    expect(json.read).toBe(true)
    expect((await tade('web', 'status')).stdout).not.toContain('could not be read')
  })

  it('says what notifications need of a phone, where they are turned on', async () => {
    // **The half this command can see, and the half it cannot.** The machine
    // being willing is a setting; the permission is on a phone and nothing
    // here can press it or read it back — so somebody who turned it on and
    // heard nothing has to be told which of the two this answer is about.
    writeFileSync(
      join(home, 'config.yaml'),
      'surfaces:\n  web:\n    enabled: true\n    install: true\n    push: true\n',
    )
    const said = await tade('web', 'status')
    expect(said.code).toBe(0)
    expect(said.stdout).toContain('told when work wants you')
    expect(said.stdout).toContain('allow notifications')
    expect(said.stdout).toContain('home screen')
    // And the honest half about the laptop: no background service, nothing
    // caught up.
    expect(said.stdout).toContain('caught up')
    const json = JSON.parse((await tade('web', 'status', '--json')).stdout) as {
      notifies: boolean
    }
    expect(json.notifies).toBe(true)
  })

  it('says nothing about notifications where they are off', async () => {
    writeFileSync(join(home, 'config.yaml'), 'surfaces:\n  web:\n    enabled: true\n')
    const said = await tade('web', 'status')
    expect(said.stdout).not.toContain('notification')
    const json = JSON.parse((await tade('web', 'status', '--json')).stdout) as {
      notifies: boolean
    }
    expect(json.notifies).toBe(false)
  })

  it('skips a damaged line of the device list rather than throwing it over', async () => {
    await paired({ device: '00112233445566aa', label: 'iPhone' })
    const path = join(home, 'web-devices.jsonl')
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"kind":"pai\n`)
    const said = await tade('web', 'devices')
    expect(said.stdout).toContain('iPhone')
    expect(said.stderr).toContain('could not be read')
  })
})
