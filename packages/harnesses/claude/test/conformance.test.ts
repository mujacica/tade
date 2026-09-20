import { testHarness } from '@tade/harnesses-core/conformance'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter } from '../src/adapter.ts'

testHarness('claude-code', {
  // An account of its own and no `claude` to run: the suite asks nothing of a
  // real one, and must not read anybody's transcripts.
  make: () =>
    new ClaudeAdapter({
      runDir: tmp('tcc-'),
      configDir: tmp('tade-claude-account-'),
      home: tmp('tade-claude-home-'),
      bin: '/nonexistent/claude',
      type: async () => {},
    }),
  cwd: () => tmp('tade-claude-cwd-'),
})
