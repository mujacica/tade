import { createHash } from 'node:crypto'
import { CONNECT_IS_HERE, type ConnectPage } from '@tade/core'

// The connect pages' HTML, drawn here rather than by the away view's page.
//
// **Not a screen of the away view's page, on purpose.** That page is a phone's:
// a shell and a script that ask `/api/snapshot` with a session, kept offline by
// its worker. These answer on this machine's own door with no session, and two
// of them on the public name to a browser GitHub sent back — so each is one
// document, whole, carrying nothing the projection holds and no secret, with a
// content policy of its own (`PAGE_CSP`): its one script and its one stylesheet
// named by their digests, nothing fetched but this origin, and the one place a
// form may post being GitHub, which is where making an App happens.
//
// Every word that is not Tade's — an App's name, an account, a sentence a step
// carries — goes through `esc`.

/** The page's styles: plain and legible in both themes, with no file to fetch. */
const STYLE = `
:root { color-scheme: light dark; --ink: #1d1d1f; --quiet: #6e6e73; --line: #d2d2d7; --good: #1f7a3a; --bg: #fbfbfd; }
@media (prefers-color-scheme: dark) { :root { --ink: #f5f5f7; --quiet: #a1a1a6; --line: #3a3a3c; --good: #4cc26f; --bg: #111113; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 42rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; }
p.lead, small, .why { color: var(--quiet); }
ol { list-style: none; padding: 0; margin: 0; }
li { border-top: 1px solid var(--line); padding: .75rem 0; display: grid; grid-template-columns: 1.5rem 1fr; gap: .25rem .5rem; }
li .tick { font-weight: 700; }
li.done .tick { color: var(--good); }
li .what { grid-column: 2; }
li button, li a.press { grid-column: 2; justify-self: start; margin-top: .25rem; }
button, a.press { font: inherit; padding: .4rem .9rem; border-radius: .5rem; border: 1px solid var(--line); background: var(--ink); color: var(--bg); cursor: pointer; text-decoration: none; }
button:disabled { opacity: .5; cursor: default; }
details { grid-column: 2; margin-top: .25rem; }
dl { margin: .5rem 0; } dt { font-weight: 600; } dd { margin: 0 0 .4rem; }
label { grid-column: 2; display: block; margin-top: .4rem; color: var(--quiet); }
input { font: inherit; padding: .3rem .5rem; border: 1px solid var(--line); border-radius: .4rem; background: transparent; color: var(--ink); }
[role=status] { min-height: 1.5em; color: var(--quiet); }
`

/**
 * The page's one script: a press asks this machine for its one-time word, then
 * posts the form GitHub makes the App from, or goes to where it is installed.
 * The answer's `said` is this machine's own sentence; nothing else is written
 * into the page.
 */
const SCRIPT = `
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-press]')
  if (!button) return
  const section = button.closest('section')
  const said = section.querySelector('[role=status]')
  const body = {}
  if (button.dataset.act === 'make') {
    for (const name of ['organisation', 'name']) {
      const input = section.querySelector('input[name=' + name + ']')
      if (input && input.value.trim() !== '') body[name] = input.value.trim()
    }
  }
  button.disabled = true
  said.textContent = 'Asking this machine…'
  try {
    const answer = await fetch(button.dataset.press, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const got = await answer.json()
    if (!answer.ok) {
      said.textContent = got.said || 'That did not work.'
      button.disabled = false
      return
    }
    said.textContent = 'Off to GitHub…'
    if (got.fields) {
      const form = document.createElement('form')
      form.method = 'post'
      form.action = got.url
      for (const [key, value] of Object.entries(got.fields)) {
        const input = document.createElement('input')
        input.type = 'hidden'
        input.name = key
        input.value = value
        form.append(input)
      }
      document.body.append(form)
      form.submit()
    } else {
      location.assign(got.url)
    }
  } catch {
    said.textContent = 'This machine did not answer.'
    button.disabled = false
  }
})
`

