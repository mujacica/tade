import { testWorkspaceDriver } from '@tade/drivers-core/conformance'
import { TmuxDriver } from '../src/index.ts'

// On its own tmux server, so a run never touches the sessions you are
// actually using. The session name is the workspace: the suite reuses it to
// build a second driver onto the same lanes, which is Tade being reopened.
testWorkspaceDriver(
  'tmux',
  (workspace) => new TmuxDriver({ socket: `tade-test-${process.pid}`, session: workspace }),
)
