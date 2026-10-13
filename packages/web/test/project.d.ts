// The project page's pure half (`src/assets/pages/project-shape.js`), declared
// for `project-client.test.ts` — beside `assets.d.ts` rather than in it, so the
// page that owns the module owns its declaration (the pages are redesigned one
// at a time, often by several agents in one checkout). Loose for
// `assets.d.ts`'s reason: a second typed description of a projected row would
// be a second schema that nothing holds to `protocol.ts`.

declare module '*/assets/pages/project-shape.js' {
  type Part = { key: string; label: string; tone: string; n: number }
  /** A projected row, as loose as the page reads it. */
  type Row = { id: string; name: string; key: string; [field: string]: unknown }
  export const AGENT_PARTS: readonly {
    key: string
    label: string
    tone: string
    marks: readonly string[]
  }[]
  export const TOP: number
  export function partOf(task: unknown): string
  export function agentsOf(tasks: readonly Row[]): { live: Row[]; over: Row[]; all: Row[] }
  export function ringOf(agents: readonly Row[]): { parts: Part[]; n: number; stalled: number }
  export function wantsOf(store: unknown, project: string): { rows: Row[]; n: number; said: string }
  export function failedOf(tasks: readonly Row[]): Row[]
  export function checksOf(agents: readonly Row[]): {
    pass: number
    fail: number
    unknown: number
    total: number
    red: Row[]
    unrun: Row[]
    green: Row[]
    figure: string
    tone: string | null
    parts: Part[]
  }
  export function queueOf(rows: readonly Row[]): {
    n: number
    ready: number
    figure: string
    parts: Part[]
  }
  export function checkSaid(checks: {
    state: string
    failed: readonly string[]
    missing: readonly string[]
    overridden: boolean
  }): string
  export function outlineOf(
    tree: readonly { row: Row; children: readonly unknown[] }[],
  ): { row: Row; depth: number }[]
  export function waitsOn(row: unknown): string[]
  export function shortName(id: string, project: string): string
  export function graphOf(
    store: unknown,
    project: string,
    clock?: (at: string) => string,
  ): {
    nodes: { id: string; label: string; under: string; tone: string; glyph: string; href: string }[]
    edges: { from: string; to: string; tone: string | null }[]
  }
  export function branchesOf(agents: readonly Row[]): {
    live: {
      id: string
      branch: string
      ahead: number | null
      behind: number | null
      dirty: number | null
      review: string | null
      offered: boolean
    }[]
    over: Row[]
    ahead: number
    unknown: number
    most: number
    figure: string
    said: string
    parts: Part[]
  }
  export function armOf(n: number | null, most: number): number
  export function reviewOf(one: {
    review: string | null
    ahead: number | null
  }): { word: string; tone: string } | null
  export function spentSaid(spend: unknown): string | null
  export function branchSaid(one: {
    ahead: number | null
    behind: number | null
    dirty: number | null
  }): string
  export function findingPart(finding: unknown): string
  export function findingsIn(
    store: unknown,
    project: string,
  ): {
    may: boolean
    live: Row[]
    over: Row[]
    n: number
    figure: string | null
    tone: string | null
    parts: Part[]
  }
  export function moneyOf(
    store: unknown,
    project: string,
  ): {
    granted: boolean
    value: string | null
    why: string
    since: string | null
    tokens: string | null
    unpriced: string | null
    exact: string | null
    estimated: string | null
    plan: { said: string; floor: boolean; why: string } | null
    unreported: number
    partial: boolean
    top: { key: string; label: string; value: number; said: string; href: string; tone: string }[]
  }
  export function partsSaid(...parts: readonly (readonly [number, string, string?])[]): string
}
