import { z } from 'zod'

// The one shape free text takes on the wire, in a file of its own.
//
// **Its own module because two schema files need it and neither may import the
// other.** `protocol.ts` composes `protocol-factory.ts`, so the arrow goes one
// way; a `Said` defined in the first and imported by the second is a cycle
// that type-checks and then hands the second an `undefined` at import time —
// which is a `TypeError` with a stack in zod, a long way from the cause. One
// leaf module, imported by both, and the cycle is unrepresentable.
//
// `protocol.ts` re-exports it, so everything that said `from './protocol.ts'`
// still does and there is still one spelling of the type.

/**
 * A piece of free text somebody wrote, as much of it as the budget allowed.
 *
 * `more` and not an ellipsis: three dots written into the text cannot be told
 * from three dots the person typed, and the house rule about a note is that it
 * is never reworded. See `page.ts`.
 */
export const SaidSchema = z.strictObject({
  /** As much of what was said as the budget allowed. */
  words: z.string(),
  more: z.boolean(),
})
export type Said = z.infer<typeof SaidSchema>
