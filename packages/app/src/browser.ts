// The window's drawing, as a browser loads it.
//
// A phone draws its own copy of the window from the state the machine sends
// (the away view's full view): the same `draw`, the same panels and their state
// machines, the same hit map, scrolling and layout, at the phone's own size.
// This file is the one door the page imports through, and everything it
// reaches is held free of Node by `test/browser.test.ts`, which walks this
// file's import closure — as the browser does, through the import map
// `wire/drawing.ts` plans — and fails on any `node:` import or Node-only
// package.
//
// A namespace each, rather than one flat list: two of these modules may name a
// helper the same, and the page should say which one it means.
//
// What the machine does with no screen, the page says for itself before it
// draws: which highlight.js colours code (`colourWith`, with the languages
// `languagesNamed` lists, imported through the same map), and what its
// renderer can show (`setCapabilities`, `browser-terminal.ts`).

export { setCapabilities } from './browser-terminal.ts'
export * as commands from './commands.ts'
export { colourWith, languagesNamed } from './highlight.ts'
export * as hits from './hits.ts'
export * as keys from './keys.ts'
export * as layout from './layout.ts'
export * as model from './model.ts'
export * as panels from './panels.ts'
export * as scroll from './scroll.ts'
export * as skin from './skin.ts'
export * as ui from './ui.ts'
export { LastFrame } from './view/last-frame.ts'
export { draw } from './view.ts'
