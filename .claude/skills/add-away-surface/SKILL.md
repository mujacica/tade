---
name: add-away-surface
description: Add or change what the away view serves — a route, the live stream, a read scope, a device grant, the pairing flow, the session credential, the window's pairing panel, `tade web`, or what the guard asks of a request. Use when a phone should be able to read or do something it cannot, when a security claim about the away view needs changing, or when something about pairing, sessions, devices, reconnection or the listener's lifetime does the wrong thing.
---

# Changing what the away view serves

The away view is `packages/web` plus the window's own end of it: a contract, a pure projection, a
`node:http` server behind pairing, a session and a guard, and a listener the window owns and dies
with. **It is off by default and listens on this machine alone**, and turning either of those round
is a person's act with its own setting in `reach.ts`'s `never` subtree.

| Changing | File |
|---|---|
| a route | `src/routes.ts`, then the `switch` in `src/server.ts` |
| the live stream's protocol | `src/stream.ts` — pure: the cursor, the ring, the resume rule, the frames, the budgets |
| who is listening, and what they are sent | `src/peers.ts` — pure, over a `Sink`; the caps, the fan-out, the backpressure, the stall |
| what a request *is* | `src/request.ts` — reading an `IncomingMessage`, and every bound on one |
| what a request must satisfy | `src/guard.ts` — pure, and `test/guard.test.ts` runs the cross-product |
| what a device may read | `src/reach.ts` (the grants), `src/surface.ts`'s `reachOf` (the seam) |
| the pairing exchange | `src/tickets.ts` (the burn), `server.ts`'s `pair` |
| the credential | `src/sessions.ts` |
| the device list | `src/devices.ts` — `<home>/web-devices.jsonl` |
| the headers and the content policy | `src/headers.ts` |
| what a refusal says | `src/errors.ts` |
| the config | `surfaces.web` in `packages/core/src/config.ts`, read only by `surfaceOf` |
| the sentences that may never get comfortable | `packages/core/src/away.ts`, re-exported by `src/surface.ts` |
| the browser's files | `src/assets/` — `.html`/`.css`/`.js` only, **never `.ts`** |
| the palette, the type scale, the primitives | `src/assets/tokens.css` — every colour is a window tone, checked by arithmetic |
| the frame: header, bars, nav, the four region states | `src/assets/frame.css`, `src/assets/shell.js` |
| what a screen looks like | `src/assets/away.css`, `src/assets/rows.js` |
| a screen | `src/assets/screens.js` (work) or `pages.js` (lists), plus a route in `src/routes.ts` **and** a view in `src/assets/routes.js` |
| what a figure says | `src/assets/figures.js` — money, tokens, ages, plan bars |
| what a state looks like | `src/assets/glyphs.js` — glyph, word and tone, never colour alone |
| the delta merge and the selectors | `src/assets/store.js` |
| the router, the stream, the keyboard | `src/assets/boot.js` |
| the browser, a11y and visual harness | `scripts/browser.ts` + `test/browser-plan.ts` |
| the listener's lifetime, the beat, the pairing panel | `packages/app/src/wire/web.ts` |
| what the window hands it | `packages/app/src/away.ts` — pure: `Workspace` in, the collections out |
| what the panel draws | `packages/app/src/panels/away/{state,view}.ts`, with four goldens in `test/screens/scenarios/away.ts` |
| the terminal's end of it | `packages/cli/src/commands/web.ts` |

## The rules that break things quietly

- **No route mutates a project or a task.** The two non-`GET` routes are session lifecycle — this
  browser's own credential, created and destroyed — and `test/routes.test.ts` asserts that set is
  exactly those two **by name**. A third fails the test until somebody puts it in `LIFECYCLE`
  deliberately, which is the conversation the rule is for.
- **A path that is not in the table is a `404`, never a `405` and never a `403` with a hint.** An off
  capability is not a thing to probe: a `403` saying "turn `diffs` on" tells whoever holds a stolen
  session that there is a diff route and what the setting is called.
- **The guard is pure and has one call site.** A guard that read `req` could only be tested by making
  a request, and then the attacks it exists for get asked once each, for the one route somebody
  remembered. Add a layer in `allowed`, not in a handler.
