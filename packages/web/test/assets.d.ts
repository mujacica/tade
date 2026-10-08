// The contract the browser's copy of a rule must satisfy.
//
// `tsc` has no declarations for a `.js` file and `allowJs` is off — turning it
// on would pull `boot.js` into the program, which reaches `document`,
// `location` and `EventSource`, none of which are in this repository's `lib`.
// A `.d.ts` beside the asset is not an option either: `src/assets/` is served,
// and a file of a kind nothing can serve fails `assets.test.ts`.
//
// So the shape lives here, in the test folder, which is the right place for
// it: it is not a type the program uses, it is the **contract a test holds two
// copies of one rule to**. `client.test.ts` runs the same table through this
// and through `src/stream.ts` and asserts they agree, so a change to either
// copy that does not change the other fails.

declare module '*/assets/live.js' {
  export const STALE_AFTER_MS: number
  export const BACKOFF_MS: readonly number[]
  export function backoffAt(tries: number): number
  export function connectionOf(
    seen: { open: boolean; lastAt: number; ended: string | null },
    now: number,
  ):
    | { kind: 'live'; sinceAt: number }
    | { kind: 'stale'; sinceAt: number }
    | { kind: 'unreachable'; sinceAt: number }
    | { kind: 'closed'; why: string }
  export function saidOf(
    connection:
      | { kind: 'live'; sinceAt: number }
      | { kind: 'stale'; sinceAt: number }
      | { kind: 'unreachable'; sinceAt: number }
      | { kind: 'closed'; why: string },
    at: string,
    now: number,
  ): string
}
