import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { getPriority } from 'node:os'
import { join } from 'node:path'
import {
  GIVE_WAY_DEFAULT,
  IONICE,
  type LaneId,
  type LaneKind,
  NO_NICE_HERE,
  QOS,
  resolveCommand,
  stringEnv,
  taskDir,
} from '@tade/core'
import type { WorkspaceDriver } from '@tade/drivers-core'
import { isRunning, until } from '@tade/drivers-core/conformance'
import { PtyDriver } from '@tade/drivers-pty'
import { TmuxDriver } from '@tade/drivers-tmux'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { EventLog } from '../src/events.ts'
import { LaneRegistry } from '../src/registry.ts'

// What a lane is actually started at, asked of the process rather than of the
// code that started it.
//
// Real lanes with a real driver, because the thing worth knowing here is what
// the kernel did: a wrapper that is built correctly and then dropped on the
// way to `spawn` looks exactly like a working feature from inside the unit
// that built it.

/**
 * A program that says what the kernel thinks of it, and then waits to be
 * closed. One that ended as soon as it had said it could be gone before
 * `spawn` returned, which still has the journal and the lane file to write,
 * and a lane that has exited cannot be listened to (`requireAlive`): whether
 * the number was heard came down to which of the two the runner got to first.
 */
const SAYS_ITS_NICE = [
  '-e',
  "process.stdout.write(`NICE=${require('node:os').getPriority()}\\n`); setInterval(() => {}, 1000)",
]

describe('what gives way to the window', () => {
  let home: string
  let log: EventLog
  let driver: PtyDriver
  let registry: LaneRegistry

  beforeEach(async () => {
    home = tmp('tade-priority-')
    log = await EventLog.open({ path: join(home, 'events.jsonl') })
    driver = new PtyDriver()
    registry = await LaneRegistry.open({ driver, log, home, path: join(home, 'lanes.json') })
  })

  afterEach(async () => {
    await registry.shutdown().catch(() => {})
    await log.close().catch(() => {})
  })

  /** Open a lane that says its own niceness, and wait for it to say it. */
  async function nicenessOf(
    id: string,
    kind: LaneKind,
    giveWay?: number,
  ): Promise<{ said: number; command: string }> {
    const task = id.split('/').slice(0, 2).join('/')
    mkdirSync(taskDir(home, task), { recursive: true })
    writeFileSync(join(taskDir(home, task), 'task.yaml'), `id: ${task}\n`)
    let seen = ''
    const record = await registry.spawn({
      id: id as LaneId,
      task,
      kind,
      cwd: home,
      command: process.execPath,
      args: SAYS_ITS_NICE,
      cols: 80,
      rows: 24,
      ...(giveWay === undefined ? {} : { giveWay }),
    })
    const stop = registry.onOutput(
      id as LaneId,
      (chunk) => {
        seen += Buffer.from(chunk).toString('utf8')
      },
      { replay: true },
    )
    try {
      await until(() => /NICE=(-?\d+)/.test(seen), { timeout: 20_000 })
    } finally {
      stop()
      await registry.close(id as LaneId)
    }
    return {
      said: Number.parseInt(/NICE=(-?\d+)/.exec(seen)?.[1] ?? '', 10),
      command: record.spec.command,
    }
  }

  // Against this process rather than against nought, because a suite may
  // itself be running niced — which is the whole point of the feature — and
  // what is under test is the step down. Clamped at 19, where the kernel
  // clamps it.
  const below = (steps: number) => Math.min(19, getPriority() + steps)

  it('starts an agent below the window when the config asks it to', async () => {
    const { said } = await nicenessOf('app/one/agent', 'agent', 3)
    expect(said).toBe(below(3))
  }, 30_000)

  it('writes down the line that says what is running, not the wrapper', async () => {
    // The spec is how a lane is put back and is read as the harness's name
    // where a lane has none (`laneSignal`). A stored `nice` would be a lane
    // whose provider is `nice` and a relaunch that lowers whatever the
    // setting says now.
    const { command } = await nicenessOf('app/two/agent', 'agent', 3)
    expect(command).toBe(process.execPath)
  }, 30_000)

  it('starts an agent at the window’s own priority when nobody asked', async () => {
    const { said } = await nicenessOf('app/three/agent', 'agent')
    expect(said).toBe(getPriority())
    const zero = await nicenessOf('app/four/agent', 'agent', 0)
    expect(zero.said).toBe(getPriority())
  }, 30_000)

  it('is the same one process, so closing a lowered lane still ends it', async () => {
    // The constraint the whole feature is held to. `nice` calls setpriority
    // and then execs in the same process, so a lowered lane is the same pid,
    // in the same process group, and `close`, `detach` and `shutdown` mean
    // exactly what they meant before. A wrapper that forked instead would
    // leave an agent running under a lane Tade had closed.
    const task = 'app/eight'
    mkdirSync(taskDir(home, task), { recursive: true })
    writeFileSync(join(taskDir(home, task), 'task.yaml'), `id: ${task}\n`)
    const record = await registry.spawn({
      id: `${task}/agent` as LaneId,
      task,
      kind: 'agent',
      cwd: home,
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      giveWay: 3,
    })
    expect(record.pid).not.toBeNull()
    expect(isRunning(record.pid ?? 0)).toBe(true)
    await registry.close(`${task}/agent` as LaneId)
    await until(() => !isRunning(record.pid ?? 0), { timeout: 10_000 })
  }, 30_000)

  it('says so where the machine has no nice, and starts the agent anyway', async () => {
    // The failure that matters is not the one where nothing gives way, it is
    // the one where an agent will not start at all: wrapping a command with a
    // program that is not there is `command not found: nice` and no agent,
    // every time somebody starts one, on a machine that was working fine. So
    // the setting is ignored and a line is written down instead.
    const path = process.env.PATH
    process.env.PATH = join(home, 'nothing-here')
    try {
      const { said, command } = await nicenessOf('app/six/agent', 'agent', 3)
      expect(said).toBe(getPriority())
      expect(command).toBe(process.execPath)
    } finally {
      process.env.PATH = path
    }
    const warnings = await log.read({ types: ['warning'] })
    expect(warnings.map((one) => String(one.detail.message))).toContain(NO_NICE_HERE)
    // Said once a window: a machine with no `nice` has no `nice` all day, and
    // a line per agent would be noise rather than news.
    await nicenessOf('app/seven/agent', 'agent', 3)
    const again = await log.read({ types: ['warning'] })
    expect(again.filter((one) => one.detail.message === NO_NICE_HERE)).toHaveLength(1)
  }, 30_000)

  it('never lowers a lane somebody is typing into, however high the setting', async () => {
    // The kind decides and not the caller: a shell is a person's own command
    // line, and a window that quietly ran what you typed below itself would
    // be a window that lies about why your build is slow.
    const { said } = await nicenessOf('app/five/shell', 'shell', 9)
    expect(said).toBe(getPriority())
  }, 30_000)
})

