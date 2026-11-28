import type { TadeExtension } from '@tade/extensions-core'

// What a browser drawing the golden scenarios is handed in place of the
// barrels of the extensions they show (`browser-goldens.ts` swaps each for
// this file).
//
// An extension is its tools, and its tools are the machine's: the disk, the
// network, `child_process`. What the window draws of one is what it declared —
// its name, title and description, its tools' names and descriptions, its
// actions and its watches — so the machine reads those off the real
// extensions and hands them to the page before the scenarios load, as
// `TADE_EXTENSIONS`, and they are these. What the scenarios draw as an
// extension's own page is its own pure file, unchanged.

export * from '../../../extensions/jev/src/page.ts'
export * from '../../../extensions/jev/src/questions.ts'
export * from '../../../extensions/resources/src/chart.ts'
export * from '../../../extensions/resources/src/usage.ts'

/** What the machine read off each extension, by the name it is exported as. */
const told = (globalThis as { TADE_EXTENSIONS?: Record<string, TadeExtension> }).TADE_EXTENSIONS
const declared = (name: string): TadeExtension => {
  const one = told?.[name]
  if (one === undefined) throw new Error(`the machine did not hand the page ${name}`)
  return one
}

export const checksExtension = declared('checksExtension')
export const depsExtension = declared('depsExtension')
export const jevExtension = declared('jevExtension')
export const sentryExtension = declared('sentryExtension')
