import { DemoToolbar } from './DemoToolbar'

// Shown on every screen of the browser demo (#100), so nobody mistakes it for the
// real app or types real client details into it. Its actions (#102) sit beside it.
export function DemoBanner() {
  return (
    <div className="demo-banner" role="region" aria-label="Demo mode">
      <strong className="demo-banner-title">Demo Mode — Fictional Data Only</strong>
      <span className="demo-banner-text">Changes stay in this browser tab and reset when you refresh. Don’t enter real client details.</span>
      <DemoToolbar />
    </div>
  )
}
