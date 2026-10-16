import { testHarness } from '@tade/harnesses-core/conformance'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { AcpAdapter } from '../src/adapter.ts'

// Every agent it is configured to drive, on a PATH where none of them is: the
// suite asks nothing of a real one, and must not read anybody's conversations.
testHarness('acp', {
  make: () => new AcpAdapter({ runDir: tmp('tacp-'), env: { PATH: tmp('tade-acp-empty-path-') } }),
  cwd: () => tmp('tade-acp-cwd-'),
})
