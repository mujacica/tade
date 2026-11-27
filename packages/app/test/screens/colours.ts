import { colourWith } from '../../src/highlight.ts'
import { requireHighlighter } from '../../src/wire/highlighter.ts'

// The scenarios colour code as the window does: with the machine's
// highlight.js, which the heart registers before anything is drawn. Its own
// module, imported first by the scenarios that colour, so that a browser
// drawing the same scenarios (`scripts/browser-goldens.ts`) is handed its own
// registration in this one's place — the swap `browser-colours.ts` is.
colourWith(requireHighlighter)
