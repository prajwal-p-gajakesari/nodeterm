import { create } from 'zustand'
import { createdAgentId } from '@shared/agents/config'
import {
  agentSessionsAgentOf,
  type AgentSessionsAgent,
  type AgentSessionsApi,
  type AgentSessionsPresence,
  type RepoShadow
} from '@shared/agent-sessions'
import type { GitApi } from '@shared/types'
import { sessionForProject } from '../session/session'
import { isHidden } from '../lib/ui-visibility'
import { useProjects } from './projects'
import { useSettings } from './settings'

// What the "Share session to repo" row needs to know before the menu opens. A node menu is BUILT
// SYNCHRONOUSLY and frozen into `setMenu`, so the row can only read facts that are already here:
//
//  - `presence`: is agent-sessions installed for this agent + account (core's answer from the
//    user's own config; a failed request is `unknown`, never `absent`).
//  - `shadow`: does the repository at a node's cwd ship its own copy (core's `RepoShadow`).
//  - `repo`: is the project folder a git repository (`git.repoRoot` — the existing git API).
//
// Filled ON DEMAND, never on a timer: Canvas asks once per project load and when a node is added or
// removed, and again (in the background) each time a node, sidebar or card menu opens, so the next
// look is fresh. INERT when agent-sessions is absent or the row is hidden in Settings: nothing is
// asked while hidden, and an `absent` answer stops there (core skips the repository walk, and the
// git read below is never made). The click itself re-detects before anything is typed, so a stale
// answer can never send.

export type RepoState = 'repo' | 'not-repo' | 'unknown'

interface AgentSessionsFacts {
  presence: Record<string, AgentSessionsPresence>
  shadow: Record<string, RepoShadow>
  repo: Record<string, RepoState>
}

export const useAgentSessionsFacts = create<AgentSessionsFacts>(() => ({ presence: {}, shadow: {}, repo: {} }))

/** The user switched the integration off (Settings → Node menu items → Share session to repo):
 *  no row, no ⌘K section, and nothing is read for it. */
export function agentSessionsHidden(): boolean {
  return isHidden('share-session', useSettings.getState().settings.hiddenNodeMenuItems ?? [])
}

/** Keys are JSON (never a joined string): an account id or a path containing the separator must
 *  not be able to forge another entry. */
export const presenceKey = (agent: AgentSessionsAgent, accountId: string | undefined): string =>
  JSON.stringify([agent, accountId ?? null])

export function presenceFor(agent: AgentSessionsAgent, accountId: string | undefined): AgentSessionsPresence | undefined {
  return useAgentSessionsFacts.getState().presence[presenceKey(agent, accountId)]
}

export const shadowKey = (agent: AgentSessionsAgent, cwd: string): string => JSON.stringify([agent, cwd])

export function shadowFor(agent: AgentSessionsAgent, cwd: string | undefined): RepoShadow | undefined {
  return cwd ? useAgentSessionsFacts.getState().shadow[shadowKey(agent, cwd)] : undefined
}

/** Is agent-sessions known to be installed for ANY agent + account read so far? */
export function anyAgentSessionsPresent(): boolean {
  return Object.values(useAgentSessionsFacts.getState().presence).some((p) => p === 'present')
}

export function repoStateFor(cwd: string): RepoState | undefined {
  return useAgentSessionsFacts.getState().repo[cwd]
}

const inflight = new Map<string, Promise<boolean>>()

