import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type LaneId, LaneKind, taskDir } from '@tade/core'
import {
  type LaneHandle,
  LaneNotFoundError,
  type LaneScreen,
  type LaneSpec,
  type PointerReport,
  type WheelTurn,
  type WorkspaceDriver,
} from '@tade/drivers-core'
import { PtyDriver } from '@tade/drivers-pty'
import { TmuxDriver } from '@tade/drivers-tmux'
import { z } from 'zod'
import type { EventLog } from './events.ts'

// The lane registry: which lanes exist, which task each belongs to, and enough
// detail to relaunch them. Persisted on every mutation and reconciled against
// reality on boot.

/**
 * Every WorkspaceDriver implementation, by name. Adding a driver means adding
 * one entry here; nothing else in the codebase changes.
 *
 * They are built from the home directory because that is what a workspace
 * belongs to: one home, one set of lanes. Two homes on one machine — a test
 * run beside a real one, most obviously — must not be able to see, adopt or
 * kill each other's agents.
 */
export const drivers: Record<string, (home: string) => WorkspaceDriver> = {
  pty: () => new PtyDriver(),
  tmux: (home) => new TmuxDriver({ session: tmuxSession(home) }),
}

/**
 * The tmux session a home's lanes live in. Stable, so reopening finds the same
 * windows, and distinct per home, so nothing else's are in reach.
 */
export function tmuxSession(home: string): string {
  return `tade-${createHash('sha1').update(home).digest('hex').slice(0, 8)}`
}

/**
 * How often a lane's output is summarised into one line of the journal.
 *
 * It was a second, and a second was 232,324 lines and 42 MB of a 54 MB
 * journal in eleven days — 86% of everything every fold over it reads,
 * carrying `{bytes: N}` that nothing anywhere reads back. Half a minute keeps
 * exactly what the line is for, which is a trace of when a lane was noisy,
 * at a thirtieth of the cost. Nothing live is paced by it: `lastOutputAt` is
 * set on every chunk, so liveness, stall detection and the window's own idea
 * of activity are unchanged.
 */
export const DEFAULT_OUTPUT_SAMPLE_MS = 30_000

export const LaneRecord = z.object({
  id: z.string(),
  task: z.string(),
  kind: z.enum(['agent', 'server', 'tests', 'shell', 'terminal']),
  spec: z.object({
    id: z.string(),
    cwd: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
    cols: z.number().optional(),
    rows: z.number().optional(),
    title: z.string().optional(),
  }),
  pid: z.number().nullable(),
  startedAt: z.number(),
  title: z.string(),
  alive: z.boolean(),
  exitCode: z.number().nullable(),
  lastOutputAt: z.number().nullable(),
  /**
   * It was running when Tade last closed, and did not come back with it:
   * nobody stopped it and it did not end on its own. What the window opens
   * again, where it left off. Cleared by closing it, by it exiting, and by
   * starting it again.
   */
  lost: z.boolean().optional(),
  /**
   * The harness an agent lane runs, so a window that finds it again supervises
   * it with the adapter it was started under. Absent on lanes written before
   * there was more than one, which ran pi.
   */
  harness: z.string().optional(),
  /** The account it runs as, when not its harness's own sign-in. */
  account: z.string().optional(),
})
export type LaneRecord = z.infer<typeof LaneRecord>

const LaneFile = z.object({
  version: z.literal(1),
  driver: z.string(),
  lanes: z.array(LaneRecord),
})

export interface SpawnRequest {
  id: LaneId
  task: string
  kind: LaneKind
  cwd: string
  command: string
  /** How to run it, and how to come back to it: written down as the lane's spec. */
  args?: string[]
  /**
   * Arguments that say something once: an agent's opening instruction.
   * Appended after `args` at launch and never written down, so a lane put
   * back from what was stored reattaches instead of starting over.
   */
  opening?: string[]
  env?: Record<string, string>
  cols?: number
  rows?: number
  title?: string
  /** For an agent: the harness it runs in. */
  harness?: string
  /** For an agent: the account it runs as, when not its harness's own. */
  account?: string
}

