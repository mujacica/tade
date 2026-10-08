// `@tade/web` — the away view's data boundary.
//
// What this package is: **a contract and a pure projection.** It says what one
// paired device may read of Tade's state, in named fields over `@tade/core`
// types, and it turns what the window already holds into that. Nothing here
// listens on a socket, reads a file, reads a clock or knows a config key — the
// server, the sessions, the devices and the browser assets are later slices'
// (`away-auth-server`, `away-stream-and-window`, `away-readonly-ui`), and each
// of them builds on this.
//
// What it must never do: **import `@tade/app` or `@tade/workbench`.** It
// declares what it needs to be handed (`reading.ts`, `input.ts`) and the window
// implements it. That is what keeps the projection testable without a window,
// and it is held by `test/modularity.test.ts` rather than by this sentence.
//
// It also may never reach `say()` or `remember()`, and it cannot: `said` has
// exactly one writer, `Keyboard.remember`, and `namedBy` reads those lines to
// authorise every `asked`-tier setting change on the machine. A page that could
// put words in somebody's mouth would inherit authority over all of them.
// `test/lifetime.test.ts` asserts the string does not appear here.
//
// Three things to know before adding a field:
//
// 1. **The projection is an allow-list and nothing is inherited.** `input.ts`
//    has the argument and is the file a new field is written into.
// 2. **Metadata and free text somebody wrote are different promises.**
//    `fields.ts` has both, mechanically.
// 3. **`(epoch, rev)` is the cursor, never `seq` and never a byte offset.**
//    `input.ts`'s `Lifetime` says why.
//
// The name is `web` because that is what it serves. It has nothing to do with
// the owner's `tade-web` site project, and neither one is the other's.

export * from './delta.ts'
export * from './fields.ts'
export * from './input.ts'
export * from './measure.ts'
export * from './page.ts'
export * from './protocol.ts'
export * from './reach.ts'
export * from './reading.ts'
export * from './snapshot.ts'
