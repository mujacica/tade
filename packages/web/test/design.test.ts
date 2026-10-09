import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assetsDir } from '../src/assets.ts'
import { contrast, hexOf } from './colour.ts'

// The design, checked by arithmetic rather than by looking.
//
// **What this file can prove and a browser cannot**: that every colour is the
// window's own tone, that every contrast ratio in the comments is the ratio the
// hex actually has, that no token is used without being defined, that no text is
// below 13px, that the gutter is set the one way that cannot be zeroed by a
// later shorthand, and that the page claims no key and no affordance it does
// not have.
//
// **What it cannot prove, and names rather than ticks**: that the page is
// beautiful, that it is usable at 360px in a real browser with a real font, and
// that axe finds nothing. Those need a browser; `scripts/browser.ts` is the
// harness for them and it reports **unrun** rather than passing when there is
// none on the machine. `browser.test.ts` holds that reporting.

const DIR = assetsDir()
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')
const TOKENS = read('tokens.css')
// The frame and the screens, which are two files for length and one stylesheet
// for every rule here: a selector is in whichever of them it belongs to, and
// nothing in this file cares which.
const AWAY = `${read('frame.css')}\n${read('away.css')}`
const CSS = `${TOKENS}\n${AWAY}`
const HTML = read('index.html')
const SCRIPTS = ['boot.js', 'shell.js', 'screens.js', 'pages.js', 'rows.js', 'dom.js'].map(read)
const EVERY = [CSS, HTML, ...SCRIPTS].join('\n')

/** The ground every ratio in `tokens.css` is quoted against. */
const GROUND = '#121212'

/**
 * The two rules that may set `--quiet` without declaring a size.
 *
 * Both colour a **glyph** whose meaning is carried by the word beside it —
 * `◻ parked`, `⏸ closed` — so neither is the only statement of anything, which
 * is the clause the ≥16px rule exists to protect. A third one is a line
 * somebody adds here, next to that argument.
 */
const GLYPHS_IN_QUIET = ['.t-quiet', '.fresh .dot.is-closed']

