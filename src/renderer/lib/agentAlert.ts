/**
 * What one agent turn-end / needs-you event does to the user: the unread record, the read ack, the
 * chime and the OS notification.
 *
 * Canvas's agent-status listener used to decide all four inline, in a closure inside a `useEffect`
 * no harness can dispatch at, so the only tests it could have were source pins. The decision is
 * lifted here so it can be pressed like any other function; the listener only gathers the facts
 * (window focus, which terminal is active, the cooldown stamps) and applies the answer.
 *
 * ## The two halves, and the line between them
 *
 * The unread dot and its ack are a RECORD: "something happened here while you were not looking".
 * The chime and the OS notification are INTERRUPTS. Issue #708's quiet rule (`fanoutStillWorking`)
 * and the handoff fold (`lib/handoffPings`) silence interrupts only — a dot is a different fact
 * from a chime, and suppressing the record to fix a noisy interrupt would trade a noisy bug for a
 * silent one. `decideAgentAlert` keeps that line: neither `quiet` nor the fold can reach
 * `markUnread` / `ackDone`.
 *
 * ## "Watching"
 *
 * A node is being WATCHED when the window has focus AND it is the terminal the user is in
 * (`agentStatus.activeId`). That is the unread rule's own definition, and nothing else here gets a
 * second one: a finish while you are in another terminal, or with the window in the background,
 * still flags unread.
 *
 * ## The OS notification, per kind
 *
 * A finish notifies under `notifyOnClaudeDone`, a needs-you under `notifyOnNeedsYou`; both need the
 * one-time consent answer (`notifyConsentAsked`). By default both are background-only — nothing pops
 * a banner over the window you are using. `notifyWhileFocused` (default off) lets a NEEDS-YOU alert
 * through while the window is focused, but never for the terminal you are watching (you can see the
 * prompt), and never for a finish (the chime already covers "a node you are not looking at
 * finished"). Main skips every notification while its window is focused unless the payload says
 * `force`, so the opt-in is the only branch that sets it: a background notification keeps
 * main's skip, which also covers the race where focus returns between this decision and the IPC.
 */

/** What happened: a turn finished (`done`), or the agent needs you (`waiting` / `blocked` — a
 *  question or an approval; the two alert identically). Same vocabulary as the chime (`SfxKind`). */
export type AgentAlertKind = 'done' | 'needsYou'

/** Per-node floor between two chimes, and between two OS notifications (separate clocks). */
export const ALERT_COOLDOWN_MS = 5000

/** The settings this decision reads — a structural slice of `Settings`. */
export interface AgentAlertPrefs {
  soundEffects: boolean
  notifyOnClaudeDone: boolean
  notifyOnNeedsYou: boolean
  notifyConsentAsked: boolean
  notifyWhileFocused: boolean
}

export interface AgentAlertInput {
  kind: AgentAlertKind
  /** `document.hasFocus()` when the event lands. */
  windowFocused: boolean
  /** This node is the terminal the user is in (`agentStatus.activeId === nodeId`). */
  activeNode: boolean
  /** Issue #708: the parent still holds working subagent cards. Silences the interrupts only. */
  quiet?: boolean
  /**
   * Did a handoff ping just announce this turn end (`suppressDoneAfterHandoff`)? A CALLBACK, not a
   * boolean, because asking CONSUMES the fold: it is asked only for a `done` that would otherwise
   * interrupt — a quiet fan-out turn must leave the fold for the turn end it was armed for.
   */
  handoffFolded?: () => boolean
  prefs: AgentAlertPrefs
  now: number
  /** When this node last chimed / last raised an OS notification (absent = never). */
  lastSoundAt?: number
  lastNotifyAt?: number
}

