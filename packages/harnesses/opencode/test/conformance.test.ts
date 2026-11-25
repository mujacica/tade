import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { testHarness } from '@tade/harnesses-core/conformance'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { OpenCodeAdapter } from '../src/adapter.ts'

/**
 * A stand-in `opencode` that answers only the question of a plan, the way
 * OpenCode 2.4.1's `api experimental.usage.limits` answered it for an account
 * on OpenCode Go: never the service.
 */
function onGo(): string {
  const bin = join(tmp('tade-opencode-bin-'), 'opencode')
  const said = {
    location: { directory: '/tmp' },
    data: {
      workspace: { id: 'wrk_1', usageURL: 'https://opencode.ai/workspace/wrk_1' },
      go: {
        rolling: { percent: 30, limited: false, resetsAt: 1_795_600_000_000 },
        weekly: { percent: 55, limited: false, resetsAt: 1_795_900_000_000 },
        monthly: { percent: 12, limited: false, resetsAt: 1_797_000_000_000 },
      },
      budgets: [],
    },
  }
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = api ] && [ "$2" = experimental.usage.limits ]; then printf '%s\\n' '${JSON.stringify(said)}'; exit 0; fi\nexit 1\n`,
  )
  chmodSync(bin, 0o755)
  return bin
}

const adapter = (bin: string) =>
  new OpenCodeAdapter({
    runDir: tmp('tade-opencode-runs-'),
    home: tmp('tade-opencode-home-'),
    bin,
    env: { PATH: process.env.PATH ?? '' },
  })

testHarness('opencode', {
  // No `opencode` to run and a home of its own: the suite asks nothing of a
  // real one, and must not read anybody's sessions.
  make: () => adapter('/nonexistent/opencode'),
  cwd: () => tmp('tade-opencode-cwd-'),
  asked: () => adapter(onGo()),
})
