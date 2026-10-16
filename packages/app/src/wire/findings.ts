import type { JudgeFinding } from '@tade/extensions-core'
import type { Wiring } from './context.ts'

// What the judges last said, held for whoever draws it: the landing desk, and
// the away view's findings.
//
// A free function over the wiring rather than a subject or a member of it, so
// two readers share one poll and nothing that builds a `Wiring` by hand has to
// learn a new field. Asked on the beat (`keepAsking`), never from a frame, and
// never oftener than `FINDINGS_MS`: an extension answers from its own record,
// and the record is a file.
//
// **A look that failed keeps the last answer.** A judge that could not say this
// time is not a judge that found nothing, so the desk goes on drawing what it
// said before; only a window that has never had an answer draws `null`, which
// every reader says as *not read* rather than as none.

/** How often the extensions are asked what their judges found. */
export const FINDINGS_MS = 30_000

interface Held {
  findings: readonly JudgeFinding[] | null
  at: number
  asking: boolean
  /** What could not answer the last time anything could not, said once until it changes. */
  said: string
}

const held = new WeakMap<object, Held>()

/**
 * What the judges last said, or null before any of them has answered. Asks
 * again on the beat once `FINDINGS_MS` has gone by, and draws when it moved.
 */
export function heldFindings(wire: Wiring): readonly JudgeFinding[] | null {
  const host = wire.opts.extensions
  if (!host) return null
  let one = held.get(host)
  if (!one) {
    one = { findings: null, at: Number.NEGATIVE_INFINITY, asking: false, said: '' }
    held.set(host, one)
  }
  const kept = one
  wire.live?.keepAsking('findings', () => {
    if (kept.asking || wire.now() - kept.at < FINDINGS_MS) return
    kept.asking = true
    kept.at = wire.now()
    void host
      .findings()
      .then(({ findings, problems, asked }) => {
        // No judge here at all is nothing read, never nothing found. Every judge
        // answered, or some did and said something: what they said stands.
        // Nothing answered and something failed: keep what was said before.
        const now = asked === 0 ? null : findings
        // A judge that could not answer is said, once for as long as it fails the same way:
        // the desk drawing what it said before must not look like the judge going quiet.
        const trouble = problems.join('; ')
        if (trouble !== kept.said) {
          kept.said = trouble
          if (trouble !== '')
            wire.note(new Error(`the judges' findings could not all be read: ${trouble}`))
          wire.draw()
        }
        if (problems.length > 0 && findings.length === 0 && kept.findings !== null) return
        if (JSON.stringify(now) === JSON.stringify(kept.findings)) return
        kept.findings = now
        wire.draw()
      })
      // `findings()` answers its problems rather than throwing; anything else is the window's to say.
      .catch((err: unknown) => {
        wire.note(err)
        wire.draw()
      })
      .finally(() => {
        kept.asking = false
      })
  })
  return kept.findings
}
