import { domainHead, domainSays } from '@tade/core'
import type { RecordsAnswer, WebRecords } from '@tade/web'
import type { Wiring } from './context.ts'

// This machine's public name's records, looked at for an owner on another
// machine of the person's whose Settings › Remotes is open on this one
// (`@tade/web`'s `records.ts`): the same look as the Public name row here
// (`web-domain.ts`) and `tade host domain`, in the same words.
//
// **The look's rule holds here too: asked when somebody is looking.** That
// window asks only while its page is open, once for each opening and again on
// its Look again; this half adds no clock. A look under way answers every ask
// that arrives while it runs, so two windows looking at once ask the world once.
//
// **Only a real window dials** (`AppOptions.domain`, handed by the CLI): a
// test's window says it does not look rather than asking the world. And a look
// is held to `RECORDS_MS`, under the link's own deadline for a request, so a
// zone whose servers never answer is said as that rather than as a link that
// went quiet.

/** How long one look may take before it is answered as one that ran out of time. */
export const RECORDS_MS = 15_000

export function recordsFrom(wire: Wiring): WebRecords {
  let looking: Promise<RecordsAnswer> | null = null
  return () => {
    looking ??= lookNow(wire).finally(() => {
      looking = null
    })
    return looking
  }
}

async function lookNow(wire: Wiring): Promise<RecordsAnswer> {
  const at = () => new Date(wire.now()).toISOString()
  const name = wire.opts.config.surfaces.web.public.toLowerCase()
  const none = (cannot: string): RecordsAnswer => ({
    at: at(),
    name: name === '' ? null : name,
    head: null,
    lines: [],
    cannot,
  })
  if (name === '') return none('it has no public name')
  const look = wire.opts.domain ?? null
  if (look === null) return none('its window does not look at DNS')
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), RECORDS_MS)
    timer.unref()
  })
  try {
    // `lookAtDomain` never throws — what it could not ask is in what it says —
    // so one that did is said as the reason, rather than as a link that broke.
    const seen = await Promise.race([look(name), late])
    if (seen === null) return none(`its look took longer than ${RECORDS_MS / 1000} s`)
    const lines = domainSays(seen).map((one) => ({ ...one, remove: [...one.remove] }))
    return { at: at(), name, head: domainHead(seen), lines, cannot: null }
  } catch (err) {
    return none(`could not look: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
}
