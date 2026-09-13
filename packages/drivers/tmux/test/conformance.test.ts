import { testWorkspaceDriver } from '@wilco/drivers-core/conformance'
import { TmuxDriver } from '../src/index.ts'

// On its own tmux server, so a run never touches the sessions you are
// actually using. The session name is the workspace: the suite reuses it to
// build a second driver onto the same lanes, which is Wilco being reopened.
testWorkspaceDriver(
  'tmux',
  (workspace) => new TmuxDriver({ socket: `wilco-test-${process.pid}`, session: workspace }),
)
