import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProgram } from '@tade/core'
import type { Remote } from '@tade/remotes-core'
import { afterAll, describe, expect, it } from 'vitest'
import { makeSshLink, NO_AGENT } from '../src/index.ts'
import { startSshd } from './sshd.ts'

// The far end is never handed this machine's SSH agent (REMOTE-TADE.md §9.3),
// held against a real `sshd` and a real `ssh-agent`, with the client config
// saying `ForwardAgent yes` for the host as a person's often does — so what is
// held is that the link's own options win, not that nobody asked.

const sshd = await startSshd()
const agents: ChildProcess[] = []
const sock = typeof sshd === 'string' ? null : await agentAt(sshd.dir)
afterAll(async () => {
  for (const agent of agents) agent.kill('SIGTERM')
  if (typeof sshd !== 'string') await sshd.stop()
})

/** An `ssh-agent` up at a socket of its own, or null where there is none to run. */
async function agentAt(dir: string): Promise<string | null> {
  const at = join(dir, 'agent.sock')
  const child = spawn('ssh-agent', ['-D', '-a', at], { stdio: 'ignore' })
  child.on('error', () => {})
  agents.push(child)
  const deadline = Date.now() + 5_000
  while (!existsSync(at)) {
    if (child.exitCode !== null || Date.now() > deadline) return null
    await new Promise((done) => setTimeout(done, 25))
  }
  return at
}

// A check that cannot run here keeps its row and says why, rather than
// passing for having looked at nothing.
const cannot =
  typeof sshd === 'string' ? sshd : sock === null ? 'no ssh-agent would start here' : null

/** What `SSH_AUTH_SOCK` was in a command the far end ran, as it wrote it down. */
async function seen(dir: string, name: string): Promise<string> {
  return (await readFile(join(dir, `seen-${name}`), 'utf8')).trim()
}

describe.skipIf(cannot !== null)(
  `the agent here, over the link${cannot ? ` (${cannot})` : ''}`,
  () => {
    it('is never forwarded, though the config forwards it and one is running here', async () => {
      if (typeof sshd === 'string' || sock === null) throw new Error(cannot ?? '')
      // The person's own config, as it often is: forward the agent to this host.
      await appendFile(sshd.config, '  ForwardAgent yes\n')
      const tade = join(sshd.dir, 'tade-env')
      await writeFile(
        tade,
        `#!/bin/sh\nprintf '%s' "\${SSH_AUTH_SOCK:-none}" > '${sshd.dir}/seen-'"$1"\n`,
      )
      await chmod(tade, 0o755)
      const env = { ...process.env, SSH_AUTH_SOCK: sock }

      // Without the link's options the far end is handed one: what this test
      // could not see would make the rest of it pass for nothing.
      const plain = await runProgram('ssh', ['-F', sshd.config, 'far', tade, 'plain'], {
        timeoutMs: 15_000,
        env,
      })
      expect(plain.code, plain.stderr).toBe(0)
      expect(await seen(sshd.dir, 'plain')).not.toBe('none')

      const link = makeSshLink({ home: sshd.dir, args: ['-F', sshd.config], env })
      const remote: Remote = {
        name: 'far',
        address: 'far',
        tade,
        session: { device: 'ab12cd34', cookie: 'ab12cd34.x', csrf: 'x', host: 'localhost:7654' },
      }
      // A command run there by pairing, and a terminal a person types into.
      await link.pair({ address: 'far', tade, label: 'mac' }).catch(() => {})
      expect(await seen(sshd.dir, 'web')).toBe('none')
      const terminal = link.terminal(remote, ['terminal'])
      expect(terminal).not.toBeNull()
      if (terminal === null) return
      const typed = await runProgram(terminal.command, terminal.args, { timeoutMs: 15_000, env })
      expect(typed.code, typed.stderr).toBe(0)
      expect(await seen(sshd.dir, 'terminal')).toBe('none')
      // And git's, which a fetch of that machine's work runs.
      const git = link.repository(remote, '/nowhere')
      expect(git?.env.GIT_SSH_COMMAND).toContain(`'${NO_AGENT[1]}'`)
    })
  },
)
