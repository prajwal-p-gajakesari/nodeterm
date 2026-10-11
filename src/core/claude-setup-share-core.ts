// Pure planning for the per-account "Share ~/.claude setup with this account" option — the sibling
// of "Share ~/.claude/skills" (issue #643, `claude-skill-share-core.ts`) for everything else a user
// configures once in `~/.claude`: settings.json (hooks, permissions, env, status line,
// enabledPlugins), the installed plugins, CLAUDE.md user memory, agents, commands, output styles.
//
// WHY THIS EXISTS. A managed account's config dir is passed as CLAUDE_CONFIG_DIR, which REPLACES
// `~/.claude` wholesale. A new account therefore silently loses every hook (a phone-push hook, a
// formatter), every permission rule and every plugin the user set up, and the add path only ever
// puts nodeterm's own managed hook there. Isolation stays the default; this is the opt-back-in.
//
// WHY LINKS AND NOT `claude --settings ~/.claude/settings.json` ON THE LAUNCH LINE. `claude --help`
// (2.1.288) describes `--settings` as loading ADDITIONAL settings; Claude Code's documented settings
// hierarchy applies those at command-line (flag) scope, ABOVE user, project and local settings — so
// the user's global file would override a project's own settings, the opposite of how it behaves
// for the system account (the precedence is the documentation's, not a measurement here). It covers
// settings.json only (no flag shares CLAUDE.md, agents, commands or output styles), a plugin
// installed from inside the account would still land in the account's own file, and every claude
// launch site (restart, resume, phone, headless) would have to thread the flag — a rule enforced at
// one mint site is enforced nowhere. A link gives the account exactly the system account's view.
//
// MEASURED (2.1.288, fabricated HOME + CLAUDE_CONFIG_DIR, no login): with `<cfg>/settings.json` and
// `<cfg>/plugins` symlinked to a fake system dir, `claude plugin marketplace add`, `plugin install`,
// `plugin disable` and `plugin enable` — each run with CLAUDE_CONFIG_DIR=<cfg> — all wrote through
// the link: the link survived every one and the target gained `extraKnownMarketplaces` /
// `enabledPlugins`. `installed_plugins.json` RECORDS the install path
// through the account (`<cfg>/plugins/cache/...`), but `plugin list --json` read from the system dir
// re-roots it under the system's own `plugins/cache`, and still resolved after the account's link
// was removed — so a plugin installed from an account does not break the system account later.
//
// THE RULES THIS FILE TURNS ON (each one is a property of the plan, not a promise of the applier):
//  1. An item is OURS iff nodeterm RECORDED linking it for this account (userData, keyed by account
//     id + the account dir's realpath) AND it is a symlink whose target normalizes to exactly
//     `join(systemDir, <its own name>)`. Shape alone is NOT enough here, unlike #643's skills: the
//     documented two-profile layout (`~/.claude-2/settings.json` → `~/.claude/settings.json`,
//     pinned by `claude-accounts-link-symlink.test.ts`) is precisely that shape, and an off-switch
//     that trusted shape would delete the user's own link.
//  2. Every item has ONE slot (`settings.json` replaces, it does not merge like a skills folder), and
//     every managed account already has its own `settings.json` (the managed hook is written there
//     at add time). So an explicit ON SETS ASIDE the account's own copy into
//     `<cfg>/.nodeterm-set-aside/<name>` (never over an existing one) and OFF puts it back — only
//     into an empty slot. Nothing is ever deleted.
//  3. Only the switch moves or removes anything. The launch sweep only links EMPTY slots.
//  4. `settings.json` is withheld while the system copy carries a key that would replace or
//     redirect this account's own login (see IDENTITY_*); `plugins` rides with it, because `enabledPlugins` lives
//     in settings.json and the two are only meaningful together.
import path from 'path'
import { AUTH_ENV_STRIP, isSafeAccountId } from './claude-accounts-core'
import { MODEL_GATEWAY_ENV_KEYS } from '../shared/agents/model-gateway'
import { isAtOrInside, normalizeLinkPath } from './claude-skill-share-core'
import type {
  ClaudeSetupItemName,
  ClaudeSetupItemState,
  ClaudeSetupShareItem,
  ClaudeSetupSkip
} from '../shared/types'

