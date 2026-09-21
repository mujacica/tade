// Reading a stream of events, which is the one thing an HTTP server has that
// a program on a pipe does not.
//
// Pure enough to be a table test: bytes in, whole events out, and a chunk
// that ends mid-event is held until the rest of it arrives. What arrives
// malformed is dropped here rather than thrown over, exactly as a half-line
// on a pipe is — a server that writes a comment, a heartbeat or a field
// nothing here knows is a server that still works.

/** One event off the stream: what it is called, and what it said. */
export interface Said {
  event: string
  data: string
}

/**
 * Whole events out of whatever has arrived so far, and what is left over.
 *
 * Events are separated by a blank line; `data:` lines are joined with
 * newlines, the way every reader of this format does it. A line that is not a
 * field, a comment (`:`) or a field nothing here reads is left out.
 */
export function eventsIn(text: string): { said: Said[]; rest: string } {
  const said: Said[] = []
  let rest = text
  // Both endings, because a server may use either and a reader that knows
  // only one silently never sees an event.
  let at = boundary(rest)
  while (at !== null) {
    const block = rest.slice(0, at.at)
    rest = rest.slice(at.at + at.length)
    const one = eventOf(block)
    if (one) said.push(one)
    at = boundary(rest)
  }
  return { said, rest }
}

function boundary(text: string): { at: number; length: number } | null {
  const rn = text.indexOf('\r\n\r\n')
  const nn = text.indexOf('\n\n')
  if (rn !== -1 && (nn === -1 || rn < nn)) return { at: rn, length: 4 }
  if (nn !== -1) return { at: nn, length: 2 }
  return null
}

function eventOf(block: string): Said | null {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    // `id` and `retry` are the stream's own bookkeeping, and resuming a
    // stream is not something Tade does: a window that came back opens again.
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}
