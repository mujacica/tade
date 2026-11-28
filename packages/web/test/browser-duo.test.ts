import { describe, expect, it } from 'vitest'
import { duo } from '../scripts/browser-duo.ts'
import { ROUTES } from '../src/routes.ts'
import { DUO, DUO_LOOKS, insetsAsVars } from './browser-duo-plan.ts'

// The Duo harness's plan, held offline: the four screens the phone reports,
// pages the server actually serves, the stylesheets' insets answered as the
// harness answers them — and no browser meaning `unrun`, never a pass.

describe('the Duo plan', () => {
  it('has both screens both ways up, at the phone’s @3x pixels over three', () => {
    const sizes = Object.fromEntries(DUO.map((one) => [one.name, [one.width, one.height]]))
    expect(sizes).toEqual({
      'outer-upright': [466, 678],
      'outer-landscape': [2034 / 3, 1398 / 3],
      'inner-upright': [669, 951],
      'inner-landscape': [2853 / 3, 2007 / 3],
    })
  })

  it('keeps the camera column, the status bar and the home indicator where the phone does', () => {
    const insets = Object.fromEntries(DUO.map((one) => [one.name, one.insets]))
    expect(insets['outer-landscape']).toEqual({ top: 0, right: 0, bottom: 34, left: 84 })
    expect(insets['outer-upright']).toEqual({ top: 84, right: 0, bottom: 34, left: 0 })
    expect(insets['inner-landscape']?.bottom).toBe(21)
    expect(insets['inner-upright']?.bottom).toBe(34)
    // A keyboard always leaves room for the box and something above it.
    for (const one of DUO) expect(one.height - one.keyboard).toBeGreaterThan(200)
  })

  it('looks at pages the machine serves, among them every one the person named', () => {
    const served = ROUTES.filter((route) => route.document === true).map(
      (route) => new RegExp(`^${route.path.replace(/:[a-z]+/g, '[^/]+')}$`),
    )
    for (const look of DUO_LOOKS) {
      expect(
        served.some((one) => one.test(look.path)),
        look.path,
      ).toBe(true)
    }
    const named = DUO_LOOKS.map((look) => look.name)
    for (const page of [
      'pairing',
      'overview',
      'agent',
      'queue',
      'plans',
      'plan',
      'spend',
      'findings',
      'notes',
      'talk-keyboard',
      'settings',
    ]) {
      expect(named).toContain(page)
    }
  })
})

describe('the insets, as the harness answers a stylesheet', () => {
  it('turns every inset into the property the harness sets, and nothing else', () => {
    const css = [
      'a { padding: env(safe-area-inset-top) env( safe-area-inset-right ); }',
      'b { bottom: calc(1px + env(safe-area-inset-bottom, 0px)); }',
      'c { left: env(safe-area-inset-left, calc(1px + 2px)); color: red; }',
    ].join('\n')
    expect(insetsAsVars(css)).toBe(
      [
        'a { padding: var(--duo-inset-top, 0px) var(--duo-inset-right, 0px); }',
        'b { bottom: calc(1px + var(--duo-inset-bottom, 0px)); }',
        'c { left: var(--duo-inset-left, 0px); color: red; }',
      ].join('\n'),
    )
  })
})

describe('with no browser', () => {
  it('says unrun with the reason, and never pass', async () => {
    const found = await duo(null, 'playwright is not installed on this machine')
    expect(found).toEqual([
      {
        check: 'duo',
        where: '—',
        verdict: 'unrun',
        said: 'playwright is not installed on this machine',
      },
    ])
  })
})

describe('the full view’s sizes', () => {
  it('are the Duo’s six and two slab phones each way up, inside their own insets', async () => {
    const { FULL_SIZES } = await import('./browser-full-plan.ts')
    expect(FULL_SIZES.filter((one) => one.name.startsWith('duo-'))).toHaveLength(6)
    const slabs = FULL_SIZES.filter((one) => one.name.startsWith('slab-'))
    expect(slabs).toHaveLength(4)
    for (const one of slabs.filter((size) => size.name.endsWith('-upright'))) {
      const turned = slabs.find((size) => size.name === one.name.replace('-upright', '-sideways'))
      expect([turned?.width, turned?.height], one.name).toEqual([one.height, one.width])
    }
    // The two the plan names a number for, and the one that folds.
    const named = FULL_SIZES.filter((one) => one.columns !== undefined).map((one) => one.name)
    expect(named).toEqual(['duo-outer-sideways', 'duo-inner-sideways', 'duo-outer-safari-sideways'])
    expect(FULL_SIZES.filter((one) => one.fold).map((one) => one.name)).toEqual([
      'duo-inner-sideways',
    ])
    // The Duo's four Home Screen sizes are the overview harness's own.
    for (const screen of DUO) {
      const same = FULL_SIZES.find(
        (one) => one.width === screen.width && one.height === screen.height,
      )
      expect(same?.insets, screen.name).toEqual(screen.insets)
    }
  })
})
