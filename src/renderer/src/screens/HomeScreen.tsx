import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { BackupReminder } from '../components/BackupReminder'
import { CasesLoadError, StateBadge } from '../cases/components'
import { formatDueDate } from '../cases/model'
import { useLoad } from '../cases/useLoad'
import { formatDate } from '../clients/components'
import { useAppRuntime, type CaseApi } from '../runtime/AppRuntime'
import {
  hoursLabel,
  STUDIO_DUE_WINDOW_DAYS,
  type StudioActivity,
  type StudioCase,
  type StudioSummary,
  type StudioTask
} from '../../../shared/studio-summary'
import { guideAnchor } from '../guidance/anchors'

// Research Studio (#116): the Home dashboard. One aggregate read (getStudioSummary)
// feeds the welcome header, the Continue researching action, the metric tiles and
// the Active cases, Upcoming tasks and Recent activity lists. Live and Demo share
// this component; Demo only adds a label saying the figures are illustrative. Every
// link goes to a real case route. The desktop app has no case support and keeps a
// simple welcome.

const todayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

export function HomeScreen() {
  const { mode, cases } = useAppRuntime()
  if (!cases) return <PlainWelcome demo={mode === 'demo'} />
  return <Studio api={cases} demo={mode === 'demo'} />
}

function PlainWelcome({ demo }: { demo: boolean }) {
  return (
    <section aria-labelledby="home-heading">
      <h1 id="home-heading">Welcome</h1>
      {demo ? (
        <>
          <p className="lead">A preview of the research workspace, filled with fictional clients.</p>
          <DemoGuidance />
        </>
      ) : (
        <>
          <BackupReminder />
          <p className="lead">Your research workspace. Everything you add stays on this computer.</p>
          <p className="placeholder-note">This is an early preview. Client management is being built next.</p>
        </>
      )}
    </section>
  )
}

function DemoGuidance() {
  return (
    <p className="placeholder-note">
      Try the <Link to="/clients">Clients</Link> screen: search and filter, add or edit a client, write notes and contact
      entries, and archive or restore a client. Nothing is saved; refreshing the page resets the demo.
    </p>
  )
}

function Studio({ api, demo }: { api: CaseApi; demo: boolean }) {
  const loaded = useLoad(() => api.getStudioSummary(), 'studio')
  const summary = loaded.data

  return (
    <section aria-labelledby="home-heading" className="studio">
      {!demo && <BackupReminder />}
      <header className="studio-header" {...guideAnchor('home-welcome')}>
        <div className="studio-textile" aria-hidden="true" />
        <p className="studio-eyebrow">Research Studio</p>
        <h1 id="home-heading">Welcome</h1>
        <p className="studio-date">{todayFormat.format(new Date())}</p>
      </header>

      {loaded.status === 'error' && <CasesLoadError onRetry={loaded.retry} what="The studio overview" />}
      {loaded.status === 'loading' && !summary && (
        <p role="status" className="muted">
          Loading your studio…
        </p>
      )}

      {summary && (
        <>
          <ContinuePanel summary={summary} />
          <Metrics summary={summary} demo={demo} />
          <div className="studio-columns">
            <ActiveCases items={summary.activeCases} />
            <UpcomingTasks items={summary.upcomingTasks} />
            <RecentActivity items={summary.recentActivity} />
          </div>
        </>
      )}
      {demo && <DemoGuidance />}
    </section>
  )
}

function ContinuePanel({ summary }: { summary: StudioSummary }) {
  const target = summary.continueCase
  if (target) {
    return (
      <div className="studio-continue">
        <Link className="button button-primary studio-continue-button" to={`/cases/${target.caseId}`} aria-describedby="continue-case">
          Continue researching <span aria-hidden="true">→</span>
        </Link>
        <p id="continue-case" className="studio-continue-case">
          <strong>{target.caseTitle}</strong> <span className="muted">for {target.clientDisplayName}</span>
        </p>
      </div>
    )
  }
  return (
    <div className="studio-continue">
      {summary.counts.activeClients > 0 ? (
        <>
          <Link className="button button-primary studio-continue-button" to="/cases/new">
            Start a case
          </Link>
          <p className="studio-continue-case muted">No open cases yet. Pick a client and start their first case.</p>
        </>
      ) : (
        <>
          <Link className="button button-primary studio-continue-button" to="/clients/new">
            Add your first client
          </Link>
          <p className="studio-continue-case muted">Every case belongs to a client, so start by adding one.</p>
        </>
      )}
    </div>
  )
}

