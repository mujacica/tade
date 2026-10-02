import { readlink } from 'node:fs/promises'
import { execa } from 'execa'

// Which agent CLIs are running right now, and in which directory.
// Lets an adopted session that is sitting on an approval prompt (no transcript
// activity for a while) still count as alive.

export interface AgentProcess {
  pid: number
  provider: string
  cwd: string
}

/**
 * Tade's own tools, lent into an agent as an MCP server of its own.
 *
 * Not a brokered server — this is the other direction. A harness that speaks
 * MCP is handed a config naming a small program of Tade's, starts it for the
 * life of the session, and every tool the agent calls through it comes back
 * into the window. It is the harness's child, in the harness's process tree,
 * so Tade never started it and cannot be told when it goes: the only way to
 * know is to look for it.
 *
 * Counted, but only the ones whose harness is still there: a server is its
 * harness process's child, so one left behind by an agent that has gone has
 * been reparented away from any of them and is not counted as somebody's. That
 * is what makes a count worth having here — it cannot be propped up by a
 * stray — and it is why this reads `ppid` rather than matching names.
 */
export interface ToolServers {
  /**
   * Whether the scan could look at all. False is `unknown`, and everything
   * above reads it as such: nought from a scan that never answered must never
   * be read as every server having gone.
   */
  looked: boolean
  /** How many agent processes have a server of Tade's alive beside them. */
  alive: number
}

/**
 * Tade's own tool server, as its command line gives it away: the program is
 * `<anywhere>/harnesses/<name>/src/mcp.ts`, so it is found wherever Tade is
 * installed rather than only in a checkout.
 */
const TOOL_SERVER = /\/harnesses\/[a-z][a-z0-9-]*\/src\/mcp\.ts$/

/**
 * How long a probe waits on a program before it gives up on it.
 *
 * Not how long the program takes — `ps` over eight hundred processes is thirty
 * milliseconds — but how long a spawn waits to be given the machine. Four
 * agents running a test suite in one checkout is exactly the machine this runs
 * on, and a budget picked from how long something takes *alone* is the mistake
 * the flaky suite was made of: three seconds expired on a `ps` that was going
 * to answer, and the window then said `ps unavailable` about a `ps` that is
 * installed and working. Ten seconds is past anything a loaded machine does to
 * a spawn, and still short enough to be a timeout rather than a hang.
 */
const PROBE_MS = 10_000

const PROVIDERS: Array<{ provider: string; re: RegExp }> = [
  { provider: 'claude-code', re: /(^|\/)claude(\s|$)/ },
  { provider: 'codex', re: /(^|\/)codex(\s|$)/ },
]

export function matchProvider(args: string): string | null {
  for (const p of PROVIDERS) if (p.re.test(args)) return p.provider
  return null
}

/** What running a program came to, as much of it as a probe reads. */
export interface Ran {
  stdout: string
  stderr: string
  exitCode: number | undefined
  timedOut: boolean
  /** Node's own, so the one case that means "not installed" is knowable. */
  code?: string | undefined
}

export type Run = (command: string, args: readonly string[]) => Promise<Ran>

/**
 * Detached, like every probe: a child in the terminal's foreground group is
 * what Terminal.app names the window after, so polling retitled it to `ps`.
 */
const spawn: Run = async (command, args) => {
  const ran = await execa(command, [...args], {
    reject: false,
    timeout: PROBE_MS,
    detached: true,
  })
  return {
    stdout: typeof ran.stdout === 'string' ? ran.stdout : '',
    stderr: typeof ran.stderr === 'string' ? ran.stderr.trim() : '',
    exitCode: ran.exitCode,
    timedOut: ran.timedOut === true,
    code: (ran as { code?: string }).code,
  }
}

/**
 * Why a program did not answer, in words somebody can act on, or null when it
 * did.
 *
 * Three cases and never one: a program that is not installed is a machine that
 * will never answer this, a program that failed said something worth repeating,
 * and a program that ran out of time was working — reporting the third as the
 * first is how `ps unavailable` came to be written about a `ps` sitting in
 * `/bin` answering everybody else.
 */
export function problemWith(program: string, ran: Ran): string | null {
  if (ran.code === 'ENOENT') return `there is no ${program} on this machine`
  if (ran.timedOut) {
    return `${program} took longer than ${Math.round(PROBE_MS / 1000)}s, which is a busy machine rather than a broken one`
  }
  if (ran.exitCode !== 0) {
    return `${program} exited ${ran.exitCode ?? 'without a code'}${ran.stderr ? `: ${ran.stderr.split('\n')[0]}` : ''}`
  }
  return null
}

/**
 * The last scan that could be made, so a probe that could not look degrades to
 * a stale answer rather than to an empty one.
 *
 * Nothing above this reads an empty list as "nobody looked" — it reads it as
 * "nothing is running", which is what a loaded machine came to say about
 * agents that were working perfectly well. Kept to the pids that still exist,
 * because the whole point of the list is evidence: a process that has gone is
 * not proof that anything is alive, however recently it was seen.
 */
let lastScan: AgentProcess[] = []

/**
 * The last tool servers seen, by pid, for the same reason `lastScan` exists —
 * and filtered the same way, by whether the pid is still there. A remembered
 * answer about a process that has gone would be the one lie this lamp must
 * never tell, so what is kept is only ever re-checked, never trusted.
 */
let lastServers: number[] = []

