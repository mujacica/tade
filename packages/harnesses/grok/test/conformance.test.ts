import { testHarness } from '@tade/harnesses-core/conformance'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { GrokAdapter } from '../src/adapter.ts'

testHarness('grok', {
  // An account folder of its own and no `grok` to run: the suite asks nothing
  // of a real one, and must not read anybody's sessions.
  make: () =>
    new GrokAdapter({
      runDir: tmp('tade-grok-runs-'),
      grokHome: tmp('tade-grok-account-'),
      home: tmp('tade-grok-home-'),
      bin: '/nonexistent/grok',
      type: async () => {},
    }),
  cwd: () => tmp('tade-grok-cwd-'),
})
