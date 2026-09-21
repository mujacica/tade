import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { extentOf, hitAt, hitBoxAt, rowHit, sameTarget } from '../src/hits.ts'
import { COLOUR, PLAIN } from '../src/skin.ts'
import { box, overlay, Row, slid, stack } from '../src/ui.ts'

// Where things are, which is the whole of what a click can know.
//
// The rule these tests exist for: a control is clickable exactly where it is
// drawn, with or without colour. Positions come from the text a control draws
// before it is painted, so painting cannot move the next control's target by
// the length of an escape code.

const plain = (text: string) =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

describe('a row of controls', () => {
  it('puts each button where its label is drawn', () => {
    const { text, hits } = new Row(60, PLAIN)
      .space()
      .button('New task', { kind: 'action', name: 'new-agent' })
      .space()
      .button('Settings', { kind: 'action', name: 'settings' })
      .build()
    expect(visibleWidth(text)).toBe(60)
    const [first, second] = hits
    expect(text.slice(first?.from, (first?.to ?? 0) + 1)).toBe('[ New task ]')
    expect(text.slice(second?.from, (second?.to ?? 0) + 1)).toBe('[ Settings ]')
  })

  it('is narrower as a chip than as a button, painted or not', () => {
    // A chip is the same block two columns in: small enough to sit beside a
    // button without reading as one, and the same width with any skin.
    const build = (skin: typeof PLAIN) =>
      new Row(30, skin)
        .chip('◉', { kind: 'action', name: 'toggle-done' })
        .button(' + ', { kind: 'action', name: 'new-agent' }, 'add')
        .build()
    const coloured = build(COLOUR)
    const bare = build(PLAIN)
    expect(coloured.hits).toEqual(bare.hits)
    const [chip, button] = bare.hits
    expect(bare.text.slice(chip?.from, (chip?.to ?? 0) + 1)).toBe('[◉]')
    expect((chip?.to ?? 0) - (chip?.from ?? 0)).toBeLessThan(
      (button?.to ?? 0) - (button?.from ?? 0),
    )
  })

  it('lays out identically in colour and without it', () => {
    const build = (skin: typeof PLAIN) =>
      new Row(80, skin)
        .button('Allow once', { kind: 'action', name: 'approve' }, 'attention')
        .space()
        .tab('checkout', { kind: 'project', project: 'checkout' }, true)
        .keys(['ctrl', 'space'])
        .field('what needs doing', 24, { caret: true })
        .toggle(true, { kind: 'control', id: 'speak' })
        .right((r) => r.text('$2.66', (t) => t, { kind: 'action', name: 'spend' }))
        .build()
    const coloured = build(COLOUR)
    const bare = build(PLAIN)
    expect(coloured.hits).toEqual(bare.hits)
    expect(visibleWidth(coloured.text)).toBe(80)
    expect(plain(coloured.text).length).toBe(plain(bare.text).length)
  })

  it('pins the right group to the edge, and drops it before it overlaps', () => {
    const roomy = new Row(40, PLAIN)
      .text('left')
      .right((r) => r.text('right'))
      .build()
    expect(roomy.text.endsWith('right')).toBe(true)
    const cramped = new Row(8, PLAIN)
      .text('left side')
      .right((r) => r.text('right'))
      .build()
    expect(cramped.text).not.toContain('right')
    expect(visibleWidth(cramped.text)).toBe(8)
  })

  it('never reports a click past its own edge', () => {
    const { hits } = new Row(10, PLAIN)
      .button('a very long label', { kind: 'action', name: 'x' })
      .build()
    for (const hit of hits) expect(hit.to).toBeLessThan(10)
  })

  it('keeps the end of a long field in view, because that is where you type', () => {
    const { text } = new Row(20, PLAIN)
      .field('refunds are charged twice when retried', 20, { caret: true })
      .build()
    expect(text).toContain('retried▏')
    expect(visibleWidth(text)).toBe(20)
  })

  it('looks pressed while held and hovered under the pointer', () => {
    const target = { kind: 'action' as const, name: 'new-agent' }
    const rest = new Row(30, COLOUR).button('New task', target).build().text
    const hover = new Row(30, COLOUR, { hover: target, pressed: null })
      .button('New task', target)
      .build().text
    const pressed = new Row(30, COLOUR, { hover: target, pressed: target })
      .button('New task', target)
      .build().text
    expect(new Set([rest, hover, pressed]).size).toBe(3)
  })
})