/** Where an explicit ON sets the account's own copy of an item aside, inside the account dir (a
 *  rename, so it must be the same filesystem). Anchored: nodeterm only ever moves `<name>` in and
 *  out of this folder, and never onto something already there. */
export const SET_ASIDE_DIR = '.nodeterm-set-aside'

/**
 * THE ALLOWLIST. Everything this option may link, and the kind the system copy must be. A closed
 * table on purpose: Claude Code keeps a login, conversations and per-machine state in the same
 * directory, and "share everything except…" would grow the next secret into the shared set.
 * nodeterm writes into none of these in an account dir except `settings.json` (its managed hook),
 * and that write goes THROUGH the link — see the `agent-integrations.ts` sweep comment.
 */
export const SHARED_SETUP_ITEMS: readonly { name: ClaudeSetupItemName; kind: 'file' | 'dir' }[] = [
  { name: 'settings.json', kind: 'file' },
  { name: 'plugins', kind: 'dir' },
  { name: 'CLAUDE.md', kind: 'file' },
  { name: 'agents', kind: 'dir' },
  { name: 'commands', kind: 'dir' },
  { name: 'output-styles', kind: 'dir' }
]

/**
 * Never shared, whatever the table above says. It OUTRANKS that table twice over: `setupItems`
 * filters these names out of whatever table it is given (so an entry added there by mistake is
 * never planned, read, recorded or linked), and the test walks the table against this set AND a
 * name pattern, so such an entry goes red even when it was added on purpose.
 */
export const NEVER_SHARED: Readonly<Record<string, string>> = {
  '.claude.json':
    "the account's login (oauthAccount) and its user-scope MCP servers (`claude mcp add -s user`)",
  '.credentials.json': "the account's login token on Linux and Windows",
  projects: "this account's conversations",
  skills: 'has its own switch, Share ~/.claude/skills (issue #643)',
  [SET_ASIDE_DIR]: "nodeterm's own set-aside folder"
}

/**
 * Top-level settings.json keys that make Claude Code authenticate through something other than the
 * account's own login, redirect it, or refuse it. Key NAMES are matched; a value is never read past "is it set",
 * never logged and never sent to the renderer. That these names exist in 2.1.288 is measured (the
 * binary's strings); what each one does is Claude Code's documentation, not our measurement.
 */
export const IDENTITY_SETTINGS_KEYS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'forceLoginMethod',
  'forceLoginOrgUUID'
] as const

/**
 * `env` entries with the same effect. Built from the lists that already exist for this exact hazard
 * — `AUTH_ENV_STRIP` is what nodeterm deletes from a managed account's pane at spawn so a stray key
 * cannot shadow the account, and the Anthropic half of `MODEL_GATEWAY_ENV_KEYS` redirects it — so a
 * settings.json `env` block cannot bring back through Claude Code what the spawn took out. Plus the
 * provider switches (the session would run on the user's cloud credentials) and the config-dir
 * variable itself.
 */
export const IDENTITY_ENV_KEYS: readonly string[] = [
  ...new Set<string>([
    ...AUTH_ENV_STRIP,
    ...MODEL_GATEWAY_ENV_KEYS.filter((k) => k.startsWith('ANTHROPIC_')),
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CONFIG_DIR'
  ])
]

/** The table everything here actually walks: `table` minus anything `NEVER_SHARED` names. A
 *  parameter only so the test can hand it a table with a forbidden entry in it. */
export function setupItems(
  table: readonly { name: ClaudeSetupItemName; kind: 'file' | 'dir' }[] = SHARED_SETUP_ITEMS
): readonly { name: ClaudeSetupItemName; kind: 'file' | 'dir' }[] {
  return table.filter((i) => !Object.hasOwn(NEVER_SHARED, i.name))
}

const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== ''

/**
 * The identity-affecting keys a settings.json sets, as `apiKeyHelper` / `env.ANTHROPIC_API_KEY`.
 * `'unreadable'` when the text is not a JSON object: a file we cannot read is not evidence that it
 * is safe, so the caller withholds it exactly as if it had matched.
 */