export interface AgentAlertDecision {
  /** Flag the node unread (it finished or needs you while you were not watching it). */
  markUnread: boolean
  /** Ack a finish the user watched happen, so the notch / phone stop glowing for it. */
  ackDone: boolean
  /** Play the chime for this kind. The caller stamps the sound cooldown when it does. */
  sound: boolean
  /** Raise an OS notification. The caller stamps the notification cooldown when it does. */
  notify: boolean
  /** Send it with `force`, past main's focused-window skip (the `notifyWhileFocused` branch only). */
  force: boolean
}

export function decideAgentAlert(i: AgentAlertInput): AgentAlertDecision {
  const watching = i.windowFocused && i.activeNode
  // Watched it finish? Then it is already read. Nothing marks it unread in this branch, so without
  // an explicit ack there would never BE a read signal — and the notch capsule's green blob and the
  // phone's Live Activity would keep glowing for a turn the user sat and watched end.
  const record = { markUnread: !watching, ackDone: watching && i.kind === 'done' }
  const silent: AgentAlertDecision = { ...record, sound: false, notify: false, force: false }
  // Everything below is an INTERRUPT, and this is where a quiet alert stops.
  if (i.quiet) return silent
  // An agent that just filed its card into a handoff column was already announced to the assignee;
  // its turn end seconds later is the same moment. Asked only here, for the reason on the field.
  if (i.kind === 'done' && i.handoffFolded?.()) return silent
  // Sound fires whether or not the window is focused: it is the one alert that catches a finish
  // while you are in the app but looking at another node.
  const sound = !!i.prefs.soundEffects && cooledDown(i.now, i.lastSoundAt)
  // OS notification: this kind's toggle, the consent answer, and the per-node cooldown.
  const wanted = i.kind === 'done' ? !!i.prefs.notifyOnClaudeDone : !!i.prefs.notifyOnNeedsYou
  if (!wanted || !i.prefs.notifyConsentAsked || !cooledDown(i.now, i.lastNotifyAt))
    return { ...record, sound, notify: false, force: false }
  // The window is in the background: the ordinary case, no `force`.
  if (!i.windowFocused) return { ...record, sound, notify: true, force: false }
  // Focused: only the opt-in, only for needs-you, and never for the node being watched. `=== true`
  // because this loosens a default — a hand-edited non-boolean must read as OFF.
  const focusedOptIn = i.kind === 'needsYou' && !watching && i.prefs.notifyWhileFocused === true
  return { ...record, sound, notify: focusedOptIn, force: focusedOptIn }
}

/**
 * The settings one consent answer writes. Every place that answers the one-time question — the
 * first-run dialog (recorded as declined before it opens; its Enable answers yes), the setup tour's
 * step, the tour's skip, and a Settings switch flipped before any of those (`notifyTogglePatch`) —
 * answers BOTH notification kinds through this, so a user who never said yes cannot be left with
 * one of them on at its shipped default.
 */
export function notifyConsentPatch(enable: boolean): {
  notifyConsentAsked: true
  notifyOnClaudeDone: boolean
  notifyOnNeedsYou: boolean
} {
  return { notifyConsentAsked: true, notifyOnClaudeDone: enable, notifyOnNeedsYou: enable }
}

/**
 * What one Settings → Notifications switch writes. Once the consent question is answered, only its
 * own key. Before that, flipping a switch IS the answer, and it must answer for the other kind
 * too: both ship ON, so writing `{ [key]: on, notifyConsentAsked: true }` alone left the other kind
 * on for someone who never pressed Enable — and the tour's skip, seeing the question answered,
 * would not decline it either. The other kind is recorded as declined; its switch shows that.
 */
export function notifyTogglePatch(
  key: 'notifyOnClaudeDone' | 'notifyOnNeedsYou',
  on: boolean,
  consentAsked: boolean
): Partial<ReturnType<typeof notifyConsentPatch>> {
  return consentAsked ? { [key]: on } : { ...notifyConsentPatch(false), [key]: on }
}

function cooledDown(now: number, last: number | undefined): boolean {
  return last === undefined || now - last >= ALERT_COOLDOWN_MS
}
