import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionsDetectResult } from '@shared/agent-sessions'

// The project's OWN session api answers (a board lane's project need not be the one on screen).
const sessions: Record<string, { source: 'local' | 'relay' | 'server'; api: unknown }> = {}
vi.mock('../session/session', () => ({ sessionForProject: (id: string) => sessions[id] }))

import { DEFAULT_SETTINGS } from '@shared/types'
import { useProjects } from './projects'
import { useSettings } from './settings'
import {
  anyAgentSessionsPresent,
  presenceFor,
  presenceKey,
  recordDetect,
  refreshDetect,
  refreshRepoState,
  refreshShareFacts,
  repoStateFor,
  resetAgentSessionsFactsForTests,
  shadowFor,
  shareFactsNodesOf
} from './agentSessions'

function fakeApi(over: { detect?: (req: unknown) => Promise<AgentSessionsDetectResult>; repoRoot?: (cwd: string) => Promise<string | null> } = {}) {
  return {
    agentSessions: {
      detect: vi.fn(over.detect ?? (async () => ({ ok: true as const, presence: 'present' as const, shadow: 'none' as const }))),
      listShared: vi.fn()
    },
    git: { repoRoot: vi.fn(over.repoRoot ?? (async (cwd: string) => cwd)) }
  }
}

const project = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  cwd: `/${id}`,
  nodes: [
    { id: 'c1', kind: 'terminal', agentId: 'claude' },
    { id: 'c2', kind: 'terminal', agentId: 'claude' },
    { id: 'x1', kind: 'terminal', agentId: 'codex', accountId: 'work', cwd: '/wt' },
    { id: 'g1', kind: 'terminal', agentId: 'grok' },
    { id: 't1', kind: 'terminal' }
  ],
  ...over
})

beforeEach(() => {
  resetAgentSessionsFactsForTests()
  for (const k of Object.keys(sessions)) delete sessions[k]
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } })
})

describe('refreshDetect / recordDetect / refreshRepoState', () => {
  it('stores core’s answer; a failed request or a rejection is unknown, never absent', async () => {
    expect(await refreshDetect(fakeApi().agentSessions, 'claude', undefined)).toBe(true)
    expect(presenceFor('claude', undefined)).toBe('present')
    expect(await refreshDetect(fakeApi().agentSessions, 'claude', undefined)).toBe(false) // unchanged
    await refreshDetect(fakeApi({ detect: async () => ({ ok: false, reason: 'failed' }) }).agentSessions, 'codex', undefined)
    expect(presenceFor('codex', undefined)).toBe('unknown')
    await refreshDetect(fakeApi({ detect: async () => Promise.reject(new Error('x')) }).agentSessions, 'gemini', undefined)
    expect(presenceFor('gemini', undefined)).toBe('unknown')
    expect(anyAgentSessionsPresent()).toBe(true)
  })

  it('the repository answer is kept per agent + cwd; a missing or failed one is unknown, never clearance', () => {
    recordDetect('codex', undefined, '/r1', { ok: true, presence: 'present', shadow: 'present' })
    recordDetect('codex', undefined, '/r2', { ok: true, presence: 'present' })
    recordDetect('gemini', undefined, '/r1', { ok: false, reason: 'failed' })
    expect([shadowFor('codex', '/r1'), shadowFor('codex', '/r2'), shadowFor('gemini', '/r1'), shadowFor('codex', '/r3')]).toEqual([
      'present',
      'unknown',
      'unknown',
      undefined
    ])
    // Absent records no repository fact at all.
    recordDetect('opencode', undefined, '/r1', { ok: true, presence: 'absent' })
    expect(shadowFor('opencode', '/r1')).toBeUndefined()
  })

  it('keys by agent AND account, as JSON: an id with a separator cannot forge another entry', () => {
    recordDetect('claude', 'a","b', undefined, { ok: true, presence: 'present' })
    expect(presenceFor('claude', 'a')).toBeUndefined()
    expect(presenceKey('claude', undefined)).not.toBe(presenceKey('claude', 'null'))
  })

  it('one request per key at a time', async () => {
    let release!: () => void
    const api = fakeApi({
      detect: () => new Promise((r) => (release = () => r({ ok: true, presence: 'absent' })))
    }).agentSessions
    const a = refreshDetect(api, 'claude', undefined, '/r')
    const b = refreshDetect(api, 'claude', undefined, '/r')
    release()
    await Promise.all([a, b])
    expect(api.detect).toHaveBeenCalledTimes(1)
    expect(api.detect).toHaveBeenCalledWith({ agent: 'claude', cwd: '/r' })
  })

  it('repository: a root is repo, null is not-repo, a rejection is unknown', async () => {
    await refreshRepoState(fakeApi().git, '/a')
    await refreshRepoState(fakeApi({ repoRoot: async () => null }).git, '/b')
    await refreshRepoState(fakeApi({ repoRoot: async () => Promise.reject(new Error('x')) }).git, '/c')
    expect([repoStateFor('/a'), repoStateFor('/b'), repoStateFor('/c'), repoStateFor('/d')]).toEqual([
      'repo',
      'not-repo',
      'unknown',
      undefined
    ])
  })
})

