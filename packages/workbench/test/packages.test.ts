import type { Config } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { packagesOf } from '../src/packages.ts'

// Which folders a plan names are packages is looked up in the tree, never
// guessed from a path's shape: `src/mail` and `packages/drivers/pty` look alike.

describe('the packages a plan names', () => {
  it('finds the ones with a manifest in, above a src, and directly inside a folder named', async () => {
    const repo = mkrepo()
    repo.write({
      'package.json': '{}',
      'packages/app/package.json': '{}',
      'packages/app/src/view/menu.ts': '',
      'packages/drivers/pty/Cargo.toml': '',
      'src/mail/send.ts': '',
    })
    const config = { projects: { app: { root: repo.root } } } as unknown as Config
    const agent = (touches: string[]) => ({ name: 'a', said: '', prompt: '', after: [], touches })
    const found = await packagesOf(config, {
      project: 'app',
      said: '',
      agents: [
        agent(['packages/app/src', 'src/mail', 'packages/app/src/view/menu.ts']),
        agent(['packages/drivers', '../outside', '/etc']),
        agent(['./']),
      ],
    })
    expect([...found('app')].sort()).toEqual(['', 'packages/app', 'packages/drivers/pty'])
    // A project nobody named, or one Tade does not have, has none.
    expect(found('elsewhere')).toEqual([])
  })
})
