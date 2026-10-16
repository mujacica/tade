import type { StreamFrame } from './held.ts'

// Reading the away view's live stream: bytes in, whole frames out.
//
// Pure, and a table test: a chunk that ends mid-frame is held until the rest
// arrives, a comment is a heartbeat (`: keep-alive`, and the opening's
// padding), and a line that is no field of the format is left out rather than
// thrown over. `@tade/mcp-http` has a reader of the same format, and it drops
// `id` on purpose because nothing there resumes; here `id` is the cursor, and
// resuming is the whole point.

/** What one read of the stream came to: the frames it finished, and what is left over. */
export interface Read {
  frames: StreamFrame[]
  rest: string
}

/** Every whole frame in what has arrived so far. */
export function framesIn(text: string): Read {
  const frames: StreamFrame[] = []
  let rest = text
  let at = boundary(rest)
  while (at !== null) {
    const block = rest.slice(0, at.at)
    rest = rest.slice(at.at + at.length)
    const one = frameOf(block)
    if (one !== null) frames.push(one)
    at = boundary(rest)
  }
  return { frames, rest }
}

/** Where the next frame ends, whichever line ending the server used. */
function boundary(text: string): { at: number; length: number } | null {
  const rn = text.indexOf('\r\n\r\n')
  const nn = text.indexOf('\n\n')
  if (rn !== -1 && (nn === -1 || rn < nn)) return { at: rn, length: 4 }
  if (nn !== -1) return { at: nn, length: 2 }
  return null
}

/**
 * One block as a frame, or null for a block that carries none: a comment, a
 * `retry:`, or nothing at all.
 */
function frameOf(block: string): StreamFrame | null {
  let event = 'message'
  let id: string | null = null
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
  }
  if (data.length === 0) return null
  return { event, id, data: data.join('\n') }
}

/**
 * How much may be held waiting for a frame to end: four megabytes.
 *
 * A snapshot is the largest thing on the stream — 48 KB for six projects and
 * twenty tasks, measured — so this is a hundred times that, and the bound that
 * stops a remote that never ends a frame from growing a string in this
 * process for ever.
 */
export const FRAME_MOST = 4 * 1024 * 1024