describe('boxes and overlays', () => {
  const window = stack(
    Array.from({ length: 10 }, (_, i) =>
      new Row(40, PLAIN).text(`row ${i}`, (t) => t, { kind: 'task', task: `t${i}` }).build(),
    ),
  )
  const panel = box(
    'New task',
    [new Row(18, PLAIN).button('Go', { kind: 'control', id: 'go' }).build()],
    20,
    PLAIN,
    { corner: 'esc' },
  )

  it('swallows every click inside a panel that no control uses', () => {
    const drawn = overlay(window, panel, { row: 2, col: 5 }, 40, PLAIN, true)
    expect(hitAt(drawn.hits, 6, 2)).toEqual({ kind: 'inert' })
    expect(hitAt(drawn.hits, 7, 3)).toEqual({ kind: 'control', id: 'go' })
  })

  it('turns everything outside a modal into closing it', () => {
    const drawn = overlay(window, panel, { row: 2, col: 5 }, 40, PLAIN, true)
    expect(hitAt(drawn.hits, 0, 0)).toEqual({ kind: 'dismiss' })
    expect(hitAt(drawn.hits, 30, 9)).toEqual({ kind: 'dismiss' })
  })

  it('leaves what is underneath clickable when it is not modal', () => {
    const drawn = overlay(window, panel, { row: 2, col: 5 }, 40, PLAIN, false)
    expect(hitAt(drawn.hits, 0, 0)).toEqual({ kind: 'task', task: 't0' })
  })

  it('keeps every row exactly as wide as the window', () => {
    const drawn = overlay(window, panel, { row: 2, col: 25 }, 40, COLOUR, true)
    for (const row of drawn.rows) expect(visibleWidth(row)).toBe(40)
  })
})

describe('hitAt', () => {
  it('answers with what is on top, because that is what you clicked', () => {
    const under = rowHit(1, 20, { kind: 'orchestrator' })
    const over = { row: 1, from: 2, to: 5, target: { kind: 'file' as const, path: 'src/' } }
    expect(hitAt([under, over], 3, 1)).toEqual(over.target)
    expect(hitAt([under, over], 9, 1)).toEqual(under.target)
    expect(hitAt([], 0, 0)).toBeNull()
  })

  it('hands back the hit itself for what cares how far along it you clicked', () => {
    const row = { row: 1, from: 8, to: 40, target: { kind: 'caret' as const, line: 3 } }
    expect(hitBoxAt([row], 12, 1)?.from).toBe(8)
    expect(hitBoxAt([row], 2, 1)).toBeNull()
  })

  it('compares targets by what they are', () => {
    expect(sameTarget({ kind: 'task', task: 'a' }, { kind: 'task', task: 'a' })).toBe(true)
    expect(sameTarget({ kind: 'task', task: 'a' }, { kind: 'task', task: 'b' })).toBe(false)
    expect(sameTarget(null, null)).toBe(true)
  })
})

describe('a window onto rows wider than the room', () => {
  const laid = () => [
    new Row(40, PLAIN)
      .space(2)
      .text('╰─', (t) => t)
      .text('refund-emails', (t) => t, { kind: 'task', task: 'checkout/refund-emails' })
      .build(),
  ]

  it('shows the left of them when nothing is scrolled past, cut to the room', () => {
    const [row] = slid(laid(), 0, 12)
    expect(visibleWidth(row?.text ?? '')).toBe(12)
    expect(plain(row?.text ?? '')).toBe('  ╰─refund-e')
  })

  it('slides the text and what can be clicked in it by the same columns', () => {
    const [here] = slid(laid(), 0, 20)
    const [moved] = slid(laid(), 2, 20)
    expect(plain(here?.text ?? '').trimEnd()).toBe('  ╰─refund-emails')
    expect(plain(moved?.text ?? '').trimEnd()).toBe('╰─refund-emails')
    const before = here?.hits.find((hit) => hit.target.kind === 'task')
    const after = moved?.hits.find((hit) => hit.target.kind === 'task')
    expect((before?.from ?? 0) - (after?.from ?? 0)).toBe(2)
    // A name still goes to its work, wherever the window has been dragged to,
    // and what has half slid off keeps the half you can still see.
    const far = slid(laid(), 6, 20)[0]
    expect(far?.hits.find((hit) => hit.target.kind === 'task')?.from).toBe(0)
    expect(hitAt(far?.hits ?? [], 0, 0)).toEqual({
      kind: 'task',
      task: 'checkout/refund-emails',
    })
  })

  it('drops what has slid off the edge rather than offering a click off the pane', () => {
    const [gone] = slid(laid(), 30, 10)
    expect(plain(gone?.text ?? '').trim()).toBe('')
    for (const hit of gone?.hits ?? []) {
      expect(hit.from).toBeGreaterThanOrEqual(0)
      expect(hit.to).toBeLessThan(10)
    }
  })

  it('reads a bar lying down back out of the map by its columns', () => {
    const bar = { kind: 'scrollbar' as const, area: 'sidebar' as const, total: 60, shown: 20 }
    const hits = [{ row: 9, from: 0, to: 19, target: bar }]
    expect(extentOf(hits, bar)).toEqual({ top: 9, rows: 1 })
    expect(extentOf(hits, bar, true)).toEqual({ top: 0, rows: 20 })
  })
})
