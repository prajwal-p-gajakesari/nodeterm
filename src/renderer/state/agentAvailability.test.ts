import { describe, it, expect } from 'vitest'
import {
  enabledAgentChoices,
  firstEnabledAgent,
  launchableDefaultAgent,
  removeCustomAgent,
  setAgentEnabled,
  setDefaultAgent
} from './agentAvailability'
import type { CustomAgent } from '@shared/types'
import { BUILTIN_AGENT_IDS } from '@shared/agents/config'

// Derived, not hardcoded: a builtin added later (copilot landed after these tests were written)
// must not silently leave one enabled and break the "every builtin disabled" premise.
const ALL_BUILTINS = [...BUILTIN_AGENT_IDS] as string[]

const custom = (id: string, label = id): CustomAgent => ({
  id: `custom:${id}`,
  label,
  launchCmd: label,
  promptInjectionMode: 'argv'
})

/**
 * The reported bug (2026-08-15): "when I add a custom agent and disable claude it still seems to
 * take claude as default". The old reassignment only considered BUILTINS, so a user who disabled
 * every builtin to live on their own CLI aliases had the default snap back to 'claude' — the one
 * agent they had just switched off.
 */
describe('firstEnabledAgent', () => {
  it('prefers the first enabled builtin, in claude → codex order', () => {
    expect(firstEnabledAgent({ disabledAgents: [], customAgents: [] })).toBe('claude')
    expect(firstEnabledAgent({ disabledAgents: ['claude'], customAgents: [] })).toBe('codex')
  })

  it('falls through to an enabled CUSTOM agent when every builtin is disabled — the bug', () => {
    const all = ALL_BUILTINS
    expect(firstEnabledAgent({ disabledAgents: all, customAgents: [custom('work')] })).toBe(
      'custom:work'
    )
  })

  it('skips a disabled custom agent too', () => {
    const all = [...ALL_BUILTINS, 'custom:work']
    expect(
      firstEnabledAgent({ disabledAgents: all, customAgents: [custom('work'), custom('personal')] })
    ).toBe('custom:personal')
  })

  it("answers 'claude' only when literally everything is disabled", () => {
    const all = [...ALL_BUILTINS, 'custom:work']
    expect(firstEnabledAgent({ disabledAgents: all, customAgents: [custom('work')] })).toBe('claude')
  })
})

describe('setAgentEnabled — default reassignment', () => {
  it('hands the default to a custom agent when the last builtin goes dark', () => {
    const s = {
      // Every builtin but claude already dark; disabling claude then leaves only the custom agent.
      disabledAgents: ALL_BUILTINS.filter((id) => id !== 'claude'),
      defaultAgent: 'claude',
      customAgents: [custom('work')]
    }
    expect(setAgentEnabled(s, 'claude', false).defaultAgent).toBe('custom:work')
  })

  it('leaves the default alone when a non-default agent is disabled', () => {
    const s = { disabledAgents: [], defaultAgent: 'claude', customAgents: [custom('work')] }
    expect(setAgentEnabled(s, 'codex', false).defaultAgent).toBe('claude')
  })
})

describe('setDefaultAgent — custom agents are eligible', () => {
  it('sets a custom agent as default and re-enables it', () => {
    const s = {
      disabledAgents: ['custom:work'],
      defaultAgent: 'claude',
      customAgents: [custom('work')]
    }
    const next = setDefaultAgent(s, 'custom:work')
    expect(next.defaultAgent).toBe('custom:work')
    expect(next.disabledAgents).not.toContain('custom:work')
  })
})

describe('removeCustomAgent', () => {
  it('reassigns a default that pointed at the removed agent', () => {
    const s = {
      disabledAgents: [],
      defaultAgent: 'custom:work',
      customAgents: [custom('work')]
    }
    const next = removeCustomAgent(s, 'custom:work')
    expect(next.customAgents).toEqual([])
    expect(next.defaultAgent).toBe('claude')
  })

  it('drops the id from disabledAgents and leaves an unrelated default alone', () => {
    const s = {
      disabledAgents: ['custom:work'],
      defaultAgent: 'gemini',
      customAgents: [custom('work'), custom('personal')]
    }
    const next = removeCustomAgent(s, 'custom:work')
    expect(next.disabledAgents).toEqual([])
    expect(next.defaultAgent).toBe('gemini')
    expect(next.customAgents.map((c) => c.id)).toEqual(['custom:personal'])
  })
})

describe('launchableDefaultAgent', () => {
  it('passes through a builtin or an existing custom default', () => {
    expect(
      launchableDefaultAgent({ disabledAgents: [], defaultAgent: 'gemini', customAgents: [] })
    ).toBe('gemini')
    expect(
      launchableDefaultAgent({
        disabledAgents: [],
        defaultAgent: 'custom:work',
        customAgents: [custom('work')]
      })
    ).toBe('custom:work')
  })

  // The stale-id case exists in the wild: older builds removed custom agents with a bare filter,
  // leaving `defaultAgent: 'custom:<uuid>'` behind in settings.json.
  it('refuses a dangling custom id — the raw uuid must never reach a shell', () => {
    expect(
      launchableDefaultAgent({ disabledAgents: [], defaultAgent: 'custom:gone', customAgents: [] })
    ).toBe('claude')
  })
})

// The picker behind "New agent in new worktree…": the same set and order as the add menus' rows.
describe('enabledAgentChoices', () => {
  it('lists every enabled builtin in canonical order, then custom agents in the user\'s order', () => {
    const out = enabledAgentChoices({
      disabledAgents: [],
      customAgents: [custom('b', 'Bravo'), custom('a', 'Alpha')]
    })
    expect(out.map((o) => o.id)).toEqual([...ALL_BUILTINS, 'custom:b', 'custom:a'])
    expect(out[0]).toEqual({ id: 'claude', label: 'Claude Code' })
    expect(out.slice(-2).map((o) => o.label)).toEqual(['Bravo', 'Alpha'])
  })

  it('leaves out what the user switched off — builtin or custom', () => {
    const out = enabledAgentChoices({
      disabledAgents: ['codex', 'custom:b'],
      customAgents: [custom('b', 'Bravo'), custom('a', 'Alpha')]
    })
    expect(out.map((o) => o.id)).not.toContain('codex')
    expect(out.map((o) => o.id)).not.toContain('custom:b')
    expect(out.map((o) => o.id)).toContain('custom:a')
  })

  it('is empty when every agent is off (the dialog then refuses to create)', () => {
    expect(
      enabledAgentChoices({ disabledAgents: [...ALL_BUILTINS, 'custom:a'], customAgents: [custom('a')] })
    ).toEqual([])
  })
})
