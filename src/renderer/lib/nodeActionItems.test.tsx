// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { MenuItem } from '../components/ContextMenu'
import { useAgentStatus } from '../state/agentStatus'
import { presenceKey, resetAgentSessionsFactsForTests, useAgentSessionsFacts } from '../state/agentSessions'
import { useSettings } from '../state/settings'
import type { CanvasNode } from '../state/workspace'
import {
  BOARD_NODE_ACTION_IDS,
  BOARD_SPATIAL_ROW_IDS,
  buildNodeActionItems,
  type NodeActionCtx
} from './nodeActionItems'

const term = (id: string, data: Record<string, unknown> = {}): CanvasNode =>
  ({ id, type: 'terminal', position: { x: 0, y: 0 }, data: { title: id, ...data } }) as unknown as CanvasNode

function fakeCtx(nodes: CanvasNode[], over: Partial<NodeActionCtx> = {}): NodeActionCtx {
  const noop = (): void => {}
  return {
    nodes,
    sessionSource: 'local',
    attached: () => true,
    agentIdOf: (id) => nodes.find((n) => n.id === id)?.data.agentId as never,
    gatewayModels: [],
    gatewayStatus: 'idle',
    gatewayError: '',
    grokModels: () => [],
    addToExistingGroup: noop,
    groupSelection: noop,
    removeFromGroup: noop,
    setNodesColor: vi.fn(),
    pickNodeIcon: vi.fn(),
    duplicateNodes: noop,
    snapNodeToZone: () => true,
    toggleCollapseNodes: noop,
    toggleMarkdown: noop,
    reloadTerminals: noop,
    liveLinkMenuItems: () => [],
    branchClaude: async () => ({ ok: true }),
    transferConversation: noop,
    restartAgentNode: async () => {},
    pauseAgentNode: async () => {},
    resumeAgentNode: noop,
    switchClaudeAccountNode: async () => {},
    switchCodexAccountNode: async () => {},
    connectedProjectIdForHost: () => undefined,
    deleteNodes: vi.fn(),
    shareSession: { projectCwd: '/repo', projectSsh: false, send: vi.fn(async () => {}) },
    ...over
  }
}

/** Top-level rows as text: `#` label, `—` rule, `[colors]` swatches, `▸` submenu. */
const top = (items: MenuItem[]): string[] =>
  items.map((it) =>
    it.type === 'separator'
      ? '—'
      : it.type === 'colors'
        ? '[colors]'
        : it.type === 'label'
          ? `#${it.label}`
          : it.type === 'submenu'
            ? `${it.label} ▸`
            : it.label
  )

/** Depth-first search for a row by its label. */
function row(items: MenuItem[], label: string): Extract<MenuItem, { label: string }> | undefined {
  for (const it of items) {
    if (it.type === 'separator' || it.type === 'colors') continue
    if (it.label === label) return it
    if (it.type === 'submenu') {
      const hit = row(it.children, label)
      if (hit) return hit
    }
  }
  return undefined
}
const hintOf = (items: MenuItem[], label: string): string | undefined => {
  const r = row(items, label)
  return r && 'hint' in r ? r.hint : undefined
}
const disabledOf = (items: MenuItem[], label: string): boolean | undefined => {
  const r = row(items, label)
  return r && 'disabled' in r ? r.disabled : undefined
}

beforeEach(() => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } })
  useAgentStatus.setState({ byId: {} })
})