- **No forwarded header is ever read** (`NEVER_TRUSTED`), *and a proxy may be in front of this* —
  `tailscale serve` is the recommended way to give a phone HTTPS. A deliberate proxy is trusted by
  being **named in `surfaces.web.trusted_hosts`** (`schemesFor`, `trusted`), which is a person's act
  in the `never` subtree; a header is anybody-on-the-network's. Read one and
  `X-Forwarded-Host` walks past the `Host` allow-list (the rebinding defence), `X-Forwarded-Proto`
  makes a plaintext session look trusted enough to act, and `X-Forwarded-For` makes the rate limit and
  the journalled address whatever the attacker typed. The address is the socket's and the host is
  `Host`.
- **`Sec-Fetch-Site` is not checked on a document navigation.** A scanned code is a typed URL
  (`none`) and a followed link is `cross-site`, so requiring `same-origin` on the shell refuses every
  real way in. Everything else — every `fetch` the page makes — is checked.
- **The pairing ticket is burned on the *claim*, before anybody at the machine is asked.** That one
  ordering is what makes a replay, a concurrent attempt, a refusal, a deadline and a throw all find
  nothing. The tempting shape — check, ask, then delete on success — is wrong in all five ways.
- **A body of `null` is a body.** `readBody` returns a discriminated answer, because `unknown | null`
  made a four-byte `null` indistinguishable from "already refused" and held the request open for ever.
- **`(epoch, rev)` is the cursor, and nothing reads `seq` or a byte offset.** The epoch is minted by
  `webServer` — *the thing that starts* — and the window reads `server.epoch` for `lifetime.epoch`,
  so a snapshot's freshness and a delta's `id` are the same string. Two sources for one value makes
  every reconnection resnapshot, which is **correct**, so no test goes red while a phone downloads
  the whole tree every two seconds.
- **The stream has no timer, and neither does the window's end of it.** Heartbeats, slow clients and
  expired sessions are all decided in `Streams.beat(now)`, called on `Live`'s existing refresh.
  `test/stream.test.ts` asserts neither pure file so much as names `setTimeout`.
- **A reopened dead session is `204`, not `401`.** A non-200 kills an `EventSource` permanently and
  `204` is the one status that tells a browser to *stop reconnecting*; a `401` every two seconds for
  as long as the phone is awake is what the alternative looks like. The guard still runs first, so a
  bad `Host` is still a `403` — it is not a session problem.
- **Over the budget, deltas stop and one `resync` is owed.** The layer underneath buffers whatever it
  is handed, so the only bound that holds is to stop handing it anything; a snapshot replaces
  anything, which is why dropping a run of deltas is correct rather than lossy.
- **Nothing is built for nobody.** `Away.beat` marks the collections stale and does two empty loops;
  the collections are built on demand (`collections()`) and memoised until the next beat, because a
  request is not idle. Building them means four folds over the whole journal, and an enabled away
  view nobody paired a phone to must not pay for one every two seconds
  (`packages/app/test/wire/away.test.ts`).
- **No handler does any work.** No `git`, no `ps`, no spawn, no file read but the device list: every
  read answers from what the window already holds, through `WebReading`. The window draws on this
  thread.
- **A read scope is per device, so the projection is built per device** (`readingFor(reach)`).
  Filtering one projection afterwards is how a field that should have been withheld rides along.
- **`bind: lan` is a read-only transport** (`scopesOn`). A credential that crossed a network in the
  clear never buys an act, whatever is turned on later — and it is **re-asked at the act**, because
  the network a device is on changes.
- **The assets folder is reached with `fileURLToPath`, never `new URL(...).pathname`.** A URL
  percent-encodes, so under any install path with a space in it — `~/Library/Application Support/…`,
  a `Program Files`, an account that is two words — `readdir` was handed `…Application%20Sup…`,
  found nothing, and every page and every file became a `404` with nothing anywhere saying why.
  `listen()` now says it when the map comes back empty, because a folder that could not be read is
  not a folder with no files in it.
