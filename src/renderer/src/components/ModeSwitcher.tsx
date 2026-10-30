import { useAppRuntime, type ModeSwitch } from '../runtime/AppRuntime'

// Always shows which mode this page is in and what that means for the data (#114),
// plus the way to the other mode. Demo and Live are separate origins, so the way
// across is a real link only when the entry point found a safe address; otherwise
// it is plain text that explains why (no anchor, nothing to click).
const demoReasons = {
  'not-on-host': 'Live mode opens only on the researcher’s own computer.',
  'not-running': 'Start Tracing Guatemala on this computer to use Live.',
  'not-available': 'Live mode is not available here.'
} as const

function Switch({ switcher, label, unavailable }: { switcher: ModeSwitch; label: string; unavailable: string }) {
  return switcher.kind === 'link' ? (
    <a className="mode-switch-link" href={switcher.href} rel="noreferrer">
      {label}
    </a>
  ) : (
    <p className="mode-switch-note">{unavailable}</p>
  )
}

export function ModeSwitcher() {
  const runtime = useAppRuntime()
  if (runtime.mode === 'desktop') return null

  if (runtime.mode === 'live') {
    return (
      <section className="mode-switcher mode-switcher-live" aria-label="Workspace mode">
        <p className="mode-badge">Live · saved on this computer</p>
        <Switch switcher={runtime.switcher} label="Open the fictional demo" unavailable="Demo not available" />
      </section>
    )
  }
  const { switcher } = runtime
  return (
    <section className="mode-switcher mode-switcher-demo" aria-label="Workspace mode">
      <p className="mode-badge">Demo · nothing is saved</p>
      <Switch
        switcher={switcher}
        label="Back to Live (your real data)"
        unavailable={switcher.kind === 'unavailable' ? demoReasons[switcher.reason] : ''}
      />
    </section>
  )
}
