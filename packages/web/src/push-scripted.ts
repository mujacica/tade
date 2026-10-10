import type { Notice } from './noticed.ts'
import { answerFor, type PushAnswer, type Pusher, type PushTo } from './push-out.ts'

// A push service that is not one: every notification kept, nothing sent, no
// socket opened and no credential needed.
//
// **The second implementation of `Pusher`, and the one every test uses.** The
// real one needs a VAPID key, a push service's cooperation and a phone that
// agreed — none of which a test may have, and the first two of which are
// somebody else's property. So the whole of the window's wiring is driven
// against this: the transitions, the budget, the quiet hours, the dedupe, the
// retries, the `410` clean-up and the revocation, each as what this recorded
// rather than as what somebody's phone did.
//
// `answers` is a queue of statuses, and what runs out is `201`: a test says
// what is different about the case it is about and nothing about the rest.
// Statuses rather than `PushAnswer`s, so a test asks for `410` and the real
// table (`answerFor`) is what turns it into *forget this* — a test that
// scripted the answer directly would be a test of its own fixture.
//
// **What this cannot prove** is that the bytes a real push service is handed
// are the bytes RFC 8291 wants. Nothing offline can, and it is not pretended
// here: `test/push-out.test.ts` drives the real sender against a stand-in for
// `https.request` and checks the protocol independently — the JWT verified
// against the public key with `node:crypto`, the encrypted record's own
// header read back — and real delivery to a real device is a manual check,
// recorded as one.

/** One notification this kept, as a test reads it back. */
export interface Pushed {
  to: PushTo
  notice: Notice
  answer: PushAnswer
}

/** A `Pusher` that records and answers, with a queue of statuses. */
export interface ScriptedPusher extends Pusher {
  /** Everything it was asked to send, oldest first. */
  readonly sent: readonly Pushed[]
  /** What the next send is answered with. Mutable, so a test can add to it. */
  answers: number[]
  /** Make the next send throw, once: the failure a sender must survive. */
  throwOnce(said: string): void
}

export function scriptedPusher(answers: readonly number[] = []): ScriptedPusher {
  const sent: Pushed[] = []
  let throwing: string | null = null
  const it: ScriptedPusher = {
    sent,
    answers: [...answers],
    throwOnce(said) {
      throwing = said
    },
    send(to, notice) {
      if (throwing !== null) {
        const said = throwing
        throwing = null
        // **A throw and not an answer**, because that is the shape a real
        // sender can fail in that no status covers — and a beat that threw
        // because a notification did is the failure worth a test.
        return Promise.reject(new Error(said))
      }
      const answer = answerFor(it.answers.shift() ?? 201)
      sent.push({ to, notice, answer })
      return Promise.resolve(answer)
    },
  }
  return it
}
