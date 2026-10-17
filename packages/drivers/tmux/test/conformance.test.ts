import { spawnSync } from 'node:child_process'
import { testWorkspaceDriver } from '@tade/drivers-core/conformance'
import { afterAll } from 'vitest'
import { TmuxDriver } from '../src/index.ts'

// On its own tmux server, so a run never touches the sessions you are
// actually using. The session name is the workspace: the suite reuses it to
// build a second driver onto the same lanes, which is Tade being reopened.
const socket = `tade-test-${process.pid}`

testWorkspaceDriver('tmux', (workspace) => new TmuxDriver({ socket, session: workspace }))

// Each test ends only its own session, so one a failed test left — detached
// and never adopted again — kept the server running for days. The whole
// server goes when the file is done.
afterAll(() => {
  spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 10_000 })
})
