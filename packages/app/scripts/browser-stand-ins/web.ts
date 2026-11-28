// What a browser drawing the golden scenarios is handed in place of
// `@tade/web`'s barrel (`browser-goldens.ts` swaps the one for the other),
// which is the away view's server. A scenario takes the QR code, the
// evaluations' answer and the runs' rollup from it: each is the web package's
// own file, unchanged.

export * from '../../../web/src/evaluations.ts'
export * from '../../../web/src/factory.ts'
export * from '../../../web/src/qr.ts'
