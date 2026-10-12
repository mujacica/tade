import {
  ACTING_IS_NOT_YOU,
  ACTING_IS_NOT_YOU_SHORT,
  AWAY_IS_WHILE_OPEN,
  DEVICES_SEEN_BY_AGENTS,
  DRAFTS_ARE_NOT_PUBLISHED,
  DRAFTS_ARE_NOT_PUBLISHED_SHORT,
  INSTALLED_IS_NOT_REVOCABLE,
  LAN_IS_PLAINTEXT,
  LAST_VIEW_IS_A_COPY,
  LAST_VIEW_IS_A_COPY_SHORT,
  OFFLINE_NEEDS_HTTPS,
  OFFLINE_NEEDS_HTTPS_SHORT,
  PUSH_GOES_THROUGH_A_STRANGER,
  PUSH_GOES_THROUGH_A_STRANGER_SHORT,
  PUSH_IS_WHILE_OPEN,
  PUSH_KEY_IS_GENERATED,
  PUSH_NEEDS_A_GESTURE,
  PUSH_NEEDS_A_GESTURE_SHORT,
  PUSH_SAYS_NOTHING,
  PUSH_SAYS_NOTHING_SHORT,
  SETTINGS_FROM_AWAY,
  SETTINGS_FROM_AWAY_SHORT,
} from './away.ts'
import type { Config } from './config.ts'
import { TALKING_IS_NOT_YOU, TALKING_IS_NOT_YOU_SHORT } from './origin.ts'
import { KEYS_AND_AGENTS, SEEN_BY_AGENTS } from './secrets.ts'
import type { SettingGroup } from './settings.ts'

/** The heading the capability rows are drawn under: what a paired device may do. */
export const DEVICE_MAY = 'A paired device may'

// The away view's thirteen controls, as a person changes them.
//
// Its own half of `settingsOf`, split off for the reason the projects half
// was: that file reached the size a file is allowed to be. It is a seam rather
// than a cut — these are exactly the keys under `reach.ts`'s `surfaces.web`
// subtree, all but `install` and `offline` refused to the orchestrator, and
// exactly the ones whose `means` carries a
// sentence the domain says once (`away.ts`) so that no control can say the
// comfortable half of it.
//
// **The page is names and values.** A row's title is what it is — the
// capability rows are short verbs under one heading (`DEVICE_MAY`) rather than
// eight sentences that each began *Let a paired device* and were cut off — and
// what one does is `short`, drawn only under the row you are on. `means` keeps
// the whole of it, every domain sentence included, because it is still what
// search, `tade config` and `tade_settings` read.
//
// **Nine of the thirteen are `live: false`, honestly.** The route table is
// built when the listener comes up, and the epoch a connected phone holds is
// per server start — so changing one under a running listener would have to
// tear down and rebuild something somebody is looking at. Saying *takes effect
// on restart* is the honest answer; doing nothing and saying nothing is the
// setting Tade accepts and ignores.
//
// **`enabled` is `live: true`**, because there is nothing to tear down in the
// direction people press it: off to on brings the listener up with whatever the
// rest says, and on to off closes it, which is the direction that takes
// authority away and is owed at once (`Away.follow`). **The three push ones and
// the key are `live: true` too**: a notification is not a route, it is decided
// on the window's own beat out of the config the window holds, so there is no
// table built at start-up for a change to be behind.

