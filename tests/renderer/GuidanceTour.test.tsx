// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { createDemoApi } from '../../src/renderer/src/demo/demoApi'
import { AppRuntimeProvider, type AppRuntime } from '../../src/renderer/src/runtime/AppRuntime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DemoBanner } from '../../src/renderer/src/components/DemoBanner'
import { DemoToolsProvider } from '../../src/renderer/src/components/DemoTools'
import { DemoToolbar } from '../../src/renderer/src/demo/DemoToolbar'
import { demoGuides, demoTour } from '../../src/renderer/src/demo/demoTour'
import { DEMO_TOUR_ID } from '../../src/renderer/src/guidance/guideIds'
import { createFakeGuidanceService, noopGuidanceService } from '../../src/renderer/src/guidance/fakeGuidance'
import { GuidanceProvider } from '../../src/renderer/src/guidance/GuidanceContext'
import { guideAnchors } from '../../src/renderer/src/guidance/anchors'
import { createTourEngine, routePath, type StepControls, type StepRenderer, type StepView } from '../../src/renderer/src/guidance/tourEngine'
import type { Guide } from '../../src/renderer/src/guidance/types'
import { waitForAnchor } from '../../src/renderer/src/guidance/waitForAnchor'
import { buildDemoData, demoCaseIds, demoClientIds } from '../../src/renderer/src/demo/sampleData'
import { escapeHtml } from '../../src/renderer/src/guidance/driverJsProvider'

// The vendor-neutral guidance seam (#102): catalog, wait helper, engine and toolbar,
// all driven by fakes. The Driver.js rendering itself is covered by tests/demo/tour.spec.ts.

