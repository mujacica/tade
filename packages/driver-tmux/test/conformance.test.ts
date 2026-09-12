import { testWorkspaceDriver } from '@wilco/driver-conformance'
import { TmuxDriver } from '../src/index.ts'

// On its own tmux server, with a fresh session per test, so a run never
// touches the sessions you are actually using.
testWorkspaceDriver(
  'tmux',
  () =>
    new TmuxDriver({
      socket: `wilco-test-${process.pid}`,
      session: `conf-${Math.random().toString(36).slice(2, 10)}`,
    }),
)
