import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  type AppArmorSeen,
  appArmorCommands,
  BWRAP_PROFILE,
  bwrapProfile,
  RELOAD_APPARMOR,
} from '../src/apparmor.ts'

// Ubuntu 24.04 refuses bwrap the user namespaces Claude Code's and Codex's
// sandboxes are made of, until bwrap has an AppArmor profile, and then every
// command an agent of its own user runs is refused. What has to be exact is
// the profile — Claude Code's own, word for word — where it goes, and that
// the line setup shows writes exactly the text it shows.

const restricted: AppArmorSeen = {
  restricted: true,
  profile: false,
  bwrap: '/usr/bin/bwrap',
  harnesses: ['claude-code'],
}

describe('the profile bwrap is given', () => {
  it('is Claude Code’s sandbox page’s, word for word, where it says to put it', () => {
    // https://code.claude.com/docs/en/sandboxing, "Ubuntu 24.04 and later".
    expect(bwrapProfile().join('\n')).toBe(
      [
        'abi <abi/4.0>,',
        'include <tunables/global>',
        '',
        'profile bwrap /usr/bin/bwrap flags=(unconfined) {',
        '  userns,',
        '  include if exists <local/bwrap>',
        '}',
      ].join('\n'),
    )
    expect(BWRAP_PROFILE).toBe('/etc/apparmor.d/bwrap')
    expect(RELOAD_APPARMOR).toBe('sudo systemctl reload apparmor')
  })

  it('attaches to the bwrap this machine has, since AppArmor matches the program’s own path', () => {
    expect(bwrapProfile('/usr/local/bin/bwrap')).toContain(
      'profile bwrap /usr/local/bin/bwrap flags=(unconfined) {',
    )
  })
})

describe('offering it', () => {
  it('writes the profile as root, then loads it, each said', () => {
    const commands = appArmorCommands(restricted)
    expect(commands.map((one) => one.says)).toEqual([
      'write bwrap its profile, /etc/apparmor.d/bwrap',
      'load it',
    ])
    expect(commands[0]?.line).toMatch(/ \| sudo tee \/etc\/apparmor\.d\/bwrap > \/dev\/null$/)
    expect(commands[1]?.line).toBe('sudo systemctl reload apparmor')
  })

  it('writes exactly the text it shows', () => {
    const line = appArmorCommands(restricted)[0]?.line ?? ''
    const [printf] = line.split(' | sudo tee ')
    const ran = spawnSync('/bin/sh', ['-c', printf ?? ''], { encoding: 'utf8' })
    expect(ran.status).toBe(0)
    expect(ran.stdout).toBe(`${bwrapProfile().join('\n')}\n`)
  })

  it('is offered only where the kernel refuses bwrap, bwrap is here, a sandbox in use is it and nothing is written yet', () => {
    expect(appArmorCommands({ ...restricted, restricted: false })).toEqual([])
    // A profile for a program that is not there allows nothing.
    expect(appArmorCommands({ ...restricted, bwrap: null })).toEqual([])
    // One already there is somebody's, and is never written over.
    expect(appArmorCommands({ ...restricted, profile: true })).toEqual([])
    expect(appArmorCommands({ ...restricted, harnesses: [] })).toEqual([])
  })
})
