import type { TadeEvent } from './events.ts'
import { noSpend, runFactsFrom, type Spend, type SpendWindow, spendFrom } from './spend.ts'

// Every machine's money and tokens: a row each, and a bottom line that adds
// every machine (ONE-AWAY-VIEW §2.6, decided 26 Nov) — counted so that no line
// is counted twice and no total claims more than it knows.
//
// **Fold per machine, never across.** `spendFrom` runs once per machine, over
// that machine's lines alone: this machine's own journal, or the copy of
// another's kept here (`readFeeds`, which reads only the current epoch of each
// — a fork a restore left beside it is named under the figures, never folded,
// because a restored journal repeats a prefix of the old one). Feeds are never
// concatenated into one fold: a `seq` means nothing outside the file it came
// from.
//
// **One machine is one row, whatever relayed it.** A machine is its id
// (`machine.json`), never its name, which is per machine and changes; two
// entries with one id are one machine and the one with this machine's own
// lines wins, then the one heard most lately. A machine never keeps a copy of
// itself. Within a machine a line is its `seq`, so a line handed over twice is
// counted once.
//
// **One day.** `since` is the door's own midnight, and each machine's lines
// are placed by their own `ts` corrected by how far that machine's clock is
// from this one's (`skewMs`), so a line written at 23:59 there is not counted
// in a day here it was not in.
//
// **The total is a marked claim, never a silent sum.** Each kind of money is
// added to its own kind (`usdExact`, `usdEstimated`, `usdListed`), so
// `pricedOf` still says what the total is made of; `usdOnPlan` is added to
// itself and is still in no money figure. It is a floor — `≥` — wherever any
// machine's figures are a part (`partial`), or it was last heard more than a
// minute ago (`HEARD_LATELY_MS`) or never: and the machine that makes it so is
// named with why, so a total never hides where it came from.

/** How long since a machine's lines were brought up to date before its figures may have moved since. */
export const HEARD_LATELY_MS = 60_000

/** One machine's lines, as this machine holds them. */
export interface MachineLines {
  /** Its name as it is drawn here. */
  name: string
  /** Its id (`machine.json`): what says two entries are one machine. */
  id: string
  /** Whether these are this machine's own lines. */
  here: boolean
  events: readonly TadeEvent[]
  /** When its lines were last brought up to date, in this machine's clock; null for never. */
  heardAt: number | null
  /** How far this machine's clock is ahead of that one's, in milliseconds; 0 where unknown. */
  skewMs?: number
  /** Its lines are known to hold back some of its work. */
  partial?: boolean
  /** Where a restore forked its history, the moment before which nothing of it is counted. */
  forkedAt?: string | null
}

/** Why a total is a floor because of one machine. */
export type FloorWhy = 'partial' | 'not heard lately' | 'never heard'

/** One machine's row. */
export interface MachineSpend {
  name: string
  id: string
  here: boolean
  spend: Spend
  heardAt: number | null
  /** Why its figures may be short, or null where they are all there is. */
  floor: FloorWhy | null
  forkedAt: string | null
}

export interface FleetSpend {
  /** This machine first, then the others by name. */
  rows: MachineSpend[]
  /** Every machine's figures added, each kind of money to its own kind. */
  total: Spend
  /** The machines that make the total a floor, and why; empty where it is all there is. */
  atLeast: { name: string; why: FloorWhy }[]
}

/** Every machine folded by itself, and the bottom line across them. */
export function fleetSpendFrom(
  machines: readonly MachineLines[],
  window: Omit<SpendWindow, 'runs'>,
  now: number,
): FleetSpend {
  const rows = oneEach(machines).map((one): MachineSpend => {
    const events = onceEach(one.events)
    const spend = spendFrom(events, {
      ...window,
      since: window.since - (one.skewMs ?? 0),
      runs: runFactsFrom(events),
    }).total
    return {
      name: one.name,
      id: one.id,
      here: one.here,
      spend,
      heardAt: one.heardAt,
      floor: floorOf(one, now),
      forkedAt: one.forkedAt ?? null,
    }
  })
  rows.sort((a, b) => Number(b.here) - Number(a.here) || (a.name < b.name ? -1 : 1))
  const total = noSpend()
  for (const row of rows) addInto(total, row.spend)
  return {
    rows,
    total,
    atLeast: rows.flatMap((row) =>
      row.floor === null ? [] : [{ name: row.name, why: row.floor }],
    ),
  }
}

/** Why one machine's figures may be short of what it did. */
function floorOf(one: MachineLines, now: number): FloorWhy | null {
  if (one.partial === true) return 'partial'
  if (one.here) return null
  if (one.heardAt === null) return 'never heard'
  return now - one.heardAt > HEARD_LATELY_MS ? 'not heard lately' : null
}

/** One entry per machine id: its own lines first, then the one heard most lately. */
function oneEach(machines: readonly MachineLines[]): MachineLines[] {
  const by = new Map<string, MachineLines>()
  for (const one of machines) {
    const was = by.get(one.id)
    if (was === undefined || better(one, was)) by.set(one.id, one)
  }
  return [...by.values()]
}

function better(one: MachineLines, than: MachineLines): boolean {
  if (one.here !== than.here) return one.here
  return (one.heardAt ?? -1) > (than.heardAt ?? -1)
}

/** Each line once, by its number in the file it came from; a line with none is its own. */
function onceEach(events: readonly TadeEvent[]): TadeEvent[] {
  const seen = new Set<number>()
  const out: TadeEvent[] = []
  for (const event of events) {
    const seq = (event as { seq?: unknown }).seq
    if (typeof seq === 'number') {
      if (seen.has(seq)) continue
      seen.add(seq)
    }
    out.push(event)
  }
  return out
}

/**
 * One machine's figures added into the total, field by field: each kind of
 * money to its own, every count to its own, and whether anything reported
 * money is whether any machine's did. By the fields a `Spend` has, so a
 * figure added to it later is added here without anybody remembering to.
 */
function addInto(total: Spend, one: Spend): void {
  const into = total as unknown as Record<string, number | boolean>
  for (const [key, value] of Object.entries(one)) {
    if (typeof value === 'number') into[key] = (into[key] as number) + value
    else if (typeof value === 'boolean') into[key] = (into[key] as boolean) || value
  }
}