describe('buildNodeActionItems — the canvas node menu, moved verbatim', () => {
  it('a plain terminal gets exactly the rows the canvas menu showed before the move', () => {
    expect(top(buildNodeActionItems(['t1'], undefined, fakeCtx([term('t1')])))).toEqual([
      '#1 node',
      'Group node',
      '—',
      '[colors]',
      'Set icon…',
      '—',
      'Duplicate',
      'Snap to zone ▸',
      'Collapse / Expand',
      'Markdown view',
      'Refresh terminal',
      '—',
      'Delete'
    ])
  })

  it('an idle Claude agent with a session id gets the conversation rows, enabled', () => {
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
    const items = buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId: 'claude' })]))
    const rows = top(items)
    expect(rows).toContain('Branch conversation')
    expect(rows).toContain('Restart ▸')
    expect(rows).toContain('Pause session ▸')
    expect(disabledOf(items, 'Restart agent')).toBe(false)
    expect(rows.at(-1)).toBe('Delete')
  })

  it('a busy agent keeps its Restart row, disabled with the reason', () => {
    useAgentStatus.setState({ byId: { a1: { state: 'working', sessionId: 's1' } } } as never)
    const items = buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId: 'claude' })]))
    expect(disabledOf(items, 'Restart agent')).toBe(true)
    expect(hintOf(items, 'Restart agent')).toBe(
      'This session is busy — restart it once its turn (or permission prompt) is done.'
    )
  })

  it('an agent with no session id says there is nothing to resume yet', () => {
    useAgentStatus.setState({ byId: { a1: { state: 'done' } } } as never)
    const items = buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId: 'claude' })]))
    expect(hintOf(items, 'Restart agent')).toBe('Nothing to resume yet — this session has not reported an id.')
  })

  it('an unmounted agent says its terminal is not attached', () => {
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
    const items = buildNodeActionItems(
      ['a1'],
      undefined,
      fakeCtx([term('a1', { agentId: 'claude' })], { attached: () => false })
    )
    expect(hintOf(items, 'Restart agent')).toBe('This terminal is not attached right now.')
  })

  it('a relay tab refuses the shell recycle and the account switch', () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, claudeAccounts: [{ id: 'acc1', label: 'Work', createdAt: 0 }] as never }
    })
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
    const items = buildNodeActionItems(
      ['a1'],
      undefined,
      fakeCtx([term('a1', { agentId: 'claude' })], { sessionSource: 'relay' })
    )
    expect(hintOf(items, 'Restart agent and shell')).toBe('Restart the shell on the machine hosting this relay session.')
    expect(disabledOf(items, 'Switch Claude account')).toBe(true)
    expect(hintOf(items, 'Switch Claude account')).toBe('Not available for relay sessions.')
  })

  it("an SSH project's node offers only the accounts pinned to its host", () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        claudeAccounts: [
          { id: 'local', label: 'Local', createdAt: 0 },
          { id: 'remote', label: 'Remote', host: 'me@box', createdAt: 0 }
        ] as never
      }
    })
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
    const items = buildNodeActionItems(
      ['a1'],
      undefined,
      fakeCtx([term('a1', { agentId: 'claude', ssh: { host: 'box', user: 'me' } })])
    )
    // The node runs on the host's own (system) account: that row carries the ✓.
    expect(row(items, '✓ System account (me@box)')).toBeDefined()
    expect(row(items, 'Remote')).toBeDefined()
    expect(row(items, 'Local')).toBeUndefined()
  })

  it('a hidden row is left out', () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hiddenNodeMenuItems: ['colors', 'icon'] } })
    const rows = top(buildNodeActionItems(['t1'], undefined, fakeCtx([term('t1')])))
    expect(rows).not.toContain('[colors]')
    expect(rows).not.toContain('Set icon…')
  })
})

describe('buildNodeActionItems — filters', () => {
  it('omit drops a section and leaves no dangling rule', () => {
    expect(
      top(buildNodeActionItems(['t1'], undefined, fakeCtx([term('t1')]), { omit: ['delete'] }))
    ).toEqual([
      '#1 node',
      'Group node',
      '—',
      '[colors]',
      'Set icon…',
      '—',
      'Duplicate',
      'Snap to zone ▸',
      'Collapse / Expand',
      'Markdown view',
      'Refresh terminal'
    ])
  })

  it('allow keeps only the listed sections', () => {
    const live = vi.fn((): MenuItem[] => [{ label: 'Share live link…', onClick: () => {} }])
    expect(
      top(
        buildNodeActionItems(['t1'], undefined, fakeCtx([term('t1')], { liveLinkMenuItems: live }), {
          allow: BOARD_NODE_ACTION_IDS
        })
      )
    ).toEqual(['[colors]', 'Set icon…', '—', 'Share live link…'])
  })

  it('on the board list the live-link row comes before the account switch', () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, claudeAccounts: [{ id: 'acc1', label: 'Work', createdAt: 0 }] as never }
    })
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
    const live = (): MenuItem[] => [{ label: 'Share live link…', onClick: () => {} }]
    const rows = top(
      buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId: 'claude' })], { liveLinkMenuItems: live }), {
        allow: BOARD_NODE_ACTION_IDS
      })
    )
    const liveAt = rows.indexOf('Share live link…')
    const switchAt = rows.findIndex((r) => r.startsWith('Switch Claude account'))
    expect(liveAt).toBeGreaterThan(-1)
    expect(switchAt).toBeGreaterThan(-1)
    expect(liveAt).toBeLessThan(switchAt)
  })

  it('no spatial row is ever on the board list, nor a row the board owns itself', () => {
    for (const id of BOARD_SPATIAL_ROW_IDS) expect(BOARD_NODE_ACTION_IDS).not.toContain(id)
    for (const id of ['label', 'markdown-view', 'delete'] as const) expect(BOARD_NODE_ACTION_IDS).not.toContain(id)
  })
})

