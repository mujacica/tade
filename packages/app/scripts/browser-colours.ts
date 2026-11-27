import { colourWith, type Highlighter, languagesNamed } from '../src/highlight.ts'

// What a browser drawing the scenarios is handed in place of
// `test/screens/colours.ts` (`browser-goldens.ts` swaps the one for the other):
// the same highlight.js, its ES build through the page's import map, with the
// same languages registered — so code is coloured in the browser exactly as it
// is on the machine, or the goldens say otherwise.
//
// A top-level `await`, which a browser's module takes and which makes every
// scenario that imports this wait for it — the order the machine's sync
// `require` gives for nothing.

/** What the page's import map can answer, read off the map itself. */
const page = (
  globalThis as unknown as {
    document: { querySelector(selector: string): { textContent: string | null } | null }
  }
).document
const map = page.querySelector('script[type="importmap"]')?.textContent ?? '{}'
const mapped = (JSON.parse(map) as { imports?: Record<string, string> }).imports ?? {}

/** Through a variable, so the compiler leaves highlight.js's DOM types out of the program. */
const load = (specifier: string): Promise<{ default: unknown }> => import(specifier)

const core = (await load('highlight.js/lib/core')).default as Highlighter
for (const language of languagesNamed()) {
  const specifier = `highlight.js/lib/languages/${language}`
  // One highlight.js does not ship is not in the map, and is plain here as it is there.
  if (specifier in mapped) core.registerLanguage(language, (await load(specifier)).default)
}
colourWith(() => core)
