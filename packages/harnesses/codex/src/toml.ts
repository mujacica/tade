// Settings said the way Codex takes them on a command line.
//
// Codex has no `--settings` to be handed a file: what a run is given goes in
// as `-c <key>=<value>`, and the value is read as TOML. So this writes one
// TOML value — always inline, never a section — which is all a command-line
// override can be. Small on purpose: it exists so nothing has to hand-write a
// quoted table, and a table Codex would refuse is a launch that never starts.

/** A value as TOML, inline: strings, numbers, booleans, arrays and tables. */
export function toml(value: unknown): string {
  if (typeof value === 'string') return text(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const pairs = Object.entries(value as Record<string, unknown>)
      // A key with nothing behind it is left out: TOML has no null, and
      // writing one as an empty string would be inventing an answer.
      .filter(([, one]) => one !== undefined && one !== null)
      .map(([key, one]) => `${text(key)}=${toml(one)}`)
    return `{${pairs.join(',')}}`
  }
  // Anything else — a function, a symbol, undefined — has no TOML to be.
  return '""'
}

/** A TOML basic string: the six escapes it defines, and nothing else raw. */
function text(said: string): string {
  let out = '"'
  for (const ch of said) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}
