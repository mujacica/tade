import type { RequiredProgram } from '@tade/core'
import { PS_PROGRAM, problemWith, type Run, spawnProbe } from './processes.ts'

// Which TCP ports each lane is listening on, derived and never assigned.
//
// Tade does not hand ports out: an agent's dev server binds whatever its
// project tells it to, and two worktrees that collide find out the way they
// would anywhere. What Tade can do is *look* — `lsof` for every listening TCP
// socket on the machine, `ps` for who belongs to which lane — and say which
// lane has which port, so a dev server is a link on the agent that started it.
//
// A lane's processes are its process group and everything descended from its
// own process: the group is what a terminal's job is, and descent catches the
// server a harness starts in a group of its own. A server that detached itself
// all the way to init is nobody's, and is not claimed for anybody.
//
// Two spawns a look, whatever the number of lanes, so it is asked for
// (`StatusOptions.ports`) rather than made on every beat by default — and
// whoever asks every beat holds the last look (`PortsHeld`), which stands for
// `PORTS_MS`: `lsof` walks every process's descriptors, a tenth of a second on
// a busy laptop, and a dev server is started far less often than that.

/**
 * What the look at ports runs, declared beside the run: every Mac has `lsof`
 * and `ps`, and a minimal Debian or Ubuntu box has neither, which without this
 * was a warning that one is missing and no line anywhere that installs it.
 * Optional, because a lane with no ports is all that is lost. `ps` is the one
 * agent detection declares, with this look's own reason: one row, two reasons.
 */
export const PORTS_PROGRAMS: readonly RequiredProgram[] = [
  {
    command: 'lsof',
    title: 'lsof',
    why: 'finding the ports each agent’s dev server listens on',
    versionArgs: ['-v'],
    optional: true,
    install: { apt: 'lsof', dnf: 'lsof', instead: { darwin: 'macOS ships with it' } },
  },
  { ...PS_PROGRAM, why: 'telling which lane each listening process belongs to' },
]

/** One process, as `ps` gives it. */
export interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
}

/** `ps -axo pid=,ppid=,pgid=`, read. Lines that are not three numbers are skipped. */
export function parseProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) })
  }
  return rows
}

/**
 * `lsof -F pn` over listening TCP sockets, read: each pid and the ports it
 * listens on. An address is `*:3000`, `127.0.0.1:5173` or `[::1]:5173`, so the
 * port is whatever follows the last colon; anything else is skipped.
 */
export function parseListening(stdout: string): Map<number, number[]> {
  const out = new Map<number, number[]>()
  let pid: number | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1))
      pid = Number.isInteger(n) && n > 0 ? n : null
    } else if (line.startsWith('n') && pid !== null) {
      const port = Number(line.slice(line.lastIndexOf(':') + 1))
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue
      const ports = out.get(pid) ?? []
      if (!ports.includes(port)) ports.push(port)
      out.set(pid, ports)
    }
  }
  return out
}

/** The processes that are a lane's: its group, and everything descended from it. */
export function processesOf(lane: number, rows: readonly ProcessRow[]): Set<number> {
  const own = new Set<number>([lane])
  const group = rows.find((row) => row.pid === lane)?.pgid
  if (group !== undefined) for (const row of rows) if (row.pgid === group) own.add(row.pid)
  const children = new Map<number, number[]>()
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid])
  const queue = [lane]
  while (queue.length > 0) {
    for (const child of children.get(queue.pop()!) ?? []) {
      if (!own.has(child)) {
        own.add(child)
        queue.push(child)
      }
    }
  }
  return own
}

/** Each lane's listening ports, by the lane's pid, sorted. Pure. */
export function portsByLane(
  lanes: readonly number[],
  rows: readonly ProcessRow[],
  listening: ReadonlyMap<number, readonly number[]>,
): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const lane of lanes) {
    const ports = new Set<number>()
    for (const pid of processesOf(lane, rows))
      for (const port of listening.get(pid) ?? []) ports.add(port)
    out.set(
      lane,
      [...ports].sort((a, b) => a - b),
    )
  }
  return out
}

/**
 * What each lane listens on, or a warning and no answer at all — never an
 * empty list for a look that could not be made, which would read as "nothing
 * is listening".
 */
export async function listeningPorts(
  lanes: readonly number[],
  options: { run?: Run } = {},
): Promise<{ ports: Map<number, number[]> | null; warnings: string[] }> {
  if (lanes.length === 0) return { ports: new Map(), warnings: [] }
  const run = options.run ?? spawnProbe
  const [ps, lsof] = await Promise.all([
    run('ps', ['-axo', 'pid=,ppid=,pgid=']),
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']),
  ])
  const psProblem = problemWith('ps', ps)
  // lsof exits 1 when nothing matched, which is an answer: nothing is listening.
  const lsofProblem =
    lsof.exitCode === 1 && lsof.stdout.trim() === '' && !lsof.timedOut && lsof.code === undefined
      ? null
      : problemWith('lsof', lsof)
  const problem = psProblem ?? lsofProblem
  if (problem)
    return { ports: null, warnings: [`listening ports could not be looked at: ${problem}`] }
  return {
    ports: portsByLane(lanes, parseProcessRows(ps.stdout), parseListening(lsof.stdout)),
    warnings: [],
  }
}

/**
 * How long one look at the ports stands for whoever keeps asking: a server
 * started this second is a link within ten. A lane the look was not asked
 * about is looked at at once, so a new agent never waits on an old answer.
 */
export const PORTS_MS = 10_000

/** The last look at the ports, kept by whoever polls, as the probe gate is. */
export interface PortsHeld {
  last: {
    at: number
    lanes: ReadonlySet<number>
    looked: Awaited<ReturnType<typeof listeningPorts>>
  } | null
}

export function newPortsHeld(): PortsHeld {
  return { last: null }
}

/**
 * `listeningPorts`, answered from the last look while it stands. A look that
 * could not be made stands too: asking again every beat would be two spawns
 * a beat to be told the same thing, `lsof` still not installed.
 */
export async function portsFor(
  lanes: readonly number[],
  now: number,
  held: PortsHeld | undefined,
  options: { run?: Run } = {},
): Promise<Awaited<ReturnType<typeof listeningPorts>>> {
  const last = held?.last
  if (last && now - last.at < PORTS_MS && lanes.every((lane) => last.lanes.has(lane)))
    return last.looked
  const looked = await listeningPorts(lanes, options)
  if (held) held.last = { at: now, lanes: new Set(lanes), looked }
  return looked
}
