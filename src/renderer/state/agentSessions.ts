import { create } from 'zustand'
import { createdAgentId } from '@shared/agents/config'
import {
  agentSessionsAgentOf,
  type AgentSessionsAgent,
  type AgentSessionsApi,
  type AgentSessionsPresence
} from '@shared/agent-sessions'
import type { GitApi } from '@shared/types'
import { sessionForProject } from '../session/session'
import { useProjects } from './projects'

// What the "Share session to repo" row needs to know before the menu opens. A node menu is BUILT
// SYNCHRONOUSLY and frozen into `setMenu`, so the row can only read facts that are already here:
//
//  - `presence`: is agent-sessions installed for this agent + account (core's three-valued answer;
//    a failed request is `unknown`, never `absent`).
//  - `repo`: is the project folder a git repository (`git.repoRoot` — the existing git API).
//
// Filled ON DEMAND, never on a timer: Canvas asks once per project load for the agent/account
// pairs on the canvas, and again (in the background) each time a node or card menu opens, so the
// next look is fresh. A fact not read yet is `undefined`, and the row says "Checking…". The click
// itself re-detects before anything is typed, so a stale "present" can never send.

export type RepoState = 'repo' | 'not-repo' | 'unknown'

interface AgentSessionsFacts {
  presence: Record<string, AgentSessionsPresence>
  repo: Record<string, RepoState>
}

export const useAgentSessionsFacts = create<AgentSessionsFacts>(() => ({ presence: {}, repo: {} }))

/** Keys are JSON (never a joined string): an account id or a path containing the separator must
 *  not be able to forge another entry. */
export const presenceKey = (agent: AgentSessionsAgent, accountId: string | undefined): string =>
  JSON.stringify([agent, accountId ?? null])

export function presenceFor(agent: AgentSessionsAgent, accountId: string | undefined): AgentSessionsPresence | undefined {
  return useAgentSessionsFacts.getState().presence[presenceKey(agent, accountId)]
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

export function refreshPresence(
  api: Pick<AgentSessionsApi, 'detect'>,
  agent: AgentSessionsAgent,
  accountId: string | undefined
): Promise<boolean> {
  const key = presenceKey(agent, accountId)
  return once(`p${key}`, async () => {
    let presence: AgentSessionsPresence
    try {
      const r = await api.detect({ agent, ...(accountId ? { accountId } : {}) })
      presence = r.ok ? r.presence : 'unknown'
    } catch {
      presence = 'unknown'
    }
    return recordPresence(agent, accountId, presence)
  })
}

/** Store an answer core gave (also the click's own re-detection). Resolves whether it CHANGED. */
export function recordPresence(
  agent: AgentSessionsAgent,
  accountId: string | undefined,
  presence: AgentSessionsPresence
): boolean {
  const key = presenceKey(agent, accountId)
  if (useAgentSessionsFacts.getState().presence[key] === presence) return false
  useAgentSessionsFacts.setState((s) => ({ presence: { ...s.presence, [key]: presence } }))
  return true
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
}

/** Canvas nodes (React Flow shape) as `refreshShareFacts` reads them: terminals only. */
export function shareFactsNodesOf(
  nodes: readonly { id: string; type?: string; data: Record<string, unknown> }[]
): ShareFactsNode[] {
  return nodes
    .filter((n) => n.type === 'terminal')
    .map((n) => ({ id: n.id, agentId: n.data.agentId, tags: n.data.tags, accountId: n.data.accountId }))
}

/**
 * Refresh what the share row of these nodes reads: the project's repository state and, per
 * agent + account among them, agent-sessions' presence — through the PROJECT's own session api (a
 * board lane's project need not be the one on screen). Nothing for a project that can never share
 * (no folder, SSH, a relay tab): its row says so without asking anybody. `nodes` defaults to the
 * project's stored nodes; Canvas passes its live array for the project it holds. `only` narrows to
 * the nodes a menu is open on. Resolves whether any fact CHANGED.
 */
export async function refreshShareFacts(
  projectId: string,
  opts: { nodes?: readonly ShareFactsNode[]; only?: readonly string[] } = {}
): Promise<boolean> {
  const project = useProjects.getState().getProject(projectId)
  if (!project?.cwd || project.ssh) return false
  const session = sessionForProject(projectId)
  if (session.source === 'relay') return false
  const nodes = opts.nodes ?? project.nodes
  const only = opts.only ? new Set(opts.only) : null
  const pairs = new Map<string, { agent: AgentSessionsAgent; accountId: string | undefined }>()
  for (const n of nodes) {
    if (only && !only.has(n.id)) continue
    const agent = agentSessionsAgentOf(createdAgentId(n))
    if (!agent) continue
    const accountId = typeof n.accountId === 'string' && n.accountId ? n.accountId : undefined
    pairs.set(presenceKey(agent, accountId), { agent, accountId })
  }
  if (pairs.size === 0) return false
  const changed = await Promise.all([
    refreshRepoState(session.api.git, project.cwd),
    ...[...pairs.values()].map((p) => refreshPresence(session.api.agentSessions, p.agent, p.accountId))
  ])
  return changed.some(Boolean)
}

/** Tests only. */
export function resetAgentSessionsFactsForTests(): void {
  inflight.clear()
  useAgentSessionsFacts.setState({ presence: {}, repo: {} })
}
