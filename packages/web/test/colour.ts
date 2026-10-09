// The xterm-256 cube and the WCAG ratio, so a test can check the page's own
// arithmetic.
//
// **Why there are two copies of this.** `packages/app/src/skin.ts` has the same
// cube table and the same `contrast()`, and `test/modularity.test.ts` forbids
// anything under `packages/web/` from importing `@tade/app` — the arrow points
// the other way, so that the away view can be tested without a window. The
// choice was therefore a copy here or **no mechanical check of the palette at
// all**, and the second is worse: the away view is the same control room
// rendered in type, so a hex that drifts from the window's own tone is two
// products, and a contrast ratio nobody recomputes is a number in a comment.
//
// What makes the copy safe is that neither half is Tade's: the 6×6×6 cube and
// the grey ramp are xterm's, and the luminance formula is WCAG's. Neither has
// changed in twenty years and neither is ours to change.

/** The cube's six levels. xterm's, not ours. */
const CUBE = [0, 95, 135, 175, 215, 255]

/** The channels of an xterm-256 tone. 232–255 are the grey ramp. */
export function rgbOf(tone: number): [number, number, number] {
  if (tone >= 232) {
    const step = 8 + 10 * (tone - 232)
    return [step, step, step]
  }
  const at = tone - 16
  const level = (n: number) => CUBE[n] ?? 0
  return [level(Math.floor(at / 36)), level(Math.floor(at / 6) % 6), level(at % 6)]
}

/** The hex a stylesheet would write for a tone, lower case and six digits. */
export function hexOf(tone: number): string {
  return `#${rgbOf(tone)
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')}`
}

/** Relative luminance, the WCAG one: 0 for black, 1 for white. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const part = value / 255
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** The channels of a `#rgb` or `#rrggbb`. */
export function channelsOf(hex: string): [number, number, number] {
  const bare = hex.replace('#', '')
  const full =
    bare.length === 3
      ? bare
          .split('')
          .map((one) => one + one)
          .join('')
      : bare
  const at = (start: number) => Number.parseInt(full.slice(start, start + 2), 16)
  return [at(0), at(2), at(4)]
}

/** How far apart two colours are, as the WCAG ratio: 1 for the same, 21 at most. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(channelsOf(a)), luminance(channelsOf(b))].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}
