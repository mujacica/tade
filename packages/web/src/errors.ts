// What goes wrong, in one shape, so the client has one branch.
//
// Pure, and the whole of what a browser is ever told about a failure. The rule
// that makes it a file rather than a handful of literals: **what the page is
// told and what the journal is told are two different sentences**, and keeping
// them apart is the only way the first stays safe to read. `said` is Tade's own
// words for a person; the detail — the host that was offered, the exception
// that was thrown, which of five checks refused — goes in a `warning` event
// where a person at the machine can read it, and never on the wire.
//
// So there is no `detail`, no `stack`, no `path` and no `host` field here, and
// that is deliberate rather than an omission waiting to be filled in.

/** Every way a request can be refused, as the page's one branch. */
export const ERRORS = [
  'malformed',
  'no_session',
  'bad_origin',
  'out_of_scope',
  'locked',
  'no_such',
  'not_offered',
  'too_big',
  'slow_down',
  'closing',
  'busy',
  'broke',
] as const
export type ErrorKind = (typeof ERRORS)[number]

/** What the browser is handed. Nothing else is ever in a body. */
export interface Refusal {
  status: number
  error: ErrorKind
  /** Tade's own sentence. Never an exception's words and never a path. */
  said: string
  /**
   * Seconds to wait, where waiting is the answer. Sent as `Retry-After` too,
   * so a client that reads neither JSON nor headers still backs off.
   */
  after?: number
  /**
   * An id for the one line in the journal that has the detail.
   *
   * Only on `broke`: it is the one refusal whose cause nobody can guess from
   * the shape of the request, so it is the one where a person needs to be able
   * to join what they saw on the phone to what was written down here.
   */
  request?: string
}

const SAID: Readonly<Record<ErrorKind, { status: number; said: string }>> = {
  malformed: { status: 400, said: 'that request did not make sense' },
  no_session: { status: 401, said: 'this device is not signed in' },
  // One sentence for all five checks at the door, on purpose: which of them
  // refused is a map of the guard, and the page's move is the same either way.
  bad_origin: { status: 403, said: 'that request did not come from this address' },
  out_of_scope: { status: 403, said: 'this device was not granted that' },
  locked: { status: 403, said: 'that needs turning on at the machine' },
  no_such: { status: 404, said: 'there is nothing here by that name' },
  // `404` and not `403`, and this is the entry somebody will want to change: a
  // `403` saying "turn diffs on" tells whoever holds a stolen session that
  // there is a diff route and what the setting is called. The person who needs
  // to know reads what they were granted in their own snapshot.
  not_offered: { status: 404, said: 'there is nothing here by that name' },
  too_big: { status: 413, said: 'that was too long to send' },
  slow_down: { status: 429, said: 'too many tries — wait a moment' },
  closing: { status: 503, said: 'Tade is closing' },
  busy: { status: 503, said: 'too many connections — try again shortly' },
  broke: { status: 500, said: 'something went wrong here' },
}

/** The refusal for a kind, with its status and its sentence already decided. */
export function refuse(
  error: ErrorKind,
  extra: { after?: number; request?: string } = {},
): Refusal {
  const { status, said } = SAID[error]
  return {
    status,
    error,
    said,
    ...(extra.after === undefined ? {} : { after: extra.after }),
    ...(extra.request === undefined ? {} : { request: extra.request }),
  }
}

/** What goes in the body: the shape above, minus the status it is sent with. */
export function bodyOf(refusal: Refusal): Record<string, string | number> {
  return {
    error: refusal.error,
    said: refusal.said,
    ...(refusal.after === undefined ? {} : { after: refusal.after }),
    ...(refusal.request === undefined ? {} : { request: refusal.request }),
  }
}
