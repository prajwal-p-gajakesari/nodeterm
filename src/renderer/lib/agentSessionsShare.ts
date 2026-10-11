// "Share session to repo" — the menu row's decision and the click's send, pure over injected reads.
//
// The row TYPES the agent's own agent-sessions push command into the node's pane, exactly as the
// user would (`@shared/agent-sessions` owns the text: a constant per agent, never `--yes`, never a
// title). What runs is then the AGENT's resolution of that name, and the summary, the redacted
// preview and the yes/no before committing are the agent-sessions SKILL's — nodeterm does not
// enforce them. So the row refuses a repository that ships its own copy (`RepoShadow`), and it is
// INERT when agent-sessions is absent: no row at all, not even a disabled one.
//
// Beyond that, the one thing this module must get right is the same thing the ⌘M composer must get
// right — never type into a pane that is not an idle agent at its prompt — and it does that with the
// composer's own gates, in the composer's order (`hostChatSend` is the other caller of the chain):
//
//   1. `chatSendRefusal` at click time (working / dialog / asleep / paused / dropped / exited —
//      `agentProcessInPane` ranks above the state), plus a held permission or question, which the
//      phone's send refuses too: text + Enter into a dialog ANSWERS it. And a session id: an agent
//      that has reported none has no conversation to share.
//   2. agent-sessions re-detected, with the repository re-checked for its own copy: a row built from
//      a stale answer never types.
//   3. `chatPaneRefusal`: for an agent that announces no quit (codex, opencode), the kernel's word
//      that the CLI still owns the pane — otherwise the command would run in a SHELL.
//   4. Step 1 again: the round trips above take time, and a turn or a dialog may have started.
//   5. `pty.sendChatPrompt`: core reads claude's screen first and refuses (nothing written) when its
//      own dialog owns the keyboard; claude's text is TYPED (TYPED_INPUT), every other agent's pasted.
//
// No queueing: unlike a chat message, a push command mid-turn is refused, not queued.
import type { AgentId } from '@shared/agents/config'
import {
  agentSessionsAgentOf,
  agentSessionsPresenceText,
  agentSessionsPushCommand,
  isSafeSharedSessionDir,
  repoShadowText,
  type AgentSessionsAgent,
  type AgentSessionsDetectResult,
  type AgentSessionsPresence,
  type RepoShadow,
  type SharedSession
} from '@shared/agent-sessions'
import { isChatPromptBlocked, TEXT_NOT_SUBMITTED, type ChatPromptResult } from '@shared/text-delivery'
import { chatSendRefusal, type ChatGateStatus, type ChatSendRefusal } from './chatSendGate'
import type { ChatPaneRefusal } from './chatPaneGate'
import type { RepoState } from '../state/agentSessions'

export const SHARE_SESSION_LABEL = 'Share session to repo'

/** The status slice the gates read (`AgentNodeStatus` fits it). */
export type ShareGateStatus = ChatGateStatus & { held?: unknown; sessionId?: string }

/** Why the row is off, in the order the reasons are checked: the permanent ones first, so a node
 *  whose project can never share does not first say "busy" and later "not a repository". */
export type ShareRowRefusal =
  | { kind: 'relay' }
  | { kind: 'ssh' }
  | { kind: 'no-folder' }
  | { kind: 'repo'; state: RepoState | undefined }
  | { kind: 'presence'; agent: AgentSessionsAgent; presence: Exclude<AgentSessionsPresence, 'present' | 'absent'> }
  | { kind: 'shadow'; shadow: RepoShadow | undefined }
  | { kind: 'no-session' }
  | { kind: 'state'; refusal: Exclude<ChatSendRefusal, null> }

export interface ShareRowInput {
  /** The agent the node was CREATED as (`createdAgentId`). */
  agentId: AgentId | undefined
  relay: boolean
  /** The node runs on an SSH host (`isRemoteSessionNode`), or its project is an SSH project. */
  remote: boolean
  projectCwd: string | undefined
  repo: RepoState | undefined
  /** agent-sessions in the user's own config for this agent + account; undefined = not read yet. */
  presence: AgentSessionsPresence | undefined
  /** A repository copy for this agent at the node's cwd; undefined = not read yet. */
  shadow: RepoShadow | undefined
  status: ShareGateStatus
}

/** The agent-state gate both the row and the click use: the composer's, a held ticket, and a
 *  session id to share. `null` = may type. */