describe('Share session to repo — the agent-sessions row (canvas menu and board cards)', () => {
  const LABEL = 'Share session to repo'
  const facts = (presence: Record<string, string>, repo: Record<string, string> = { '/repo': 'repo' }): void =>
    useAgentSessionsFacts.setState({ presence, repo } as never)
  beforeEach(() => {
    resetAgentSessionsFactsForTests()
    facts({ [presenceKey('claude', undefined)]: 'present', [presenceKey('codex', 'acct1')]: 'present' })
    useAgentStatus.setState({ byId: { a1: { state: 'done', sessionId: 's1' } } } as never)
  })

  it('an idle claude agent in a git project with agent-sessions installed gets the row, enabled', () => {
    const send = vi.fn(async () => {})
    const items = buildNodeActionItems(
      ['a1'],
      undefined,
      fakeCtx([term('a1', { agentId: 'claude', title: 'fix --yes --branch x' })], {
        shareSession: { projectCwd: '/repo', projectSsh: false, send }
      })
    )
    const r = row(items, LABEL)
    expect(r).toBeDefined()
    expect(disabledOf(items, LABEL)).toBe(false)
    expect(hintOf(items, LABEL)).toMatch(/^Types \/sessions:push in this session/)
    ;(r as { onClick: () => void }).onClick()
    // The row hands over the node id and nothing else — no title, no flag can reach the command.
    expect(send).toHaveBeenCalledWith('a1')
  })

  it('the account is the node’s own: a managed codex account reads its own presence', () => {
    useAgentStatus.setState({ byId: { c1: { state: 'done' } } } as never)
    const ctx = fakeCtx([term('c1', { agentId: 'codex', accountId: 'acct1' }), term('c2', { agentId: 'codex' })])
    expect(disabledOf(buildNodeActionItems(['c1'], undefined, ctx), LABEL)).toBe(false)
    // The system codex account was never detected here: "Checking…", not the managed account's answer.
    expect(hintOf(buildNodeActionItems(['c2'], undefined, ctx), LABEL)).toMatch(/^Checking whether agent-sessions/)
  })

  it('is disabled with the reason — never silently missing — wherever it cannot run', () => {
    const at = (over: Partial<NodeActionCtx>, data: Record<string, unknown> = {}): string | undefined => {
      const items = buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId: 'claude', ...data })], over))
      expect(disabledOf(items, LABEL)).toBe(true)
      return hintOf(items, LABEL)
    }
    const share = (o: Partial<NodeActionCtx['shareSession']>): Partial<NodeActionCtx> => ({
      shareSession: { projectCwd: '/repo', projectSsh: false, send: vi.fn(async () => {}), ...o }
    })
    expect(at({ sessionSource: 'relay' })).toBe('Not available for relay sessions.')
    expect(at(share({ projectSsh: true }))).toMatch(/^Not available for SSH projects yet/)
    expect(at({}, { ssh: { host: 'box', user: 'me' } })).toMatch(/^Not available for SSH projects yet/)
    expect(at(share({ projectCwd: undefined }))).toMatch(/has no folder/)
    facts({ [presenceKey('claude', undefined)]: 'present' }, { '/repo': 'not-repo' })
    expect(at({})).toBe('This project’s folder is not a git repository.')
    facts({ [presenceKey('claude', undefined)]: 'absent' })
    expect(at({})).toContain('/plugin install sessions@agent-sessions')
    facts({ [presenceKey('claude', undefined)]: 'disabled' })
    expect(at({})).toMatch(/switched off/)
    facts({ [presenceKey('claude', undefined)]: 'present' })
    useAgentStatus.setState({ byId: { a1: { state: 'working', sessionId: 's1' } } } as never)
    expect(at({})).toMatch(/is working — share once its turn is done/)
    useAgentStatus.setState({ byId: { a1: { state: 'waiting', sessionId: 's1' } } } as never)
    expect(at({})).toMatch(/waiting for an answer/)
    useAgentStatus.setState({ byId: { a1: { state: 'done', hibernated: true } } } as never)
    expect(at({})).toMatch(/asleep/)
  })

  it('only the four agents agent-sessions pushes from get it; a plain terminal and a selection do not', () => {
    for (const agentId of ['codex', 'opencode', 'gemini']) {
      facts({ [presenceKey(agentId as never, undefined)]: 'present' })
      expect(row(buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId })])), LABEL)).toBeDefined()
    }
    for (const agentId of ['grok', 'copilot']) {
      expect(row(buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId })])), LABEL)).toBeUndefined()
    }
    expect(row(buildNodeActionItems(['t1'], undefined, fakeCtx([term('t1')])), LABEL)).toBeUndefined()
    const two = fakeCtx([term('a1', { agentId: 'claude' }), term('a2', { agentId: 'claude' })])
    expect(row(buildNodeActionItems(['a1', 'a2'], undefined, two), LABEL)).toBeUndefined()
  })

  it('board parity: a card takes the same row', () => {
    expect(BOARD_NODE_ACTION_IDS).toContain('share-session')
    const items = buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId: 'claude' })]), {
      allow: BOARD_NODE_ACTION_IDS
    })
    expect(top(items)).toContain(LABEL)
    expect(disabledOf(items, LABEL)).toBe(false)
  })

  it('can be hidden from Settings like any other convenience row', () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hiddenNodeMenuItems: ['share-session'] } })
    expect(row(buildNodeActionItems(['a1'], undefined, fakeCtx([term('a1', { agentId: 'claude' })])), LABEL)).toBeUndefined()
  })
})
