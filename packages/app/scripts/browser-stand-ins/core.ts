// What a browser drawing the golden scenarios is handed in place of
// `@tade/core`'s barrel (`browser-goldens.ts` swaps the one for the other).
//
// The barrel is everything, and reaches the disk, the clock and
// `child_process`. A scenario needs the domain the drawing does —
// `@tade/core/pure` — and the few modules more it builds its state with: the
// away view's sentences, the config's schema, the Settings page's rows and the
// machines' grid. Each is core's own file, unchanged; one that reaches Node
// fails the build by name rather than being stood in for here.
//
// A name a scenario imports that is not below is a page error naming it, never
// a screen drawn from something else.

export * from '../../../core/src/away.ts'
export * from '../../../core/src/config.ts'
export * from '../../../core/src/inventory.ts'
export * from '../../../core/src/pure.ts'
export * from '../../../core/src/settings.ts'
