import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type LaneHandle,
  type LaneId,
  type LaneKind,
  LaneNotFoundError,
  type LaneSpec,
  type WorkspaceDriver,
} from '@wilco/core'
import { PtyDriver } from '@wilco/driver-pty'
import { z } from 'zod'
import type { EventLog } from './events.ts'

// The lane registry: which lanes exist, which task each belongs to, and enough
// detail to relaunch them. Persisted on every mutation and reconciled against
// reality on boot.

/**
 * Every WorkspaceDriver implementation, by name. Adding a driver means adding
 * one entry here; nothing else in the codebase changes.
 */
export const drivers: Record<string, () => WorkspaceDriver> = {
  pty: () => new PtyDriver(),
}

export const LaneRecord = z.object({
  id: z.string(),
  task: z.string(),
  kind: z.enum(['agent', 'server', 'tests', 'shell']),
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
  args?: string[]
  env?: Record<string, string>
  cols?: number
  rows?: number
  title?: string
}

export interface LaneRegistryOptions {
  driver: WorkspaceDriver
  log: EventLog
  /** Where the registry is persisted; `<wilcoHome>/lanes.json`. */
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
  private readonly path: string
  private readonly outputSampleMs: number
  private saving: Promise<unknown> = Promise.resolve()

  private constructor(opts: LaneRegistryOptions) {
    this.driver = opts.driver
    this.log = opts.log
    this.path = opts.path
    this.outputSampleMs = opts.outputSampleMs ?? 1_000
  }

  static async open(opts: LaneRegistryOptions): Promise<LaneRegistry> {
    const registry = new LaneRegistry(opts)
    await registry.reconcile()
    return registry
  }

  /**
   * Lanes are children of the daemon, so a daemon restart kills them. Rather
   * than pretend they are alive, mark them dead and keep their spec so they
   * can be relaunched.
   */
  private async reconcile(): Promise<void> {
    const parsed = LaneFile.safeParse(await readJson(this.path))
    if (!parsed.success) return
    for (const lane of parsed.data.lanes) {
      const alive = lane.alive && lane.pid !== null && isRunning(lane.pid)
      this.lanes.set(lane.id, { ...lane, alive })
      if (lane.alive && !alive) {
        await this.log.append({
          type: 'lane_exited',
          lane: lane.id,
          task: lane.task,
          detail: { reason: 'not running after daemon restart', pid: lane.pid },
        })
      }
    }
    await this.save()
  }

  async spawn(req: SpawnRequest): Promise<LaneRecord> {
    if (this.lanes.get(req.id)?.alive) throw new Error(`lane already running: ${req.id}`)
    const spec: LaneSpec = {
      id: req.id,
      cwd: req.cwd,
      command: req.command,
      args: req.args ?? [],
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
      spec: handle.spec,
      pid: handle.pid,
      startedAt: handle.startedAt,
      title: handle.title,
      alive: true,
      exitCode: null,
      lastOutputAt: null,
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

  /** Relaunch a lane from its stored spec (after a daemon restart). */
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

  async capture(id: LaneId, lines: number): Promise<string> {
    this.requireAlive(id)
    return this.driver.capture(id, { lines })
  }

  async resize(id: LaneId, cols: number, rows: number): Promise<void> {
    this.requireAlive(id)
    await this.driver.resize(id, cols, rows)
    const record = this.require(id)
    record.spec = { ...record.spec, cols, rows }
    await this.save()
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

  async close(id: LaneId): Promise<void> {
    const record = this.lanes.get(id)
    if (!record) throw new LaneNotFoundError(id)
    await this.driver.close(id)
    this.flushOutput(id)
    record.alive = false
    for (const un of this.unsubscribes.get(id) ?? []) un()
    this.unsubscribes.delete(id)
    await this.log.append({ type: 'lane_closed', lane: id, task: record.task })
    await this.save()
  }

  async shutdown(): Promise<void> {
    for (const id of this.lanes.keys()) {
      this.flushOutput(id as LaneId)
      for (const un of this.unsubscribes.get(id) ?? []) un()
    }
    this.unsubscribes.clear()
    await this.driver.shutdown()
    await this.saving
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
      this.flushOutput(id)
      void this.log
        .append({ type: 'lane_exited', lane: id, task: record.task, detail: { code, signal } })
        .then(() => this.save())
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
    void this.log.append({
      type: 'output',
      lane: id,
      task: record?.task ?? null,
      detail: { bytes: pending.bytes },
    })
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
      lanes: this.list(),
    }
    this.saving = this.saving.then(() => writeJsonAtomic(this.path, snapshot))
    await this.saving
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`)
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(tmp, path)
}

export type { LaneHandle }
