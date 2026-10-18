import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { lookAtAppArmor } from '../src/apparmor.ts'

// Whether AppArmor keeps bwrap from its namespaces is three reads: the
// kernel's switch, the profile's file and where bwrap is. A machine is stood
// in by a folder for `/` and a PATH, since this one is a Mac or a runner that
// is not Ubuntu 24.04.

function machine(switched: string | null, profile: boolean): string {
  const root = tmp('tade-apparmor-root-')
  if (switched !== null) {
    mkdirSync(join(root, 'proc/sys/kernel'), { recursive: true })
    writeFileSync(join(root, 'proc/sys/kernel/apparmor_restrict_unprivileged_userns'), switched)
  }
  if (profile) {
    mkdirSync(join(root, 'etc/apparmor.d'), { recursive: true })
    writeFileSync(join(root, 'etc/apparmor.d/bwrap'), 'abi <abi/4.0>,\n')
  }
  return root
}

/** A PATH with a bwrap on it, reached through a link as a package manager's often is. */
function withBwrap(): { env: NodeJS.ProcessEnv; real: string } {
  const real = join(tmp('tade-apparmor-real-'), 'bwrap')
  writeFileSync(real, '#!/bin/sh\n')
  chmodSync(real, 0o755)
  const bin = tmp('tade-apparmor-bin-')
  symlinkSync(real, join(bin, 'bwrap'))
  return { env: { PATH: bin }, real }
}

describe('AppArmor and bwrap here', () => {
  it('reads a kernel that refuses bwrap and no profile, with the bwrap a profile would attach to', async () => {
    const { env, real } = withBwrap()
    expect(await lookAtAppArmor(['claude-code'], { root: machine('1\n', false), env })).toEqual({
      restricted: true,
      profile: false,
      bwrap: await realpath(real),
      harnesses: ['claude-code'],
    })
  })

  it('reads a profile that is there, a switch that is off, and a kernel with no switch at all', async () => {
    const { env } = withBwrap()
    expect(await lookAtAppArmor([], { root: machine('1\n', true), env })).toMatchObject({
      restricted: true,
      profile: true,
    })
    expect(await lookAtAppArmor([], { root: machine('0\n', false), env })).toMatchObject({
      restricted: false,
    })
    // No such key restricts nothing, as Claude Code's sandbox page says.
    expect(await lookAtAppArmor([], { root: machine(null, false), env })).toMatchObject({
      restricted: false,
    })
  })

  it('says no bwrap where none is on PATH', async () => {
    const env = { PATH: tmp('tade-apparmor-empty-') }
    expect(await lookAtAppArmor([], { root: machine('1', false), env })).toMatchObject({
      bwrap: null,
    })
  })
})