/** Whether a pid is still there. EPERM is somebody else's process, which counts. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** What is left of the last scan: one rule, read wherever this one could not look. */
function stale(): AgentProcess[] {
  lastScan = lastScan.filter((one) => alive(one.pid))
  return lastScan
}

/**
 * The tool servers still provably there: what was seen last time, less whatever
 * has since gone. `looked` stays true because this is evidence rather than a
 * guess — every pid in it was signalled just now.
 */
function staleServers(): ToolServers {
  lastServers = lastServers.filter((pid) => alive(pid))
  return { looked: true, alive: lastServers.length }
}

export async function listAgentProcesses(
  options: { run?: Run } = {},
): Promise<{ processes: AgentProcess[]; servers: ToolServers; warnings: string[] }> {
  const run = options.run ?? spawn
  // `ppid` as well, which is what ties Tade's own tool server to the agent it
  // was started for: the server is the harness process's child. One more
  // column on a scan that was already being made, rather than a second spawn —
  // this runs on every poll.
  const ps = await run('ps', ['-axo', 'pid=,ppid=,args='])
  const problem = problemWith('ps', ps)
  if (problem) {
    // Stable wording, whatever it found: a warning is drawn where you are
    // looking and the same sentence twice is shown once, so a count in it
    // would be a new line every poll for as long as the machine stays busy.
    const still = stale()
    return {
      processes: still,
      servers: staleServers(),
      warnings: [
        still.length === 0
          ? `process scan could not look: ${problem}`
          : `process scan could not look: ${problem}; reporting what the last scan found`,
      ],
    }
  }
  const found: Array<{ pid: number; provider: string }> = []
  /** Tade's own tool servers, each with the process that started it. */
  const servers: Array<{ pid: number; parent: number }> = []
  for (const line of ps.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const args = m[3]!
    // Checked before the providers, because the server's own line names the
    // harness package and would otherwise read as the harness itself.
    if (TOOL_SERVER.test(args.split(/\s+/).at(-1) ?? '')) {
      servers.push({ pid, parent: Number(m[2]) })
      continue
    }
    const provider = matchProvider(args)
    if (provider) found.push({ pid, provider })
  }
  // Only the ones still beside an agent: a server whose harness has gone was
  // reparented away from it, and counting it would prop the answer up with a
  // process nobody is using.
  const harnesses = new Set(found.map((one) => one.pid))
  lastServers = servers.filter((one) => harnesses.has(one.parent)).map((one) => one.pid)
  const toolServers: ToolServers = { looked: true, alive: lastServers.length }
  if (found.length === 0) {
    lastScan = []
    return { processes: [], servers: toolServers, warnings: [] }
  }

  const { cwds, warnings } = await processCwds(
    found.map((f) => f.pid),
    run,
  )
  const processes = found.flatMap((f) => {
    const cwd = cwds.get(f.pid)
    return cwd ? [{ ...f, cwd }] : []
  })
  // Only a scan that looked replaces the last one: one whose `ps` answered and
  // whose `lsof` did not has placed nobody, and taking that as the truth would
  // throw away the answer a busy machine still has.
  if (warnings.length === 0) {
    lastScan = processes
    return { processes, servers: toolServers, warnings }
  }
  return { processes: processes.length > 0 ? processes : stale(), servers: toolServers, warnings }
}

/**
 * Where each agent process was started, remembered by pid: a process does not
 * move, so asking lsof again every poll was work — and a retitled terminal —
 * for an answer already known. A pid reused by another process gets a fresh
 * answer, because the args that made it an agent are checked first.
 */
const knownCwds = new Map<number, string>()

async function processCwds(
  pids: number[],
  run: Run,
): Promise<{ cwds: Map<number, string>; warnings: string[] }> {
  const out = new Map<number, string>()
  for (const pid of pids) {
    const known = knownCwds.get(pid)
    if (known) out.set(pid, known)
  }
  for (const pid of [...knownCwds.keys()]) if (!pids.includes(pid)) knownCwds.delete(pid)
  const unknown = pids.filter((pid) => !out.has(pid))
  if (unknown.length === 0) return { cwds: out, warnings: [] }
  const asked = await askCwds(unknown, run)
  for (const [pid, cwd] of asked.cwds) {
    knownCwds.set(pid, cwd)
    out.set(pid, cwd)
  }
  return { cwds: out, warnings: asked.warnings }
}

async function askCwds(
  pids: number[],
  run: Run,
): Promise<{ cwds: Map<number, string>; warnings: string[] }> {
  const out = new Map<number, string>()
  if (process.platform === 'linux') {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          out.set(pid, await readlink(`/proc/${pid}/cwd`))
        } catch {}
      }),
    )
    return { cwds: out, warnings: [] }
  }
  // macOS / BSD: lsof field output, `p<pid>` then `n<path>` per process.
  const r = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')])
  // lsof exits 1 when any pid it was given has gone, which is ordinary here —
  // so what counts as trouble is not having looked at all.
  const problem = r.code === 'ENOENT' || r.timedOut ? problemWith('lsof', r) : null
  let pid: number | null = null
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== null) out.set(pid, line.slice(1))
  }
  return {
    cwds: out,
    // Said rather than swallowed: an agent whose directory nobody could read is
    // an agent that drops out of the answer, which looks exactly like one that
    // stopped.
    warnings: problem ? [`agent directories could not be read: ${problem}`] : [],
  }
}
