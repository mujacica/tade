import { testHarness } from '@tade/harnesses-core/conformance'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { PiAdapter } from '../src/adapter.ts'

testHarness('pi', {
  make: () =>
    new PiAdapter({ runDir: tmp('tade-pi-conf-'), sessionsRoot: tmp('tade-pi-sessions-') }),
  cwd: () => tmp('tade-pi-cwd-'),
})
