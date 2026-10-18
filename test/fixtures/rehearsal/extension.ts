// The rehearsal's scripted intake source: a watch whose doorbell is GitHub's,
// so a signed delivery to /hooks/github makes it look now. What it finds is
// read from REQUESTS.json in the project it watches — one request each, found
// once by its id — in place of GitHub's issues, which need GitHub.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export default {
  name: 'rehearsal-intake',
  title: 'Rehearsal intake',
  description:
    'A scripted intake source for the rehearsal: requests in REQUESTS.json, looked at when GitHub rings.',
  watches: [
    {
      id: 'requests',
      title: 'Rehearsal requests',
      means: 'Reads REQUESTS.json in the project: each entry a request, found once by its id.',
      every: '1h',
      // It stands in for GitHub, which is off this machine.
      network: true,
      about: 'repository',
      offers: 'ask',
      doorbell: { source: 'github', events: ['issues'] },
      async check(ctx: { watching: { root: string } }) {
        const text = await readFile(join(ctx.watching.root, 'REQUESTS.json'), 'utf8').catch(
          (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') return '[]'
            throw err
          },
        )
        const requests = JSON.parse(text) as { id: string; title: string }[]
        return { found: requests.map((one) => ({ key: one.id, title: one.title })) }
      },
    },
  ],
}
