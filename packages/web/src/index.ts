// `@tade/web` — the away view's data boundary.
//
// What this package is: **a contract, a pure projection, and the server that
// serves it.** The contract says what one paired device may read of Tade's
// state, in named fields over `@tade/core` types; the projection turns what the
// window already holds into that; the server is `node:http` behind pairing, a
// session and a guard.
//
// **Nothing here starts anything, and nothing here changes anything unless a
// person turned that on too.** `webServer(...).listen()` is called by whoever
// holds the home lock, and only where `surfaces.web.enabled` says so. Acting
// is a second setting and a second table: with `surfaces.web.acting` off there
// is no route and no `WebActing`, so a crafted call is the `404` of a path
// nobody built — `acting.ts` is the whole of what one may ever do, and it is a
// method per verb with no shape a path, a command or a setting could arrive
// in.
//
// **This is not the `ToolHost`.** That is a Unix socket in `@tade/orchestrator`
// for the window's own child agents, undiscoverable and dead with the window.
// Nothing routes the away view through it, nothing here can reach it, and
// `test/separation.test.ts` is where that stops being a sentence.
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
// `test/separation.test.ts` asserts no source file here reaches either.
//
// Three things to know before adding a field, and a fourth before adding a
// route (`routes.ts` has it: **no route in `ROUTES` mutates a project or a
// task, and the acting routes are a second table a setting turns on**):
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

export * from './acted.ts'
export * from './acting.ts'
export * from './acts.ts'
export * from './assets.ts'
export * from './delta.ts'
export * from './devices.ts'
export * from './errors.ts'
export * from './fields.ts'
export * from './guard.ts'
export * from './headers.ts'
export * from './input.ts'
export * from './measure.ts'
export * from './page.ts'
export * from './peers.ts'
export * from './protocol.ts'
export * from './qr.ts'
export * from './reach.ts'
export * from './reading.ts'
export * from './receipts.ts'
export * from './request.ts'
export * from './routes.ts'
export * from './server.ts'
export * from './serving.ts'
export * from './sessions.ts'
export * from './snapshot.ts'
export * from './stream.ts'
export * from './surface.ts'
export * from './tickets.ts'
export * from './verbs.ts'
