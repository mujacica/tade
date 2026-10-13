// The workflows page's pure half (`src/assets/pages/workflows-shape.js`),
// declared for `workflows-client.test.ts` — beside `assets.d.ts` rather than
// in it, so the page that owns the module owns its declaration (the pages are
// redesigned one at a time, often by several agents in one checkout). Loose
// for `assets.d.ts`'s reason: a second typed description of a projected row
// would be a second schema that nothing holds to `protocol.ts`.

declare module '*/assets/pages/workflows-shape.js' {
  type Mark = { glyph: string; word: string; tone: string }
  type Part = { key: string; label: string; tone: string; n: number }
  export const STANDINGS: readonly {
    key: string
    label: string
    tone: string
    text: string
    glyph: string
    always: boolean
  }[]
  export const GROUPS: readonly { key: string; heading: string }[]
  export const RUN_MARKS: Record<string, Mark>
  export const MOST_VERSIONS: number
  export const MAP: { dx: number; dy: number; r: number; pad: number }
  export function standingOf(row: any): string
  export function standingMark(key: string): Mark
  export function partsOf(rows: readonly any[]): Part[]
  export function groupsOf(rows: readonly any[]): { key: string; heading: string; rows: any[] }[]
  export function runStandingOf(run: any): string
  export function runsFrom(row: any, runs: readonly any[]): any[]
  export function runsLineOf(
    row: any,
    runs: readonly any[],
  ): { total: number; parts: (Mark & { key: string; n: number })[] }
  export function runsSaid(line: { total: number; parts: readonly any[] }): string
  export function overallOf(
    rows: readonly any[],
    runs: readonly any[],
  ): { workflows: number; parts: Part[]; runs: number; going: number; problems: number }
  export function versionsOf(
    row: any,
    runs?: readonly any[],
  ): {
    marks: { key: string; label: string; kind: string; runs: number; under: string }[]
    earlier: number
  }
  export function versionsSaid(row: any, runs?: readonly any[]): string
  export function shapeOf(places: readonly any[]): {
    dots: { name: string; x: number; y: number }[]
    lines: { from: string; to: string; d: string }[]
    width: number
    height: number
    stages: number
    circular: string[]
  }
  export function shapeSaid(places: readonly any[]): string
  export function stagesOf(row: any): {
    key: string
    n: number | null
    label: string
    heard: string
    steps: { name: string; step: any; waits: readonly any[] }[]
  }[]
  export function graphOf(row: any): {
    nodes: { id: string; label: string; under: string; tone: null; glyph: string; href: null }[]
    edges: { from: string; to: string; tone: null }[]
  }
  export function fitsAcross(
    graph: { nodes: readonly any[]; edges: readonly any[] },
    room: number,
  ): boolean
  export function readinessOf(row: any): { glyph: string; tone: string; said: string }
  export function stepFactsOf(step: any): { label: string; value: string; mono: boolean }[]
  export function fieldLabel(field: any): string
  export function fieldSaid(field: any): string
  export function editorOf(field: any): string
  export function choicesOf(field: any): { value: string; said: string }[]
  export function prefillOf(field: any): string
  export function cutOf(field: any): string
  export function toggleSaid(field: any): string
  export function toggledValue(field: any): string
  type Box = { value: string; was: string | null; saved: string | null; focused: boolean }
  export function boxAfter(box: Box, now: string, rev: string | null): Box
  export function boxDirty(box: Box): boolean
  export function stateOf(
    kind: string,
    heading: string,
    line: string,
  ): { kind: string; icon: string; line: string }
}