/** Read one fact once at a time per key; resolves whether the stored value CHANGED. */
function once(key: string, read: () => Promise<boolean>): Promise<boolean> {
  const running = inflight.get(key)
  if (running) return running
  const p = read().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** Ask core about one agent + account, and — with a cwd — the repository there. */
export function refreshDetect(
  api: Pick<AgentSessionsApi, 'detect'>,
  agent: AgentSessionsAgent,
  accountId: string | undefined,
  cwd?: string
): Promise<boolean> {
  return once(`d${JSON.stringify([agent, accountId ?? null, cwd ?? null])}`, async () => {
    let r: Awaited<ReturnType<AgentSessionsApi['detect']>>
    try {
      r = await api.detect({ agent, ...(accountId ? { accountId } : {}), ...(cwd ? { cwd } : {}) })
    } catch {
      r = { ok: false, reason: 'failed' }
    }
    return recordDetect(agent, accountId, cwd, r)
  })
}

/** Store an answer core gave (also the click's own re-detection). A failed request is `unknown` —
 *  for the repository too: no answer is never clearance. Resolves whether a fact CHANGED. */
export function recordDetect(
  agent: AgentSessionsAgent,
  accountId: string | undefined,
  cwd: string | undefined,
  r: Awaited<ReturnType<AgentSessionsApi['detect']>>
): boolean {
  const presence: AgentSessionsPresence = r.ok ? r.presence : 'unknown'
  const pKey = presenceKey(agent, accountId)
  const s = useAgentSessionsFacts.getState()
  let changed = false
  const next: Partial<AgentSessionsFacts> = {}
  if (s.presence[pKey] !== presence) {
    next.presence = { ...s.presence, [pKey]: presence }
    changed = true
  }
  if (cwd && presence !== 'absent') {
    const shadow: RepoShadow = r.ok ? (r.shadow ?? 'unknown') : 'unknown'
    const sKey = shadowKey(agent, cwd)
    if (s.shadow[sKey] !== shadow) {
      next.shadow = { ...s.shadow, [sKey]: shadow }
      changed = true
    }
  }
  if (changed) useAgentSessionsFacts.setState(next)
  return changed
}

export function refreshRepoState(git: Pick<GitApi, 'repoRoot'>, cwd: string): Promise<boolean> {
  return once(`r${JSON.stringify(cwd)}`, async () => {
    let state: RepoState
    try {
      state = (await git.repoRoot(cwd)) ? 'repo' : 'not-repo'
    } catch {
      state = 'unknown'
    }
    const prev = useAgentSessionsFacts.getState().repo[cwd]
    if (prev === state) return false
    useAgentSessionsFacts.setState((s) => ({ repo: { ...s.repo, [cwd]: state } }))
    return true
  })
}

/** A node as either shape carries it: a canvas node's `data`, or a stored `CanvasNodeState`. */
export interface ShareFactsNode {
  id: string
  agentId?: unknown
  tags?: unknown
  accountId?: unknown
  /** The node's own working directory (a worktree frame's node runs in the worktree). */
  cwd?: unknown
}

/** Canvas nodes (React Flow shape) as `refreshShareFacts` reads them: terminals only. */
export function shareFactsNodesOf(
  nodes: readonly { id: string; type?: string; data: Record<string, unknown> }[]
): ShareFactsNode[] {
  return nodes
    .filter((n) => n.type === 'terminal')
    .map((n) => ({ id: n.id, agentId: n.data.agentId, tags: n.data.tags, accountId: n.data.accountId, cwd: n.data.cwd }))
}

/**
 * Refresh what the share row of these nodes reads, through the PROJECT's own session api (a board
 * lane's project need not be the one on screen): per agent + account + node cwd among them, core's
 * detection (presence, and the repository there); then — only if agent-sessions is not absent for
 * one of them — whether the project folder is a git repository. Nothing at all while the row is
 * hidden in Settings, or for a project that can never share (no folder, SSH, a relay tab). `nodes`
 * defaults to the project's stored nodes; Canvas passes its live array for the project it holds.
 * `only` narrows to the nodes a menu is open on. Resolves whether any fact CHANGED.
 */
export async function refreshShareFacts(
  projectId: string,
  opts: { nodes?: readonly ShareFactsNode[]; only?: readonly string[] } = {}
): Promise<boolean> {
  if (agentSessionsHidden()) return false
  const project = useProjects.getState().getProject(projectId)
  if (!project?.cwd || project.ssh) return false
  const session = sessionForProject(projectId)
  if (session.source === 'relay') return false
  const nodes = opts.nodes ?? project.nodes
  const only = opts.only ? new Set(opts.only) : null
  const asks = new Map<string, { agent: AgentSessionsAgent; accountId: string | undefined; cwd: string }>()
  for (const n of nodes) {
    if (only && !only.has(n.id)) continue
    const agent = agentSessionsAgentOf(createdAgentId(n))
    if (!agent) continue
    const accountId = typeof n.accountId === 'string' && n.accountId ? n.accountId : undefined
    const cwd = typeof n.cwd === 'string' && n.cwd ? n.cwd : project.cwd
    asks.set(JSON.stringify([agent, accountId ?? null, cwd]), { agent, accountId, cwd })
  }
  if (asks.size === 0) return false
  const detected = await Promise.all(
    [...asks.values()].map((a) => refreshDetect(session.api.agentSessions, a.agent, a.accountId, a.cwd))
  )
  const facts = useAgentSessionsFacts.getState().presence
  const anyInstalled = [...asks.values()].some((a) => {
    const p = facts[presenceKey(a.agent, a.accountId)]
    return p !== undefined && p !== 'absent'
  })
  const repoChanged = anyInstalled ? await refreshRepoState(session.api.git, project.cwd) : false
  return detected.some(Boolean) || repoChanged
}

/** Tests only. */
export function resetAgentSessionsFactsForTests(): void {
  inflight.clear()
  useAgentSessionsFacts.setState({ presence: {}, shadow: {}, repo: {} })
}