- **`fresh.warnings` is the one metadata field whose words this package did not write**, so the
  *no path of its own* claim is kept at the boundary (`withoutPaths`) and not inherited:
  `collectStatus` writes `<project>: <its root>: <what git said>`. Its fixture carries the shapes
  status really produces, because a fixture whose warnings happen to be tidy is the leakage test
  passing while the claim is false. Bounded by `budget.warnings` too — the freshness rides on
  every frame, so it is the one collection whose budget is about what a connected phone pays for
  ever rather than about what fits on a screen.
- **A money figure is drawn with the period it covers** (`fresh.spendSince`, `sinceSaid`). The
  window folds from **its** midnight, so a task that cost forty dollars yesterday arrives with no
  cost at all and the dash's own word is *not recorded* — the three-dashes lie one period out. The
  instant is on the wire rather than a word on the page, because the phone is somewhere else and
  *today* is not the same day there.
- **A `.ts` file in `src/assets/` is renamed to `.js` at publish**, so it is served under one name here
  and another on somebody else's machine. `git add` every asset, too: staging copies only
  `git ls-files` output, so an un-added `.css` is a page with no styles everywhere but here
  (`test/release.test.ts` reads the staged tree the way the server does).
- **A screen is two tables, held equal.** `src/routes.ts` says which paths answer with the shell and
  `src/assets/routes.js` says which the page knows; a path in one and not the other is a screen that
  works until somebody reloads it. `test/routes-client.test.ts` asserts both directions.
- **Nothing in the page derives a state.** `deriveState` already decided and the projection carries
  its answer and its own `reason` clause, verbatim. A second wording is a second state machine — the
  queue's words are `describeQueueState`'s, copied into `glyphs.js` because a browser cannot import a
  `.ts` file and held equal by `test/glyphs.test.ts`. Four rules in `figures.js` are the domain's the
  same way.
- **Two nulls, two sentences.** A figure that is null because nobody recorded it and one that is null
  because this device was not granted it are different facts, and a page that drew both as *not
  recorded* tells somebody their work cost nothing. `you.reads` is the only way to tell them apart
  from the page (`mayRead`), and every screen that can draw a dash asks.
- **A screen is built once and then patched.** A delta writes text and classes into nodes that
  already exist (`keyed`, `textIn`), so focus, a half-made selection and the scroll position survive
  it — and **a delta never moves the current tab**, which only navigation does.
- **An age freezes when the stream is not live** and gains the moment it was last true. An age
  counting up against a snapshot nothing can refresh is the lie §5.10 exists to prevent, so `asOf`
  hands the server's own last word to every row rather than the device's clock.
- **Nothing in the client touches `innerHTML`**, there is no Markdown renderer, and the content policy
  has no `unsafe-inline`. Those three are what actually stands against injected script; `HttpOnly`
  stops the *theft* of a credential and not its use.

## Four sentences that may never get more comfortable

In `src/surface.ts`, said once so no control, README line or commit message can say the easy half.
`test/separation.test.ts` holds each of them.

- `LAN_IS_PLAINTEXT` — on a LAN anybody on the wifi reads every page and the cookie, and
  `tailscale serve` is the way out. **Never** say a LAN is secure, encrypted, private or safe.
- `COOKIES_IGNORE_PORTS` — RFC 6265 §8.5, and **no cookie prefix changes it**. `__Host-` gives real
  `Domain`/`Path` guarantees and nothing about ports; the honest mitigations are the session being
  bound to the exact host it was minted for, and TLS.
- `HTTPONLY_IS_NOT_XSS` — it stops a script reading the cookie, not injected script using it.
- `DEVICES_AND_AGENTS` — `0600` keeps the file from other people, and **an agent is not another
  person**: one on this machine can append a line and pair itself. Said with the way out in the same
  breath — the list shows every device, every act is journalled under its id, and "Disconnect
  everything" needs no network.

## The config, and the four controls over it

`surfaces.web` is read in exactly one place — `surfaceOf` — and its four keys are `never` in
`reach.ts`: each either widens who can reach the control room (`enabled`, `bind`), decides what the
pairing code says (`port`), or names a host whose `https` origin is trusted (`trusted_hosts`). A
tier is a property of the path, so `packages/core/test/reach.test.ts` asserts it by subtree rather
than through what Settings happens to list.

