// The sentences about the away view that have to be said where somebody is
// deciding, and that may never get more comfortable.
//
// **Why they live in the domain and not in `@tade/web`.** Three of them belong
// on a *control*: the one that turns a LAN bind on, and the one that lists the
// devices that have been let in. A control's words are a `Setting`'s `means`
// (`settings.ts`), and `@tade/core` cannot import `@tade/web` — the arrow goes
// the other way and a test holds it. So the choice was a second spelling of
// each sentence beside the control, or one spelling here with `@tade/web`
// re-exporting it. A second spelling is the exact failure these sentences
// exist to prevent: somebody edits the one on the page, the comfortable half
// survives, and the honest half is still true in a file nobody reads.
//
// This is `KEYS_AND_AGENTS`'s treatment (`secrets.ts`) applied to the same
// kind of claim, and said the same way round: **the fact, then the way out, in
// one breath.** A warning with nothing to do about it is one people learn to
// scroll past.
//
// `packages/web/test/separation.test.ts` holds each of them to its words.

/**
 * What is true of a `lan` bind, said on the control that turns one on.
 *
 * It does not say "use HTTPS for security"; it says what anybody on the wifi
 * can read, because the person deciding has to be able to picture it. And the
 * way out is in the same breath.
 */
export const LAN_IS_PLAINTEXT =
  'On your network this is plain HTTP: anybody on the same wifi can read every page it serves ' +
  'and the session cookie with it. `tailscale serve localhost:7654` gives a phone HTTPS while ' +
  'Tade keeps listening on this machine alone, which is a smaller surface than this one.'

/**
 * Why a cookie prefix is not the answer to a port, said where somebody would
 * otherwise believe it is.
 *
 * `__Host-` requires `Secure`, `Path=/` and no `Domain`, and gives real
 * guarantees about all three. It gives **nothing** about ports: RFC 6265 §8.5
 * is unchanged by it. So the honest mitigations are named instead, and this
 * sentence exists because "the prefix fixes it" is what a reader of the
 * attribute list would conclude.
 */
export const COOKIES_IGNORE_PORTS =
  'Cookies are not isolated by port, and no cookie prefix changes that: anything else listening ' +
  'on this address can be sent this session cookie, and can overwrite it. What stands against ' +
  'that is the session being bound to the exact host it was paired for, and TLS, which removes ' +
  'the plaintext the other thing would be reading.'

/**
 * What `HttpOnly` does and what it does not, said once because the short
 * version of it is wrong.
 *
 * It stops a script *reading* the cookie. It does not stop injected script
 * calling `fetch` from the page's own origin with the page's own token — so it
 * is not a defence against cross-site scripting, only against the theft of a
 * credential. What is a defence is the page never building markup: no
 * `innerHTML`, no Markdown, a content policy with nothing inline.
 */
export const HTTPONLY_IS_NOT_XSS =
  'HttpOnly keeps a script from reading this session cookie. It does not keep one from using it: ' +
  'script that got onto the page can call Tade with the page’s own credentials. What stands ' +
  'against that is that the page builds no markup at all.'

/**
 * What is true of every paired device, said wherever one is granted or listed.
 *
 * The same treatment `KEYS_AND_AGENTS` gets, for the same reason: the fact,
 * then the way out, in one breath. Nothing in the file can answer it, so it is
 * said instead.
 */
export const DEVICES_AND_AGENTS =
  'Paired devices and the digests of their credentials live in `web-devices.jsonl`, `0600` — ' +
  'which keeps them from other people, and an agent is not another person. An agent on this ' +
  'machine runs as you with nothing containing it, so it can append a line to that file and pair ' +
  'itself. What stands against that: the device list here shows every device there is, every act ' +
  'one takes is in the journal under its id, and “Disconnect everything” needs no network.'

/** The short clause, for the one line a control gets. */
export const DEVICES_SEEN_BY_AGENTS = 'an agent on this machine could pair itself'

/**
 * What the away view is, said where somebody is turning it on.
 *
 * The two facts a person needs before the switch and not after it: that it
 * dies with the window, so a bookmark tapped with Tade closed is a connection
 * error and not an empty control room; and that it can change nothing, which
 * is what makes turning it on a small decision.
 */
export const AWAY_IS_WHILE_OPEN =
  'The away view answers only while this window is open: close Tade and nothing is listening, ' +
  'which is also why closing Tade is harmless.'
