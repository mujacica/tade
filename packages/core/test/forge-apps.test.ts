import { describe, expect, it } from 'vitest'
import { appSlug, appsKept, GITHUB_APP } from '../src/forge-apps.ts'

// The GitHub App's keys as the config keeps them, read the one way every
// extension is handed them (`ExtensionContext.apps`).

const KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'

describe('the apps kept here', () => {
  it('is the GitHub App where its id and its key are both kept', () => {
    expect(appsKept({ intake: { github_app_id: '4242', github_app_key: KEY } }, {})).toEqual([
      { host: 'github.com', id: '4242', key: KEY },
    ])
  })

  it('is nothing where half of one is kept, because half signs for nothing', () => {
    expect(appsKept({ intake: { github_app_id: '4242' } }, {})).toEqual([])
    expect(appsKept({ intake: { github_app_key: KEY } }, {})).toEqual([])
    expect(appsKept({}, {})).toEqual([])
    expect(
      appsKept({ intake: { github_app_id: 'not a number', github_app_key: KEY } }, {}),
    ).toEqual([])
  })

  it('reads an id YAML read as a number, as somebody writing it by hand would write it', () => {
    expect(appsKept({ intake: { github_app_id: 4242, github_app_key: KEY } }, {})[0]?.id).toBe(
      '4242',
    )
  })

  it('lets the key’s variable win over the file, as every key’s does', () => {
    const kept = appsKept(
      { intake: { github_app_id: '4242', github_app_key: 'old' } },
      { [GITHUB_APP.key.env]: KEY },
    )
    expect(kept[0]?.key).toBe(KEY)
  })

  it('reads a slug only where it is one, since it goes into an address', () => {
    expect(appSlug({ intake: { github_app_slug: 'tade-vps' } })).toBe('tade-vps')
    expect(appSlug({ intake: { github_app_slug: '../evil' } })).toBeNull()
    expect(appSlug({})).toBeNull()
  })
})
