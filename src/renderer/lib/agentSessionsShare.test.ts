import { afterEach, describe, expect, it, vi } from 'vitest'
import { setCustomAgentBaseResolver } from '@shared/agents/config'
import { sharedSessionContinuePrompt, type SharedSession } from '@shared/agent-sessions'
import { TEXT_NOT_SUBMITTED, type ChatPromptResult } from '@shared/text-delivery'
import { promptExceedsLineBudget } from './promptSpill'
import {
  continuableSharedSessions,
  sendShareCommand,
  shareRefusalText,
  shareRowHint,
  shareRowState,
  sharedSessionPaletteLabel,
  shareSentNotice,
  type ShareRowInput,
  type ShareSendDeps
} from './agentSessionsShare'

afterEach(() => setCustomAgentBaseResolver(null))

const ok: ShareRowInput = {
  agentId: 'claude',
  relay: false,
  remote: false,
  projectCwd: '/repo',
  repo: 'repo',
  presence: 'present',
  shadow: 'none',
  status: { state: 'done', sessionId: 's1' }
}

describe('shareRowState — what the row shows', () => {
  it('no row for an agent agent-sessions cannot push from, or no agent', () => {
    for (const agentId of ['grok', 'copilot', 'antigravity', undefined]) {
      expect(shareRowState({ ...ok, agentId })).toBeNull()
    }
  })

  it('enabled for an idle (or unknown-state) claude, codex, opencode or gemini node', () => {
    for (const agentId of ['claude', 'codex', 'opencode', 'gemini']) {
      expect(shareRowState({ ...ok, agentId })).toEqual({ refusal: null })
    }
    // A resumed idle session legitimately reports no state yet: allowed, given a session id.
    expect(shareRowState({ ...ok, status: { sessionId: 's1' } })).toEqual({ refusal: null })
  })

  it('INERT when agent-sessions is absent or not read yet: no row at all, wherever the node is', () => {
    for (const presence of ['absent', undefined] as const) {
      for (const over of [{}, { relay: true }, { remote: true }, { projectCwd: undefined }, { repo: 'not-repo' as const }]) {
        expect(shareRowState({ ...ok, ...over, presence })).toBeNull()
      }
    }
  })

  it('refuses a repository that ships its own copy, and an unread repository', () => {
    expect(shareRowState({ ...ok, shadow: 'present' })?.refusal).toEqual({ kind: 'shadow', shadow: 'present' })
    expect(shareRowState({ ...ok, shadow: 'unknown' })?.refusal).toEqual({ kind: 'shadow', shadow: 'unknown' })
    expect(shareRowState({ ...ok, shadow: undefined })?.refusal).toEqual({ kind: 'shadow', shadow: undefined })
    expect(shareRefusalText({ kind: 'shadow', shadow: 'present' }, 'Codex')).toMatch(/may run that instead of yours/)
  })

  it('an agent that has reported no session id has nothing to share', () => {
    expect(shareRowState({ ...ok, status: { state: 'done' } })?.refusal).toEqual({ kind: 'no-session' })
    expect(shareRefusalText({ kind: 'no-session' }, 'Claude')).toBe('Nothing to share yet — this session has not reported an id.')
  })

  it('refuses in order: relay, SSH, no folder, repository, agent-sessions, repository copy, then the agent state', () => {
    const all: ShareRowInput = {
      ...ok,
      relay: true,
      remote: true,
      projectCwd: undefined,
      repo: 'not-repo',
      presence: 'disabled',
      shadow: 'present',
      status: { state: 'working', sessionId: 's1' }
    }
    expect(shareRowState(all)?.refusal?.kind).toBe('relay')
    expect(shareRowState({ ...all, relay: false })?.refusal?.kind).toBe('ssh')
    expect(shareRowState({ ...all, relay: false, remote: false })?.refusal?.kind).toBe('no-folder')
    expect(shareRowState({ ...all, relay: false, remote: false, projectCwd: '/r' })?.refusal).toEqual({
      kind: 'repo',
      state: 'not-repo'
    })
    expect(shareRowState({ ...all, relay: false, remote: false, projectCwd: '/r', repo: 'repo' })?.refusal).toEqual({
      kind: 'presence',
      agent: 'claude',
      presence: 'disabled'
    })
    const clear = { ...all, relay: false, remote: false, projectCwd: '/r', repo: 'repo' as const, presence: 'present' as const }
    expect(shareRowState(clear)?.refusal).toEqual({ kind: 'shadow', shadow: 'present' })
    expect(shareRowState({ ...clear, shadow: 'none' })?.refusal).toEqual({ kind: 'state', refusal: 'working' })
  })

  it('never while waiting, blocked, held, asleep, paused, dropped or exited', () => {
    const cases: Array<[ShareRowInput['status'], string]> = [
      [{ state: 'waiting', sessionId: 's' }, 'dialog'],
      [{ state: 'blocked', sessionId: 's' }, 'dialog'],
      [{ state: 'done', sessionId: 's', held: { tool: 'AskUserQuestion' } }, 'dialog'],
      [{ state: 'done', sessionId: 's', hibernated: true }, 'asleep'],
      [{ state: 'done', sessionId: 's', paused: true }, 'paused'],
      [{ state: 'done', sessionId: 's', dropped: true }, 'dropped'],
      [{ sessionId: 's', sessionEnded: true }, 'exited']
    ]
    for (const [status, refusal] of cases) {
      expect(shareRowState({ ...ok, status })?.refusal).toEqual({ kind: 'state', refusal })
    }
  })

  it('a fact not read yet says "Checking…", an unreadable one says it could not look', () => {
    expect(shareRefusalText({ kind: 'repo', state: undefined }, 'Claude')).toMatch(/^Checking/)
    expect(shareRefusalText({ kind: 'repo', state: 'unknown' }, 'Claude')).toMatch(/^Could not check/)
    expect(shareRefusalText({ kind: 'shadow', shadow: undefined }, 'Codex')).toMatch(/^Checking/)
    expect(shareRefusalText({ kind: 'presence', agent: 'codex', presence: 'unknown' }, 'Codex')).toMatch(/^Could not check/)
  })

  it('the enabled hint says what is typed and that the confirmation is agent-sessions’, in the session', () => {
    expect(shareRowHint('claude')).toMatch(/^Types \/sessions:push in this session\./)
    expect(shareRowHint('codex')).toMatch(/^Types \$agent-sessions push/)
    expect(shareRowHint('gemini')).toMatch(/^Asks the agent to use agent-sessions/)
    for (const a of ['claude', 'codex', 'gemini'])
      expect(shareRowHint(a)).toMatch(/agent-sessions writes a summary, shows a redacted preview and asks you there before it commits and pushes\./)
    expect(shareSentNotice('Claude Code')).toBe(
      'Asked Claude Code to share this session with agent-sessions — review its preview in the session and answer it there.'
    )
  })
})

