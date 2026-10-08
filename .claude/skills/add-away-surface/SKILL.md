---
name: add-away-surface
description: Add or change what the away view serves — a route, a read scope, a device grant, the pairing flow, the session credential, or what the guard asks of a request. Use when a phone should be able to read or do something it cannot, when a security claim about the away view needs changing, or when something about pairing, sessions or devices does the wrong thing.
---

# Changing what the away view serves

The away view is `packages/web`: a contract, a pure projection, and a `node:http` server behind
pairing, a session and a guard. **It is off by default and listens on this machine alone**, and
turning either of those round is a person's act with its own setting in `reach.ts`'s `never` subtree.

| Changing | File |
|---|---|
| a route | `src/routes.ts`, then the `switch` in `src/server.ts` |
| what a request must satisfy | `src/guard.ts` — pure, and `test/guard.test.ts` runs the cross-product |
| what a device may read | `src/reach.ts` (the grants), `src/surface.ts`'s `reachOf` (the seam) |
| the pairing exchange | `src/tickets.ts` (the burn), `server.ts`'s `pair` |
| the credential | `src/sessions.ts` |
| the device list | `src/devices.ts` — `<home>/web-devices.jsonl` |
| the headers and the content policy | `src/headers.ts` |
| what a refusal says | `src/errors.ts` |
| the config | `surfaces.web` in `packages/core/src/config.ts`, read only by `surfaceOf` |
| the browser's files | `src/assets/` — `.html`/`.css`/`.js` only, **never `.ts`** |

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
- **No forwarded header is ever read** (`NEVER_TRUSTED`). There is no reverse proxy in front of this,
  so `X-Forwarded-Host` walks past the `Host` allow-list (the rebinding defence), `X-Forwarded-Proto`
  makes a plaintext session look trusted enough to act, and `X-Forwarded-For` makes the rate limit and
  the journalled address whatever the attacker typed. The address is the socket's and the host is
  `Host`.
- **`Sec-Fetch-Site` is not checked on a document navigation.** A scanned code is a typed URL
  (`none`) and a followed link is `cross-site`, so requiring `same-origin` on the shell refuses every
  real way in. Everything else — every `fetch` the page makes — is checked.
- **The pairing ticket is burned on the *claim*, before anybody at the machine is asked.** That one
  ordering is what makes a replay, a concurrent attempt, a refusal, a deadline and a throw all find
  nothing. The tempting shape — check, ask, then delete on success — is wrong in all five ways.
- **A body of `null` is a body.** `read` returns a discriminated answer, because `unknown | null`
  made a four-byte `null` indistinguishable from "already refused" and held the request open for ever.
- **No handler does any work.** No `git`, no `ps`, no spawn, no file read but the device list: every
  read answers from what the window already holds, through `WebReading`. The window draws on this
  thread.
- **A read scope is per device, so the projection is built per device** (`readingFor(reach)`).
  Filtering one projection afterwards is how a field that should have been withheld rides along.
- **`bind: lan` is a read-only transport** (`scopesOn`). A credential that crossed a network in the
  clear never buys an act, whatever is turned on later — and it is **re-asked at the act**, because
  the network a device is on changes.
- **A `.ts` file in `src/assets/` is renamed to `.js` at publish**, so it is served under one name here
  and another on somebody else's machine. `git add` every asset, too: staging copies only
  `git ls-files` output, so an un-added `.css` is a page with no styles everywhere but here.
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

## The config, and why Settings has no field for it yet

`surfaces.web` is read in exactly one place — `surfaceOf` — and its four keys are `never` in
`reach.ts`. **Settings deliberately offers no control for them**, and that is not an oversight: the
listener they turn on is wired into the window by `away-stream-and-window`, and a control marked
*takes effect on restart* that does nothing after a restart is precisely "a setting Tade accepts and
ignores". The field lands in the slice that makes it true. A tier is a property of the path, so the
keys are refused to the orchestrator either way (`packages/core/test/reach.test.ts` says so
directly, rather than through what Settings happens to list).

**Adding the field is a visible change**, so it redraws the README's pictures in the same commit
(`redraw-the-pictures`) — a new Settings category pushes the list past the rows the panel has, which
is correct (it scrolls) and moves every settings golden.

## What is not built, and must not arrive because a route was convenient

No setting is writable, nothing grants anything, nothing publishes, nothing starts an agent, nothing
runs a command, nothing reaches a credential and nothing reaches the `ToolHost` — which is a Unix
socket in `@tade/orchestrator` for the window's own children, and is **not this**
(`test/separation.test.ts`). Each of those is a `never remote` line with an argument behind it; if a
phase wants one, it gets its own setting in the `never` subtree, its own threat model and its own
go/no-go, not a route somebody added.

## What a test here cannot prove

A real phone's camera reading the QR at the module size a terminal draws; iOS Safari's local-network
prompt; whether `.local` resolves on the owner's devices. Each is **named as outstanding** rather than
ticked. `test/qr.test.ts` proves the *encoding* by decoding it with `jsqr`, which is a different
codebase — that is the most a machine here can say.
