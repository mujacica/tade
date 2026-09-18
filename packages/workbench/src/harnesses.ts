import type { WorkerAdapter } from '@tade/harnesses-core'
import { PiAdapter } from '@tade/harnesses-pi'

// The harnesses agents can run in, by name: the one registry every call site
// goes through, so adding a harness is an adapter and a line here — never a
// `new` somewhere that assumed there was only ever pi.

export interface HarnessOptions {
  runDir: string
  socketDir: string
  approvals: 'bypass' | 'policy'
}

/** What a harness gives the workbench: the port, and how to put an agent in a lane. */
export type LaneHarness = WorkerAdapter & { launchSpec: PiAdapter['launchSpec'] }

export const HARNESS_ADAPTERS: Readonly<Record<string, (opts: HarnessOptions) => LaneHarness>> = {
  pi: (opts) => new PiAdapter(opts),
}