describe('refreshShareFacts — through the project’s own session, only where sharing can run', () => {
  it('asks once per agent + account among the nodes, and the repository once, on that project’s api', async () => {
    const api = fakeApi()
    sessions.p1 = { source: 'local', api }
    useProjects.setState({ projects: [project('p1')] } as never)
    expect(await refreshShareFacts('p1')).toBe(true)
    expect(api.git.repoRoot).toHaveBeenCalledWith('/p1')
    expect(api.agentSessions.detect.mock.calls.map((c) => c[0])).toEqual([
      { agent: 'claude', cwd: '/p1' },
      { agent: 'codex', accountId: 'work', cwd: '/wt' }
    ])
    expect(repoStateFor('/p1')).toBe('repo')
  })

  it('INERT when absent: nothing past the presence answer — no git read', async () => {
    const api = fakeApi({ detect: async () => ({ ok: true, presence: 'absent' }) })
    sessions.p1 = { source: 'local', api }
    useProjects.setState({ projects: [project('p1')] } as never)
    await refreshShareFacts('p1')
    expect(api.agentSessions.detect).toHaveBeenCalled()
    expect(api.git.repoRoot).not.toHaveBeenCalled()
    expect(repoStateFor('/p1')).toBeUndefined()
  })

  it('hidden in Settings: nothing is read at all', async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hiddenNodeMenuItems: ['share-session'] } })
    const api = fakeApi()
    sessions.p1 = { source: 'local', api }
    useProjects.setState({ projects: [project('p1')] } as never)
    expect(await refreshShareFacts('p1')).toBe(false)
    expect(api.agentSessions.detect).not.toHaveBeenCalled()
    expect(api.git.repoRoot).not.toHaveBeenCalled()
  })

  it('`only` narrows to the nodes a menu is open on', async () => {
    const api = fakeApi()
    sessions.p1 = { source: 'local', api }
    useProjects.setState({ projects: [project('p1')] } as never)
    await refreshShareFacts('p1', { only: ['x1'] })
    expect(api.agentSessions.detect.mock.calls.map((c) => c[0])).toEqual([{ agent: 'codex', accountId: 'work', cwd: '/wt' }])
  })

  it('asks nobody for a project that can never share: SSH, no folder, a relay tab, or no such agent', async () => {
    const api = fakeApi()
    sessions.ssh = { source: 'local', api }
    sessions.nocwd = { source: 'local', api }
    sessions.relay = { source: 'relay', api }
    sessions.grok = { source: 'local', api }
    useProjects.setState({
      projects: [
        project('ssh', { ssh: { host: 'h', user: 'u' } }),
        project('nocwd', { cwd: undefined }),
        project('relay'),
        project('grok', { nodes: [{ id: 'g', kind: 'terminal', agentId: 'grok' }] })
      ]
    } as never)
    for (const id of ['ssh', 'nocwd', 'relay', 'grok', 'missing']) expect(await refreshShareFacts(id)).toBe(false)
    expect(api.agentSessions.detect).not.toHaveBeenCalled()
    expect(api.git.repoRoot).not.toHaveBeenCalled()
  })

  it('reads a live canvas array as terminals only', () => {
    expect(
      shareFactsNodesOf([
        { id: 'a', type: 'terminal', data: { agentId: 'claude', accountId: 'w', title: 'x' } },
        { id: 's', type: 'sticky', data: { agentId: 'claude' } }
      ])
    ).toEqual([{ id: 'a', agentId: 'claude', tags: undefined, accountId: 'w', cwd: undefined }])
  })
})
