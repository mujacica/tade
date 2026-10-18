import { testHarness } from '@tade/harnesses-core/conformance'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { CodexAdapter } from '../src/adapter.ts'
import { HELLO, READ, stand } from './stand-in.ts'

const adapter = (bin: string) =>
  new CodexAdapter({
    runDir: tmp('tcx-'),
    codexHome: tmp('tade-codex-account-'),
    home: tmp('tade-codex-home-'),
    bin,
    type: async () => {},
  })

testHarness('codex', {
  // A home of its own and no `codex` to run: the suite asks nothing of a real
  // one, and must not read anybody's threads.
  make: () => adapter('/nonexistent/codex'),
  cwd: () => tmp('tade-codex-cwd-'),
  // Its plan asked of a stand-in app server, never the service.
  asked: () => adapter(stand({ hello: HELLO, read: READ })),
})