// What the kernel holds about a lowered lane *and what it starts*, read the
// way anybody would read it — `ps`, `ionice -p` — and under each driver,
// because the wrapper reaches the program by a different road under each:
// node-pty's own spawn, and tmux's server running the line it was handed.
//
// The child is the half that matters. An agent's cost is its builds, tests
// and `git`, none of which Tade starts, so what is proved here is that they
// inherit: the lane's program starts one, and that one is read too.

/** Starts a child that will outlive the asking, and says both pids. */
const SAYS_ITS_PIDS = [
  '-e',
  "const k = require('node:child_process').spawn('sleep', ['60'], { stdio: 'ignore' }); process.stdout.write(`PIDS=${process.pid},${k.pid}\\n`); setInterval(() => {}, 1000)",
]

const here = (program: string) => resolveCommand(program, stringEnv(process.env)) !== null

/** `ps`'s answer for one pid: niceness, and macOS's base priority, which QoS sets. */
function psOf(pid: number): { nice: number; pri: number } {
  const [nice, pri] = execFileSync('ps', ['-o', 'nice=,pri=', '-p', String(pid)], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .map((word) => Number.parseInt(word, 10))
  return { nice: nice ?? Number.NaN, pri: pri ?? Number.NaN }
}

/**
 * The base priority a utility clamp holds a process to on macOS. Default QoS
 * is 31 and background 4; 20 is what `ps -o pri` says, unprivileged, of
 * anything started under `taskpolicy -c utility`.
 */
const UTILITY_PRI = 20

const DRIVERS: Array<[string, () => WorkspaceDriver]> = [
  ['pty', () => new PtyDriver()],
  ...(here('tmux')
    ? [
        [
          'tmux',
          () => new TmuxDriver({ socket: `tade-priority-${process.pid}`, session: 'p' }),
        ] as [string, () => WorkspaceDriver],
      ]
    : []),
]

describe.each(DRIVERS)('what an agent and its children are started at, under %s', (_, make) => {
  let home: string
  let log: EventLog
  let driver: WorkspaceDriver
  let registry: LaneRegistry
  /** What this process starts with nothing lowering it: the window's own level. */
  let own: { nice: number; pri: number }

  beforeEach(async () => {
    home = tmp('tade-priority-tree-')
    log = await EventLog.open({ path: join(home, 'events.jsonl') })
    driver = make()
    registry = await LaneRegistry.open({ driver, log, home, path: join(home, 'lanes.json') })
    // Asked of a child rather than of this process, because a helper the
    // window starts — `git`, `ps` — is what it is being compared with, and a
    // node test worker's own threads can carry a QoS of their own.
    const kid = spawn('sleep', ['60'], { stdio: 'ignore' })
    try {
      await until(() => kid.pid !== undefined && isRunning(kid.pid), { timeout: 5_000 })
      own = psOf(kid.pid ?? 0)
    } finally {
      kid.kill('SIGKILL')
    }
  })

  afterEach(async () => {
    await registry.shutdown().catch(() => {})
    await driver.shutdown().catch(() => {})
    await log.close().catch(() => {})
  })

  /** Open a lane of `kind` that starts a child, and read both from outside. */
  async function treeOf(id: string, kind: LaneKind, giveWay: number) {
    const task = id.split('/').slice(0, 2).join('/')
    mkdirSync(taskDir(home, task), { recursive: true })
    writeFileSync(join(taskDir(home, task), 'task.yaml'), `id: ${task}\n`)
    let seen = ''
    await registry.spawn({
      id: id as LaneId,
      task,
      kind,
      cwd: home,
      command: process.execPath,
      args: SAYS_ITS_PIDS,
      cols: 80,
      rows: 24,
      giveWay,
    })
    const stop = registry.onOutput(
      id as LaneId,
      (chunk) => {
        seen += Buffer.from(chunk).toString('utf8')
      },
      { replay: true },
    )
    try {
      await until(() => /PIDS=\d+,\d+/.test(seen), { timeout: 20_000 })
      const [lane, child] = (/PIDS=(\d+),(\d+)/.exec(seen) ?? [])
        .slice(1)
        .map((n) => Number.parseInt(n, 10)) as [number, number]
      const io = (pid: number) =>
        here(IONICE) ? execFileSync(IONICE, ['-p', String(pid)], { encoding: 'utf8' }).trim() : null
      return {
        lane: psOf(lane),
        child: psOf(child),
        io: { lane: io(lane), child: io(child) },
        childPid: child,
      }
    } finally {
      stop()
      await registry.close(id as LaneId)
    }
  }

  it('lowers an agent and everything it starts, by the default', async () => {
    const tree = await treeOf('app/tree/agent', 'agent', GIVE_WAY_DEFAULT)
    try {
      const nice = Math.min(19, own.nice + GIVE_WAY_DEFAULT)
      expect(tree.lane.nice).toBe(nice)
      expect(tree.child.nice).toBe(nice)
      if (here(QOS)) {
        // At most utility's, and never above what this process starts at:
        // a suite that is itself run lowered starts its helpers at utility
        // already, and the clamp cannot go below where it is.
        expect(tree.lane.pri).toBeLessThanOrEqual(Math.min(own.pri, UTILITY_PRI))
        expect(tree.child.pri).toBeLessThanOrEqual(Math.min(own.pri, UTILITY_PRI))
      }
      if (here(IONICE)) {
        expect(tree.io.lane).toBe('best-effort: prio 7')
        expect(tree.io.child).toBe('best-effort: prio 7')
      }
    } finally {
      try {
        process.kill(tree.childPid, 'SIGKILL')
      } catch {
        // Gone with its lane, which is as good.
      }
    }
  }, 30_000)

  it('starts a terminal at the window’s own level, child and all', async () => {
    // The contrast that makes the line above mean something: what a person
    // types into is never lowered, so its children are the window's peers.
    const tree = await treeOf('app/tree/shell', 'terminal', GIVE_WAY_DEFAULT)
    try {
      expect(tree.lane.nice).toBe(own.nice)
      expect(tree.child.nice).toBe(own.nice)
      expect(tree.child.pri).toBe(own.pri)
    } finally {
      try {
        process.kill(tree.childPid, 'SIGKILL')
      } catch {
        // Gone with its lane.
      }
    }
  }, 30_000)
})