export interface LaneRegistryOptions {
  driver: WorkspaceDriver
  log: EventLog
  /** Tade's home, where a task's own file says whether the task is still there. */
  home: string
  /** Where the registry is persisted; `<tadeHome>/lanes.json`. */
  path: string
  /** How often per lane output is summarised into the event log. */
  outputSampleMs?: number
}

export class LaneRegistry {
  private readonly lanes = new Map<string, LaneRecord>()
  private readonly unsubscribes = new Map<string, Array<() => void>>()
  private readonly pending = new Map<string, { bytes: number; timer: NodeJS.Timeout }>()
  private readonly driver: WorkspaceDriver
  private readonly log: EventLog
  private readonly home: string
  private readonly path: string
  private readonly outputSampleMs: number
  private saving: Promise<unknown> = Promise.resolve()

  private constructor(opts: LaneRegistryOptions) {
    this.driver = opts.driver
    this.log = opts.log
    this.home = opts.home
    this.path = opts.path
    this.outputSampleMs = opts.outputSampleMs ?? DEFAULT_OUTPUT_SAMPLE_MS
  }

  static async open(opts: LaneRegistryOptions): Promise<LaneRegistry> {
    const registry = new LaneRegistry(opts)
    await registry.reconcile()
    return registry
  }

  /**
   * Come back to the lanes that are still there, and be honest about the rest.
   *
   * Surviving is not the same as being reachable. A pid in the process table
   * proves only that something is running; it says nothing about whether this
   * driver can write to it, and a fresh driver knows nothing about a lane it
   * did not open. So the driver is asked, and its answer is the whole answer:
   * a lane it cannot hand back is gone however alive its pid looks. That is
   * the difference between `capabilities.detach` — whether lanes outlive us —
   * and `capabilities.adopt`, whether we can find them again afterwards.
   */
  private async reachable(): Promise<Map<string, LaneHandle>> {
    // Two questions, because they answer different things: `list` is what this
    // driver instance already holds, `adopt` is what it can go and find. A
    // driver that survived in-process answers the first; a brand new one
    // answers the second.
    const found: LaneHandle[] = []
    for (const ask of [
      () => this.driver.list(),
      () => (this.driver.capabilities.adopt ? this.driver.adopt({}) : Promise.resolve([])),
    ]) {
      // A driver that cannot answer is a driver with nothing running: the
      // tmux server is not up, and reporting that as an error on open would
      // put a stack trace between you and an empty workbench.
      found.push(...(await ask().catch(() => [])))
    }
    return new Map(found.map((handle) => [handle.id as string, handle]))
  }

  private async reconcile(): Promise<void> {
    const reachable = await this.reachable()
    const parsed = LaneFile.safeParse(await readJson(this.path))
    for (const lane of parsed.success ? parsed.data.lanes : []) {
      const handle = reachable.get(lane.id)
      reachable.delete(lane.id)
      if (!handle && forgettable(this.home, lane)) continue
      // Keep the stored spec when the lane is gone: it is how `relaunch` puts
      // the work back. When it is here, the driver's handle is fresher.
      const record: LaneRecord = handle
        ? {
            ...lane,
            // The handle remembers the line the lane was opened with, opening
            // instruction and all — tmux keeps the whole spec on its window.
            // What was written down is the line to come back on, so that is
            // the one kept; everything else about the lane is the driver's.
            spec: { ...handle.spec, args: lane.spec.args },
            pid: handle.pid,
            title: handle.title,
            alive: handle.alive,
          }
        : // Alive when the file was last written and gone now: the window closed on it.
          { ...lane, alive: false, ...(lane.alive ? { lost: true } : {}) }
      this.lanes.set(lane.id, record)
      if (record.alive) await this.readopt(record)
      else if (lane.alive) {
        await this.log.append({
          type: 'lane_exited',
          lane: lane.id,
          task: lane.task,
          detail: { reason: this.lostReason(), pid: lane.pid },
        })
      }
    }

    // Lanes the driver knows and we do not: opened by another window, or ours
    // from before the registry file was lost. The id carries the task, so
    // nothing about them has to be guessed.
    for (const handle of reachable.values()) {
      if (handle.alive) await this.readopt(adoptedRecord(handle))
    }
    await this.save()
  }