export function identityKeysIn(raw: string): string[] | 'unreadable' {
  let value: unknown
  try {
    value = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    return 'unreadable'
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unreadable'
  const obj = value as Record<string, unknown>
  const found: string[] = IDENTITY_SETTINGS_KEYS.filter((k) => isSet(obj[k]))
  const env = obj.env
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const k of IDENTITY_ENV_KEYS) {
      if (isSet((env as Record<string, unknown>)[k])) found.push(`env.${k}`)
    }
  }
  return found
}

/** One allowlisted name in the SYSTEM dir, classified by FOLLOWING (`stat`) — `~/.claude/agents`
 *  that is itself a link into a dotfiles repo is a perfectly good folder to share. `real` is its
 *  realpath, for recognising an account entry that already resolves to it. */
export interface SetupSystemEntry {
  kind: 'file' | 'dir' | 'absent' | 'other'
  real?: string
}

/** One allowlisted name in the ACCOUNT dir, classified WITHOUT following (`lstat`). Only a `link`
 *  can be ours; `other` (a socket, an entry we could not lstat) is never moved or removed. */
export interface SetupAccountEntry {
  kind: 'absent' | 'file' | 'dir' | 'link' | 'other'
  /** Raw `readlink` value, for `link` only. */
  linkTarget?: string
  /** realpath, when it resolves. */
  real?: string
}

export interface SetupShareFacts {
  /** REALPATH of `~/.claude`. */
  systemDir: string
  /** REALPATH of the account's config dir. */
  configDir: string
  system: Partial<Record<ClaudeSetupItemName, SetupSystemEntry>>
  account: Partial<Record<ClaudeSetupItemName, SetupAccountEntry>>
  /** Which names already sit in `<cfg>/.nodeterm-set-aside/`. */
  setAside: Partial<Record<ClaudeSetupItemName, boolean>>
  /** The set-aside folder itself, by `lstat`: anything but a real directory (a link could point the
   *  set-aside renames anywhere) refuses the whole option. */
  setAsideDir: 'absent' | 'dir' | 'other'
  /** `identityKeysIn` of the system settings.json; `[]` when there is none. */
  settingsIdentity: string[] | 'unreadable'
  /** Names nodeterm recorded linking for THIS account dir (already sanitized and dir-matched). */
  recorded: readonly string[]
  /** Windows path semantics. Defaults to this process's platform. */
  win?: boolean
}

export type SetupStep = 'set-aside' | 'link' | 'unlink' | 'restore'

export interface SetupItemPlan {
  name: ClaudeSetupItemName
  kind: 'file' | 'dir'
  /** The link target ON creates and OFF requires: `join(systemDir, name)`. */
  target: string
  /** In order. The applier stops an item at its first failure, and a failed `link` after a
   *  successful `set-aside` puts the account's copy back (the one rollback). */
  steps: SetupStep[]
}

export interface SetupSharePlan {
  items: SetupItemPlan[]
  /** Why an item was left alone, where that is something the person can act on. */
  skipped: { name: ClaudeSetupItemName; reason: ClaudeSetupSkip }[]
  /** The record after a fully successful run. The applier recomputes it from a re-read. */
  recordAfter: ClaudeSetupItemName[]
  refused?: 'same-directory' | 'set-aside-unavailable'
}

/** The link target an item of ours points at. */
export function setupLinkTarget(systemDir: string, name: string, win: boolean): string {
  return (win ? path.win32 : path.posix).join(systemDir, name)
}

/** Rule 1, as ONE predicate shared by the planner, the status read and the applier's last-moment
 *  re-check before an unlink. */
export function isOurSetupLink(
  name: string,
  entry: SetupAccountEntry | undefined,
  systemDir: string,
  recorded: ReadonlySet<string>,
  win: boolean
): boolean {
  return (
    recorded.has(name) &&
    entry?.kind === 'link' &&
    normalizeLinkPath(entry.linkTarget, win) ===
      normalizeLinkPath(setupLinkTarget(systemDir, name, win), win)
  )
}

