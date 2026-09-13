import { testWorkspaceDriver } from '@wilco/drivers-core/conformance'
import { PtyDriver } from '../src/index.ts'

testWorkspaceDriver('pty', () => new PtyDriver({ scrollback: 1_000 }))
