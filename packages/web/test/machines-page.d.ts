// The Machines page's pure half (`src/assets/pages/machines-shape.js`),
// declared for `machines-page-client.test.ts` — beside `assets.d.ts` rather
// than in it, so the page that owns the module owns its declaration. Loose for
// `assets.d.ts`'s reason: the answer it reads is `MachinesAnswer`, held by the
// machine's own types, and a second description of it here would be a second
// schema.

declare module '*/assets/pages/machines-shape.js' {
  type Cell = { mark: string; days: number | null; where: readonly string[]; said: string | null }
  type Column = {
    machine: string
    asOf: string | null
    here: boolean
    said: string | null
    synced?: string | null
  }
  type Tile = {
    key: string
    label: string
    value: string | null
    under: string
    tone?: string | null
  }
  type Press = { id: string; word: string; again?: string }
  export const KIND_TITLE: Record<string, string>
  export const MARK_SAID: Record<string, string>
  export function markTone(mark: string): string
  export function cellSaid(cell: Cell): string
  export function columnSaid(column: Column | undefined, clock: (at: string) => string): string
  export function groupsOf(
    answer: unknown,
  ): { kind: string; head: string; rows: { id: string; kind: string; label: string }[] }[]
  export function hereAt(answer: unknown): number
  export function leadOf(answer: unknown): Tile[]
  export function pressesOf(answer: unknown): Press[]
  export function underWay(answer: unknown): boolean
  export function diffTone(line: string): string
  export function leftSaid(one: { name: string; where: string; why: string }): string
  export function refusedSaid(got: unknown): { title: string; fix: string } | null
}