export function shareStateRefusal(agentId: AgentId, st: ShareGateStatus): ShareRowRefusal | null {
  const state = chatSendRefusal(agentId, st)
  if (state !== null) return { kind: 'state', refusal: state }
  if (st.held) return { kind: 'state', refusal: 'dialog' }
  if (!st.sessionId) return { kind: 'no-session' }
  return null
}

/**
 * `null` = no row at all: an agent agent-sessions cannot push from, or agent-sessions NOT KNOWN TO BE
 * INSTALLED for this agent + account (absent, or not read yet — a user without the tool never sees
 * the row, not even disabled, and is never shown how to get it). Otherwise the row, disabled with the
 * first reason that applies: the permanent ones first, so a node whose project can never share does
 * not first say "busy" and later "not a repository".
 */
export function shareRowState(i: ShareRowInput): { refusal: ShareRowRefusal | null } | null {
  const agent = agentSessionsAgentOf(i.agentId)
  if (!agent || !i.agentId) return null
  if (i.presence === undefined || i.presence === 'absent') return null
  if (i.relay) return { refusal: { kind: 'relay' } }
  if (i.remote) return { refusal: { kind: 'ssh' } }
  if (!i.projectCwd) return { refusal: { kind: 'no-folder' } }
  if (i.repo !== 'repo') return { refusal: { kind: 'repo', state: i.repo } }
  if (i.presence !== 'present') return { refusal: { kind: 'presence', agent, presence: i.presence } }
  if (i.shadow !== 'none') return { refusal: { kind: 'shadow', shadow: i.shadow } }
  return { refusal: shareStateRefusal(i.agentId, i.status) }
}

/** The sentence a disabled row carries (its hover hint). */
export function shareRefusalText(r: ShareRowRefusal, agentLabel: string): string {
  switch (r.kind) {
    case 'relay':
      return 'Not available for relay sessions.'
    case 'ssh':
      return 'Not available for SSH projects yet — agent-sessions would have to run on the host.'
    case 'no-folder':
      return 'This project has no folder, so there is no repository to share into.'
    case 'repo':
      return r.state === undefined
        ? 'Checking whether this project is a git repository…'
        : r.state === 'unknown'
          ? 'Could not check whether this project is a git repository.'
          : 'This project’s folder is not a git repository.'
    case 'presence':
      return agentSessionsPresenceText(r.agent, r.presence)
    case 'shadow':
      return repoShadowText(r.shadow)
    case 'no-session':
      return 'Nothing to share yet — this session has not reported an id.'
    case 'state':
      switch (r.refusal) {
        case 'working':
          return `${agentLabel} is working — share once its turn is done.`
        case 'dialog':
          return `${agentLabel} is waiting for an answer in the terminal — answer it first.`
        case 'asleep':
          return `${agentLabel} is asleep to save memory — resume it first.`
        case 'paused':
          return `${agentLabel} is paused — resume it first.`
        case 'dropped':
          return `${agentLabel} is no longer running in this terminal — resume it first.`
        case 'exited':
          return `${agentLabel} has exited — relaunch it first.`
      }
  }
}

/** The enabled row's hint: what the click types, and whose confirmation follows — the skill's, in
 *  the session (nodeterm does not hold the push back itself). */
export function shareRowHint(agentId: AgentId): string {
  const command = agentSessionsPushCommand(agentId) ?? ''
  const typed = command.startsWith('/') || command.startsWith('$') ? `Types ${command}` : 'Asks the agent to use agent-sessions'
  return `${typed} in this session. agent-sessions writes a summary, shows a redacted preview and asks you there before it commits and pushes.`
}

/** The notice after the command was typed. */
export function shareSentNotice(agentLabel: string): string {
  return `Asked ${agentLabel} to share this session with agent-sessions — review its preview in the session and answer it there.`
}

export type ShareOutcome =
  | { kind: 'sent' }
  /** The text may be in the composer but its Enter was not confirmed: never retried. */
  | { kind: 'pasted-not-submitted'; text: string }
  /** Nothing was typed; `text` says why. */
  | { kind: 'refused'; text: string }
  /** The send started and its answer was lost: it may have been typed. Never retried. */
  | { kind: 'unconfirmed'; text: string }
  | { kind: 'busy' }

