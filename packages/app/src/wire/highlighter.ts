import { createRequire } from 'node:module'
import { type Highlighter, languagesNamed } from '../highlight.ts'

const require = createRequire(import.meta.url)

/**
 * highlight.js's core and the languages a file is ever coloured as, loaded the
 * first time a file is — never on the way to the window's first frame. The
 * machine's highlighter, handed to `colourWith` by the heart; `highlight.ts`
 * itself imports nothing of Node, so the window draws in a browser too.
 *
 * The whole library registers all 193 languages it ships as it loads: 195
 * modules of the 1,185 an open read, 70–100 ms before anything was drawn
 * (load 5–22 on 14 cores), for a viewer that is opened later or not at all.
 * The core alone is 4 ms, and a language Tade has no name for here was never
 * coloured anyway, so registering only the named ones colours exactly what
 * the whole library did. One it does not ship is left plain, as it was.
 */
export function requireHighlighter(): Highlighter {
  const core = require('highlight.js/lib/core') as Highlighter
  for (const language of languagesNamed()) {
    try {
      const module = require(`highlight.js/lib/languages/${language}`) as { default?: unknown }
      core.registerLanguage(language, module.default ?? module)
    } catch {
      // Not one highlight.js ships: plain, which is what it always was.
    }
  }
  return core
}
