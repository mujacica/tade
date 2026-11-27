import { AWAY_WORDS, THEIR_WORDS } from '@tade/core/pure'

// The headings a message to the orchestrator goes under, and taking one apart
// again. `inbox.ts` composes them (`withNews`) and the conversation's own view
// reads them back (`transcript.ts`) — which is drawn in a browser too
// (`browser.ts`), so this is its own file rather than a corner of the inbox,
// whose other half reaches the away view's scrubbing and through it Node.

/** The heading what Tade tells it on its own goes under (`tell`), when news went with it. */
export const TADE_WORDS = 'Tade says:'

const SINCE = 'Since you last heard from Tade:'

/**
 * A message as `withNews` composed it, taken apart again: the news that went
 * with it, and the words under whichever heading they were under — the
 * person's (`THEIR_WORDS`), a paired device's (`AWAY_WORDS`), Tade's own
 * (`TADE_WORDS`), or none, where nothing went with the words and they were sent
 * as they were. Tade's line about where they were standing, and its paragraph
 * above a request from away, are neither, and are left out.
 *
 * For a conversation read back out of its harness's record, which keeps what
 * was sent and not who it was from.
 */
export function unwrapped(message: string): {
  news: string[]
  heading: 'them' | 'away' | 'tade' | null
  words: string
} {
  let rest = message
  const news: string[] = []
  if (rest.startsWith(`${SINCE}\n`)) {
    const lines = rest.split('\n')
    let at = 1
    for (; at < lines.length && (lines[at] ?? '').startsWith('- '); at++) {
      news.push((lines[at] ?? '').slice(2).replace(/^\d{1,2}:\d{2} /, ''))
    }
    rest = lines.slice(at).join('\n').replace(/^\n/, '')
  }
  const headings = [
    [THEIR_WORDS, 'them'],
    [AWAY_WORDS, 'away'],
    [TADE_WORDS, 'tade'],
  ] as const
  for (const [heading, whose] of headings) {
    // At the start, or on a line of its own below Tade's.
    const at = `\n${rest}`.indexOf(`\n${heading}\n`)
    if (at >= 0) return { news, heading: whose, words: rest.slice(at + heading.length + 1) }
  }
  return { news, heading: null, words: rest }
}
