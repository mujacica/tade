import { isImageLine } from './composite.ts'

// What pi-tui's `terminal-image.js` is, in a browser.
//
// pi-tui's Markdown — which lays out the orchestrator's answers and every
// extension's README in the window — asks that file three things: what the
// terminal can do, how to wrap a link, and whether a line is an image. The file
// itself finds out what the terminal can do by asking `child_process`, `os` and
// the environment, none of which a browser has. So a browser drawing the window
// (`browser.ts`) is handed this in its place — the import map swaps the URL
// (`@tade/web`'s `drawing.ts`), and the walk that holds the drawing free of
// Node walks through the same swap.
//
// **What it can do is told, never detected**: the page says, once, what its
// own renderer draws (`setCapabilities`), and the machine's answer is the
// default where it says nothing — no images, no true colour, no OSC 8 links,
// which is pi-tui's own answer for a terminal it cannot identify. `hyperlink`
// and `isImageLine` are pi-tui's, line for line (1.6.1), held equal to the real
// ones by `test/browser-terminal.test.ts`.

/** pi-tui's `TerminalCapabilities`: what the screen being drawn for can show. */
export interface TerminalCapabilities {
  images: 'kitty' | 'iterm2' | null
  trueColor: boolean
  hyperlinks: boolean
}

let capabilities: TerminalCapabilities = { images: null, trueColor: false, hyperlinks: false }

/** What the screen can show, as the page said it last. */
export function getCapabilities(): TerminalCapabilities {
  return capabilities
}

/** The page's answer to what its renderer draws: said once, before anything is drawn. */
export function setCapabilities(caps: TerminalCapabilities): void {
  capabilities = caps
}

/** Longest URL that `hyperlink` wraps in an OSC 8 sequence. */
const MAX_HYPERLINK_URL_LENGTH = 8192

/** Wrap text in an OSC 8 hyperlink sequence; a URL past the limit is left as text. */
export function hyperlink(text: string, url: string): string {
  if (url.length > MAX_HYPERLINK_URL_LENGTH) return text
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`
}

export { isImageLine }