function Metrics({ summary, demo }: { summary: StudioSummary; demo: boolean }) {
  const { counts, hours } = summary
  const tiles: { label: string; value: string; hint?: string; tone: string }[] = [
    { label: 'Open cases', value: String(counts.openCases), hint: `${counts.casesByState.active} active`, tone: 'accent' },
    {
      label: 'Overdue tasks',
      value: String(counts.overdueTasks),
      hint: counts.overdueTasks > 0 ? 'Needs attention' : 'All caught up',
      tone: counts.overdueTasks > 0 ? 'alert' : 'teal'
    },
    { label: `Due in ${STUDIO_DUE_WINDOW_DAYS} days`, value: String(counts.tasksDueSoon), hint: 'Tasks with a deadline', tone: 'gold' },
    { label: 'Hours this week', value: hoursLabel(hours.weekMinutes), hint: `${hoursLabel(hours.monthMinutes)} this month`, tone: 'teal' }
  ]
  return (
    <section aria-labelledby="studio-metrics-heading" className="studio-metrics">
      <h2 id="studio-metrics-heading" className="visually-hidden">
        At a glance
      </h2>
      {demo && <p className="studio-demo-note">Illustrative figures from fictional demo data</p>}
      <ul className="studio-tiles">
        {tiles.map((tile) => (
          <li key={tile.label} className={`studio-tile studio-tile-${tile.tone}`}>
            <span className="studio-tile-value">{tile.value}</span>
            <span className="studio-tile-label">{tile.label}</span>
            {tile.hint && <span className="studio-tile-hint">{tile.hint}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Panel({ id, title, empty, children }: { id: string; title: string; empty: string | null; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="card studio-panel">
      <h2 id={id}>{title}</h2>
      {empty ? <p className="muted studio-empty">{empty}</p> : <ul className="studio-list">{children}</ul>}
    </section>
  )
}

function ActiveCases({ items }: { items: StudioCase[] }) {
  return (
    <Panel id="studio-cases-heading" title="Active cases" empty={items.length === 0 ? 'No open cases right now.' : null}>
      {items.map((item) => (
        <li key={item.caseId}>
          <Link className="studio-row" to={`/cases/${item.caseId}`}>
            <span className="studio-row-title">{item.caseTitle}</span>
            <span className="studio-row-meta">
              {item.clientDisplayName} <StateBadge state={item.state} />
              {item.dueDate && <> · Due {formatDueDate(item.dueDate)}</>}
            </span>
          </Link>
        </li>
      ))}
    </Panel>
  )
}

function UpcomingTasks({ items }: { items: StudioTask[] }) {
  return (
    <Panel id="studio-tasks-heading" title="Upcoming tasks" empty={items.length === 0 ? 'Nothing is due. Tasks with a deadline appear here.' : null}>
      {items.map((item) => (
        <li key={item.taskId}>
          <Link className="studio-row" to={`/cases/${item.caseId}`}>
            <span className="studio-row-title">{item.title}</span>
            <span className="studio-row-meta">
              {item.caseTitle} · {item.clientDisplayName}
            </span>
            <span className="due-date">
              <time dateTime={item.dueDate}>{formatDueDate(item.dueDate)}</time>
              {item.overdue && <span className="overdue-tag">Overdue</span>}
            </span>
          </Link>
        </li>
      ))}
    </Panel>
  )
}

function RecentActivity({ items }: { items: StudioActivity[] }) {
  return (
    <Panel id="studio-activity-heading" title="Recent activity" empty={items.length === 0 ? 'Activity appears here as you work on cases.' : null}>
      {items.map((item) => (
        <li key={item.id}>
          <Link className="studio-row" to={`/cases/${item.caseId}`}>
            <span className="studio-row-title">{item.label}</span>
            <span className="studio-row-meta">
              {item.caseTitle} · {item.clientDisplayName}
            </span>
            <time className="muted studio-row-time" dateTime={item.at}>
              {formatDate(item.at)}
            </time>
          </Link>
        </li>
      ))}
    </Panel>
  )
}