  /**
   * Take up a lane that was already running. Journalled either way: whether
   * the file knew about it changes nothing about what happened, which is that
   * work carried on while nobody was watching and is being watched again now.
   */
  private async readopt(record: LaneRecord): Promise<void> {
    this.lanes.set(record.id, record)
    this.watch(record)
    await this.log.append({
      type: 'lane_adopted',
      lane: record.id,
      task: record.task,
      detail: { command: record.spec.command, cwd: record.spec.cwd, pid: record.pid },
    })
  }

  private lostReason(): string {
    return this.driver.capabilities.detach
      ? 'gone: the driver could not find it again'
      : 'gone: lanes do not outlive Tade under this driver'
  }

  async spawn(req: SpawnRequest): Promise<LaneRecord> {
    if (this.lanes.get(req.id)?.alive) throw new Error(`lane already running: ${req.id}`)
    const spec: LaneSpec = {
      id: req.id,
      cwd: req.cwd,
      command: req.command,
      args: [...(req.args ?? []), ...(req.opening ?? [])],
      ...(req.env ? { env: req.env } : {}),
      ...(req.cols ? { cols: req.cols } : {}),
      ...(req.rows ? { rows: req.rows } : {}),
      ...(req.title ? { title: req.title } : {}),
    }
    const handle = await this.driver.open(spec)
    const record: LaneRecord = {
      id: req.id,
      task: req.task,
      kind: req.kind,
      // Without what was said once: the spec is how to come back to this
      // lane, and a relaunch that repeated the opening instruction would set
      // an agent off on work it has already done.
      spec: { ...handle.spec, args: req.args ?? [] },
      pid: handle.pid,
      startedAt: handle.startedAt,
      title: handle.title,
      alive: true,
      exitCode: null,
      lastOutputAt: null,
      ...(req.harness ? { harness: req.harness } : {}),
      ...(req.account ? { account: req.account } : {}),
    }
    this.lanes.set(req.id, record)
    this.watch(record)
    await this.log.append({
      type: 'lane_opened',
      lane: req.id,
      task: req.task,
      detail: { command: spec.command, args: spec.args, cwd: spec.cwd, pid: handle.pid },
    })
    await this.save()
    return record
  }

  /**
   * Relaunch a lane from its stored spec, after it went away. Nothing is said
   * to it: the stored spec is the line that reattaches, so an agent comes
   * back to its conversation rather than being told its first instruction
   * again.
   */
  async relaunch(id: LaneId): Promise<LaneRecord> {
    const record = this.require(id)
    if (record.alive) return record
    this.lanes.delete(id)
    return this.spawn({
      id,
      task: record.task,
      kind: record.kind,
      cwd: record.spec.cwd,
      command: record.spec.command,
      args: record.spec.args,
      ...(record.spec.env ? { env: record.spec.env } : {}),
      ...(record.spec.cols ? { cols: record.spec.cols } : {}),
      ...(record.spec.rows ? { rows: record.spec.rows } : {}),
      ...(record.harness ? { harness: record.harness } : {}),
      ...(record.account ? { account: record.account } : {}),
      title: record.title,
    })
  }

