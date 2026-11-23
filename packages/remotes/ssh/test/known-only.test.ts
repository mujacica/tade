import { existsSync } from 'node:fs'
import { appendFile, chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProgram } from '@tade/core'
import type { Remote } from '@tade/remotes-core'
import { afterAll, describe, expect, it } from 'vitest'
import { KNOWN_ONLY, makeSshLink } from '../src/index.ts'
import { startSshd } from './sshd.ts'

// A host is reached only as it was written down, held against a real `sshd`
// this machine has never met, with the person's own config saying
// `StrictHostKeyChecking no` for it as a pasted line often does — so what is
// held is that the link's own options win, not that nobody asked.

const sshd = await startSshd({ met: false })
afterAll(async () => {
  if (typeof sshd !== 'string') await sshd.stop()
})

const cannot = typeof sshd === 'string' ? sshd : null

describe.skipIf(cannot !== null)(
  `a host never written down, over the link${cannot ? ` (${cannot})` : ''}`,
  () => {
    it('is refused, though the config says to check nothing', async () => {
      if (typeof sshd === 'string') throw new Error(cannot ?? '')
      await appendFile(sshd.config, '  StrictHostKeyChecking no\n')
      const tade = join(sshd.dir, 'tade-ran')
      await writeFile(tade, `#!/bin/sh\ntouch '${sshd.dir}/ran-'"$1"\n`)
      await chmod(tade, 0o755)

      // Without the link's options the config lets it through: what this test
      // could not see would make the rest of it pass for nothing. Written
      // nowhere, so the host is still one never met.
      const plain = await runProgram(
        'ssh',
        ['-F', sshd.config, '-o', 'UserKnownHostsFile=/dev/null', 'far', tade, 'plain'],
        { timeoutMs: 15_000 },
      )
      expect(plain.code, plain.stderr).toBe(0)
      expect(existsSync(join(sshd.dir, 'ran-plain'))).toBe(true)

      const link = makeSshLink({ home: sshd.dir, args: ['-F', sshd.config] })
      // Pairing runs `<tade> web …` there: it must never get as far as running.
      const paired = await link.pair({ address: 'far', tade, label: 'mac' }).then(
        () => 'paired',
        (error: unknown) => String(error),
      )
      expect(paired).toMatch(/host key/i)
      expect(existsSync(join(sshd.dir, 'ran-web'))).toBe(false)

      // And a terminal a person types into, which is the one not in BatchMode.
      const remote: Remote = {
        name: 'far',
        address: 'far',
        tade,
        session: { device: 'ab12cd34', cookie: 'ab12cd34.x', csrf: 'x', host: 'localhost:7654' },
      }
      const terminal = link.terminal(remote, ['terminal'])
      expect(terminal).not.toBeNull()
      if (terminal === null) return
      const typed = await runProgram(terminal.command, terminal.args, { timeoutMs: 15_000 })
      expect(typed.code).not.toBe(0)
      expect(existsSync(join(sshd.dir, 'ran-terminal'))).toBe(false)
      // And git's, which a fetch of that machine's work runs.
      const git = link.repository(remote, '/nowhere')
      expect(git?.env.GIT_SSH_COMMAND).toContain(`'${KNOWN_ONLY[1]}'`)
    })
  },
)