export function awayGroup(config: Config): SettingGroup {
  const web = config.surfaces.web
  return {
    id: 'away',
    title: 'Away view',
    about: `One page, served from this machine, to a device you pair by scanning the code this page shows once it is on, or by opening its link. It shows what is working, what is queued, what is stopped and what it cost; anything a device may change beyond that is granted per device, at this machine. ${AWAY_IS_WHILE_OPEN} Off by default and everything under it on, so turning it on is the one click — and ${DEVICES_SEEN_BY_AGENTS}, which is why the device list shows every device there is.`,
    keywords: [
      'away',
      'web',
      'phone',
      'mobile',
      'browser',
      'remote',
      'page',
      'server',
      'listen',
      'port',
      'pair',
      'pairing',
      'qr',
      'code',
      'link',
      'url',
      'device',
      'devices',
      'lan',
      'tailscale',
      'proxy',
      'https',
      'act',
      'acting',
      'ask',
      'talk',
    ],
    settings: [
      {
        path: 'surfaces.web.enabled',
        title: 'Serve the away view',
        means:
          'on: listening now, while the window is open, with the code and link to pair a device shown here; off: nothing is listening at all',
        short: 'on: listening while this window is open, with the code to pair shown here',
        value: String(web.enabled),
        fallback: 'false',
        type: { kind: 'flag' },
        // `true` both ways (`Away.follow`): off to on has no listener to tear
        // down, and on to off is the direction owed at once.
        live: true,
      },
      {
        path: 'surfaces.web.bind',
        // Deliberately a *second* decision from `enabled`, which is why it is
        // a second row rather than a third option on the first one: "on" and
        // "on the network" being one control is how a laptop in a café ends
        // up serving its control room to the café.
        title: 'Who can reach it',
        means: `loopback: this machine alone, which is what a tunnel or tailscale serve connects to; lan: every interface, in the clear. ${LAN_IS_PLAINTEXT}`,
        short:
          'loopback: this machine, and a tunnel to it; lan: your network, in the clear, and never to act',
        value: web.bind,
        fallback: 'loopback',
        type: { kind: 'choice', options: ['loopback', 'lan'] },
        live: false,
        keywords: ['network', 'wifi', 'plaintext', 'interface', 'expose'],
      },
      {
        path: 'surfaces.web.port',
        title: 'Port',
        means:
          'the port it listens on, and the one the pairing code carries. Already in use is said and nothing listens — never a quiet bind somewhere else',
        short: 'what it listens on and the code carries; one in use is said, never swapped',
        value: String(web.port),
        fallback: '7654',
        type: { kind: 'number' },
        live: false,
      },
      {
        path: 'surfaces.web.trusted_hosts',
        title: 'Trusted hostnames',
        means:
          'names beyond this machine’s own addresses that may reach it — a tailnet name, a tunnel. This is also the only way an https origin off this machine is trusted, because no forwarded header is ever read: a proxy is trusted by being named here, never by what it writes in a header',
        short: 'a tailnet or tunnel name: the only way an https origin off this machine is trusted',
        value: web.trusted_hosts.join(' '),
        fallback: 'none',
        type: { kind: 'text', placeholder: 'studio.yak-bebop.ts.net' },
        live: false,
        keywords: ['tailscale', 'tailnet', 'tunnel', 'cloudflare', 'reverse proxy', 'origin'],
      },
      {
        path: 'surfaces.web.push_key',
        // The key, shown as itself like every other key Tade keeps, and the
        // only one that is **generated** rather than pasted — which is why its
        // own sentence is here as well as `KEYS_AND_AGENTS`. Clearing it is
        // the revocation lever, and the row says so, because a field nobody
        // can see the point of is a field somebody pastes something into.
        title: 'Notification signing key',
        short: `${SEEN_BY_AGENTS}; generated here, and clearing it revokes every subscription`,
        means: `${PUSH_KEY_IS_GENERATED} ${KEYS_AND_AGENTS}`,
        value: web.push_key,
        fallback: 'generated when it is first needed',
        type: { kind: 'text', placeholder: 'generated — clear this to mint a new one' },
        live: true,
        keywords: ['vapid', 'key', 'secret', 'sign', 'signing', 'revoke', 'rotate'],
      },
      {
        path: 'surfaces.web.acting',
        // A **third** decision, and a row of its own for the same reason
        // `bind` is one: reading from the sofa and changing work from anywhere
        // are different things to want, and a control that granted both at
        // once would be a yes to a question nobody was asked. Still not
        // enough on its own — a device needs the scope you grant it in the
        // away panel, and the request needs this machine or an https host you
        // named — which is why the sentence says what acting can never reach
        // rather than leaving it to be inferred.
        title: 'Act',
        section: DEVICE_MAY,
        short: `answer, steer and queue, once granted per device; ${ACTING_IS_NOT_YOU_SHORT}`,
        means: `on: a device you have granted it can answer an approval, tell an agent something, change what is queued, mark work finished, write a note, add to what a task is told, and approve a request a grant here already allowed — and, granted those too, stop or reopen an agent and close or reopen a project; off: there is no route to do any of it. ${ACTING_IS_NOT_YOU}`,
        value: String(web.acting),
        fallback: 'true',
        type: { kind: 'flag' },
        // `false` like the rest, and honestly asymmetric: turning it **on**
        // needs a restart because the route table is built with the listener,
        // and turning it **off** is read at every act, so the direction that
        // takes authority away is immediate. Said that way round rather than
        // claimed to be live.
        live: false,
        keywords: ['act', 'acting', 'approve', 'steer', 'park', 'change', 'answer', 'verb'],
      },
      {
        path: 'surfaces.web.orchestrator',
        // A **fourth** decision, and the one that must never share a switch
        // with Acting. Acting's verbs each name a target and the state they
        // expect; this hands free text to a model that holds tools, which is
        // the difference between answering a question and being able to ask
        // for anything. The sentence says what the narrowing is rather than
        // promising the model behaves, because a paragraph in a prompt is
        // information and this is the control somebody decides on.
        title: 'Talk to Tade',
        section: DEVICE_MAY,
        short: `send it a message, once granted; ${TALKING_IS_NOT_YOU_SHORT}`,
        means: `on: a device you have granted it can send a message into the same conversation you type into, and is answered in words; off: there is no route to send one. ${TALKING_IS_NOT_YOU}`,
        value: String(web.orchestrator),
        fallback: 'true',
        type: { kind: 'flag' },
        // `false` like the rest, and asymmetric the same way `acting` is:
        // turning it on needs a restart because the route table is built with
        // the listener, and turning it off is read at every turn — so the
        // direction that takes authority away is immediate.
        live: false,
        keywords: ['ask', 'talk', 'chat', 'message', 'orchestrator', 'conversation', 'prompt'],
      },
      {
        path: 'surfaces.web.drafts',
        // A **fifth** decision, and a row of its own rather than a clause on
        // Acting: Acting's verbs are about work that already exists, and this
        // writes a file every future run of a workflow would be stamped from
        // once somebody here publishes it. The sentence names what it cannot
        // reach, because *bounded* is the word a comfortable version of it
        // would keep while dropping the bound.
        title: 'Save draft workflows',
        section: DEVICE_MAY,
        short: `fill in a drafted workflow a field at a time; ${DRAFTS_ARE_NOT_PUBLISHED_SHORT}`,
        means: `on: a device you have granted it can fill in one field at a time of a workflow that is already drafted; off: there is no route to save one. ${DRAFTS_ARE_NOT_PUBLISHED}`,
        value: String(web.drafts),
        fallback: 'true',
        type: { kind: 'flag' },
        // `false` like the rest, and asymmetric the same way: on waits for the
        // route table the listener builds, off is read at every save.
        live: false,
        keywords: ['draft', 'drafts', 'workflow', 'template', 'designer', 'edit', 'form'],
      },
      {
        path: 'surfaces.web.settings',
        // A **tenth** decision, and a row of its own rather than a clause on
        // Acting: Acting's verbs are about work, and this writes the config.
        // The sentence is the list of what it reaches, because *only the
        // harmless ones* is the word a comfortable version would keep.
        title: 'Change settings',
        section: DEVICE_MAY,
        short: `once granted per device; ${SETTINGS_FROM_AWAY_SHORT}`,
        means: `on: a device you have granted it can change the few settings an ordinary request is enough for; off: there is no route to change one. ${SETTINGS_FROM_AWAY}`,
        value: String(web.settings),
        fallback: 'true',
        type: { kind: 'flag' },
        // `false` like the rest, and asymmetric the same way: on waits for the
        // route table the listener builds, off is read at every change.
        live: false,
        keywords: ['settings', 'config', 'configure', 'setting', 'preferences'],
      },
      {
        path: 'surfaces.web.install',
        // A **sixth** decision, and the first one whose effect is on somebody
        // else's hardware. The row says what is put there — the page, and
        // nothing of the work — and then the two things a person cannot find
        // out by trying it: that a browser refuses all of it off a secure
        // origin, and that turning it off again is something a device has to
        // be *told*, which happens when it next reaches this machine.
        title: 'Install the page',
        section: DEVICE_MAY,
        short: `on a home screen, never your work; ${OFFLINE_NEEDS_HTTPS_SHORT}`,
        means: `on: a paired device can add this to a home screen and open it with nothing to ask, showing the page and never your work; off: a device that installed it is served a worker that removes it again. ${OFFLINE_NEEDS_HTTPS} ${INSTALLED_IS_NOT_REVOCABLE}`,
        value: String(web.install),
        fallback: 'true',
        type: { kind: 'flag' },
        // `false` like the rest, and honestly so: what `/sw.js` answers with
        // is built when the listener comes up, so both directions wait for a
        // restart — and then the *device* waits until it next reaches this
        // machine, which is said in the sentence rather than implied.
        live: false,
        keywords: [
          'install',
          'pwa',
          'offline',
          'home screen',
          'icon',
          'manifest',
          'service worker',
          'cache',
          'standalone',
        ],
      },
      {
        path: 'surfaces.web.offline',
        // A **seventh** decision, under the sixth rather than beside it: this
        // is for the cold open and there is no cold open without a shell to
        // open. The sentence is a *list* of what is kept, because minimal and
        // redacted are the words a comfortable version of it would keep while
        // dropping what was actually on the disk.
        title: 'Keep its last view',
        section: DEVICE_MAY,
        short: `opens offline on ${LAST_VIEW_IS_A_COPY_SHORT}`,
        means: `on: an installed device keeps a few counts and the moment they were true, so opening it with nothing to ask says what it last knew; off: it opens with nothing. ${LAST_VIEW_IS_A_COPY}`,
        value: String(web.offline),
        fallback: 'true',
        type: { kind: 'flag' },
        // `false` like the rest. Turning it off clears what is on a device the
        // next time that device reaches this machine, which is the same
        // *told, not assumed* rule the row above has.
        live: false,
        keywords: ['offline', 'cache', 'last seen', 'counts', 'stale', 'train', 'aeroplane'],
      },
      {
        path: 'surfaces.web.push',
        // An **eighth** decision, under the sixth: a notification is delivered
        // to a service worker, and there is no worker without the shell that
        // registers one. The row says the two things a person cannot find out
        // by trying it — that this is only half the switch, and that a closed
        // laptop sends nothing — and says them before the switch rather than
        // after it.
        title: 'Get notifications',
        section: DEVICE_MAY,
        short: `${PUSH_GOES_THROUGH_A_STRANGER_SHORT}; ${PUSH_NEEDS_A_GESTURE_SHORT}`,
        means: `on: a device that installed this and allowed notifications is sent one when work wants you, gets stuck, goes red or finishes — ${PUSH_SAYS_NOTHING_SHORT}; off: nothing is sent. ${PUSH_NEEDS_A_GESTURE} ${PUSH_GOES_THROUGH_A_STRANGER} ${PUSH_IS_WHILE_OPEN}`,
        value: String(web.push),
        fallback: 'true',
        type: { kind: 'flag' },
        // `true`, and honestly: a notification is decided on the window's own
        // beat out of the config it holds, so there is no start-up table for
        // either direction to wait behind.
        live: true,
        keywords: [
          'push',
          'notification',
          'notifications',
          'alert',
          'alerts',
          'notify',
          'badge',
          'lock screen',
          'vapid',
          'web push',
          'apns',
          'fcm',
        ],
      },
      {
        path: 'surfaces.web.push_details',
        // A **ninth** decision, under the eighth, and a row of its own rather
        // than a clause on it: *send me notifications* and *put the name of my
        // work on a lock screen* are different things to want, and a control
        // that granted both at once would be a yes to a question nobody was
        // asked. The sentence is the list of what is sent, because *generic*
        // is the word a comfortable version of it would keep.
        title: 'Get work names in them',
        section: DEVICE_MAY,
        short: 'the name of the work on a lock screen, never more than that device may read',
        means: `on: a notification carries the name of the piece of work it is about; off: it carries a count and no text at all. ${PUSH_SAYS_NOTHING} It can never say more than that device was granted to read.`,
        value: String(web.push_details),
        fallback: 'true',
        type: { kind: 'flag' },
        live: true,
        keywords: ['details', 'payload', 'title', 'generic', 'redacted', 'privacy', 'lock screen'],
      },
    ],
  }
}
