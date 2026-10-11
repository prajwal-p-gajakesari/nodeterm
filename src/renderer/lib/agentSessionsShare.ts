// "Share session to repo" — the menu row's decision and the click's send, pure over injected reads.
//
// The row TYPES the agent's own agent-sessions push command into the node's pane, exactly as the
// user would (`@shared/agent-sessions` owns the text: a constant per agent, never `--yes`, never a
// title). The agent then writes its summary, renders the redacted transcript and shows a preview;
// nothing is committed or pushed until the user says yes INSIDE the session. So the one thing this
// module must get right is the same thing the ⌘M composer must get right — never type into a pane
// that is not an idle agent at its prompt — and it does that with the composer's own gates, in the
// composer's order (`hostChatSend` is the other caller of the same chain):
//
//   1. `chatSendRefusal` at click time (working / dialog / asleep / paused / dropped / exited —
//      `agentProcessInPane` ranks above the state), plus a held permission or question, which the
//      phone's send refuses too: text + Enter into a dialog ANSWERS it.
//   2. agent-sessions re-detected: a row built from a stale "present" never types a command the
//      agent no longer has.
//   3. `chatPaneRefusal`: for an agent that announces no quit (codex, opencode), the kernel's word
//      that the CLI still owns the pane — otherwise the command would run in a SHELL.
//   4. `pty.sendChatPrompt`: core reads claude's screen first and refuses (nothing written) when its
//      own dialog owns the keyboard; claude's text is TYPED (TYPED_INPUT), every other agent's pasted.
//
// No queueing: unlike a chat message, a push command mid-turn is refused, not queued.
import type { AgentId } from '@shared/agents/config'
import {
  agentSessionsAgentOf,
  agentSessionsInstallHint,
  agentSessionsPushCommand,
  isSafeSharedSessionDir,
  type AgentSessionsAgent,
  type AgentSessionsDetectResult,
  type AgentSessionsPresence,
  type SharedSession
} from '@shared/agent-sessions'
import { isChatPromptBlocked, TEXT_NOT_SUBMITTED, type ChatPromptResult } from '@shared/text-delivery'
import { chatSendRefusal, type ChatGateStatus, type ChatSendRefusal } from './chatSendGate'
import type { ChatPaneRefusal } from './chatPaneGate'
import type { RepoState } from '../state/agentSessions'

export const SHARE_SESSION_LABEL = 'Share session to repo'

/** The status slice the gates read (`AgentNodeStatus` fits it). */
export type ShareGateStatus = ChatGateStatus & { held?: unknown }

/** Why the row is off, in the order the reasons are checked: the permanent ones first, so a node
 *  whose project can never share does not first say "busy" and later "not a repository". */
export type ShareRowRefusal =
  | { kind: 'relay' }
  | { kind: 'ssh' }
  | { kind: 'no-folder' }
  | { kind: 'repo'; state: RepoState | undefined }
  | { kind: 'presence'; agent: AgentSessionsAgent; presence: AgentSessionsPresence | undefined }
  | { kind: 'state'; refusal: Exclude<ChatSendRefusal, null> }

export interface ShareRowInput {
  /** The agent the node was CREATED as (`createdAgentId`). */
  agentId: AgentId | undefined
  relay: boolean
  /** The node runs on an SSH host (`isRemoteSessionNode`), or its project is an SSH project. */
  remote: boolean
  projectCwd: string | undefined
  repo: RepoState | undefined
  presence: AgentSessionsPresence | undefined
  status: ShareGateStatus
}

/** `null` = no row at all (an agent agent-sessions cannot push from, or not an agent). */
export function shareRowState(i: ShareRowInput): { refusal: ShareRowRefusal | null } | null {
  const agent = agentSessionsAgentOf(i.agentId)
  if (!agent || !i.agentId) return null
  if (i.relay) return { refusal: { kind: 'relay' } }
  if (i.remote) return { refusal: { kind: 'ssh' } }
  if (!i.projectCwd) return { refusal: { kind: 'no-folder' } }
  if (i.repo !== 'repo') return { refusal: { kind: 'repo', state: i.repo } }
  if (i.presence !== 'present') return { refusal: { kind: 'presence', agent, presence: i.presence } }
  const state = chatSendRefusal(i.agentId, i.status)
  if (state !== null) return { refusal: { kind: 'state', refusal: state } }
  if (i.status.held) return { refusal: { kind: 'state', refusal: 'dialog' } }
  return { refusal: null }
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
      return r.presence === undefined
        ? 'Checking whether agent-sessions is installed…'
        : agentSessionsInstallHint(r.agent, r.presence)
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

/** The enabled row's hint: what the click does, and that nothing leaves without the user's yes. */
export function shareRowHint(agentId: AgentId): string {
  const command = agentSessionsPushCommand(agentId) ?? ''
  const typed = command.startsWith('/') || command.startsWith('$') ? `Types ${command}` : 'Asks the agent to use agent-sessions'
  return `${typed} in this session: it writes a summary and shows a redacted preview. Nothing is committed or pushed until you confirm there.`
}

/** The notice after the command was typed. */
export function shareSentNotice(agentLabel: string): string {
  return `Asked ${agentLabel} to share this session — review the preview in the session, then confirm there to commit and push.`
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
    const st = deps.status()
    const state = chatSendRefusal(agentId, st)
    if (state !== null) return { kind: 'refused', text: shareRefusalText({ kind: 'state', refusal: state }, agentLabel) }
    if (st.held) return { kind: 'refused', text: shareRefusalText({ kind: 'state', refusal: 'dialog' }, agentLabel) }
    let presence: AgentSessionsPresence
    try {
      const r = await deps.detect(agent)
      presence = r.ok ? r.presence : 'unknown'
    } catch {
      presence = 'unknown'
    }
    if (presence !== 'present') return { kind: 'refused', text: agentSessionsInstallHint(agent, presence) }
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
