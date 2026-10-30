import { DEMO_TOUR_ID } from '../guidance/guideIds'
import type { Guide } from '../guidance/types'
import { demoCaseIds, demoClientIds } from './sampleData'

// App-owned guide catalog (#102). Plain-text copy only. Every step explains or
// points; none clicks, types, saves, archives, submits or exports. Profile and
// case steps use fixed fictional demo ids.

export const demoTour: Guide = {
  guideId: DEMO_TOUR_ID,
  version: 1,
  steps: [
    {
      stepId: 'welcome',
      route: '/',
      anchorId: 'home-welcome',
      title: 'Welcome to the Research Studio',
      body: 'This is your home base: open cases, upcoming tasks and recent activity. Everything here is fictional.'
    },
    {
      stepId: 'clients-search',
      route: '/clients',
      anchorId: 'clients-search',
      title: 'Find any client',
      body: 'Search by name, Fiverr username or email, then narrow the list by status or source.'
    },
    {
      stepId: 'clients-add',
      route: '/clients',
      anchorId: 'clients-add',
      title: 'Add a client',
      body: 'New clients start here. The tour will not open it, so nothing is created.'
    },
    {
      stepId: 'client-profile',
      route: `/clients/${demoClientIds.lucia}`,
      anchorId: 'client-summary',
      title: 'A client profile',
      body: 'Contact details and background live together on one page. This is a made-up client.'
    },
    {
      stepId: 'client-history',
      route: `/clients/${demoClientIds.lucia}`,
      anchorId: 'client-history',
      title: 'Notes and contact history',
      body: 'Record what you found and every message sent or received. The tour will not save anything.'
    },
    {
      stepId: 'client-archive',
      route: `/clients/${demoClientIds.lucia}`,
      anchorId: 'client-archive',
      title: 'Archive and restore',
      body: 'Archiving hides a client without deleting anything, and restoring brings everything back. Not used in this tour.'
    },
    {
      stepId: 'case',
      route: `/cases/${demoCaseIds.paternal}`,
      anchorId: 'case-header',
      title: 'A research case',
      body: 'Each order becomes a case with its goal, tasks, journal and hours. This is that client’s case.'
    }
  ]
}

export const demoGuides: readonly Guide[] = [demoTour]
