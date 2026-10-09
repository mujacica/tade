// The contract the browser's copy of a rule must satisfy.
//
// `tsc` has no declarations for a `.js` file and `allowJs` is off — turning it
// on would pull the away view's modules into the program, and they reach
// `document`, `location` and `EventSource`, none of which are in this
// repository's `lib`. A `.d.ts` beside the asset is not an option either:
// `src/assets/` is served, and a file of a kind nothing can serve fails
// `assets.test.ts`.
//
// So the shape lives here, in the test folder, which is the right place for
// it: it is not a type the program uses, it is the **contract a test holds two
// copies of one rule to**. `client.test.ts` runs the same table through this
// and through `src/stream.ts` and asserts they agree, so a change to either
// copy that does not change the other fails.
//
// Only the modules a test imports are declared. The ones that build DOM are
// not declared and not imported: what they do is checked in a browser
// (`scripts/browser.ts`) and over their own text (`design.test.ts`), because a
// type declaration for a renderer is a second description of it that nothing
// holds to the first.

type Connection =
  | { kind: 'live'; sinceAt: number }
  | { kind: 'stale'; sinceAt: number }
  | { kind: 'unreachable'; sinceAt: number }
  | { kind: 'closed'; why: string }

declare module '*/assets/live.js' {
  export const STALE_AFTER_MS: number
  export const BACKOFF_MS: readonly number[]
  export const GIVEN_UP_AFTER: number
  export function backoffAt(tries: number): number
  export function connectionOf(
    seen: { open: boolean; lastAt: number; ended: string | null },
    now: number,
  ): Connection
  /** `live | stale | reconnecting | unreachable | closed`. */
  export function standingOf(connection: unknown, tries?: number): string
  export function partsOf(
    standing: string,
    connection: unknown,
    at: string,
    now: number,
    tight?: boolean,
  ): { glyph: string; words: string }
}

declare module '*/assets/figures.js' {
  export const PLAN_WARM: number
  export const PLAN_TIGHT: number
  export const SEGMENTS: number
  export function planPressure(used: number): string
  export function duration(ms: number): string
  export function pricedOf(spend: unknown): string
  export function onPlanOf(spend: unknown): string
  export function money(
    spend: unknown,
    granted?: boolean,
  ): { said: string; mark: string; why: string }
  export function onPlan(spend: unknown): { said: string; floor: boolean; why: string } | null
  export function tokens(count: number): string
  export function tokensSaid(spend: unknown): { said: string; unpriced: string } | null
  export function planBar(used: number): { bar: string; said: string; pressure: string }
  export function count(n: number): string
  export function ageSaid(at: string | null, asOf: number, frozen?: boolean): string | null
  export function clockOf(at: string): string
  export function shortClockOf(at: string): string
  export function untilSaid(at: string | null, now: number): string | null
}

interface Mark {
  glyph: string
  word: string
  tone: string
}

declare module '*/assets/glyphs.js' {
  export const TASK_STATES: Readonly<Record<string, Mark>>
  export const CHECK_STATES: Readonly<Record<string, Mark>>
  export const REVIEW_STATES: Readonly<Record<string, Mark>>
  export const FRESH_MARKS: Readonly<Record<string, Mark>>
  export function taskMark(state: string): Mark
  export function checkMark(state: string): Mark
  export function reviewMark(state: string): Mark
  export function findingMark(finding: unknown): Mark
  export function queueMark(state: unknown): Mark
  export function freshMark(kind: string): Mark
  export function joined(items: readonly string[]): string
  export function queueSaid(state: unknown, clock: (at: string) => string): string
  export function originSaid(origin: { kind: string; name: string }): string
}

declare module '*/assets/routes.js' {
  export const TITLES: Readonly<Record<string, string>>
  export const NAV: readonly { view: string; mark: string; label: string; counts: string | null }[]
  export const MORE: readonly { view: string; mark: string; label: string; counts: string | null }[]
  export function viewOf(path: string): { view: string; project?: string; task?: string }
  export function pathOf(where: { view: string; project?: string; task?: string }): string
  export function taskPath(id: string): string
  export function navFor(where: { view: string }): string
  export function safeHref(url: unknown): string | null
}

declare module '*/assets/store.js' {
  export const SPEAKS: number
  export const GRANTS: readonly string[]
  /**
   * Deliberately loose. These declarations exist so a test can *call* the
   * browser's copy of a rule; the shapes themselves are `protocol.ts`'s, and a
   * second typed description of them here would be a second schema that
   * nothing holds to the first.
   */
  export type Store = Record<string, any>
  export function emptyStore(): Store
  export function applySnapshot(store: Store, snapshot: unknown): string | null
  export function applyDelta(store: Store, delta: unknown): string | null
  export function rowsOf(store: Store, collection: string): readonly any[]
  export function wantsYou(store: Store): readonly any[]
  export function wantingIds(store: Store): Set<string>
  export function projectsOf(store: Store): readonly any[]
  export function tasksIn(store: Store, project: string): readonly any[]
  export function taskAt(store: Store, project: string, name: string): any
  export function projectAt(store: Store, name: string): any
  export function queueIn(store: Store, project: string | null): readonly any[]
  export function notesOf(store: Store): readonly any[]
  export function findingsOf(store: Store): readonly any[]
  export function plansOf(store: Store): readonly any[]
  export function spendFold(tasks: readonly any[], partial?: boolean): Record<string, any>
  export function checksFold(tasks: readonly any[]): Record<string, any>
  export function checksWord(fold: Record<string, any>): string
  export function reviewsOf(store: Store): { offered: readonly any[]; unoffered: readonly any[] }
  export function mayRead(store: Store, grant: string): boolean
  export function omitted(store: Store, collection: string): number
  export function asOf(store: Store, kind: string, now: number): { at: number; frozen: boolean }
}

declare module '*/assets/shell.js' {
  export function barsFor(
    standing: string,
    connection: unknown,
    store: unknown,
    now: number,
    tries: number,
    extra?: readonly unknown[],
  ): { key: string; glyph: string; lead: string; under?: string; tone?: string }[]
  export function crossing(was: Set<string> | null, is: Set<string>): string
  export function titleFor(where: { view: string; project?: string; task?: string }): string
}