describe('the palette is the window’s own', () => {
  // A token line in `tokens.css` is `--amber`, a hex, and a comment opening
  // with the xterm tone it is: the three things this block reads off it.
  const declared = [
    ...TOKENS.matchAll(/^\s{2}(--[\w-]+):\s*(#[0-9a-f]{3,8});\s*\/\*\s*(\d{1,3})\b/gm),
  ].map((found) => ({ token: found[1] ?? '', hex: found[2] ?? '', tone: Number(found[3]) }))

  it('names a tone for every colour, and there are enough of them to be the palette', () => {
    expect(declared.length).toBeGreaterThanOrEqual(20)
  })

  it('writes the hex the tone actually is, for every one', () => {
    // The away view is the same control room rendered in type. A hex that
    // drifted from `skin.ts`'s tone would be a second palette nobody decided
    // on, and nothing else would notice.
    for (const one of declared) {
      expect(one.hex, `${one.token} says tone ${one.tone}`).toBe(hexOf(one.tone))
    }
  })

  it('quotes the ratio each colour actually has against the page’s ground', () => {
    // Every ratio in the comments is recomputed here, so a number in a comment
    // cannot be a number somebody once believed.
    const quoted = [
      ...TOKENS.matchAll(
        /^\s{2}(--[\w-]+):\s*(#[0-9a-f]{6});\s*\/\*\s*\d{1,3}\s*·\s*([\d.]+)\s*·/gm,
      ),
    ]
    expect(quoted.length).toBeGreaterThanOrEqual(10)
    for (const found of quoted) {
      const [, token, hex, said] = found
      expect(contrast(hex ?? '', GROUND).toFixed(2), `${token} says ${said}`).toBe(said)
    }
  })

  it('is dark, and says that is a decision rather than leaving it to a browser', () => {
    // A second palette is a second design that stops being maintained, and the
    // window has no light skin. `color-scheme: dark` is what makes the
    // browser's own chrome match instead of flashing white around the page.
    expect(TOKENS).toContain('color-scheme: dark')
    expect(CSS).not.toContain('prefers-color-scheme: light')
    expect(HTML).toContain('content="dark"')
    expect(AWAY).toContain('background: var(--ground)')
  })
})

describe('what can be read, with the arithmetic', () => {
  const hex = (token: string) =>
    new RegExp(`${token}:\\s*(#[0-9a-f]{6})`).exec(TOKENS)?.[1] ?? '#000000'

  it('puts body text and headings clear of AAA', () => {
    expect(contrast(hex('--bright'), GROUND)).toBeGreaterThanOrEqual(7)
    expect(contrast(hex('--heading'), GROUND)).toBeGreaterThanOrEqual(7)
  })

  it('keeps every state colour above AA as text', () => {
    for (const token of ['--amber', '--violet', '--green', '--cyan', '--red']) {
      expect(contrast(hex(token), GROUND), token).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('holds the one colour that only passes AA to a size where it does', () => {
    // `--quiet` is 4.74:1: AA for normal text and **not** AAA. So it is used at
    // 16px and above, only for figures and hints, and never as the only
    // statement of a fact — anything that is takes `--heading` at 7.88:1.
    const quiet = contrast(hex('--quiet'), GROUND)
    expect(quiet).toBeGreaterThanOrEqual(4.5)
    expect(quiet).toBeLessThan(7)
    // **Every rule that sets it declares its own size, in the same block.**
    // That is what makes the rule mechanical rather than a note: a rule that
    // inherits a size from somewhere else is one nobody can check here.
    for (const found of AWAY.matchAll(/([^{}]*)\{([^{}]*color:\s*var\(--quiet\)[^{}]*)\}/g)) {
      const selector = (found[1] ?? '').trim().split('\n').at(-1)?.trim() ?? ''
      if (GLYPHS_IN_QUIET.includes(selector)) continue
      const size = /font-size:\s*var\((--s4|--step-[0-3])\)/.exec(found[2] ?? '')
      expect(size?.[1], `${selector} sets --quiet`).toBeDefined()
    }
  })

  it('never uses the one colour the palette calls a ground as text', () => {
    // `inkOn`'s rule, in type: `--amber-dark` is 3.27:1 and is a **ground and a
    // border**. Text on it would be unreadable on the page's own background,
    // so `color:` may never name it — `border-color:` may, and does.
    expect(AWAY).not.toMatch(/(?:^|[;{])\s*color:\s*var\(--amber-dark\)/m)
    expect(AWAY).toMatch(/border-color:\s*var\(--amber-dark\)/)
  })

  it('lays the right ink on each coloured ground', () => {
    // A coloured ground takes the dark ink, a grey ground the light one. The
    // window computes this rather than writing it beside each button, because
    // a choice made once per control is one that gets made wrong.
    expect(contrast(hex('--ink'), hex('--amber'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(hex('--ink-light'), hex('--control'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(hex('--ink'), hex('--amber-light'))).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps the focus ring readable against every ground it lands on', () => {
    for (const ground of ['--ground', '--surface', '--raised', '--chosen', '--control']) {
      expect(contrast(hex('--cyan'), hex(ground)), ground).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('type', () => {
  it('has no text below 13px anywhere', () => {
    expect(TOKENS).toContain('--step--1: 0.8125rem')
    // Nothing sets a size in px or a rem below the floor: a hard-coded size is
    // how 11px arrives on a page whose scale says it does not have one.
    for (const found of CSS.matchAll(/font-size:\s*([\d.]+)(px|rem)/g)) {
      const [, size, unit] = found
      const px = unit === 'rem' ? Number(size) * 16 : Number(size)
      expect(px, found[0]).toBeGreaterThanOrEqual(13)
    }
  })

  it('sizes every field at 17px, so iOS does not zoom the page on focus', () => {
    const field = /\binput\s*\{[^}]*\}/.exec(AWAY)?.[0] ?? ''
    expect(field).toContain('font-size: var(--step-1)')
    expect(TOKENS).toContain('--step-1: 1.0625rem')
  })

  it('loads no webfont, which the policy would refuse anyway', () => {
    expect(CSS).not.toContain('@font-face')
    expect(CSS).not.toContain('@import')
    expect(TOKENS).toContain('ui-sans-serif')
    expect(TOKENS).toContain('ui-monospace')
  })

  it('uppercases only the section headings, and gives them a word to read', () => {
    const uppercase = [...AWAY.matchAll(/text-transform:\s*uppercase/g)]
    expect(uppercase.length).toBeLessThanOrEqual(2)
    // A screen reader spells an uppercase heading; the `aria-label` is the
    // sentence-case one it reads instead.
    expect(read('rows.js')).toContain("'aria-label': sentence(title)")
  })
})

describe('the layout', () => {
  it('sets the gutter once, the one way a later shorthand cannot zero', () => {
    const body = /\bbody\s*\{[^}]*\}/.exec(TOKENS)?.[0] ?? ''
    expect(body).toContain('padding-inline: var(--s4)')
    // A `padding:` shorthand added later for vertical room is exactly how a
    // page loses its side margins at 360px without anybody touching the gutter.
    expect(body).not.toMatch(/\bpadding:\s/)
    expect(body).toContain('padding-block:')
  })

  it('reflows the cards with no breakpoint at all', () => {
    expect(TOKENS).toContain('repeat(auto-fit, minmax(')
  })

  it('has the three breakpoints, content-driven and in order', () => {
    const widths = [...AWAY.matchAll(/@media \(min-width:\s*(\d+)px\)/g)].map((one) =>
      Number(one[1]),
    )
    expect(widths).toEqual([...widths].sort((a, b) => a - b))
    expect(widths).toContain(768)
    expect(widths).toContain(1100)
  })

  it('lets only the tables and the tab strip be wider than the page', () => {
    // Everything else must reflow. A stray `overflow-x` is a page that scrolls
    // sideways on a phone for a reason nobody can find.
    const owners = [...AWAY.matchAll(/([^{}]+)\{[^{}]*overflow-x:\s*auto[^{}]*\}/g)].map((one) =>
      (one[1] ?? '').trim().split('\n').at(-1)?.trim(),
    )
    for (const owner of owners) expect(['.scrolls', '.tabstrip'], String(owner)).toContain(owner)
  })

  it('keeps room for the tab bar and the phone’s own safe area', () => {
    expect(AWAY).toContain('env(safe-area-inset-bottom)')
    expect(HTML).toContain('viewport-fit=cover')
  })
})

describe('reach and motion', () => {
  it('has a 44px floor and uses it on every control', () => {
    expect(TOKENS).toContain('--tap: 44px')
    for (const selector of ['.press', '.tab', '.back', '.more', '.tabstrip a', 'input']) {
      // The exact selector at the start of a rule, so `.tab` is not answered by
      // `.tabs` — which is the bar itself and has no height of its own.
      const block =
        new RegExp(`^${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'm').exec(AWAY)?.[1] ?? ''
      expect(block, selector).toMatch(/min-height:\s*var\(--tap\)/)
    }
  })

  it('never removes a focus ring but from the one place it is not a control', () => {
    expect(TOKENS).toContain(':focus-visible')
    expect(TOKENS).toContain('outline: 2px solid var(--cyan)')
    // **One exception, named.** A navigation moves focus to the `main`
    // landmark so a screen reader starts at the screen somebody asked for; that
    // is a reading position, not a keyboard landing on a control, and a box
    // drawn round the whole page says nothing. A second `outline: none` fails
    // here until somebody writes its argument beside this one.
    const removed = [...CSS.matchAll(/([^{}]*)\{[^{}]*outline:\s*(?:none|0)\b[^{}]*\}/g)].map(
      (one) => (one[1] ?? '').trim().split('\n').at(-1)?.trim(),
    )
    expect(removed).toEqual(['main[tabindex="-1"]:focus'])
  })

  it('turns every animation and transition off for reduced motion', () => {
    expect(TOKENS).toContain('@media (prefers-reduced-motion: reduce)')
    expect(TOKENS).toMatch(/animation-duration:\s*1ms !important/)
    expect(TOKENS).toMatch(/transition-duration:\s*1ms !important/)
    // And the skeleton never shimmers, which is the one thing that would
    // animate on a page that is otherwise still.
    expect(AWAY).not.toContain('@keyframes')
  })

  it('uses `!important` only where reduced motion needs it', () => {
    for (const found of CSS.matchAll(/[^;{}]*!important/g)) {
      expect(found[0], found[0]).toMatch(/animation|transition|scroll-behavior/)
    }
  })
})

describe('the shell’s own semantics', () => {
  it('has a title, a viewport, and no way to forbid zoom', () => {
    expect(HTML).toContain('<title>')
    expect(HTML).toContain('width=device-width')
    // The layout has to hold at 200% zoom; a page that forbids it is a page
    // that decided for somebody with worse eyes than the author's.
    expect(HTML).not.toContain('maximum-scale')
    expect(HTML).not.toContain('user-scalable')
  })

  it('builds the landmarks, the skip link and one live region', () => {
    const frame = read('shell.js')
    expect(frame).toContain("el('header'")
    expect(frame).toContain("el('nav'")
    expect(frame).toContain("'aria-label': 'Sections'")
    expect(frame).toContain("attrs: { id: 'main' }")
    expect(frame).toContain('skip to what wants you')
    // **One** live region, announcing only what crossed into wanting you.
    // Announcing the snapshot would read the whole page aloud every two
    // seconds, which is worse than announcing nothing.
    expect([...frame.matchAll(/'aria-live'/g)]).toHaveLength(1)
    expect(frame).toContain("'aria-live': 'polite'")
  })

  it('labels every region, so the page is navigable by heading', () => {
    expect(read('rows.js')).toContain("'aria-labelledby': id")
  })

  it('leans on no tooltip, which a phone has no way to show', () => {
    for (const text of SCRIPTS) expect(text).not.toMatch(/\btitle:\s*(?!el)/)
  })

  it('claims no key it does not answer', () => {
    // A key that looks like it works and does not is worse than one that was
    // never offered. There is no search on this page in this phase, so there
    // is no `/` in the sheet and none in the handler.
    const entry = read('boot.js')
    const sheet = read('shell.js')
    const offered = [...sheet.matchAll(/\['(g [a-z]|[jk?] \/ [jk?]|\w+)',/g)].map((one) => one[1])
    expect(offered.length).toBeGreaterThan(4)
    for (const key of offered) {
      if (key === undefined) continue
      const letter = key.startsWith('g ') ? key.slice(2) : key
      expect(entry, `the sheet offers ${key}`).toContain(letter.split(' ')[0] ?? letter)
    }
    expect(sheet).not.toContain("['/',")
  })
})

describe('what no sentence on this page may say', () => {
  it('never promises a network is private, in any file', () => {
    // The same rule `test/separation.test.ts` holds the domain's four sentences
    // to, extended to the browser's files — because a comfortable sentence on
    // the page would undo a careful one in the window.
    for (const [at, text] of [
      ['away.css', AWAY],
      ['index.html', HTML],
    ] as const) {
      for (const word of ['encrypted', 'is secure', 'is private', 'is safe']) {
        expect(text.toLowerCase(), `${at} says ${word}`).not.toContain(word)
      }
    }
    for (const text of SCRIPTS) {
      for (const word of ['encrypted', 'is secure', 'is private', 'is safe']) {
        expect(text.toLowerCase(), `a module says ${word}`).not.toContain(word)
      }
    }
  })

  it('never says a figure nobody recorded is nought', () => {
    for (const text of SCRIPTS) expect(text).not.toContain('$0.00')
  })
})

describe('every token is defined before it is used', () => {
  it('uses none the tokens file does not declare', () => {
    const defined = new Set(
      [...TOKENS.matchAll(/^\s{2}(--[\w-]+):/gm)].map((found) => found[1] ?? ''),
    )
    const used = new Set([...CSS.matchAll(/var\((--[\w-]+)/g)].map((found) => found[1] ?? ''))
    for (const token of used) expect([...defined], `${token} is used`).toContain(token)
  })

  it('declares none it does not use, so the palette is not a wish list', () => {
    const defined = [...TOKENS.matchAll(/^\s{2}(--[\w-]+):/gm)].map((found) => found[1] ?? '')
    const used = new Set([...CSS.matchAll(/var\((--[\w-]+)/g)].map((found) => found[1] ?? ''))
    for (const token of defined) expect([...used], `${token} is declared`).toContain(token)
  })
})
