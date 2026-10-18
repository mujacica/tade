import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Remote } from '@tade/remotes-core'
import { heldBy, Workbench } from '@tade/workbench'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { makeSshLink } from '../../remotes/ssh/src/index.ts'
import { startSshd } from '../../remotes/ssh/test/sshd.ts'

// A Mac's window, linked to a machine whose Tade is `tade serve` — the unit
// `tade host service` writes runs nothing else there. The link is the window's
// own (the ssh link, through a real `sshd`), pairing runs the real CLI over
// SSH as `tade remote add` does, and the far end is the real binary with no
// terminal, holding an agent in tmux: so what is held is that everything the
// window draws of a remote still arrives with no window there, and that
// restarting the service ends no agent and loses the link only while it is
// down. That systemd restarts it the same way is proved in a container
// (`set-up-the-machine`, "Proving it").

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const sshd = await startSshd()
afterAll(async () => {
  if (typeof sshd !== 'string') await sshd.stop()
})

const started: ReturnType<typeof serve>[] = []
let far: string | null = null
afterEach(async () => {
  for (const { child } of started.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  // Real processes in a real tmux: whatever is left is stopped.
  if (far === null) return
  const left = await Workbench.open({ home: far }).catch(() => null)
  await left?.stopEverything().catch(() => {})
  await left?.close().catch(() => {})
  far = null
})

/** `tade serve` there, and everything it has said. */
function serve(home: string): {
  child: ChildProcess
  err: () => string
  exited: Promise<number | null>
} {
  const child = spawn(process.execPath, [bin, 'serve'], {
    env: { ...process.env, TADE_HOME: home, HOME: home },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    err += chunk
  })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const one = { child, err: () => err, exited }
  started.push(one)
  return one
}

/** A port the machine has just said is free. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const address = server.address()
  await new Promise<void>((done) => server.close(() => done()))
  return typeof address === 'object' && address !== null ? address.port : 0
}

/** Whether a process is still there. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const cannot = typeof sshd === 'string' ? sshd : null

describe.skipIf(cannot !== null)(
  `a Mac linked to a machine that runs \`tade serve\`${cannot ? ` (${cannot})` : ''}`,
  () => {
    it('draws its projects and agents, attaches one, and keeps them across a restart of it', async () => {
      if (typeof sshd === 'string') return
      const repo = mkrepo()
      repo.commit('first')
      const home = repo.home
      far = home
      const port = await freePort()
      writeFileSync(
        join(home, 'config.yaml'),
        [
          'projects:',
          '  app:',
          `    root: ${repo.root}`,
          'workspace:',
          '  driver: tmux',
          'surfaces:',
          '  web:',
          '    enabled: true',
          `    port: ${port}`,
          '',
        ].join('\n'),
      )
      // An agent working there before the service ever started: closing a
      // window lets go of it, and under tmux it carries on.
      const worktree = repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge' })
      const before = await Workbench.open({ home })
      await before.startAgent({ task: 'app/refunds', cwd: worktree, prompt: '' })
      const pid = before.lanes().find((lane) => lane.task === 'app/refunds')?.pid ?? null
      await before.close()
      expect(pid).not.toBeNull()
      const agent = pid as number

      let serving = serve(home)
      const ready = (one: ReturnType<typeof serve>) => () => one.err().includes('with no screen.')
      await until('it holds the home', ready(serving))

      // The command that is Tade there: one word, as a remote shell reads it.
      const tade = join(sshd.dir, 'tade-serving')
      writeFileSync(
        tade,
        `#!/bin/sh\nTADE_HOME='${home}' exec '${process.execPath}' '${bin}' "$@"\n`,
      )
      chmodSync(tade, 0o755)
      const link = makeSshLink({ home: tmp('tade-mac-'), args: ['-F', sshd.config] })
      try {
        const session = await link.pair({ address: 'far', tade, label: 'mac' })
        const remote: Remote = { name: 'vps', address: 'far', tade, session }
        link.open(remote)
        const held = () => link.held('vps')
        const working = () =>
          held()?.link.kind === 'live' &&
          (held()?.projection?.tasks ?? []).some(
            (task) => task.id === 'app/refunds' && task.mark !== 'stopped',
          )
        await until('its agent, drawn here', () => {
          link.beat(Date.now())
          return working()
        })
        expect(held()?.projection?.projects.map((project) => project.name)).toEqual(['app'])
        // Its screen is read there and a terminal in front of it is that
        // machine's own line, as for a window there.
        const screen = await link.request('vps', '/api/agent/app/refunds')
        expect(screen.status).toBe(200)
        const attach = await link.request('vps', '/api/attach', { task: 'app/refunds' })
        expect(attach.status).toBe(200)
        expect((attach.body as { command: string }).command).toContain('tmux')
        const epoch = held()?.cursor?.epoch

        // Restarting it: the agent is not Tade's, and the link takes it back up.
        serving.child.kill('SIGTERM')
        expect(await serving.exited).toBe(0)
        await until('the link to go down', () => {
          link.beat(Date.now())
          return held()?.link.kind === 'down'
        })
        expect(running(agent)).toBe(true)
        // Kept as of when it went down, never drawn as nothing.
        expect((held()?.projection?.tasks ?? []).map((task) => task.id)).toContain('app/refunds')

        serving = serve(home)
        await until('it holds the home again', ready(serving))
        await until('its agent, drawn here again', () => {
          link.beat(Date.now())
          return working() && held()?.cursor?.epoch !== epoch
        })
        expect(running(agent)).toBe(true)
      } finally {
        await link.shutdown()
      }
      serving.child.kill('SIGTERM')
      expect(await serving.exited).toBe(0)
    }, 180_000)
  },
)

/**
 * Why a wait ran out: what each `tade serve` it started had printed and
 * whether it is still running, and who holds the home — one of them, this
 * test's own workbench that never let go, something else, or nobody — since
 * "timed out" alone says nothing about which of them was slow or stuck.
 */
async function why(what: string): Promise<string> {
  const said = started.map(({ child, err }, at) => {
    const state =
      child.exitCode !== null
        ? `exited ${child.exitCode}`
        : child.signalCode !== null
          ? `ended by ${child.signalCode}`
          : 'running'
    return `tade serve ${at} (pid ${child.pid}, ${state}) printed:\n${err().slice(-4_000) || '(nothing)'}`
  })
  // A lock naming a process that is gone is nobody's (`heldBy`).
  const holder = far === null ? null : await heldBy(far)
  const ours = started.findIndex(({ child }) => child.pid === holder)
  const holds =
    holder === null
      ? 'nobody holds the home'
      : ours >= 0
        ? `tade serve ${ours} holds the home (pid ${holder})`
        : holder === process.pid
          ? `this test's own process holds the home (pid ${holder})`
          : `pid ${holder}, none of these, holds the home`
  return [`timed out waiting for ${what}`, ...said, holds].join('\n\n')
}

/** Wait for a condition, with a ceiling, saying which it was and why. */
async function until(what: string, ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (ok()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(await why(what))
}
