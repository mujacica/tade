import { testHarness } from '@tade/harnesses-core/conformance'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { CodexAdapter } from '../src/adapter.ts'

testHarness('codex', {
  // A home of its own and no `codex` to run: the suite asks nothing of a real
  // one, and must not read anybody's threads.
  make: () =>
    new CodexAdapter({
      runDir: tmp('tcx-'),
      codexHome: tmp('tade-codex-account-'),
      home: tmp('tade-codex-home-'),
      bin: '/nonexistent/codex',
      type: async () => {},
    }),
  cwd: () => tmp('tade-codex-cwd-'),
})
