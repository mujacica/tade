// Every machine's rows on one page — the machine chips, `everyMachine` and
// `reviewsOnce` — declared for `every-machine-client.test.ts`, beside
// `assets.d.ts` rather than in it (ambient modules of one name merge). Loose for
// `assets.d.ts`'s reason: a second typed description of a projected row would be
// a second schema that nothing holds to `protocol.ts`.

declare module '*/assets/machines.js' {
  export const HERE: ''
  export function pickedIn(store: unknown, picked: string | null): string | null
  export function drawsOf(picked: string | null, machine: string | null | undefined): boolean
  export function chipsOf(
    store: unknown,
    picked: string | null,
  ): { key: string | null; label: string; tone: string; said: string | null; on: boolean }[]
  export function reviewsOnce(drawn: { machine: string; store: any }[]): any[]
  export function storesDrawn(
    store: unknown,
    picked: string | null,
  ): { machine: string; store: any; up: boolean }[]
  export function navCountsOf(store: unknown, picked: string | null): Record<string, number>
}

declare module '*/assets/there.js' {
  type Screen = { node: any; update(view: unknown): void; leave?(): void }
  export function machinePicked(store: unknown): string | null
  export function machineChips(): { node: any; update(store: unknown): void }
  export function everyMachine(
    make: (ctx: any) => Screen,
    ctx?: unknown,
    once?: ((drawn: { machine: string; store: any }[]) => any[]) | null,
  ): Screen
}

declare module '*/assets/pages/queue.js' {
  export function queueScreen(): { node: any; update(view: unknown): void }
}

declare module '*/assets/pages/reviews.js' {
  export function reviewsScreen(ctx?: unknown): { node: any; update(view: unknown): void }
}

declare module '*/assets/side.js' {
  export function sideOf(ctx?: unknown): { node: any; update(view: unknown): void }
}
