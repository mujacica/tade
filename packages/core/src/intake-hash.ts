import { createHash } from 'node:crypto'

// What a hash of a request means — one answer, for every source.
//
// `IntakeMaterial.hash` is written by whichever connector read the words and
// compared by `intakeAgain`, which knows nothing about connectors: it is handed
// the hash a look just computed and the hash recorded when somebody approved,
// and says whether the text has moved. So the two have to be the same function,
// and three connectors each spelling it for themselves — each with a comment
// saying it must match the others — is three chances for one of them to be
// right about everything except the encoding.
//
// Its own file rather than a line in `intake.ts`, which is pure and must stay
// that way: this is the one part of the envelope that needs `node:crypto`.

/**
 * sha256 of the request as it was read, prefixed with the algorithm.
 *
 * Of **exactly** the text that goes in `verbatim`, which is what makes the
 * comparison meaningful: a hash of a trimmed body against a hash of an
 * untrimmed one reads as somebody having edited the request.
 *
 * The prefix is there so a later algorithm is a different-looking hash rather
 * than a silently incomparable one — `intakeAgain` reads an unequal hash as
 * "the text has changed", which holds the work, so the failure direction of
 * ever changing this is a re-park and a sentence rather than a start on words
 * nobody approved.
 */
export function intakeHash(verbatim: string): string {
  return `sha256:${createHash('sha256').update(verbatim, 'utf8').digest('hex')}`
}