const digest = (text: string): string =>
  `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

/**
 * The content policy every connect page is answered with: the away view's own
 * (`CSP`), but for its one inline script and stylesheet, named by digest, and
 * the one place a form may go — GitHub, where an App is made.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  `script-src ${digest(SCRIPT)}`,
  `style-src ${digest(STYLE)}`,
  "connect-src 'self'",
  "img-src 'none'",
  "base-uri 'none'",
  'form-action https://github.com',
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ')

/** Text as HTML, so nothing anybody else wrote can be markup. */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function document(title: string, body: string, script = false): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${esc(title)}</title><style>${STYLE}</style></head>`,
    `<body><main>${body}</main>${script ? `<script>${SCRIPT}</script>` : ''}</body></html>`,
  ].join('')
}

/** The guided page: every source, each a list of steps with what is done ticked. */
export function connectHome(
  pages: readonly {
    page: ConnectPage
    asks: readonly { what: string; why: string }[]
    events: readonly string[]
  }[],
  publicName: string | null,
): string {
  const sections = pages.map(({ page, asks, events }) => {
    const steps = page.steps.map((step) => {
      const press = step.press
        ? `<button type="button" data-press="/connect/${page.source}/${step.press.act}" data-act="${step.press.act}">${esc(step.press.label)}</button>`
        : ''
      const asking =
        step.id === 'make'
          ? [
              '<details><summary>What it asks GitHub for, and why</summary><dl>',
              ...asks.map((one) => `<dt>${esc(one.what)}</dt><dd>${esc(one.why)}</dd>`),
              '</dl>',
              events.length > 0
                ? `<small>And it is sent: ${events.map(esc).join(', ')} — each only makes a watch look now.</small>`
                : '<small>With no public name it is sent nothing: the watches poll.</small>',
              '<small> Nothing it may do writes anything; replies and pushes stay yours.</small>',
              '</details>',
              `<label>Name on GitHub <input name="name" maxlength="34" placeholder="Tade${publicName ? ` ${esc(publicName.split('.')[0] ?? '')}` : ''}"></label>`,
              '<label>Under an organisation <input name="organisation" maxlength="39" placeholder="your own account"></label>',
              step.done
                ? '<small class="what">Making another replaces the App kept here; the old one stays on GitHub until you delete it there.</small>'
                : '',
            ].join('')
          : ''
      return `<li class="${step.done ? 'done' : 'todo'}"><span class="tick">${step.done ? '✓' : '○'}</span><strong>${esc(step.title)}</strong><span class="what">${esc(step.said)}</span>${asking}${press}</li>`
    })
    return `<section><h2>${esc(page.title)}</h2><ol>${steps.join('')}</ol><p role="status"></p></section>`
  })
  return document(
    'Connect — Tade',
    `<h1>Connect</h1><p class="lead">${esc(CONNECT_IS_HERE)}</p>${sections.join('')}`,
    true,
  )
}

/** Where GitHub sent the browser back once the App was made: what was, and the next press. */
export function madePage(
  made: { name: string; install: string | null } | { problem: string },
): string {
  if ('problem' in made) {
    return document(
      'Not made — Tade',
      `<h1>The App was not kept</h1><p>${esc(made.problem)}</p><p class="lead">Make it again from the Connect page on this machine.</p>`,
    )
  }
  const next =
    made.install === null
      ? '<p class="lead">Install it from the Connect page on this machine.</p>'
      : `<p>Next, pick which repositories it may read.</p><p><a class="press" href="${esc(made.install)}">Install it on GitHub</a></p>`
  return document(
    'Made — Tade',
    `<h1>GitHub App ${esc(made.name)} is made</h1><p class="lead">Its key is kept on this machine, which reads your repositories as it once it is installed on them.</p>${next}`,
  )
}

/** Where GitHub sent the browser back once the App was installed. */
export function installedPage(): string {
  return document(
    'Installed — Tade',
    '<h1>Installed</h1><p class="lead">This machine reads the repositories you picked as the App from its next look, and its watches look as soon as GitHub delivers. You can close this page.</p>',
  )
}

/** Anything else at a callback: a word this machine never minted, used, or too old. */
export function nothingPage(): string {
  return document(
    'Nothing here — Tade',
    '<h1>There is nothing to finish here</h1><p class="lead">Start again from the Connect page on the machine you are connecting.</p>',
  )
}
