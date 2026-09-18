import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Schedule, whenProblem } from '@tade/core'
import { z } from 'zod'

// Schedules, as they were told to Tade: kept the way notes are, next to the
// journal, append-only, one JSON object per line, the file itself the truth.
//
// Nothing could recover a schedule — when it runs and what it does exist only
// because somebody said so — so every change is a line of its own saying who
// made it: made, renamed, paused, resumed or removed. Folding the lines gives
// the schedules as they are; reading them gives how each came to be that way,
// which is how a schedule nobody remembers making gets traced and undone. A line
// that will not read is skipped, never thrown over.

const FILE = 'schedules.jsonl'

const Line = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), schedule: Schedule, by: z.string(), at: z.string() }),
  z.object({
    op: z.literal('rename'),
    id: z.string(),
    name: z.string().min(1),
    by: z.string(),
    at: z.string(),
  }),
  z.object({ op: z.literal('pause'), id: z.string(), by: z.string(), at: z.string() }),
  z.object({ op: z.literal('resume'), id: z.string(), by: z.string(), at: z.string() }),
  z.object({ op: z.literal('remove'), id: z.string(), by: z.string(), at: z.string() }),
])
type Line = z.infer<typeof Line>

/** A schedule as it stands: what was set, as renamed since, and whether it is paused. */
export interface KeptSchedule extends Schedule {
  paused: boolean
}

/** The schedules a file's lines add up to, in the order they were first made. */
export function foldSchedules(text: string): KeptSchedule[] {
  const kept = new Map<string, KeptSchedule>()
  /** The name each was last set with: set again under it, a rename since is kept. */
  const setAs = new Map<string, string>()
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let parsed: ReturnType<typeof Line.safeParse>
    try {
      parsed = Line.safeParse(JSON.parse(raw))
    } catch {
      continue
    }
    if (!parsed.success) continue
    const line = parsed.data
    if (line.op === 'set') {
      const before = kept.get(line.schedule.id)
      // Changing what a schedule does is not renaming it: a name somebody gave
      // it stays unless the change names it anew.
      const renamed = before && setAs.get(line.schedule.id) === line.schedule.name
      kept.set(line.schedule.id, {
        ...line.schedule,
        name: renamed ? before.name : line.schedule.name,
        paused: before?.paused ?? false,
      })
      setAs.set(line.schedule.id, line.schedule.name)
      continue
    }
    const one = kept.get(line.id)
    if (!one) continue
    if (line.op === 'rename') one.name = line.name
    if (line.op === 'pause') one.paused = true
    if (line.op === 'resume') one.paused = false
    if (line.op === 'remove') kept.delete(line.id)
  }
  return [...kept.values()]
}

/** The schedules in a home, read without the workbench: a question never needs the window. */
export function readSchedules(home: string): KeptSchedule[] {
  try {
    return foldSchedules(readFileSync(join(home, FILE), 'utf8'))
  } catch {
    return []
  }
}

export class Schedules {
  private readonly path: string
  private kept: KeptSchedule[]

  private constructor(path: string, kept: KeptSchedule[]) {
    this.path = path
    this.kept = kept
  }

  static open(home: string): Schedules {
    mkdirSync(home, { recursive: true })
    return new Schedules(join(home, FILE), readSchedules(home))
  }

  all(): KeptSchedule[] {
    return this.kept.map((one) => ({ ...one }))
  }

  get(id: string): KeptSchedule | null {
    const found = this.kept.find((one) => one.id === id)
    return found ? { ...found } : null
  }

  /**
   * Make a schedule, or change one that has its id: a paused one stays paused.
   * Refused, with why, when its rule cannot be kept.
   */
  set(schedule: Schedule, by: string, now = Date.now()): KeptSchedule {
    const checked = Schedule.parse(schedule)
    const problem = whenProblem(checked.when)
    if (problem) throw new Error(`${checked.name}: ${problem}`)
    this.write({ op: 'set', schedule: checked, by, at: new Date(now).toISOString() })
    return this.get(checked.id) as KeptSchedule
  }

  rename(id: string, name: string, by: string, now = Date.now()): KeptSchedule {
    this.require(id)
    const text = name.replace(/\s+/g, ' ').trim()
    if (!text) throw new Error('what should it be called?')
    this.write({ op: 'rename', id, name: text, by, at: new Date(now).toISOString() })
    return this.get(id) as KeptSchedule
  }

  pause(id: string, paused: boolean, by: string, now = Date.now()): KeptSchedule {
    this.require(id)
    this.write({ op: paused ? 'pause' : 'resume', id, by, at: new Date(now).toISOString() })
    return this.get(id) as KeptSchedule
  }

  remove(id: string, by: string, now = Date.now()): void {
    this.require(id)
    this.write({ op: 'remove', id, by, at: new Date(now).toISOString() })
  }

  private require(id: string): KeptSchedule {
    const found = this.kept.find((one) => one.id === id)
    if (!found) {
      const names = this.kept.map((one) => one.id)
      throw new Error(
        `there is no schedule called ${id}${names.length > 0 ? ` (there is ${names.join(', ')})` : ''}`,
      )
    }
    return found
  }

  private write(line: Line): void {
    const fresh = !existsSync(this.path)
    appendFileSync(this.path, `${JSON.stringify(line)}\n`)
    // What a watch was turned on with can say more than it should: kept to you.
    if (fresh) chmodSync(this.path, 0o600)
    this.kept = foldSchedules(readFileSync(this.path, 'utf8'))
  }
}