function deps(over: Partial<ShareSendDeps> = {}): ShareSendDeps & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    status: () => ({ state: 'done', sessionId: 's1' }),
    detect: async () => ({ ok: true, presence: 'present', shadow: 'none' }),
    paneRefusal: async () => null,
    sendChatPrompt: async (text) => {
      sent.push(text)
      return true
    },
    ...over
  }
}

describe('sendShareCommand — the composer’s gates, re-read at click time', () => {
  it('types exactly the agent’s push command — never --yes — and nothing else', async () => {
    for (const [agentId, text] of [
      ['claude', '/sessions:push'],
      ['codex', '$agent-sessions push']
    ] as const) {
      const d = deps()
      expect(await sendShareCommand(`n-${agentId}`, agentId, 'Agent', d)).toEqual({ kind: 'sent' })
      expect(d.sent).toEqual([text])
    }
    const d = deps()
    await sendShareCommand('n-gem', 'gemini', 'Gemini', d)
    expect(d.sent).toHaveLength(1)
    expect(d.sent[0]).not.toMatch(/--yes/)
  })

  it('a custom agent types its base harness’s command', async () => {
    setCustomAgentBaseResolver((id) => (id === 'custom:x' ? 'claude' : undefined))
    const d = deps()
    expect(await sendShareCommand('n1', 'custom:x', 'Mine', d)).toEqual({ kind: 'sent' })
    expect(d.sent).toEqual(['/sessions:push'])
  })

  it('refuses before typing anything while the agent is working, in a dialog, held, gone or id-less', async () => {
    for (const status of [
      { state: 'working' as const, sessionId: 's' },
      { state: 'waiting' as const, sessionId: 's' },
      { state: 'blocked' as const, sessionId: 's' },
      { state: 'done' as const, sessionId: 's', held: { tool: 'ExitPlanMode' } },
      { state: 'done' as const, sessionId: 's', hibernated: true },
      { sessionId: 's', sessionEnded: true },
      { state: 'done' as const }
    ]) {
      const d = deps({ status: () => status })
      const out = await sendShareCommand('n1', 'claude', 'Claude', d)
      expect(out.kind).toBe('refused')
      expect(d.sent).toEqual([])
    }
  })

  it('re-detects at click time: absent, disabled, unknown, a repository copy or no answer types nothing', async () => {
    for (const detect of [
      async () => ({ ok: true as const, presence: 'absent' as const }),
      async () => ({ ok: true as const, presence: 'disabled' as const, shadow: 'none' as const }),
      async () => ({ ok: true as const, presence: 'unknown' as const, shadow: 'none' as const }),
      async () => ({ ok: true as const, presence: 'present' as const, shadow: 'present' as const }),
      async () => ({ ok: true as const, presence: 'present' as const, shadow: 'unknown' as const }),
      // No repository answer is never clearance.
      async () => ({ ok: true as const, presence: 'present' as const }),
      async () => ({ ok: false as const, reason: 'failed' as const }),
      async () => {
        throw new Error('ipc down')
      }
    ]) {
      const d = deps({ detect })
      const out = await sendShareCommand('n1', 'codex', 'Codex', d)
      expect(out.kind).toBe('refused')
      expect(d.sent).toEqual([])
    }
  })

  it('asks the kernel whether the CLI still owns the pane (exited / unverified refuse)', async () => {
    for (const pane of ['exited', 'unverified'] as const) {
      const d = deps({ paneRefusal: async () => pane })
      const out = await sendShareCommand('n1', 'codex', 'Codex', d)
      expect(out).toMatchObject({ kind: 'refused' })
      expect(out.kind === 'refused' && out.text).toMatch(/nothing was typed/)
      expect(d.sent).toEqual([])
    }
    const d = deps({ paneRefusal: async () => Promise.reject(new Error('x')) })
    expect((await sendShareCommand('n1', 'codex', 'Codex', d)).kind).toBe('refused')
    expect(d.sent).toEqual([])
  })

  it('checks the cheap gates before the round trips, and the pane after detection', async () => {
    const order: string[] = []
    const d = deps({
      status: () => {
        order.push('status')
        return { state: 'done', sessionId: 's1' }
      },
      detect: async () => {
        order.push('detect')
        return { ok: true, presence: 'present', shadow: 'none' }
      },
      paneRefusal: async () => {
        order.push('pane')
        return null
      },
      sendChatPrompt: async () => {
        order.push('send')
        return true
      }
    })
    await sendShareCommand('n1', 'claude', 'Claude', d)
    expect(order).toEqual(['status', 'detect', 'pane', 'status', 'send'])
  })

  it('a plugin switched off since the menu opened is named as the reason', async () => {
    const d = deps({ detect: async () => ({ ok: true, presence: 'disabled', shadow: 'none' }) })
    expect(await sendShareCommand('n1', 'claude', 'Claude', d)).toMatchObject({ kind: 'refused', text: expect.stringMatching(/switched off/) })
    expect(d.sent).toEqual([])
  })

  it('a busy agent is refused before any round trip (no detection, no pane read)', async () => {
    const detect = vi.fn(async () => ({ ok: true as const, presence: 'present' as const, shadow: 'none' as const }))
    const paneRefusal = vi.fn(async () => null)
    const d = deps({ status: () => ({ state: 'working', sessionId: 's1' }), detect, paneRefusal })
    expect((await sendShareCommand('n1', 'claude', 'Claude', d)).kind).toBe('refused')
    expect(detect).not.toHaveBeenCalled()
    expect(paneRefusal).not.toHaveBeenCalled()
  })

  it('re-reads the agent state right before typing: a turn that started during the round trips refuses', async () => {
    const states = [{ state: 'done' as const, sessionId: 's1' }, { state: 'working' as const, sessionId: 's1' }]
    let reads = 0
    const d = deps({ status: () => states[Math.min(reads++, 1)] })
    const out = await sendShareCommand('n1', 'claude', 'Claude', d)
    expect(out).toMatchObject({ kind: 'refused', text: expect.stringMatching(/is working/) })
    expect(d.sent).toEqual([])
  })

  it('maps every send result honestly and never retries', async () => {
    const run = async (r: ChatPromptResult | Error) => {
      const send = vi.fn(async () => {
        if (r instanceof Error) throw r
        return r
      })
      const out = await sendShareCommand('n1', 'claude', 'Claude', deps({ sendChatPrompt: send }))
      expect(send).toHaveBeenCalledTimes(1)
      return out
    }
    expect(await run({ blocked: 'screen', dialog: 'Do you trust this folder?' })).toMatchObject({
      kind: 'refused',
      text: expect.stringMatching(/showing a dialog — nothing was typed/)
    })
    expect(await run({ blocked: 'screen', dialog: null })).toMatchObject({
      kind: 'refused',
      text: expect.stringMatching(/input box isn’t on screen/)
    })
    expect(await run('pasted-not-submitted')).toEqual({ kind: 'pasted-not-submitted', text: TEXT_NOT_SUBMITTED })
    expect(await run(false)).toMatchObject({ kind: 'refused' })
    expect(await run(new Error('dropped reply'))).toEqual({ kind: 'unconfirmed', text: TEXT_NOT_SUBMITTED })
  })

  it('one share at a time per node: a second click while the first types is ignored', async () => {
    let release!: (v: ChatPromptResult) => void
    const d = deps({ sendChatPrompt: () => new Promise((r) => (release = r)) })
    const first = sendShareCommand('n1', 'claude', 'Claude', d)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await sendShareCommand('n1', 'claude', 'Claude', d)).toEqual({ kind: 'busy' })
    release(true)
    expect(await first).toEqual({ kind: 'sent' })
    // …and the guard is released afterwards.
    expect((await sendShareCommand('n1', 'claude', 'Claude', deps())).kind).toBe('sent')
  })

  it('an agent agent-sessions cannot push from is refused without any read', async () => {
    const d = deps({ status: vi.fn(() => ({ state: 'done' as const })) })
    expect((await sendShareCommand('n1', 'grok', 'Grok', d)).kind).toBe('refused')
    expect(d.status).not.toHaveBeenCalled()
    expect(d.sent).toEqual([])
  })
})

