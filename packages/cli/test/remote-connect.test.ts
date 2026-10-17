import { join } from 'node:path'
import { CONNECT_TITLES } from '@tade/core'
import type { LinkOptions, RemoteLink } from '@tade/remotes-core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import type { WebConnecting } from '@tade/web'
import { REMOTE_LINKS } from '@tade/workbench/remotes'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  type Asking,
  addRemote,
  connectRemote,
  type Holding,
  PAGES_ARE_OPEN_HERE,
  type Place,
} from '../src/commands/remote-guide.ts'

// `tade remote connect`: a remote's own pages that connect a source, served
// here and opened in this machine's browser until ctrl+c — against a far end
// that is a real away view, reached by the scripted link — because Settings ›
// Remotes sends the person there for what Slack's own page shows them, which
// is never carried from here.

const makeScriptedLink = REMOTE_LINKS.scripted as unknown as (
  options: LinkOptions & {
    remotes: ReadonlyMap<string, FarEnd & { identity: { fingerprints: string[]; known: 'known' } }>
  },
) => RemoteLink

/** That machine's window, knowing only Slack's page, with its signing secret to keep. */
const slack: WebConnecting = {
  page: async (source) => ({
    page: {
      source,
      title: CONNECT_TITLES[source],
      steps:
        source === 'slack'
          ? [
              {
                id: 'keep',
                title: 'Give this machine its signing secret',
                done: false,
                said: 'from the app’s Basic Information',
                press: {
                  act: 'keep',
                  label: 'Keep it',
                  fields: [{ name: 'signing_secret', label: 'Signing Secret', secret: true }],
                },
              },
            ]
          : [],
      writes: 'It writes nothing.',
    },
    asks: [],
    events: [],
  }),
  form: () => ({ url: 'https://example.com/nothing-is-made' }),
  installUrl: () => null,
  made: async () => ({ problem: 'nothing is made here' }),
  installed: async () => ({ problem: 'nothing is installed here' }),
  keep: async () => ({ kept: ['the signing secret'] }),
}

describe('tade remote connect', () => {
  let home: string
  let far: FarEnd
  let out: string[]
  let err: string[]
  let exit: number

  const nobody: Asking = { interactive: false, ask: async () => false, run: async () => 0 }
  const place = (): Place => ({
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    setExit: (code) => {
      exit = code
    },
    home,
    configPath: join(home, 'config.yaml'),
    linkFor: () =>
      makeScriptedLink({
        home,
        remotes: new Map([
          [
            'far',
            Object.assign(far, {
              identity: { fingerprints: ['ED25519 SHA256:far'], known: 'known' as const },
            }),
          ],
        ]),
      }),
    asking: nobody,
    now: Date.now,
  })

  /** Holding them open until `end`, with what was handed to the browser written down. */
  const holding = (opened: string[], opens: Holding['open'] = async () => {}) => {
    let end: () => void = () => {}
    const ended = new Promise<void>((done) => {
      end = done
    })
    let held: () => void = () => {}
    const holdingNow = new Promise<void>((done) => {
      held = done
    })
    const seams: Holding = {
      open: async (opener) => {
        opened.push([opener.command, ...opener.args].join(' '))
        await opens(opener)
      },
      until: () => {
        held()
        return ended
      },
    }
    return { seams, end: () => end(), holdingNow }
  }

  beforeEach(async () => {
    home = tmp('tade-remote-connect-')
    far = await startFarEnd()
    far.connecting = slack
    out = []
    err = []
    exit = 0
    await addRemote(place(), 'vps', { ssh: 'far', tade: 'tade', label: 'mac' })
    expect(exit).toBe(0)
    out = []
    err = []
  })

  afterEach(async () => {
    await far.close()
  })

  it('serves that machine’s own page here, opens it in this machine’s browser, and stops at ctrl+c', async () => {
    const opened: string[] = []
    const { seams, end, holdingNow } = holding(opened)
    const running = connectRemote(place(), 'vps', {}, seams)
    await holdingNow
    const url = out[0] ?? ''
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/connect$/)
    expect(opened).toEqual([expect.stringContaining(url)])
    expect(err).toContain(PAGES_ARE_OPEN_HERE)
    const page = await fetch(url)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Signing Secret')
    end()
    await running
    expect(exit).toBe(0)
    await expect(fetch(url)).rejects.toThrow()
  })

  it('opens no browser with --no-open, and only prints the address', async () => {
    const opened: string[] = []
    const { seams, end, holdingNow } = holding(opened)
    const running = connectRemote(place(), 'vps', { open: false }, seams)
    await holdingNow
    expect(opened).toEqual([])
    expect(out).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/connect$/)])
    end()
    await running
  })

  it('says the address where no browser would open, and keeps serving it', async () => {
    const { seams, end, holdingNow } = holding([], async () => {
      throw new Error('xdg-open is not installed, or not on PATH')
    })
    const running = connectRemote(place(), 'vps', {}, seams)
    await holdingNow
    const url = out[0] ?? ''
    expect(err).toContain(
      `no browser opened here (xdg-open is not installed, or not on PATH): open ${url}`,
    )
    expect((await fetch(url)).status).toBe(200)
    end()
    await running
    expect(exit).toBe(0)
  })

  it('refuses a remote that is not in the config, serving nothing', async () => {
    const { seams } = holding([])
    await connectRemote(place(), 'nope', {}, seams)
    expect(exit).toBe(2)
    expect(err).toEqual(['there is no remote called nope'])
    expect(out).toEqual([])
  })
})
