import { chmod, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { testRemoteLink } from '@tade/remotes-core/conformance'
import type { FarEnd } from '@tade/remotes-core/far'
import { afterAll } from 'vitest'
import { makeSshLink } from '../src/index.ts'
import { startSshd } from './sshd.ts'

// The ssh link against real far ends through a real `sshd`: the master, the
// forward to a Unix socket, the stream through it, and pairing by running the
// real CLI over SSH (`tade web pair --owner --json`) in the far end's home —
// the same command `tade remote add` runs on a VPS.

const CLI = resolve(import.meta.dirname, '../../../cli/src/bin.ts')
const sshd = await startSshd()
afterAll(async () => {
  if (typeof sshd !== 'string') await sshd.stop()
})

let made = 0
testRemoteLink(
  'ssh',
  async (options) => {
    if (typeof sshd === 'string') throw new Error(sshd)
    return {
      link: makeSshLink({ ...options, args: ['-F', sshd.config] }),
      reach: async (far: FarEnd) => {
        // The command that is Tade there: this repository's CLI, in the far
        // end's home — one word, as a remote shell reads it.
        const tade = join(sshd.dir, `tade-${made++}`)
        await writeFile(
          tade,
          `#!/bin/sh\nTADE_HOME='${far.home}' exec '${process.execPath}' '${CLI}' "$@"\n`,
        )
        await chmod(tade, 0o755)
        return { address: 'far', tade }
      },
      close: async () => {},
    }
  },
  typeof sshd === 'string' ? { skip: sshd } : {},
)
