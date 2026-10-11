// What to tell the user about "Share ~/.claude setup" for one account — after flipping the switch,
// and every time Settings opens. Pure, so every sentence is unit-tested rather than reasoned about.
//
// Two kinds of text, and the split matters: the SUMMARY (what is shared, what is set aside) sits
// under the switch inside the account's folded options, while a WARNING is something the person
// must not miss and is shown on the account row itself. A shared settings.json that a program
// replaced with a regular file (`diverged`) or a ~/.claude/settings.json that now replaces this
// account's login are both silent otherwise: the switch still says "on".
import type {
  ClaudeSetupItemName,
  ClaudeSetupShareItem,
  ClaudeSetupShareResult
} from '@shared/types'

export interface SetupShareView {
  summary: string | null
  warnings: string[]
}

const FILE_ITEMS: ReadonlySet<ClaudeSetupItemName> = new Set(['settings.json', 'CLAUDE.md'])

/** "a", "a and b", "a, b and c". */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
const isAre = (n: readonly unknown[]): string => (n.length === 1 ? 'is' : 'are')
const itThem = (n: readonly unknown[]): string => (n.length === 1 ? 'it' : 'them')

function errorSentence(item: ClaudeSetupShareItem, enabled: boolean): string {
  const code = item.error ?? 'failed'
  if (code === 'EPERM' && enabled && FILE_ITEMS.has(item.name)) {
    // A folder is a junction and needs no privilege; a FILE link on Windows does. Same wording as
    // the worktree shared-paths EPERM, which hits the identical Windows rule.
    return `${item.name} could not be linked: symlink not permitted (on Windows, enable Developer Mode). This account keeps its own copy.`
  }
  if (code === 'not-ours') {
    return `${item.name} changed while it was being unlinked, so it was left as it is.`
  }
  if (code === 'EEXIST') {
    return `${item.name} was left alone: something is already in the place it would move to.`
  }
  return `${item.name} could not be ${enabled ? 'linked' : 'unlinked'} (${code}).`
}

export function setupShareView(res: ClaudeSetupShareResult, enabled: boolean): SetupShareView {
  const warnings: string[] = []
  if (res.error) {
    // An empty `items` here is "could not look", never "nothing to share".
    return { summary: null, warnings: [`Setup sharing could not be checked (${res.error}).`] }
  }
  if (res.refused === 'remote-account') {
    return { summary: 'Accounts on an SSH host keep their own setup — nothing was changed.', warnings }
  }
  if (res.refused === 'same-directory') {
    return {
      summary: 'This account’s folder is ~/.claude itself (or inside it), so there is nothing to share.',
      warnings
    }
  }
  if (res.refused === 'set-aside-unavailable') {
    return {
      summary: null,
      warnings: [`${res.setAsideDir} is not a folder, so nothing was changed. Remove or rename it first.`]
    }
  }

  const by = (pred: (i: ClaudeSetupShareItem) => boolean): ClaudeSetupItemName[] =>
    res.items.filter(pred).map((i) => i.name)
  const shared = by((i) => i.state === 'shared')
  const byYou = by((i) => i.state === 'shared-by-you')
  const diverged = by((i) => i.state === 'diverged')
  const dangling = by((i) => i.state === 'dangling')
  const settings = res.items.find((i) => i.name === 'settings.json')
  const keys = list(res.identityKeys)

  for (const item of res.items) if (item.error) warnings.push(errorSentence(item, enabled))

  if (enabled) {
    if (res.identityKeys.length > 0 && settings?.state === 'shared') {
      warnings.push(
        `~/.claude/settings.json now sets ${keys}, which can replace or redirect this account’s own login. Turn this off to give it its own settings back.`
      )
    } else if (res.identityKeys.length > 0) {
      warnings.push(
        `settings.json and plugins are not shared: ~/.claude/settings.json sets ${keys}, which would replace or redirect this account’s own login.`
      )
    } else if (res.settingsUnreadable && settings?.state !== 'shared') {
      warnings.push(
        'settings.json and plugins are not shared: ~/.claude/settings.json could not be read as JSON.'
      )
    }
    if (diverged.length) {
      warnings.push(
        `${list(diverged)} ${isAre(diverged)} no longer shared — ${
          diverged.length === 1 ? 'it was' : 'they were'
        } replaced by a regular file in ${res.configDir ?? 'this account’s folder'}. Copy any change you want to keep into ~/.claude, delete ${itThem(diverged)} there, then turn this off and on again.`
      )
    }
    if (dangling.length) {
      warnings.push(
        `${list(dangling)} ${isAre(dangling)} linked, but ~/.claude no longer has ${itThem(dangling)}.`
      )
    }
    for (const item of res.items) {
      if (item.skipped === 'set-aside-occupied') {
        warnings.push(
          `${item.name} was not shared: ${res.setAsideDir} already holds a copy of it. Move that copy out first.`
        )
      }
    }

    const parts: string[] = []
    if (shared.length) parts.push(`Sharing ${list(shared)}.`)
    else if (!byYou.length) parts.push('Nothing in ~/.claude to share yet.')
    if (byYou.length) {
      parts.push(`${list(byYou)} already ${byYou.length === 1 ? 'points' : 'point'} at ~/.claude on ${byYou.length === 1 ? 'its' : 'their'} own.`)
    }
    const aside = by((i) => i.setAside && i.state === 'shared')
    if (aside.length) {
      parts.push(`This account’s own ${list(aside)} ${isAre(aside)} set aside and ${aside.length === 1 ? 'comes' : 'come'} back when you turn this off.`)
    }
    return { summary: parts.join(' '), warnings }
  }

  // OFF. Silence is the normal answer; what is left is something the switch could not finish.
  const stillLinked = [...shared, ...dangling]
  if (stillLinked.length) {
    warnings.push(
      `${list(stillLinked)} ${isAre(stillLinked)} still linked to ~/.claude. Turn this on and off again to remove ${itThem(stillLinked)}.`
    )
  }
  const notBack = by((i) => i.setAside && i.state !== 'shared' && i.state !== 'dangling')
  if (notBack.length) {
    warnings.push(
      `${list(notBack)} ${notBack.length === 1 ? 'was' : 'were'} not put back: something else is in ${
        notBack.length === 1 ? 'its' : 'their'
      } place now. This account’s earlier copy is in ${res.setAsideDir}.`
    )
  }
  return { summary: null, warnings }
}
