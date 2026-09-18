import { homedir } from 'node:os'
import type { AgentSignal, Workspace } from '@tade/core'

// Human-readable `tade status`. Terse on purpose: one line per task, one
// summary line per group of untracked sessions.

export function formatStatus(ws: Workspace): string[] {
  const lines: string[] = []
  const width = Math.max(
    8,
    ...ws.projects.flatMap((p) => p.tasks.map((t) => t.id.length - p.name.length - 1)),
  )
  for (const p of ws.projects) {
    lines.push(`${p.name}${p.tasks.length === 0 && p.untracked.length === 0 ? '  (no tasks)' : ''}`)
    for (const t of p.tasks) {
      const name = t.id.slice(p.name.length + 1).padEnd(width)
      const flag = t.stalled ? ' ⚠' : ''
      lines.push(`  ${name}  ${t.state.padEnd(7)}  ${t.reason}${flag}`)
    }
    if (p.untracked.length > 0) lines.push(`  + ${sessions(p.untracked)} outside Tade`)
  }
  if (ws.elsewhere.length > 0) {
    const where = [...new Set(ws.elsewhere.map((s) => tilde(s.cwd)))].slice(0, 3).join(', ')
    lines.push(`elsewhere: ${sessions(ws.elsewhere)} (${where})`)
  }
  if (lines.length === 0) lines.push('no projects')
  if (ws.warnings.length > 0) {
    lines.push(
      `${ws.warnings.length} warning${ws.warnings.length === 1 ? '' : 's'} (--json for details)`,
    )
  }
  return lines
}

function sessions(list: AgentSignal[]): string {
  const byTurn = new Map<string, number>()
  for (const s of list) {
    const k = `${s.provider} ${s.turn === 'unknown' ? 'active' : s.turn}`
    byTurn.set(k, (byTurn.get(k) ?? 0) + 1)
  }
  const parts = [...byTurn].map(([k, n]) => (n > 1 ? `${n}× ${k}` : k))
  return `${list.length} session${list.length === 1 ? '' : 's'}: ${parts.join(', ')}`
}

function tilde(p: string): string {
  const h = homedir()
  return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p
}