/** Is this item shareable right now? The coupling and the identity guard live here, once. */
function systemShareable(
  facts: SetupShareFacts,
  item: { name: ClaudeSetupItemName; kind: 'file' | 'dir' }
): {
  ok: boolean
  withheld?: ClaudeSetupSkip
} {
  const sys = facts.system[item.name]
  if (sys?.kind !== item.kind) return { ok: false }
  if (item.name === 'settings.json' || item.name === 'plugins') {
    const settings = facts.system['settings.json']
    // `plugins` without settings.json is half a feature: nothing would enable what it installs.
    if (settings?.kind !== 'file') return { ok: false }
    if (facts.settingsIdentity === 'unreadable') return { ok: false, withheld: 'withheld-unreadable' }
    if (facts.settingsIdentity.length > 0) return { ok: false, withheld: 'withheld-identity' }
  }
  return { ok: true }
}

/** What one item IS right now — the status the Settings row shows, and the planner's input. */
export function classifySetupItem(
  facts: SetupShareFacts,
  name: ClaudeSetupItemName
): ClaudeSetupItemState {
  const win = facts.win ?? process.platform === 'win32'
  const recorded = new Set(facts.recorded)
  const acc = facts.account[name] ?? { kind: 'absent' }
  const sys = facts.system[name]
  const kind = setupItems().find((i) => i.name === name)?.kind
  if (isOurSetupLink(name, acc, facts.systemDir, recorded, win)) {
    return sys?.kind === kind ? 'shared' : 'dangling'
  }
  if (acc.kind === 'absent') return 'none'
  // Already pointing at the system copy by the user's own hand (the two-profile layout, a manual
  // `ln -s`). Its effect is what sharing would do, and it is not ours: left alone in BOTH directions.
  if (acc.real && sys?.real && normalizeLinkPath(acc.real, win) === normalizeLinkPath(sys.real, win)) {
    return 'shared-by-you'
  }
  // We linked it, and something else sits there now — Claude Code or an editor replaced the link
  // with a regular file, or the user swapped it. Never overwritten; reported until resolved.
  if (recorded.has(name)) return 'diverged'
  return 'own'
}

/** The per-item status, for a read with no write (the Settings row on open) and for the re-read
 *  after an apply. */
export function describeSetupShare(facts: SetupShareFacts): ClaudeSetupShareItem[] {
  return setupItems().map(({ name }) => ({
    name,
    state: classifySetupItem(facts, name),
    setAside: !!facts.setAside[name]
  }))
}

/** Both directions of the same-directory refusal, on realpaths: an account dir that IS `~/.claude`
 *  (a linked account hand-edited to it) or sits inside it would make every link point at itself,
 *  and the set-aside renames would move the user's own system files. */
export function setupShareRefusal(
  facts: Pick<SetupShareFacts, 'systemDir' | 'configDir' | 'setAsideDir' | 'win'>
): SetupSharePlan['refused'] {
  const win = facts.win ?? process.platform === 'win32'
  if (
    isAtOrInside(facts.systemDir, facts.configDir, win) ||
    isAtOrInside(facts.configDir, facts.systemDir, win)
  ) {
    return 'same-directory'
  }
  if (facts.setAsideDir === 'other') return 'set-aside-unavailable'
  return undefined
}

/**
 * Decide what to do. Never touches the filesystem, never throws.
 *
 * `gesture: 'toggle'` is the person flipping the switch — the only caller allowed to set an item
 * aside (move the account's own copy) or, with `enabled: false`, to remove anything. `'sweep'` is
 * the launch pass replaying a stored `true`: it links EMPTY slots and does nothing else, because a
 * background pass that moves files is a second, unannounced owner of the account's directory.
 */
