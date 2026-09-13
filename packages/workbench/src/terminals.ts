import type { LaneRecord } from './registry.ts'

// Terminals: shells that belong to a project rather than to an agent, opened
// along the bottom of the window, by the orchestrator, or by voice.
//
// A terminal is an ordinary lane — the driver runs it, the registry keeps it,
// and under tmux it outlives the window like everything else. What makes one a
// terminal is its kind and its id, `<project>/terminals/<n>`, so they never
// share a name with an agent's lanes and are found again after a restart.

/** The task segment every terminal's lane id carries. */
export const TERMINALS = 'terminals'

export interface TerminalInfo {
  id: string
  project: string
  /** What it is called: `terminal 1` until somebody renames it. */
  name: string
  cwd: string
  startedAt: number
}

/** The terminals among a registry's lanes, oldest first: the order their tabs were opened in. */
export function terminalsFrom(lanes: readonly LaneRecord[], project?: string): TerminalInfo[] {
  return lanes
    .filter((lane) => lane.kind === 'terminal' && lane.alive)
    .map((lane) => ({
      id: lane.id,
      project: lane.id.split('/')[0] ?? '',
      name: lane.title || `terminal ${lane.id.split('/').at(-1) ?? ''}`,
      cwd: lane.spec.cwd,
      startedAt: lane.startedAt,
    }))
    .filter((terminal) => project === undefined || terminal.project === project)
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

/** The next free lane id for a project's terminal, and the name it starts with. */
export function nextTerminal(
  project: string,
  lanes: readonly LaneRecord[],
): { id: string; name: string } {
  const taken = new Set(lanes.filter((lane) => lane.alive).map((lane) => lane.id))
  for (let n = 1; ; n++) {
    const id = `${project}/${TERMINALS}/${n}`
    if (!taken.has(id)) return { id, name: `terminal ${n}` }
  }
}

/**
 * The terminal somebody meant by a word or two: its name, its number, or its
 * id — and with nothing said, the only one there is. Null when it could be
 * more than one, because running a command in the wrong shell is worse than
 * asking which.
 */
export function findTerminal(
  terminals: readonly TerminalInfo[],
  said: string | null | undefined,
): TerminalInfo | null {
  const want = (said ?? '')
    .trim()
    .toLowerCase()
    .replace(/^(the|a|my)\s+/, '')
    .replace(/\s+terminal$/, '')
  if (want === '') return terminals.length === 1 ? (terminals[0] ?? null) : null
  const number = /^(terminal\s*)?(\d+)$/.exec(want)?.[2]
  const exact = terminals.filter(
    (terminal) =>
      terminal.name.toLowerCase() === want ||
      terminal.id === want ||
      (number !== undefined && terminal.id.endsWith(`/${number}`)),
  )
  if (exact.length === 1) return exact[0] ?? null
  const partial = terminals.filter((terminal) => terminal.name.toLowerCase().includes(want))
  return partial.length === 1 ? (partial[0] ?? null) : null
}

/** Lines of a terminal's text containing some text, any case, numbered from the top of what was read. */
export function matchingLines(
  text: string,
  query: string,
  max = 50,
): { line: number; text: string }[] {
  const want = query.toLowerCase()
  if (want === '') return []
  const found: { line: number; text: string }[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && found.length < max; i++) {
    const line = lines[i] ?? ''
    if (line.toLowerCase().includes(want)) found.push({ line: i + 1, text: line.trimEnd() })
  }
  return found
}