export interface ShareSendDeps {
  /** The node's agent status, read at CLICK time. */
  status(): ShareGateStatus
  /** Re-detect agent-sessions for the node's agent + account, WITH the node's cwd so core re-checks
   *  the repository for its own copy. */
  detect(agent: AgentSessionsAgent): Promise<AgentSessionsDetectResult>
  paneRefusal(): Promise<ChatPaneRefusal>
  sendChatPrompt(text: string): Promise<ChatPromptResult>
}

/** One share at a time per node: a typed send takes seconds, and a second click would type the
 *  command twice. */
const inFlight = new Set<string>()

export async function sendShareCommand(
  nodeId: string,
  agentId: AgentId,
  agentLabel: string,
  deps: ShareSendDeps
): Promise<ShareOutcome> {
  const agent = agentSessionsAgentOf(agentId)
  const command = agentSessionsPushCommand(agentId)
  if (!agent || !command) return { kind: 'refused', text: `${agentLabel} cannot share sessions with agent-sessions.` }
  if (inFlight.has(nodeId)) return { kind: 'busy' }
  inFlight.add(nodeId)
  try {
    const before = shareStateRefusal(agentId, deps.status())
    if (before) return { kind: 'refused', text: shareRefusalText(before, agentLabel) }
    let presence: AgentSessionsPresence
    let shadow: RepoShadow | undefined
    try {
      const r = await deps.detect(agent)
      presence = r.ok ? r.presence : 'unknown'
      shadow = r.ok ? r.shadow : undefined
    } catch {
      presence = 'unknown'
    }
    if (presence !== 'present') return { kind: 'refused', text: agentSessionsPresenceText(agent, presence) }
    // No answer about the repository is no clearance: only a definite `none` lets the command through.
    if (shadow !== 'none') return { kind: 'refused', text: repoShadowText(shadow ?? 'unknown') }
    let pane: ChatPaneRefusal
    try {
      pane = await deps.paneRefusal()
    } catch {
      pane = 'unverified'
    }
    if (pane) {
      return {
        kind: 'refused',
        text:
          pane === 'exited'
            ? `${agentLabel} is no longer running in this terminal — nothing was typed.`
            : `Could not confirm ${agentLabel} is running in this terminal — nothing was typed.`
      }
    }
    // Again, right before typing: the reads above took round trips, and a turn, a permission prompt
    // or a hibernation may have started meanwhile.
    const after = shareStateRefusal(agentId, deps.status())
    if (after) return { kind: 'refused', text: shareRefusalText(after, agentLabel) }
    let result: ChatPromptResult
    try {
      result = await deps.sendChatPrompt(command)
    } catch {
      // The call STARTED: a rejection may come after the text landed (a dropped IPC reply).
      return { kind: 'unconfirmed', text: TEXT_NOT_SUBMITTED }
    }
    if (isChatPromptBlocked(result)) {
      return {
        kind: 'refused',
        text:
          result.dialog === null
            ? `${agentLabel}’s input box isn’t on screen — nothing was typed. Check the terminal.`
            : `${agentLabel} is showing a dialog — nothing was typed. Answer it in the terminal first.`
      }
    }
    if (result === 'pasted-not-submitted') return { kind: 'pasted-not-submitted', text: TEXT_NOT_SUBMITTED }
    if (result !== true) return { kind: 'refused', text: `Could not type into ${agentLabel}’s session — nothing was sent.` }
    return { kind: 'sent' }
  } finally {
    inFlight.delete(nodeId)
  }
}

// ── "Continue shared session" (⌘K) ─────────────────────────────────────────────────────────────

/** The sessions a palette row may offer: a folder name that still passes the allowlist (re-checked
 *  here, the renderer's own belt over core's) and a summary to read first — a session without one
 *  has nothing for the continue prompt to point at. Core's order (newest first) is kept. */
export function continuableSharedSessions(items: readonly SharedSession[]): SharedSession[] {
  return items.filter((s) => isSafeSharedSessionDir(s.dir) && s.hasSummary)
}

/** `<title> (<author>, <agent>, <date>)` — every part is display text core already made one safe
 *  line; empty parts are left out rather than shown as blanks. */
export function sharedSessionPaletteLabel(s: SharedSession): string {
  const meta = [s.author, s.agentLabel, s.date].filter((x) => typeof x === 'string' && x.length > 0)
  const title = s.title || 'Untitled session'
  return meta.length ? `${title} (${meta.join(', ')})` : title
}
