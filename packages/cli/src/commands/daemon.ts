import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wilcoHome } from '@wilco/core'
import { DaemonClient } from '@wilco/daemon/client'
import { socketPath } from '@wilco/daemon/protocol'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

const DAEMON_BIN = fileURLToPath(new URL('../../../daemon/src/bin.ts', import.meta.url))

export function registerDaemon(program: Command, io: Io, setExit: (code: number) => void): void {
  const daemon = program.command('daemon').description('Manage the Wilco daemon (wilcod)')

  daemon
    .command('start')
    .description('Start the daemon in the background')
    .option('--foreground', 'run in this terminal instead')
    .action(async (opts: { foreground?: boolean }) => {
      const socket = socketPath()
      if (await DaemonClient.isRunning(socket)) {
        io.out(`daemon already running at ${socket}`)
        return
      }
      if (opts.foreground) {
        // Replace this process with the daemon: Ctrl-C stops it.
        await import(DAEMON_BIN)
        return
      }
      const logFile = join(wilcoHome(), 'daemon.log')
      const started = await startDetached(logFile)
      if (!started.ok) {
        io.err(`daemon failed to start: ${started.error}`)
        io.err(`see ${logFile}`)
        setExit(Exit.error)
        return
      }
      io.out(`daemon listening on ${started.socket} (pid ${started.pid}, log ${logFile})`)
    })

  daemon
    .command('stop')
    .description('Stop the daemon')
    .action(async () => {
      const socket = socketPath()
      if (!(await DaemonClient.isRunning(socket))) {
        io.out('daemon not running')
        return
      }
      const client = await DaemonClient.connect(socket)
      await client.stop()
      await client.close()
      io.out('daemon stopped')
    })

  daemon
    .command('status')
    .description('Show daemon status')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const socket = socketPath()
      let client: DaemonClient
      try {
        client = await DaemonClient.connect(socket)
      } catch {
        if (opts.json) io.out(JSON.stringify({ running: false, socket }))
        else io.out(`daemon not running (socket ${socket})`)
        setExit(Exit.error)
        return
      }
      const info = await client.info()
      await client.close()
      if (opts.json) {
        io.out(JSON.stringify({ running: true, ...info }, null, 2))
        return
      }
      const caps = Object.entries(info.capabilities)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ')
      io.out(`daemon  pid ${info.pid}  driver ${info.driver}  lanes ${info.lanes}`)
      io.out(`socket  ${info.socket}`)
      io.out(`can     ${caps || 'nothing declared'}`)
    })
}

interface StartResult {
  ok: boolean
  pid?: number
  socket?: string
  error?: string
}

/** Spawn wilcod detached and wait for it to report that it is listening. */
async function startDetached(logFile: string): Promise<StartResult> {
  const out = openSync(logFile, 'a')
  const child = spawn(process.execPath, [DAEMON_BIN], {
    detached: true,
    stdio: ['ignore', 'pipe', out],
    env: process.env,
  })
  return new Promise<StartResult>((resolve) => {
    let settled = false
    const done = (r: StartResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(
      () => done({ ok: false, error: 'timed out waiting for socket' }),
      10_000,
    )
    const stdout = child.stdout
    if (!stdout) {
      done({ ok: false, error: 'wilcod produced no output' })
      return
    }
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      const m = /wilcod listening on (.+)/.exec(chunk)
      if (m) {
        stdout.destroy()
        child.unref()
        done({ ok: true, pid: child.pid!, socket: m[1]!.trim() })
      }
    })
    child.on('error', (err) => done({ ok: false, error: err.message }))
    child.on('exit', (code) => done({ ok: false, error: `wilcod exited with code ${code}` }))
  })
}
