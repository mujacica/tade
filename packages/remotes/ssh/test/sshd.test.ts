import { spawn } from 'node:child_process'
import { runProgram } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { startSshd } from './sshd.ts'

// The fixture's own sshd ends with what started it. It runs detached, so a
// worker that died before its `afterAll` used to leave the listener and the
// ssh master riding it under pid 1, running an hour after their suite. And
// `stop` ends the connections too: each one's `sshd-session` calls setsid, so
// signalling the listener's group never reached them.

const fixture = new URL('./sshd.ts', import.meta.url).href

/** A master on its own control socket, the way a link holds one. */
function master(config: string, dir: string) {
  return runProgram(
    'ssh',
    [
      '-F',
      config,
      '-o',
      'BatchMode=yes',
      '-o',
      `ControlPath=${dir}/cm`,
      '-o',
      'ControlMaster=yes',
      '-o',
      'ControlPersist=yes',
      '-f',
      '-N',
      'far',
    ],
    { timeoutMs: 15_000 },
  )
}

/** What is still running with `dir` in its command line, once it has had ten seconds to go. */
async function stillNaming(dir: string): Promise<string[]> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const listed = await runProgram('ps', ['-A', '-ww', '-o', 'pid=,command='], {
      timeoutMs: 10_000,
    })
    const left = listed.stdout.split('\n').filter((line) => line.includes(dir))
    if (left.length === 0 || Date.now() > deadline) return left
    await new Promise((done) => setTimeout(done, 100))
  }
}

describe('the sshd a test starts', () => {
  it('ends with the master riding it when it is stopped', async (ctx) => {
    const sshd = await startSshd()
    if (typeof sshd === 'string') return ctx.skip(sshd)
    try {
      const held = await master(sshd.config, sshd.dir)
      expect(held.code, held.stderr).toBe(0)
    } finally {
      await sshd.stop()
    }
    expect(await stillNaming(sshd.dir)).toEqual([])
  })

  it('ends with the worker that started it, though that never reached its afterAll', async (ctx) => {
    const script = [
      `const { startSshd } = await import(${JSON.stringify(fixture)})`,
      'const sshd = await startSshd()',
      `if (typeof sshd === 'string') { process.stdout.write('cannot:' + sshd); process.exit(0) }`,
      `const { spawnSync } = await import('node:child_process')`,
      `spawnSync('ssh', ['-F', sshd.config, '-o', 'BatchMode=yes', '-o', 'ControlPath=' + sshd.dir + '/cm', '-o', 'ControlMaster=yes', '-o', 'ControlPersist=yes', '-f', '-N', 'far'], { timeout: 15000 })`,
      'process.stdout.write(sshd.dir)',
      `process.kill(process.pid, 'SIGKILL')`,
    ].join('\n')
    const worker = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let said = ''
    let err = ''
    worker.stdout.on('data', (chunk: Buffer) => {
      said += chunk.toString()
    })
    worker.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    const signal = await new Promise<NodeJS.Signals | null>((done) =>
      worker.once('exit', (_code, sig) => done(sig)),
    )
    if (said.startsWith('cannot:')) return ctx.skip(said.slice('cannot:'.length))
    expect(signal, err).toBe('SIGKILL')
    expect(said, err).toMatch(/tsd-/)
    expect(await stillNaming(said)).toEqual([])
  })
})
