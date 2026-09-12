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

const PROVIDERS: Array<{ provider: string; re: RegExp }> = [
  { provider: 'claude-code', re: /(^|\/)claude(\s|$)/ },
  { provider: 'codex', re: /(^|\/)codex(\s|$)/ },
]

export function matchProvider(args: string): string | null {
  for (const p of PROVIDERS) if (p.re.test(args)) return p.provider
  return null
}

export async function listAgentProcesses(): Promise<{
  processes: AgentProcess[]
  warnings: string[]
}> {
  const ps = await execa('ps', ['-axo', 'pid=,args='], { reject: false, timeout: 3_000 })
  if (ps.exitCode !== 0 || typeof ps.stdout !== 'string') {
    return { processes: [], warnings: ['process scan failed: ps unavailable'] }
  }
  const found: Array<{ pid: number; provider: string }> = []
  for (const line of ps.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const provider = matchProvider(m[2]!)
    if (provider) found.push({ pid: Number(m[1]), provider })
  }
  if (found.length === 0) return { processes: [], warnings: [] }

  const cwds = await processCwds(found.map((f) => f.pid))
  const processes = found.flatMap((f) => {
    const cwd = cwds.get(f.pid)
    return cwd ? [{ ...f, cwd }] : []
  })
  return { processes, warnings: [] }
}

async function processCwds(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (process.platform === 'linux') {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          out.set(pid, await readlink(`/proc/${pid}/cwd`))
        } catch {}
      }),
    )
    return out
  }
  // macOS / BSD: lsof field output, `p<pid>` then `n<path>` per process.
  const r = await execa('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], {
    reject: false,
    timeout: 3_000,
  })
  if (typeof r.stdout !== 'string') return out
  let pid: number | null = null
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== null) out.set(pid, line.slice(1))
  }
  return out
}
