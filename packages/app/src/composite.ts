import {
  extractSegments,
  sliceByColumn,
  sliceWithWidth,
  visibleWidth,
} from '@earendil-works/pi-tui/dist/utils.js'

// pi-tui's `compositeTuiLine`, here because of where pi-tui keeps it.
//
// It lives in pi-tui's `tui.js`, beside the renderer, and `tui.js` imports
// `node:perf_hooks` and `terminal-image.js` (`child_process`, `os`): the one
// helper the drawing needs from that file would bring Node into a browser that
// draws the window (`browser.ts`). Everything it is made of is in `utils.js`,
// which is pure, so this is its body, line for line, over those — and
// `test/composite.test.ts` holds the two equal over every golden screen's rows
// and the overlays drawn on them, so a pi-tui that changes its own fails there.
//
// pi-tui is MIT; this is a copy of nineteen lines of it (1.6.1, `dist/tui.js`).

/** Resets the style and closes any open hyperlink, between the three parts of a composited row. */
const SEGMENT_RESET = '\x1b[0m\x1b]8;;\x07'

/** A kitty or iTerm2 image's escape, which a row carrying one is left as it is for. */
const IMAGE_PREFIXES = ['\x1b_G', '\x1b]1337;File='] as const

/** pi-tui's `isImageLine`: whether a row carries an inline image's escape anywhere in it. */
export function isImageLine(line: string): boolean {
  return IMAGE_PREFIXES.some((prefix) => line.includes(prefix))
}

/** Composite overlay content into a terminal line at a fixed column. */
export function compositeTuiLine(
  baseLine: string,
  overlayLine: string,
  startCol: number,
  overlayWidth: number,
  totalWidth: number,
): string {
  if (isImageLine(baseLine)) return baseLine
  const afterStart = startCol + overlayWidth
  const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true)
  const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true)
  const beforePad = Math.max(0, startCol - base.beforeWidth)
  const overlayPad = Math.max(0, overlayWidth - overlay.width)
  const actualBeforeWidth = Math.max(startCol, base.beforeWidth)
  const actualOverlayWidth = Math.max(overlayWidth, overlay.width)
  const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth)
  const afterPad = Math.max(0, afterTarget - base.afterWidth)
  const result =
    base.before +
    ' '.repeat(beforePad) +
    SEGMENT_RESET +
    overlay.text +
    ' '.repeat(overlayPad) +
    SEGMENT_RESET +
    base.after +
    ' '.repeat(afterPad)
  return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true)
}
