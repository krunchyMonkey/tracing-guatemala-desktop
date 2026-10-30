import { driver, type Driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import './tour.css'
import { findAnchor } from './waitForAnchor'
import { createTourEngine, routePath, type StepControls, type StepRenderer, type StepView } from './tourEngine'
import type { GuidanceService, Guide } from './types'

// The ONLY module that imports driver.js and its stylesheet (#102). Both are
// bundled locally by Vite; nothing is fetched at run time. It is loaded with a
// dynamic import from the demo entry only, so the Live web app and the desktop
// app never contain it. Driver.js sets its styles through the CSSOM, which the
// demo's `style-src 'self'` allows; no CSP directive is relaxed for it.

/** Driver.js renders `title`/`description` as HTML, but guide copy is plain text. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

class DriverStepRenderer implements StepRenderer {
  private current: Driver | null = null
  private currentGuide: Guide | null = null
  private hiding = false
  private controls: StepControls | null = null

  constructor(private readonly reducedMotion: () => boolean) {}

  show(view: StepView, controls: StepControls): void {
    this.controls = controls
    if (!this.current || this.currentGuide !== view.guide) {
      this.hide()
      this.currentGuide = view.guide
      this.current = this.create(view.guide)
    }
    this.current.drive(view.index)
  }

  hide(): void {
    const existing = this.current
    this.current = null
    this.currentGuide = null
    if (!existing) return
    this.hiding = true
    try {
      existing.destroy()
    } finally {
      this.hiding = false
    }
  }

  private create(guide: Guide): Driver {
    const total = guide.steps.length
    const steps: DriveStep[] = guide.steps.map((step, i) => ({
      element: () => findAnchor(step.anchorId) ?? document.body,
      popover: {
        title: escapeHtml(step.title),
        description: escapeHtml(step.body),
        side: 'bottom',
        align: 'start',
        progressText: `Step ${i + 1} of ${total}`,
        nextBtnText: i === total - 1 ? 'Finish' : 'Next',
        showButtons: i === 0 ? ['next', 'close'] : ['next', 'previous', 'close']
      }
    }))
    const reduced = this.reducedMotion()
    return driver({
      steps,
      animate: !reduced,
      smoothScroll: !reduced,
      allowClose: true,
      allowKeyboardControl: true,
      overlayClickBehavior: 'none',
      disableActiveInteraction: true,
      showProgress: true,
      prevBtnText: 'Back',
      doneBtnText: 'Finish',
      closeBtnLabel: 'Close tour',
      popoverClass: 'tg-tour-popover',
      stagePadding: 6,
      onPopoverRender: (popover) => {
        popover.wrapper.setAttribute('role', 'dialog')
        popover.wrapper.setAttribute('aria-label', 'Guided tour')
      },
      onNextClick: () => this.controls?.next(),
      onPrevClick: () => this.controls?.back(),
      onDoneClick: () => this.controls?.finish(),
      // Escape, the close button, or the library tearing itself down.
      onDestroyed: () => {
        if (!this.hiding) {
          this.current = null
          this.currentGuide = null
          this.controls?.close()
        }
      }
    })
  }
}

export interface DriverJsOptions {
  guides: readonly Guide[]
  anchorTimeoutMs?: number
}

export function createDriverJsGuidanceService({ guides, anchorTimeoutMs }: DriverJsOptions): GuidanceService {
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  return createTourEngine({
    guides,
    anchorTimeoutMs,
    renderer: new DriverStepRenderer(reducedMotion),
    navigate: (route) => {
      window.location.hash = `#${route}`
    },
    currentRoute: () => routePath(window.location.hash),
    onRouteChange: (listener) => {
      window.addEventListener('hashchange', listener)
      return () => window.removeEventListener('hashchange', listener)
    }
  })
}
