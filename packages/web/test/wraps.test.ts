import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CUT_ALLOWED } from './browser-plan.ts'

// **Nothing on the away view is cut to fit**: text too long for its width
// wraps, on a phone and at a desk. The browser harness's `cut` check asks a
// real browser of every screen (`scripts/browser.ts`); this asks the files,
// offline, on every commit — so a rule with an ellipsis or a line clamp that
// is not on the allow-list (`CUT_ALLOWED`) fails here before anybody opens a
// browser, and the script that writes three dots after a slice fails with it.

const ASSETS = join(import.meta.dirname, '..', 'src', 'assets')

function filesIn(dir: string, ending: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((one) =>
    one.isDirectory()
      ? filesIn(join(dir, one.name), ending)
      : one.name.endsWith(ending)
        ? [join(dir, one.name)]
        : [],
  )
}

/** Every rule that asks to cut its text, as `file: selector`. */
function cutsIn(file: string): { selector: string; how: string }[] {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const found: { selector: string; how: string }[] = []
  for (const rule of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const body = rule[2] ?? ''
    const clamp = /(?:^|[\s;])(?:-webkit-)?line-clamp:\s*([^;]+);/.exec(body)?.[1]?.trim()
    const ellipsis = /text-overflow:\s*ellipsis/.test(body)
    const clamps = clamp !== undefined && !['none', 'unset', 'initial'].includes(clamp)
    if (!ellipsis && !clamps) continue
    found.push({
      selector: (rule[1] ?? '').trim().replace(/\s+/g, ' '),
      how: clamps ? 'clamp' : 'ellipsis',
    })
  }
  return found
}

describe('text on the away view', () => {
  const sheets = filesIn(ASSETS, '.css')

  it('is never cut by a stylesheet, but where the allow-list says, as it says', () => {
    expect(sheets.length).toBeGreaterThan(10)
    const allowed = new Map(CUT_ALLOWED.map((one) => [one.selector, one.how]))
    const cut = sheets.flatMap((file) =>
      cutsIn(file)
        .filter((one) => allowed.get(one.selector) !== one.how)
        .map((one) => `${file.slice(ASSETS.length + 1)}: ${one.selector} (${one.how})`),
    )
    expect(cut).toEqual([])
  })

  it('has no entry on the allow-list that nothing uses', () => {
    const used = new Set(sheets.flatMap((file) => cutsIn(file).map((one) => one.selector)))
    expect(CUT_ALLOWED.filter((one) => !used.has(one.selector))).toEqual([])
  })

  it('is never cut by a script writing three dots after a slice', () => {
    const scripts = filesIn(ASSETS, '.js')
    const cut = scripts.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, at) => ({ line, at }))
        .filter(({ line }) => /\.slice\([^)]*\)\}?…|\.slice\([^)]*\)\s*\+\s*['"`]…/.test(line))
        .map(({ at }) => `${file.slice(ASSETS.length + 1)}:${at + 1}`),
    )
    expect(cut).toEqual([])
  })
})