function addAnchor(id: string) {
  const el = document.createElement('div')
  el.setAttribute('data-guide-id', id)
  document.body.append(el)
  return el
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('guide catalog', () => {
  it('has the seven planned steps with unique ids, known anchors and plain-text copy', () => {
    expect(demoTour.steps.map((s) => s.stepId)).toEqual([
      'welcome',
      'clients-search',
      'clients-add',
      'client-profile',
      'client-history',
      'client-archive',
      'case'
    ])
    expect(new Set(demoTour.steps.map((s) => s.stepId)).size).toBe(demoTour.steps.length)
    for (const step of demoTour.steps) {
      expect(guideAnchors).toContain(step.anchorId)
      expect(step.route.startsWith('/')).toBe(true)
      expect(`${step.title}${step.body}`).not.toMatch(/[<>]/)
    }
    expect(demoGuides.map((g) => g.guideId)).toEqual([DEMO_TOUR_ID])
    expect(demoTour.version).toBeGreaterThan(0)
  })

  it('uses fixed fictional demo ids for the profile and case steps', () => {
    const routes = demoTour.steps.map((s) => s.route)
    expect(routes).toContain(`/clients/${demoClientIds.lucia}`)
    expect(routes).toContain(`/cases/${demoCaseIds.paternal}`)
  })
})

describe('escapeHtml', () => {
  it('neutralises markup so copy is always shown as plain text', () => {
    expect(escapeHtml(`<img src=x onerror="a()"> & 'q'`)).toBe('&lt;img src=x onerror=&quot;a()&quot;&gt; &amp; &#39;q&#39;')
  })
})

describe('waitForAnchor', () => {
  it('resolves at once when the anchor exists', async () => {
    const el = addAnchor('clients-add')
    await expect(waitForAnchor('clients-add')).resolves.toBe(el)
  })

  it('resolves when the anchor is rendered later, without polling', async () => {
    const pending = waitForAnchor('client-history', { timeoutMs: 2000 })
    const el = addAnchor('client-history')
    await expect(pending).resolves.toBe(el)
  })

  it('gives up with null at the timeout, or when aborted', async () => {
    await expect(waitForAnchor('case-header', { timeoutMs: 20 })).resolves.toBeNull()
    const controller = new AbortController()
    const pending = waitForAnchor('case-header', { timeoutMs: 5000, signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toBeNull()
  })

  it('never builds a selector from an unsafe id', async () => {
    await expect(waitForAnchor('a"] , body [x="', { timeoutMs: 10 })).resolves.toBeNull()
  })
})

describe('tour engine', () => {
  const guide: Guide = {
    guideId: 'test',
    version: 1,
    steps: [
      { stepId: 'a', route: '/', anchorId: 'home-welcome', title: 'A', body: 'a' },
      { stepId: 'b', route: '/clients', anchorId: 'clients-search', title: 'B', body: 'b' },
      { stepId: 'c', route: '/clients', anchorId: 'clients-add', title: 'C', body: 'c' }
    ]
  }

  let hash = '/'
  const routeListeners = new Set<() => void>()
  const shown: StepView[] = []
  let controls: StepControls
  let hides = 0
  const renderer: StepRenderer = {
    show(view, c) {
      shown.push(view)
      controls = c
    },
    hide() {
      hides += 1
    }
  }
  const navigate = vi.fn((route: string) => {
    hash = route
    queueMicrotask(() => routeListeners.forEach((l) => l()))
  })

  const make = (anchors: string[], g: Guide = guide) => {
    anchors.forEach(addAnchor)
    return createTourEngine({
      guides: [g],
      renderer,
      navigate,
      currentRoute: () => routePath(hash),
      onRouteChange: (l) => {
        routeListeners.add(l)
        return () => routeListeners.delete(l)
      },
      anchorTimeoutMs: 30
    })
  }

  beforeEach(() => {
    hash = '/'
    shown.length = 0
    hides = 0
    routeListeners.clear()
    navigate.mockClear()
  })

  it('walks forward and back across routes and completes in memory', async () => {
    const engine = make(['home-welcome', 'clients-search', 'clients-add'])
    await engine.start('test')
    expect(shown.map((v) => v.step.stepId)).toEqual(['a'])
    expect(shown[0]).toMatchObject({ isFirst: true, isLast: false, total: 3 })
    expect(engine.getState()).toMatchObject({ active: true, stepId: 'a' })

    controls.next()
    await vi.waitFor(() => expect(shown).toHaveLength(2))
    expect(navigate).toHaveBeenCalledWith('/clients')
    controls.next()
    await vi.waitFor(() => expect(shown).toHaveLength(3))
    expect(shown[2]).toMatchObject({ step: { stepId: 'c' }, isLast: true })
    expect(navigate).toHaveBeenCalledTimes(1)

    controls.back()
    await vi.waitFor(() => expect(shown).toHaveLength(4))
    expect(shown[3]!.step.stepId).toBe('b')

    controls.next()
    await vi.waitFor(() => expect(shown).toHaveLength(5))
    controls.finish()
    expect(engine.getState()).toMatchObject({ active: false, stepId: null, completedGuideIds: ['test'] })
    expect(engine.isActive()).toBe(false)
  })

  it('skips a step whose anchor never appears, in both directions', async () => {
    const engine = make(['home-welcome', 'clients-add'])
    await engine.start('test')
    controls.next()
    await vi.waitFor(() => expect(shown).toHaveLength(2))
    expect(shown[1]!.step.stepId).toBe('c')
    controls.back()
    await vi.waitFor(() => expect(shown).toHaveLength(3))
    expect(shown[2]!.step.stepId).toBe('a')
  })

  it('ends with a message and no overlay when no anchor can be found', async () => {
    const engine = make([])
    await engine.start('test')
    expect(shown).toHaveLength(0)
    expect(engine.getState()).toMatchObject({ active: false, notice: expect.stringMatching(/could not find/) })
    expect(hides).toBeGreaterThan(0)
  })

  it('finishes when the remaining steps are all missing', async () => {
    const engine = make(['home-welcome'])
    await engine.start('test')
    controls.next()
    await vi.waitFor(() => expect(engine.isActive()).toBe(false))
    expect(engine.getState().completedGuideIds).toEqual(['test'])
  })

  it('stop() closes without completing, and a restart begins at step one', async () => {
    const engine = make(['home-welcome', 'clients-search', 'clients-add'])
    await engine.start('test')
    controls.next()
    await vi.waitFor(() => expect(shown).toHaveLength(2))
    engine.stop()
    expect(engine.getState()).toMatchObject({ active: false, completedGuideIds: [] })
    await engine.start('test')
    expect(shown.at(-1)!.step.stepId).toBe('a')
  })

  it('ends the tour when the route changes by other means', async () => {
    const engine = make(['home-welcome', 'clients-search'])
    await engine.start('test')
    hash = '/settings'
    routeListeners.forEach((l) => l())
    expect(engine.isActive()).toBe(false)
    expect(routeListeners.size).toBe(0)
  })

  it('reports an unknown guide without starting anything', async () => {
    const engine = make(['home-welcome'])
    await engine.start('nope')
    expect(engine.getState()).toMatchObject({ active: false, notice: expect.stringMatching(/not available/) })
  })

  it('notifies subscribers and lets them unsubscribe', async () => {
    const engine = make(['home-welcome'])
    const listener = vi.fn()
    const off = engine.subscribe(listener)
    await engine.start('test')
    expect(listener).toHaveBeenCalled()
    off()
    listener.mockClear()
    engine.stop()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('demo toolbar with a substituted service', () => {
  const runtime: AppRuntime = {
    mode: 'demo',
    switcher: { kind: 'unavailable', reason: 'not-available' },
    data: createDemoApi(buildDemoData(), { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }),
    backup: null,
    cases: null
  }
  const renderBanner = (service?: ReturnType<typeof createFakeGuidanceService>['service']) =>
    render(
      <AppRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <DemoToolsProvider tools={<DemoToolbar />}>
            {service ? (
              <GuidanceProvider service={service}>
                <DemoBanner />
              </GuidanceProvider>
            ) : (
              <DemoBanner />
            )}
          </DemoToolsProvider>
        </MemoryRouter>
      </AppRuntimeProvider>
    )

  it('shows no tour button without a guidance service', () => {
    renderBanner()
    expect(screen.getByRole('region', { name: 'Demo mode' }).textContent).toContain('Demo Mode — Fictional Data Only')
    expect(screen.queryByRole('button', { name: /tour/i })).toBeNull()
  })

  it('starts the demo tour through the service and then offers Restart', () => {
    const { service, calls } = createFakeGuidanceService()
    renderBanner(service)
    fireEvent.click(screen.getByRole('button', { name: 'Take a tour' }))
    expect(calls).toEqual([`start:${DEMO_TOUR_ID}`])
    expect(screen.getByRole('button', { name: 'Restart tour' })).toBeTruthy()
  })

  it('moves focus back to the tour button when the tour closes', () => {
    const { service } = createFakeGuidanceService()
    renderBanner(service)
    fireEvent.click(screen.getByRole('button', { name: 'Take a tour' }))
    const other = document.createElement('button')
    document.body.append(other)
    other.focus()
    service.stop()
    return vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Take a tour' })))
  })

  it('has an inert no-op service for tests', async () => {
    await noopGuidanceService.start('x')
    expect(noopGuidanceService.isActive()).toBe(false)
  })
})
