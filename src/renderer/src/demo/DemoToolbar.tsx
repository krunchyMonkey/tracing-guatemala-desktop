import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { DEMO_TOUR_ID } from '../guidance/guideIds'
import { useGuidance, useGuidanceState } from '../guidance/GuidanceContext'
import { screenLabelFor } from './feedback/payload'
import { useAppRuntime } from '../runtime/AppRuntime'
import { FeedbackDialog } from './FeedbackDialog'

// Demo-only actions beside the Demo Mode banner (#102). Rendered by DemoBanner, so
// they never appear in the Live web app or the desktop app. Without a guidance
// service (tests, or before the tour code has loaded) there is no tour button.
export function DemoToolbar() {
  const guidance = useGuidance()
  const state = useGuidanceState()
  const runtime = useAppRuntime()
  const { pathname } = useLocation()
  const tourButton = useRef<HTMLButtonElement>(null)
  const wasActive = useRef(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [appVersion, setAppVersion] = useState('0.0.0')

  // After the tour closes (Finish, Escape, Close, interruption) focus returns here.
  useEffect(() => {
    if (wasActive.current && !state.active) tourButton.current?.focus()
    wasActive.current = state.active
  }, [state.active])

  useEffect(() => {
    let current = true
    runtime.data.getAppInfo().then(
      (info) => {
        if (current) setAppVersion(info.version)
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [runtime])

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
      <button type="button" className="button button-secondary demo-action" onClick={() => setFeedbackOpen(true)}>
        Send feedback
      </button>
      {state.notice && (
        <span role="status" className="demo-notice">
          {state.notice}
        </span>
      )}
      {feedbackOpen && (
        <FeedbackDialog screen={screenLabelFor(pathname)} guideStep={state.stepId} appVersion={appVersion} onClose={() => setFeedbackOpen(false)} />
      )}
    </div>
  )
}
