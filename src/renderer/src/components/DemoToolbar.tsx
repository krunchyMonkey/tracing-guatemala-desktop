import { useEffect, useRef } from 'react'
import { DEMO_TOUR_ID } from '../guidance/guideIds'
import { useGuidance, useGuidanceState } from '../guidance/GuidanceContext'

// Demo-only actions beside the Demo Mode banner (#102). Rendered by DemoBanner, so
// they never appear in the Live web app or the desktop app. Without a guidance
// service (tests, or before the tour code has loaded) there is no tour button.
export function DemoToolbar() {
  const guidance = useGuidance()
  const state = useGuidanceState()
  const tourButton = useRef<HTMLButtonElement>(null)
  const wasActive = useRef(false)

  // After the tour closes (Finish, Escape, Close, interruption) focus returns here.
  useEffect(() => {
    if (wasActive.current && !state.active) tourButton.current?.focus()
    wasActive.current = state.active
  }, [state.active])

  const completed = state.completedGuideIds.includes(DEMO_TOUR_ID)

  return (
    <div className="demo-actions">
      {guidance && (
        <button
          ref={tourButton}
          type="button"
          className="button button-secondary demo-action"
          onClick={() => void guidance.start(DEMO_TOUR_ID)}
        >
          {completed || state.active ? 'Restart tour' : 'Take a tour'}
        </button>
      )}
      {state.notice && (
        <span role="status" className="demo-notice">
          {state.notice}
        </span>
      )}
    </div>
  )
}
