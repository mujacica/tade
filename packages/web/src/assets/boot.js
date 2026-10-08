// The bootstrap: pair this device, or sign it out. Nothing else.
//
// Two absolute rules, and they are the ones that hold against script that got
// onto this page rather than against anything a network does:
//
// 1. **Nothing here touches `innerHTML`.** Every value reaches the DOM through
//    `textContent`. `test/assets.test.ts` asserts the string does not appear in
//    this folder, and the content policy has no `unsafe-inline` to fall back
//    on.
// 2. **The ticket leaves the address bar immediately.** It arrives in the
//    fragment — which a browser never sends to a server, so it is in no access
//    log, no `Referer` and no error report — and the first thing this does is
//    read it and replace the history entry, so it is not in the visible URL or
//    the back stack either. What is left is the device's own history store for
//    ninety seconds, which is what the expiry is for.

const $ = (id) => document.getElementById(id)

/** The ticket out of the fragment, taken out of the address bar as it is read. */
function ticket() {
  const hash = location.hash
  const found = /^#t=([A-Za-z0-9_-]{27})$/.exec(hash)
  // Replaced whatever was in the fragment, including something that was not a
  // ticket: a value nobody here understands is still a value nobody needs in
  // their address bar.
  if (hash !== '') history.replaceState(null, '', location.pathname)
  return found === null ? null : found[1]
}

/** One request. JSON in, JSON out, and the token a form cannot send. */
async function ask(method, path, body, csrf) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (csrf !== undefined) headers['x-tade-csrf'] = csrf
  const answer = await fetch(path, {
    method,
    headers,
    // Same-origin and nothing else: this page has no other origin to talk to,
    // and the policy's `connect-src 'self'` means it could not if it did.
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let said = null
  try {
    said = await answer.json()
  } catch {
    said = null
  }
  return { status: answer.status, body: said }
}

function show(which) {
  for (const id of ['pairing', 'signed-in']) $(id).hidden = id !== which
}

/** Tade's own sentence for what happened, or its own for what it cannot name. */
function sentence(answer) {
  if (answer.body !== null && typeof answer.body.said === 'string') return answer.body.said
  return 'something went wrong here'
}

async function start() {
  const held = ticket()
  const mine = await ask('GET', '/api/devices')
  if (mine.status === 200 && mine.body !== null) {
    $('said').textContent = ''
    $('me').textContent = mine.body.you.label
    $('reads').textContent =
      mine.body.you.reads.length === 0 ? 'names and counts' : mine.body.you.reads.join(', ')
    show('signed-in')
    wireOut(mine.body.you.csrf, mine.body.you.device)
    return
  }
  $('said').textContent = held === null ? 'This device is not paired.' : ''
  show('pairing')
  wirePair(held)
}

function wirePair(held) {
  const button = $('pair')
  const said = $('pair-said')
  if (held === null) {
    button.disabled = true
    said.textContent = 'Open the pairing panel in Tade and scan the code there.'
    return
  }
  button.addEventListener('click', async () => {
    button.disabled = true
    said.textContent = 'Asking at the machine…'
    const answer = await ask('POST', '/api/pair', { ticket: held, label: $('label').value })
    if (answer.status === 201) {
      location.replace('/')
      return
    }
    // One try per ticket, whatever the answer: it was burned the moment it was
    // presented, so there is nothing here to press again.
    said.textContent = sentence(answer)
  })
}

function wireOut(csrf, device) {
  const button = $('out')
  const said = $('out-said')
  button.addEventListener('click', async () => {
    button.disabled = true
    const answer = await ask('DELETE', `/api/devices/${encodeURIComponent(device)}`, {}, csrf)
    if (answer.status === 200) {
      location.replace('/pair')
      return
    }
    button.disabled = false
    said.textContent = sentence(answer)
  })
}

start().catch(() => {
  $('said').textContent = 'Tade is not answering.'
})
