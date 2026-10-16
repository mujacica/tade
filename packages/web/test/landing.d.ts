// The landing desk's pure half (`src/assets/pages/landing-shape.js`), declared
// for `landing-client.test.ts` — beside `assets.d.ts` rather than in it, so the
// page that owns the module owns its declaration. Loose for `assets.d.ts`'s
// reason: a second typed description of a projected row would be a second
// schema that nothing holds to `protocol.ts`.

declare module '*/assets/pages/landing-shape.js' {
  type Tier = 'ready' | 'yours' | 'theirs'
  type Fact = { label: string; value: string | null; tone?: string | null; under?: string }
  type Card = {
    id: string
    project: string
    name: string
    href: string
    words: string | null
    tier: Tier
    mark: { glyph: string; word: string; tone: string }
    why: string
    also: string | null
    review: string | null
    waitedSaid: string | null
    ageLabel: string | null
    facts: Fact[]
  }
  type Page = {
    total: number
    groups: Record<Tier, Card[]>
    parts: { key: Tier; label: string; tone: string; n: number }[]
  }
  type State = { kind: string; icon: string; title: string; line: string } | null
  export const TIERS: Record<Tier, { heading: string; word: string; glyph: string; tone: string }>
  export function onDesk(tasks: readonly unknown[]): unknown[]
  export function checksSaid(task: unknown): Omit<Fact, 'label'>
  export function findingsSaid(found: unknown): Omit<Fact, 'label'>
  export function conflictsSaid(conflicts: unknown): Omit<Fact, 'label'>
  export function sizeSaid(size: unknown): Omit<Fact, 'label'>
  export function cardOf(
    task: unknown,
    asOf: number,
    opts?: { frozen?: boolean; spend?: boolean },
  ): Card
  export function deskPage(
    tasks: readonly unknown[],
    asOf: number,
    opts?: { frozen?: boolean; spend?: boolean },
  ): Page
  export function figureSaid(page: Page | null): { word: string; tone: string | null }
  export function leadSaid(page: Page): string
  export function wholeOf(had: boolean, shut: boolean, granted: boolean, page: Page | null): State
}