  list(task?: string): LaneRecord[] {
    const all = [...this.lanes.values()]
    const mine = task ? all.filter((l) => l.task === task) : all
    return mine.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  get(id: LaneId): LaneRecord | null {
    return this.lanes.get(id) ?? null
  }

  attachCommand(id: LaneId): string {
    this.require(id)
    return this.driver.attachCommand(id)
  }

  async write(id: LaneId, data: Uint8Array): Promise<void> {
    this.requireAlive(id)
    await this.driver.write(id, data)
  }

  async capture(id: LaneId, lines: number, styled = false): Promise<string> {
    this.requireAlive(id)
    return this.driver.capture(id, { lines, ...(styled ? { styled } : {}) })
  }

  /** How far back that lane can be read, where typing appears, and whose the scrolling is. */
  async screen(id: LaneId): Promise<LaneScreen> {
    this.requireAlive(id)
    return this.driver.screen(id)
  }

  /** Turn the wheel over a lane, for a program that scrolls itself. */
  async wheel(id: LaneId, turn: WheelTurn): Promise<void> {
    this.requireAlive(id)
    await this.driver.wheel(id, turn)
  }

  /** Tell a lane what the pointer did, for a program that answers it itself. */
  async point(id: LaneId, report: PointerReport): Promise<void> {
    this.requireAlive(id)
    await this.driver.point(id, report)
  }

  async resize(id: LaneId, cols: number, rows: number): Promise<void> {
    this.requireAlive(id)
    await this.driver.resize(id, cols, rows)
    const record = this.require(id)
    record.spec = { ...record.spec, cols, rows }
    await this.save()
  }

  /** Raise this lane on screen, for a driver whose lanes are real windows. */
  async focus(id: LaneId): Promise<void> {
    this.requireAlive(id)
    await this.driver.focus(id)
  }

  async setTitle(id: LaneId, title: string): Promise<void> {
    this.requireAlive(id)
    await this.driver.setTitle(id, title)
    this.require(id).title = title
    await this.save()
  }

  onOutput(id: LaneId, listener: (chunk: Uint8Array) => void, opts?: { replay?: boolean }) {
    this.requireAlive(id)
    return this.driver.onOutput(id, listener, opts)
  }

  onExit(id: LaneId, listener: (exit: { code: number | null; signal: number | null }) => void) {
    this.requireAlive(id)
    return this.driver.onExit(id, listener)
  }

  async close(id: LaneId): Promise<void> {
    const record = this.lanes.get(id)
    if (!record) throw new LaneNotFoundError(id)
    await this.driver.close(id)
    this.flushOutput(id)
    record.alive = false
    // Closed on purpose: not something to open again behind anyone's back.
    delete record.lost
    for (const un of this.unsubscribes.get(id) ?? []) un()
    this.unsubscribes.delete(id)
    await this.log.append({ type: 'lane_closed', lane: id, task: record.task })
    await this.save()
  }

  /**
   * Close the window. Lanes are left exactly as they are and the file keeps
   * saying they were alive, because next time `reconcile` asks the driver
   * rather than trusting the file.
   */
  async detach(): Promise<void> {
    this.release()
    await this.driver.detach()
    await this.saving
  }

  /** Stop the work, not just the watching. */
  async shutdown(): Promise<void> {
    this.release()
    await this.driver.shutdown()
    await this.saving
  }

  private release(): void {
    // Every sample that is waiting, not every lane that is still listed: a
    // lane can leave the list with a timer still to fire, and that timer
    // outlived the journal it was going to write to. Taken as a list first,
    // because flushing one takes it out of the map being read.
    for (const id of [...this.pending.keys()]) this.flushOutput(id as LaneId)
    for (const id of this.lanes.keys()) {
      for (const un of this.unsubscribes.get(id) ?? []) un()
    }
    this.unsubscribes.clear()
  }

  private watch(record: LaneRecord): void {
    const id = record.id as LaneId
    const stopOutput = this.driver.onOutput(id, (chunk) => {
      record.lastOutputAt = Date.now()
      this.sampleOutput(record, chunk.byteLength)
    })
    const stopExit = this.driver.onExit(id, ({ code, signal }) => {
      record.alive = false
      record.exitCode = code
      // It ended while we watched: that is its own doing, not the window's.
      delete record.lost
      this.flushOutput(id)
      // Nobody is waiting on this, so nobody would catch it either: a lane
      // that ends while the window is closing has a journal that has already
      // gone, and an unhandled rejection out of a driver's callback takes the
      // process down rather than the line it could not write. What is lost is
      // one `lane_exited` about a lane that is lost too.
      void this.log
        .append({ type: 'lane_exited', lane: id, task: record.task, detail: { code, signal } })
        .then(() => this.save())
        .catch(() => {})
    })
    this.unsubscribes.set(id, [stopOutput, stopExit])
  }

  /**
   * Raw output stays in the driver's scrollback; the log records a periodic
   * byte count instead, so a chatty agent can't bloat the journal.
   */
  private sampleOutput(record: LaneRecord, bytes: number): void {
    const current = this.pending.get(record.id)
    if (current) {
      current.bytes += bytes
      return
    }
    const timer = setTimeout(() => this.flushOutput(record.id as LaneId), this.outputSampleMs)
    timer.unref?.()
    this.pending.set(record.id, { bytes, timer })
  }

  private flushOutput(id: LaneId): void {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    const record = this.lanes.get(id)
    // As above: a byte count nobody awaited, and the journal may have closed
    // under it — a sample is the least of what is in there, and never worth
    // the process.
    void this.log
      .append({
        type: 'output',
        lane: id,
        task: record?.task ?? null,
        detail: { bytes: pending.bytes },
      })
      .catch(() => {})
  }

  private require(id: LaneId): LaneRecord {
    const record = this.lanes.get(id)
    if (!record) throw new LaneNotFoundError(id)
    return record
  }

  private requireAlive(id: LaneId): LaneRecord {
    const record = this.require(id)
    if (!record.alive) throw new LaneNotFoundError(`${id} (exited)`)
    return record
  }

  private async save(): Promise<void> {
    const snapshot: z.infer<typeof LaneFile> = {
      version: 1,
      driver: this.driver.id,
      lanes: this.list().map((lane) => ({ ...lane, spec: withoutInherited(lane.spec) })),
    }
    this.saving = this.saving.then(() => writeJsonAtomic(this.path, snapshot))
    await this.saving
  }
}

/**
 * A lane the registry has no reason left to remember.
 *
 * A dead lane is kept for one thing — its spec, which is how `relaunch` puts
 * the work back — and work whose task is gone cannot be put back. So the rule
 * is the one that was already written, applied at its own edge: nothing is
 * forgotten while there is still a task to put it back into.
 *
 * It is never asked of a lane the driver handed back (that one is alive), nor
 * of one marked `lost`, which is exactly the lane the next window opens again.
 * And it is safe against the thing that makes pruning dangerous here: a dead
 * lane is evidence `deriveState` reads — a task with one is `review` or
 * `failed` where a task with none is `queued` — so forgetting one while its
 * task still exists would quietly rewrite that task's state. A task with no
 * task file has no state derived for it at all, which is what makes this the
 * one place the record can go without changing an answer.
 *
 * 117 of the 136 lanes on the machine this was measured on were dead agents of
 * tasks removed weeks earlier, each carrying a 3 KB relaunch spec: the file
 * goes from 377 KB to 51 KB, and it is rewritten atomically on every lane
 * event.
 */
function forgettable(home: string, lane: LaneRecord): boolean {
  if (lane.alive || lane.lost) return false
  // One place to look, whichever way the task works: its own folder in Tade's
  // home. Anything this cannot read is a task — `existsSync` says false for a
  // path it cannot reach, and a disk that is not mounted must never be read as
  // work that is over.
  return !existsSync(join(taskDir(home, lane.task), 'task.yaml')) && existsSync(lane.spec.cwd)
}

/**
 * A record for a lane we found rather than opened.
 *
 * Lane ids are `<project>/<task>/<lane>`, which makes them self-describing:
 * an adopted lane can say which task it belongs to without anyone having
 * written that down. The last segment is the kind when it names one, which is
 * what `tade spawn <project>/<task>` produces.
 */
function adoptedRecord(handle: LaneHandle): LaneRecord {
  const parts = (handle.id as string).split('/')
  const tail = parts[2]
  return {
    id: handle.id,
    task: parts.slice(0, 2).join('/'),
    kind: LaneKind.safeParse(tail).data ?? 'shell',
    spec: handle.spec,
    pid: handle.pid,
    startedAt: handle.startedAt,
    title: handle.title,
    alive: handle.alive,
    exitCode: handle.exitCode,
    lastOutputAt: handle.lastOutputAt,
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * A spec as it is written down: only the environment Tade set, never what the
 * lane inherited from the window. That is everyone's shell environment, API
 * keys and tokens included, and a relaunch inherits it again anyway — drivers
 * lay a spec's env over their own.
 */
export function withoutInherited(
  spec: LaneSpec,
  inherited: NodeJS.ProcessEnv = process.env,
): LaneSpec {
  if (!spec.env) return spec
  const own = Object.fromEntries(
    Object.entries(spec.env).filter(([key, value]) => inherited[key] !== value),
  )
  const { env: _, ...rest } = spec
  return Object.keys(own).length > 0 ? { ...rest, env: own } : rest
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`)
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

export type { LaneHandle }