export function planSetupShare(
  facts: SetupShareFacts,
  opts: { enabled: boolean; gesture: 'toggle' | 'sweep' }
): SetupSharePlan {
  const win = facts.win ?? process.platform === 'win32'
  const plan: SetupSharePlan = { items: [], skipped: [], recordAfter: [] }
  const refused = setupShareRefusal(facts)
  if (refused) return { ...plan, recordAfter: [...sanitizeRecorded(facts.recorded)], refused }

  // A recorded name ON leaves untouched (diverged, dangling) STAYS recorded, so the row keeps saying
  // so until it is resolved; OFF drops every name, and the applier keeps one only if its unlink failed.
  const after = new Set<ClaudeSetupItemName>(sanitizeRecorded(facts.recorded))

  for (const item of setupItems()) {
    const target = setupLinkTarget(facts.systemDir, item.name, win)
    const state = classifySetupItem(facts, item.name)
    const setAside = !!facts.setAside[item.name]
    const push = (steps: SetupStep[]): void => {
      plan.items.push({ name: item.name, kind: item.kind, target, steps })
    }

    if (!opts.enabled) {
      // OFF removes exactly what rule 1 calls ours, then returns the account's own copy to its slot
      // — and only to an EMPTY slot (`none` here, or the one the unlink just freed).
      after.delete(item.name)
      if (state === 'shared' || state === 'dangling') push(setAside ? ['unlink', 'restore'] : ['unlink'])
      else if (state === 'none' && setAside) push(['restore'])
      else if (setAside) plan.skipped.push({ name: item.name, reason: 'not-restored' })
      continue
    }

    if (state === 'shared' || state === 'dangling' || state === 'shared-by-you') continue
    if (state === 'diverged') {
      plan.skipped.push({ name: item.name, reason: 'diverged' })
      continue
    }
    const share = systemShareable(facts, item)
    if (!share.ok) {
      if (share.withheld) plan.skipped.push({ name: item.name, reason: share.withheld })
      continue
    }
    if (state === 'none') {
      // An empty slot — a fresh share, or one whose copy was already set aside earlier. The sweep
      // may do this one: it moves nothing.
      push(['link'])
      after.add(item.name)
      continue
    }
    // `own`: the account has its own copy in the slot.
    if (opts.gesture === 'sweep') {
      plan.skipped.push({ name: item.name, reason: 'own-kept' })
      continue
    }
    const acc = facts.account[item.name]
    if (acc?.kind === 'other') {
      plan.skipped.push({ name: item.name, reason: 'own-kept' })
      continue
    }
    if (setAside) {
      // Setting aside again would overwrite the copy already there (POSIX rename replaces).
      plan.skipped.push({ name: item.name, reason: 'set-aside-occupied' })
      continue
    }
    push(['set-aside', 'link'])
    after.add(item.name)
  }
  // Table order, so the file it is written to is stable.
  plan.recordAfter = setupItems().map((i) => i.name).filter((n) => after.has(n))
  return plan
}

/** Only allowlisted names survive a read of the record — it is a hand-editable file, and a name
 *  outside the table must never become something the off-switch will act on. */
export function sanitizeRecorded(raw: readonly unknown[]): ClaudeSetupItemName[] {
  const allowed = new Set<string>(setupItems().map((i) => i.name))
  const out: ClaudeSetupItemName[] = []
  for (const v of raw) {
    if (typeof v !== 'string' || !allowed.has(v)) continue
    if (!out.includes(v as ClaudeSetupItemName)) out.push(v as ClaudeSetupItemName)
  }
  return out
}

/** The record file's shape: `{ version: 1, accounts: { <id>: { dir, links } } }`. */
export interface SetupShareRecordFile {
  version: 1
  accounts: Record<string, { dir: string; links: ClaudeSetupItemName[] }>
}

/** Parse the record file, dropping anything it cannot trust: an id outside the account alphabet,
 *  a non-absolute dir, a link name outside the allowlist. Never throws. */
export function sanitizeSetupShareRecord(raw: unknown): SetupShareRecordFile {
  const out: SetupShareRecordFile = { version: 1, accounts: {} }
  if (!raw || typeof raw !== 'object') return out
  const accounts = (raw as { accounts?: unknown }).accounts
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) return out
  for (const [id, entry] of Object.entries(accounts as Record<string, unknown>)) {
    if (!isSafeAccountId(id) || !entry || typeof entry !== 'object') continue
    const { dir, links } = entry as { dir?: unknown; links?: unknown }
    if (typeof dir !== 'string' || !(path.isAbsolute(dir) || path.win32.isAbsolute(dir))) continue
    if (!Array.isArray(links)) continue
    const clean = sanitizeRecorded(links)
    if (clean.length) out.accounts[id] = { dir, links: clean }
  }
  return out
}