**All four are `live: false`, honestly.** The listener comes up when the window starts and the epoch
a connected phone holds is per server start, so turning one on mid-session would have to tear down
and rebuild something somebody is looking at. Saying *takes effect on restart* is the honest answer;
doing nothing and saying nothing is the setting Tade accepts and ignores.

**A new key here is a visible change**, so it redraws the README's pictures in the same commit
(`redraw-the-pictures`): the Settings category list grew past the rows the panel has, which is
correct (it scrolls) and moved every settings golden.

## What is not built, and must not arrive because a route was convenient

No setting is writable, nothing grants anything, nothing publishes, nothing starts an agent, nothing
runs a command, nothing reaches a credential and nothing reaches the `ToolHost` — which is a Unix
socket in `@tade/orchestrator` for the window's own children, and is **not this**
(`test/separation.test.ts`). Each of those is a `never remote` line with an argument behind it; if a
phase wants one, it gets its own setting in the `never` subtree, its own threat model and its own
go/no-go, not a route somebody added.

## `tade web`, and what it cannot do

`status`, `devices` and `revoke` read `config.yaml` and `web-devices.jsonl` **directly and never open
the workbench** — questions never need the window, and disconnecting a phone you have lost must not
depend on Tade being open. The file is append-only and keyed by device, so a line the terminal writes
and a line the window writes fold to the same answer whichever order they land in; nothing rewrites
it, which is what makes that true rather than lucky.

`off` is **two acts under one word**: the setting, and every credential. An "off" that leaves
credentials behind lets every phone that was ever paired straight back in when somebody turns it on
again next week.

`pair` **cannot mint a code**. A ticket lives in the memory of the process whose server has to claim
it, and there is no channel from a shell into the window — the `ToolHost` is a Unix socket for the
window's own child agents and must never become this. So it says which window is open and points at
the panel that mints one.

## The page, and what holds it

`test/design.test.ts` checks the design by **arithmetic over the production files**: every hex is the
xterm tone it names, every contrast ratio in a comment is the ratio the hex has, no text is under
13px, the gutter is `padding-inline` and no shorthand can zero it, every token used is declared and
every token declared is used, `--quiet` only appears in a rule that declares its own size, and the
one `outline: none` in the stylesheet is named with its argument.

`scripts/browser.ts` is the other half and it needs a real browser:

```
pnpm add -D -w playwright axe-core && pnpm exec playwright install chromium
node packages/web/scripts/browser.ts --shots /tmp/away
# or, with a Chrome the machine already has:
TADE_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  node packages/web/scripts/browser.ts
```

It pairs a device through the real page, visits every route at 360/834/1440, runs axe, and checks the
landmarks, the targets and that nothing scrolls sideways. **It pairs twice**: a device granted
nothing, which is what the honesty checks are for, and then one granted everything at the widest
width — because every figure draws differently with the grant, and the page with actual money,
notes and sign-ins on it is the one the owner will look at. **Neither is in the lockfile**, because
Playwright's install pulls hundreds of megabytes of browser onto every machine, and this repository
holds the line that `pnpm install` runs two scripts and installs nothing else. **With no browser it
reports `unrun` with the reason and exits 2** — never a pass. That property is what
`test/browser.test.ts` holds, offline, and it is the one that matters: an a11y harness that silently
found nothing and went green is worse than none.

## What a test here cannot prove

A real phone's camera reading the QR at the module size a terminal draws; iOS Safari's local-network
prompt; whether `.local` resolves on the owner's devices; whether a real reverse proxy passes a
stream through unbuffered; **whether the page is beautiful or useful**, which is the owner's after a
week; and how it behaves in Safari and Firefox — the harness drives Chromium, and the other two are
named rather than claimed. Each is **named as outstanding** rather than ticked. `test/qr.test.ts`
proves the *encoding* by decoding it with `jsqr`, which is a different codebase — that is the most a
machine here can say.

**A typed URL cannot pair.** The ticket is in the QR's fragment, so a person who types the address
reaches the pairing page with nothing to present and is told to scan the code in the window.
DESIGN §5.7 wanted a six-digit code as the typeable path; that is a second kind of credential with
its own threat model, and it is **not built** — outstanding, not decided against.
