// The full view's pure modules (§10 T4 of the Duo plan), as the tests that hold
// them import them. Only what a test reads is declared; why this lives here and
// not beside the assets is `assets.d.ts`'s first paragraph.

type FullOrientation = 'upright' | 'sideways'
type FullMode = 'overview' | 'full'

declare module '*/assets/mode.js' {
  export const MODES: { overview: string; full: string }
  export const ORIENTATIONS: readonly FullOrientation[]
  export function orientationOf(width: number, height: number): FullOrientation
  export function defaultMode(orientation: FullOrientation): FullMode
  export function modesFrom(text: unknown): Partial<Record<FullOrientation, FullMode>>
  export function modesText(modes: Partial<Record<FullOrientation, FullMode>>): string
  export function modeFor(
    orientation: FullOrientation,
    modes: Partial<Record<FullOrientation, FullMode>>,
  ): FullMode
}

declare module '*/assets/full-fit.js' {
  export const CELL: number
  export const UPRIGHT_COLUMNS: number
  export const SMALLEST: number
  export function fitOf(room: {
    width: number
    height: number
    screen?: { width: number; height: number }
    ratio?: number
    lead?: number
  }): { font: number; columns: number; rows: number; book: boolean; sidebar: number | null }
  export function foldAt(columns: number): number
}

declare module '*/assets/full-cells.js' {
  export interface Pen {
    fg: string | null
    bg: string | null
    bold: boolean
    dim: boolean
    italic: boolean
    underline: boolean
    reverse: boolean
  }
  export interface Run {
    text: string
    ink: string
    ground: string | null
    bold: boolean
    italic: boolean
    underline: boolean
    wide: boolean
    link: string | null
  }
  export const THEME: { background: string; foreground: string; ansi: readonly string[] }
  export const PEN: Pen
  export function colour256(n: number): string
  export function applySgr(pen: Pen, codes: readonly number[]): Pen
  export function paintOf(pen: Pen): { ink: string; ground: string | null }
  export function widthOfPoint(point: number): number
  export function widthOf(glyph: string): number
  export function glyphAt(row: string, at: number): string
  export function runsOf(row: string): Run[]
}

declare module '*/assets/full-widths.js' {
  export const WIDTHS: readonly number[]
  export const JOINED: readonly number[]
}

declare module '*/assets/full-keys.js' {
  export const BYTES: Record<string, string>
  export const ROW: readonly { label: string; name: string; bytes: string }[]
  export function bytesOf(
    key: string,
    mods?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
  ): string | null
}

declare module '*/assets/full-grid.js' {
  export function safeLink(url: unknown): string | null
}
