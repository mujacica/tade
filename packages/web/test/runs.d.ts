// The runs page's pure half (`src/assets/pages/runs-shape.js`), declared for
// `runs-client.test.ts` — beside `assets.d.ts` rather than in it, so the page
// that owns the module owns its declaration (the pages are redesigned one at a
// time, often by several agents in one checkout). Loose for `assets.d.ts`'s
// reason: a second typed description of a projected row would be a second
// schema that nothing holds to `protocol.ts`.

declare module '*/assets/pages/runs-shape.js' {
  type Part = { key: string; label: string; tone: string; n: number }
  type Mark = { glyph: string; word: string; tone: string }
  export const PARTS: readonly {
    key: string
    label: string
    tone: string
    text: string
    glyph: string
    always: boolean
  }[]
  export const GROUPS: readonly { key: string; heading: string }[]
  export const STANDINGS: Record<string, Mark & { group: string }>
  export const MAP: { dx: number; dy: number; r: number; pad: number }
  export function partOf(step: any): string
  export function partMark(part: string): Mark
  export function partsOf(steps: readonly any[]): Part[]
  export function toneOfPart(part: string): string
  export function graphOf(
    row: any,
    names?: Map<string, string>,
  ): {
    nodes: { id: string; label: string; under: string; tone: string; glyph: string; href: string }[]
    edges: { from: string; to: string; tone: string }[]
  }
  export function standingOf(run: any): string
  export function runMark(run: any): Mark
  export function groupsOf(runs: readonly any[]): { key: string; heading: string; runs: any[] }[]
  export function overallOf(runs: readonly any[]): {
    runs: number
    needs: number
    going: number
    finished: number
    unseen: number
    steps: number
    done: number
    parts: Part[]
  }
  export function nowOf(
    run: any,
    room?: number,
  ): {
    lines: { task: string; name: string; project: string; part: string; said: string }[]
    more: number
  }
  export function waitsOf(
    step: any,
    run: any,
  ): {
    task: string
    name: string
    finished: boolean
    seen: boolean
    part: string
    why: { words: string; more: boolean } | null
  }[]
  export function shortNamesOf(steps: readonly any[]): Map<string, string>
  export function directionFor(
    graph: { nodes: readonly { id: string }[]; edges: readonly { from: string; to: string }[] },
    room: number,
  ): 'right' | 'down'
  export function stagesOf(run: any): {
    layer: number
    name: string
    said: string
    steps: any[]
    done: number
    part: string
  }[]
  export function orderOf(steps: readonly any[]): Map<string, number>
  export function inOrder<T>(steps: readonly T[]): T[]
  export function mapOf(run: any): {
    dots: { task: string; name: string; part: string; x: number; y: number }[]
    lines: { from: string; to: string; done: boolean; d: string }[]
    width: number
    height: number
  }
  export function dotPath(dot: { x: number; y: number; part: string }, r?: number): string
  export function mapSaid(run: any): string
  export function runSays(row: any, view: any): string
  export function stepSays(step: any): string
  export function costSaid(usd: number | null, view: any): string
  export function paidOf(
    usd: number | null,
    view: any,
    hasCost?: boolean,
  ): { said: string; mark: string; why: string }
  export function stateOf(
    kind: string,
    title: string,
    line: string,
  ): { kind: string; icon: string; title: string; line: string }
  export function whySaid(wait: { why: { words: string; more: boolean } | null }, view: any): string
}