describe('the palette rows of "Continue shared session"', () => {
  const s = (over: Partial<SharedSession> = {}): SharedSession => ({
    dir: '2026-09-22_reconcile-fabric-tables_prajwal-p_7dcecef6',
    title: 'Reconcile fabric tables',
    author: 'Prajwal P',
    agentId: 'claude',
    agentLabel: 'Claude Code',
    date: '2026-09-22',
    hasSummary: true,
    transcriptFiles: ['transcript.md'],
    ...over
  })

  it('label: title (author, agent, date), leaving out empty parts', () => {
    expect(sharedSessionPaletteLabel(s())).toBe('Reconcile fabric tables (Prajwal P, Claude Code, 2026-09-22)')
    expect(sharedSessionPaletteLabel(s({ title: '', author: '', agentLabel: '' }))).toBe('Untitled session (2026-09-22)')
  })

  it('offers only sessions with a summary whose folder still passes the allowlist', () => {
    const items = [s(), s({ dir: '../../etc' }), s({ dir: '2026-09-23_x_y_12345678', hasSummary: false })]
    expect(continuableSharedSessions(items).map((x) => x.dir)).toEqual([s().dir])
  })

  it('the continue prompt of the longest folder name, with one transcript, still fits a typed launch line', () => {
    const longest = `2026-09-22_${'a'.repeat(40)}_${'b'.repeat(67)}_${'c'.repeat(8)}`
    expect(longest.length).toBe(128)
    const prompt = sharedSessionContinuePrompt(longest, ['transcript.md'])
    expect(prompt).toBeDefined()
    expect(promptExceedsLineBudget(prompt)).toBe(false)
    // Even every transcript part it may name stays within the inline budget (launchPromptFor would
    // spill it to a file otherwise — Canvas runs it either way).
    const many = Array.from({ length: 12 }, (_, i) => `transcript-${i + 1}.md`)
    expect(promptExceedsLineBudget(sharedSessionContinuePrompt(longest, many))).toBe(false)
  })
})
