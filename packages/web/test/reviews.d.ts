// The reviews page's pure half (`src/assets/pages/reviews-shape.js`), declared
// for `reviews-client.test.ts` — beside `assets.d.ts` rather than in it, so the
// page that owns the module owns its declaration. Loose for `assets.d.ts`'s
// reason: a second typed description of a projected row would be a second
// schema that nothing holds to `protocol.ts`.

declare module '*/assets/pages/reviews-shape.js' {
  type Hold = 'you' | 'red' | 'draft' | 'unchecked' | 'ready'
  type Mark = { glyph: string; word: string; tone: string }
  type Cell = { key: string; name: string; glyph: string; word: string; tone: string }
  type Checks = {
    state: 'pass' | 'fail' | 'unknown'
    cells: Cell[]
    line: string
    said: string
    overruled: boolean
  }
  type Card = {
    id: string
    project: string
    name: string
    href: string
    words: string | null
    hold: Hold | 'settled' | null
    holdMark: Mark & { label?: string }
    because: string
    review: string | null
    reviewMark: Mark
    forge: { href: string; number: string | null } | null
    agent: Mark
    checks: Checks
    branch: string | null
    distance: string | null
    since: string | null
    waited: number | null
    waitedSaid: string | null
    asksYou: boolean
  }
  type Part = { key: Hold; label: string; tone: string; n: number }
  type Page = {
    total: number
    open: number
    counts: Record<Hold, number>
    parts: Part[]
    held: number
    you: Card[]
    blocked: Card[]
    ready: Card[]
    unoffered: Card[]
    settled: Card[]
    merged: number
    closed: number
  }
  export const HOLDS: Record<Hold, { label: string; glyph: string; word: string; tone: string }>
  export const CELLS: Record<
    'fail' | 'none' | 'pass' | 'unread',
    { glyph: string; word: string; tone: string }
  >
  export function textTone(tone: string): string
  export function holdOf(task: any): Hold | 'settled' | null
  export function checksRowOf(checks: any): Checks
  export function forgeOf(review: any): { href: string; number: string | null } | null
  export function aheadSaid(ahead: number | null, behind: number | null): string | null
  export function reviewOf(task: any, asOf: number, frozen?: boolean): Card
  export function reviewsPage(
    offered: readonly any[],
    unoffered: readonly any[],
    asOf: number,
    frozen?: boolean,
  ): Page
  export function figureSaid(page: Page | null): { word: string; tone: string | null }
  export function leadSaid(page: Page): string
  export function heldSaid(page: Page): string
  export function stagesOf(page: Page): {
    before: { n: number; under: string }
    after: { n: number; under: string }
  }
  export function rowLine(card: Card): string
  export function settledSaid(n: number, open: boolean): string
  export function omittedSaid(omitted: number): string | null
}
