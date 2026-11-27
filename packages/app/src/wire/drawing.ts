import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DrawingPlan, drawingFor, resolveBare } from '@tade/web/drawing'
import { languagesNamed } from '../highlight.ts'

// What the away view serves a browser that draws the window: `browser.ts` and
// everything it imports, highlight.js's core and the languages a file is
// coloured as (which a page registers with `colourWith`, as the heart does
// here), and pi-tui's `terminal-image.js` swapped for `browser-terminal.ts`.
// `@tade/web`'s `drawing.ts` walks it and serves it; this is only what it is.

/** The file every page imports the drawing through. */
export const BROWSER_ENTRY = fileURLToPath(new URL('../browser.ts', import.meta.url))

/** Where highlight.js and pi-tui are resolved from: the package that depends on both. */
const HERE = fileURLToPath(import.meta.url)

/** What pi-tui's Markdown imports to ask the terminal, and what a browser is given instead. */
const TERMINAL_IMAGE = '@earendil-works/pi-tui/dist/terminal-image.js'
const BROWSER_TERMINAL = fileURLToPath(new URL('../browser-terminal.ts', import.meta.url))

/**
 * The plan, resolved: the languages are only those highlight.js ships, as
 * `wire/highlighter.ts` registers only those, so a name it does not have is
 * plain in a browser exactly as it is here.
 */
export async function drawingPlan(): Promise<DrawingPlan> {
  // highlight.js's ES build keeps each language beside its core, as
  // `languages/<name>.js`: one that is not there is one it does not ship.
  const core = await resolveBare('highlight.js/lib/core', HERE, 'the drawing')
  const languages: DrawingPlan['roots'][number][] = languagesNamed()
    .filter((language) => existsSync(join(dirname(core), 'languages', `${language}.js`)))
    .map((language) => ({ specifier: `highlight.js/lib/languages/${language}`, from: HERE }))
  return {
    roots: [
      { file: BROWSER_ENTRY },
      { specifier: 'highlight.js/lib/core', from: HERE },
      ...languages,
    ],
    swaps: { [await resolveBare(TERMINAL_IMAGE, HERE, 'the drawing')]: BROWSER_TERMINAL },
  }
}

/** The drawing, built: what the away view serves under `/draw`. */
export async function drawing(): ReturnType<typeof drawingFor> {
  return drawingFor(await drawingPlan())
}
