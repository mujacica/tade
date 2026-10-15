import { describe, expect, it } from 'vitest'
import {
  anchorOf,
  byDestination,
  forAgent,
  forTade,
  HUNK_REACH,
  hunkFor,
  type LineComment,
  saidOf,
  withComment,
} from '../src/comments.ts'
import { parseDiff } from '../src/diff.ts'
import { THEIR_WORDS, withNews } from '../src/inbox.ts'

const patch = parseDiff(
  [
    'diff --git a/src/pay.ts b/src/pay.ts',
    '--- a/src/pay.ts',
    '+++ b/src/pay.ts',
    '@@ -10,4 +10,5 @@ export function pay() {',
    '   const a = 1',
    '-  const b = 2',
    '+  const b = 3',
    '+  const c = 4',
    '   return a + b',
    '@@ -40,2 +41,2 @@',
    '-  old()',
    '+  fresh()',
  ].join('\n'),
)

const comment = (over: Partial<LineComment> = {}): LineComment => ({
  task: 'shop/pay',
  path: 'src/pay.ts',
  line: 11,
  side: 'new',
  hunk: ['@@ -10,4 +10,5 @@ export function pay() {', '+  const b = 3'],
  words: 'why three?',
  to: 'tade',
  ...over,
})

describe('the hunk a comment carries', () => {
  it('is the hunk its line is in, heading and all, and not the next one', () => {
    expect(hunkFor(patch, { side: 'new', git: 12 }, 'ignored')).toEqual([
      '@@ -10,4 +10,5 @@ export function pay() {',
      '   const a = 1',
      '-  const b = 2',
      '+  const b = 3',
      '+  const c = 4',
      '   return a + b',
    ])
  })

  it('finds a line taken out by the number it had before', () => {
    expect(hunkFor(patch, { side: 'old', git: 40 }, 'ignored')).toEqual([
      '@@ -40,2 +41,2 @@',
      '-  old()',
      '+  fresh()',
    ])
  })

  it('is the line alone where git drew no hunk round it, or was never asked', () => {
    expect(hunkFor(patch, { side: 'new', git: 3 }, '  const z = 0')).toEqual(['   const z = 0'])
    expect(hunkFor(patch, { side: 'new', git: null }, 'typed since')).toEqual([' typed since'])
    expect(hunkFor(null, { side: 'new', git: 11 }, 'x')).toEqual([' x'])
  })

  it('is cut to what the line is next to, in a hunk of hundreds', () => {
    const body = Array.from({ length: 200 }, (_, i) => `+line ${i + 1}`)
    const long = parseDiff(['@@ -1,0 +1,200 @@', ...body].join('\n'))
    const hunk = hunkFor(long, { side: 'new', git: 100 }, '')
    expect(hunk[0]).toBe('@@ -1,0 +1,200 @@')
    expect(hunk).toHaveLength(1 + 2 * HUNK_REACH + 1)
    expect(hunk).toContain('+line 100')
  })
})

describe('a review’s comments', () => {
  it('keep one comment a line: writing again replaces it, writing nothing takes it back', () => {
    const one = withComment([], comment())
    const changed = withComment(one, comment({ words: 'why three, not two?' }))
    expect(changed.map((c) => c.words)).toEqual(['why three, not two?'])
    expect(withComment(changed, comment({ words: '  ' }))).toEqual([])
    // Another side of the same number is another line.
    expect(withComment(one, comment({ side: 'old' }))).toHaveLength(2)
  })

  it('go by destination, each group in the order it was written', () => {
    const groups = byDestination([
      comment({ line: 1 }),
      comment({ line: 2, to: { agent: 'shop/pay' } }),
      comment({ line: 3 }),
      comment({ line: 4, to: { agent: 'shop/pay' } }),
    ])
    expect(groups.map((g) => [g.to, g.comments.map((c) => c.line)])).toEqual([
      ['tade', [1, 3]],
      [{ agent: 'shop/pay' }, [2, 4]],
    ])
  })
})

describe('what the orchestrator is handed', () => {
  it('puts only their words under their heading, and the hunk above it as Tade’s', () => {
    const { about, words } = forTade([comment()])
    expect(words).toBe('why three?')
    expect(about).toContain('src/pay.ts:11 — on shop/pay’s change')
    expect(about).toContain('+  const b = 3')
    // Composed the way the window composes a turn: everything an agent wrote
    // is above the heading, so `unwrapped` and the orchestrator read only the
    // person's words as theirs.
    const message = withNews(words, [], () => '', THEIR_WORDS, about)
    const [above, below] = message.split(`\n${THEIR_WORDS}\n`)
    expect(above).toContain('const b = 3')
    expect(below).toBe('why three?')
  })

  it('numbers several so each set of words is found beside its line, and keeps the words exact', () => {
    const odd = '  keep   my\tspacing  '
    const { about, words } = forTade([comment(), comment({ line: 41, words: odd })])
    expect(words).toBe(`[1] why three?\n[2] ${odd}`)
    expect(about).toContain('[1] src/pay.ts:11')
    expect(about).toContain('[2] src/pay.ts:41')
  })

  it('says a line taken out is one, and fences a hunk no backtick in it can close', () => {
    const fenced = forTade([comment({ side: 'old', hunk: ['-```js', '-x'] })]).about
    expect(anchorOf({ path: 'a.md', line: 4, side: 'old' })).toBe('a.md:4 (a line taken out)')
    expect(fenced).toContain('````diff\n-```js\n-x\n````')
  })
})

describe('what an agent is told', () => {
  it('has each anchor, its hunk and the words as written, and says whose change another one is', () => {
    const text = forAgent(
      [comment(), comment({ task: 'shop/cart', path: 'src/cart.ts', line: 3, words: 'and here' })],
      'shop/pay',
    )
    expect(text).toContain('src/pay.ts:11\n```diff')
    expect(text).toContain('```\nwhy three?')
    expect(text).toContain('src/cart.ts:3 — on shop/cart’s change')
    expect(text).not.toContain('src/pay.ts:11 — on')
    expect(text).toContain('```\nand here')
  })

  it('and the conversation shows what was sent to Tade by line', () => {
    expect(saidOf([comment(), comment({ line: 12, words: 'and c?' })])).toBe(
      'src/pay.ts:11 · why three?\nsrc/pay.ts:12 · and c?',
    )
  })
})
