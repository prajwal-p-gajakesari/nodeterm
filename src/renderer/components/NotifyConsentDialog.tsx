import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'

interface Props {
  onEnable: () => void
  onDismiss: () => void
}

/** A polished one-time prompt asking to enable agent notifications. Enable answers BOTH kinds —
 *  a finished turn and an agent that needs you (`notifyConsentPatch`); Settings splits them. */
export function NotifyConsentDialog({ onEnable, onDismiss }: Props) {
  // Only the TOPMOST modal answers a key — this one and a ConfirmDialog can be on screen together,
  // and both window listeners used to fire on one Enter (see ./dialog-stack).
  const isTop = useDialogStack()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onDismiss()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onEnable()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, onEnable, onDismiss])

  return createPortal(
    <div className="consent-overlay" onClick={onDismiss}>
      <div className="consent-card" onClick={(e) => e.stopPropagation()}>
        <div className="consent-icon">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
        </div>
        <h2 className="consent-title">Get notified when an agent finishes or needs you</h2>
        <p className="consent-desc">
          nodeterm can ping you when an agent's turn finishes, or when it is waiting on an
          approval or a question, while the app is in the background — so you don't have to
          babysit a running session. You can change either one any time in Settings.
        </p>
        <div className="consent-actions">
          <button className="consent-btn ghost" onClick={onDismiss}>
            Not now
          </button>
          <button className="consent-btn primary" autoFocus onClick={onEnable}>
            Enable notifications
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
