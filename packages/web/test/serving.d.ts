// The links to an agent's dev servers (`src/assets/serving.js`), declared for
// `serving-client.test.ts` — beside `assets.d.ts` rather than in it, as each
// page's own module is, and loose for that file's reason.

declare module '*/assets/serving.js' {
  export function servedBy(tasks: readonly { servers?: readonly number[] }[]): number[]
  export function servedAt(port: number, at: string | undefined): string | null
  export function servingIn(tools: unknown): { update(ports: readonly number[]): void }
}
