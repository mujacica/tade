// The inbox page's pure half (`src/assets/pages/inbox-shape.js`), declared for
// `inbox-client.test.ts` — beside `assets.d.ts` rather than in it, so the page
// that owns the module owns its declaration. Loose for `assets.d.ts`'s reason:
// a second typed description of a projected row would be a second schema that
// nothing holds to `protocol.ts`.

declare module '*/assets/pages/inbox-shape.js' {
  type Mark = { glyph: string; word: string; tone: string }
  type Stand = 'approve' | 'stuck' | 'moving' | 'done' | 'refused'
  type Action = { word: string; name: string | null; href: string }
  type Request = {
    key: string
    state: string
    stand: Stand
    mark: Mark
    name: string
    named: boolean
    from: string
    project: string
    because: string
    moved: boolean
    waited: number | null
    waitedSaid: string
    starts: string | null
    href: string
    action: Action | null
  }
  type Group = { kind: string; heading: string; n: number; oldestSaid: string; cards: Request[] }
  type Part = { key: Stand; label: string; tone: string; n: number }
  type Door = {
    key: string
    name: string
    state: string
    mark: Mark
    broken: boolean
    when: string | null
    because: string
    facts: string
  }
  type Page = {
    total: number
    waiting: number
    oldestSaid: string | null
    parts: Part[]
    groups: Group[]
    moving: Request[]
    settled: Request[]
    doors: Door[]
  }
  type Pair = [string, string]
  export const STANDS: Record<Stand, { label: string; tone: string }>
  export const KINDS: Record<string, { heading: string }>
  export const DOOR_ORDER: readonly string[]
  export function stateOf(
    kind: string,
    title: string,
    line: string,
    mark?: string,
  ): { kind: string; icon: string; title: string; line: string }
  export function knownIn(store: unknown): (id: string) => boolean
  export function nameOf(row: unknown): string
  export function taskName(id: string): string
  export function standOf(row: unknown): Stand
  export function fromSaid(row: unknown, withId?: boolean): string
  export function startsSaid(would: unknown): string | null
  export function actionOf(row: unknown, known: (id: string) => boolean): Action
  export function heldTaskOf(row: unknown, known: (id: string) => boolean): string | null
  export function chipsOf(
    row: unknown,
    mayWho: boolean,
  ): { key: string; said: string; mono: boolean }[]
  export function approveWhy(
    row: unknown,
    here: boolean,
    standing: { kind: string; why?: string },
  ): string
  export function requestOf(row: unknown, asOf: number, known?: (id: string) => boolean): Request
  export function groupsOf(cards: readonly Request[]): Group[]
  export function doorOf(row: unknown, asOf: number, now: number): Door
  export function byDoor<T extends { state: string; source: string }>(sources: readonly T[]): T[]
  export function doorsOf(sources: readonly unknown[], asOf: number, now: number): Door[]
  export function inboxPage(
    rows: readonly unknown[],
    sources: readonly unknown[],
    asOf: number,
    now: number,
    known?: (id: string) => boolean,
  ): Page
  export function figureSaid(page: Page | null): { word: string; tone: string | null }
  export function heroSaid(page: Page): { label: string; under: string | null }
  export function calmSaid(page: Page): string
  export function groupSaid(group: Group): string
  export function settledSaid(n: number, open: boolean): string
  export function emptySays(sources: readonly unknown[]): string
  export function troubleOf<T extends { state: string }>(sources: readonly T[]): T | undefined
  export function provenanceOf(row: unknown, may: boolean): Pair[]
  export function factsSplit(pairs: readonly Pair[], row: unknown): { first: Pair[]; more: Pair[] }
  export function standingOfRequest(
    row: unknown,
    asOf: number,
  ): {
    mark: Mark
    word: string
    wash: 'wants' | 'failed' | null
    arrived: string
    moved: string | null
  }
  export function workOf(
    one: unknown,
    known?: (id: string) => boolean,
  ): { key: string; name: string; mark: Mark; says: string; href: string | null }
  export function workSaid(one: unknown): string
  export function runHref(row: unknown): string | null
  export function unsentSaid(one: unknown): { said: string; why: string }
}
