import qrcode from 'qrcode-generator'

// The QR for the pairing panel: a URL in, a grid of modules out.
//
// **A QR code is not networking and it is not encryption.** It is a way of
// typing a URL with a camera. Whether the phone can reach this machine is
// decided by the network; whether the connection is private is decided by TLS.
// What the code carries is an address and a ninety-second ticket, and the
// ticket authorises nothing on its own (`tickets.ts`).
//
// **Why a dependency, against this repository's instinct.** DESIGN.md committed
// to zero new runtime dependencies and to a hand-written ~400-line Reed–Solomon
// encoder. The zero is a good instinct in the wrong place here, for one reason
// that is not about effort: **a wrong QR is a feature that silently does not
// scan.** There is no test on this machine that can tell a correct encoding
// from one that a phone's camera rejects — `redraw-the-pictures` cannot
// photograph a camera — so the evidence has to come from an encoder that
// millions of scans have been through and from a decoder written by somebody
// else. `qrcode-generator` is Kazuhiko Arase's implementation, MIT, ~2,200
// lines of pure JavaScript with no dependencies of its own and no native build
// step, which is the line DECISIONS §4.9 draws: nothing about anybody's install
// changes, because there is nothing to compile.
//
// `test/qr.test.ts` decodes what this produces with `jsqr` — a **devDependency**
// and a different codebase — which is the only way an encoder can be checked
// without a phone. What it still cannot prove is the optics: whether the code
// scans at the module size a terminal draws is a real camera's answer, and it
// is recorded as outstanding rather than ticked.

/**
 * How much correction. `M` recovers about 15% and is what every scanner is
 * tuned for; `H` would be bigger on screen for an address that is being read
 * from eight inches away in good light.
 */
const CORRECTION = 'M'

/**
 * How wide a quiet zone, in modules.
 *
 * Four is what the specification requires, and it is not decoration: a code
 * drawn hard against a dark panel is a code whose finder patterns a camera
 * cannot find. Whatever draws this adds it from here rather than deciding
 * again.
 */
export const QUIET = 4

/** A code: the modules, and how many of them there are on a side. */
export interface Code {
  /** Row-major, `true` for a dark module. No quiet zone: `QUIET` is the caller's. */
  modules: readonly (readonly boolean[])[]
  /** The side, in modules, not counting the quiet zone. */
  side: number
}

/**
 * The code for a string, or null where it will not fit.
 *
 * Null rather than a throw, because the caller is a panel being drawn: an
 * address that is somehow too long is a line of text saying so, not a window
 * that fell over. In practice nothing reaches it — a pairing URL is under
 * eighty bytes and version 10 holds several hundred — and it is here because
 * "it cannot happen" is how a thrown error ends up in a draw loop.
 */
export function codeFor(text: string): Code | null {
  if (text === '') return null
  let made: ReturnType<typeof qrcode>
  try {
    // `0` is "pick the smallest version that fits", which is what keeps the
    // code as coarse as possible — and a coarse code is one a camera reads.
    made = qrcode(0, CORRECTION)
    made.addData(text, 'Byte')
    made.make()
  } catch {
    return null
  }
  const side = made.getModuleCount()
  if (side <= 0) return null
  const modules: boolean[][] = []
  for (let row = 0; row < side; row++) {
    const line: boolean[] = []
    for (let column = 0; column < side; column++) line.push(made.isDark(row, column))
    modules.push(line)
  }
  return { modules, side }
}

/**
 * The code as the half-block rows a terminal draws, two module rows per line.
 *
 * Here rather than in the window because the encoder is here and a second
 * drawing of the same grid is a second thing to get wrong. Half-blocks and not
 * full ones: a terminal cell is about twice as tall as it is wide, so one
 * character per module gives a code half again too wide to fit a panel and
 * stretched enough that scanners struggle. `▀` is the top half, so an odd
 * number of rows ends on a row with nothing under it, which is quiet zone
 * anyway.
 */
export function blocksFor(code: Code, quiet = QUIET): string[] {
  const side = code.side + quiet * 2
  const dark = (row: number, column: number): boolean => {
    const y = row - quiet
    const x = column - quiet
    if (y < 0 || x < 0 || y >= code.side || x >= code.side) return false
    return code.modules[y]?.[x] ?? false
  }
  const rows: string[] = []
  for (let row = 0; row < side; row += 2) {
    let line = ''
    for (let column = 0; column < side; column++) {
      const top = dark(row, column)
      const bottom = dark(row + 1, column)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    rows.push(line)
  }
  return rows
}

/**
 * The code as `<rect>` elements' coordinates, for the pairing page.
 *
 * Coordinates and not markup: the page builds the elements itself, because the
 * content policy has no `unsafe-inline` and nothing anywhere in the client
 * touches `innerHTML`. One rect per dark module, in module units, so whatever
 * draws it picks the scale with a `viewBox`.
 */
export function rectsFor(code: Code, quiet = QUIET): { x: number; y: number }[] {
  const rects: { x: number; y: number }[] = []
  for (let row = 0; row < code.side; row++) {
    for (let column = 0; column < code.side; column++) {
      if (code.modules[row]?.[column] === true) rects.push({ x: column + quiet, y: row + quiet })
    }
  }
  return rects
}

/** The side of the drawing, quiet zone included: the `viewBox` a page needs. */
export function sideWithQuiet(code: Code, quiet = QUIET): number {
  return code.side + quiet * 2
}
