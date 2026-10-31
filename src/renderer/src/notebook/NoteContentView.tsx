import { Fragment, type ReactNode } from 'react'
import { isSafeHref, type NoteBlock, type NoteContent, type RecordKind, type RecordRef, type TextRun } from '../../../shared/note-content'

// A read-only, safe rendering of page content (revision previews). Only React elements:
// text goes in as text children (React escapes it), there is no innerHTML anywhere, and
// a link is only made from an address that passes the same http/https/mailto check the
// host applies. No inline styles (the CSP forbids them); indent is a class.

const DEFAULT_LABELS: Record<RecordKind, string> = { journal: 'Journal entry', task: 'Task', time: 'Research hours entry' }

type ListBlock = Extract<NoteBlock, { type: 'bullet' | 'numbered' | 'check' }>
const isList = (block: NoteBlock): block is ListBlock => block.type === 'bullet' || block.type === 'numbered' || block.type === 'check'

function lines(text: string): ReactNode[] {
  return text.split('\n').flatMap((part, index) => (index === 0 ? [part] : [<br key={index} />, part]))
}

function Run({ run }: { run: TextRun }) {
  let node: ReactNode = <>{lines(run.text)}</>
  const marks = run.marks ?? []
  if (marks.includes('code')) node = <code>{node}</code>
  if (marks.includes('bold')) node = <strong>{node}</strong>
  if (marks.includes('italic')) node = <em>{node}</em>
  if (marks.includes('underline')) node = <u>{node}</u>
  if (marks.includes('strike')) node = <s>{node}</s>
  if (run.href && isSafeHref(run.href)) {
    node = (
      <a href={run.href} target="_blank" rel="noopener noreferrer nofollow">
        {node}
      </a>
    )
  }
  return <>{node}</>
}

const Runs = ({ runs }: { runs: TextRun[] }) => (
  <>
    {runs.map((run, index) => (
      <Run key={index} run={run} />
    ))}
  </>
)

const indentClass = (indent: number): string | undefined => (indent > 0 ? `note-indent-${indent}` : undefined)

function Block({ block, describe }: { block: Exclude<NoteBlock, ListBlock>; describe: (ref: RecordRef) => string }) {
  switch (block.type) {
    case 'paragraph':
      return (
        <p className={indentClass(block.indent)}>
          <Runs runs={block.content} />
        </p>
      )
    case 'heading': {
      const Tag = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5'
      return (
        <Tag>
          <Runs runs={block.content} />
        </Tag>
      )
    }
    case 'divider':
      return <hr />
    case 'reference':
      return (
        <div className="note-reference">
          <span className="note-reference-label">{describe(block.target)}</span>
        </div>
      )
  }
}

function List({ items }: { items: ListBlock[] }) {
  const first = items[0]!
  const counters: number[] = []
  const rows = items.map((item) => {
    let value: number | undefined
    if (item.type === 'numbered') {
      counters[item.indent] = (counters[item.indent] ?? 0) + 1
      counters.length = item.indent + 1
      value = counters[item.indent]
    } else {
      counters.length = Math.min(counters.length, item.indent)
    }
    return (
      <li key={item.id} value={value} className={indentClass(item.indent)}>
        {item.type === 'check' && <span aria-label={item.checked ? 'Done: ' : 'To do: '}>{item.checked ? '☑ ' : '☐ '}</span>}
        <Runs runs={item.content} />
      </li>
    )
  })
  return first.type === 'numbered' ? <ol className="note-view-list">{rows}</ol> : <ul className={`note-view-list${first.type === 'check' ? ' note-view-checks' : ''}`}>{rows}</ul>
}

export function NoteContentView({ content, describe }: { content: NoteContent; describe?: (ref: RecordRef) => string }) {
  const label = describe ?? ((ref: RecordRef) => DEFAULT_LABELS[ref.kind])
  const out: ReactNode[] = []
  let index = 0
  while (index < content.blocks.length) {
    const block = content.blocks[index]!
    if (isList(block)) {
      const items: ListBlock[] = [block]
      while (index + 1 < content.blocks.length) {
        const next = content.blocks[index + 1]!
        if (!isList(next) || next.type !== block.type) break
        items.push(next)
        index += 1
      }
      out.push(<List key={block.id} items={items} />)
    } else {
      out.push(<Block key={block.id} block={block as Exclude<NoteBlock, ListBlock>} describe={label} />)
    }
    index += 1
  }
  if (out.length === 0) return <p className="muted note-view-empty">This version is empty.</p>
  return (
    <div className="note-view">
      {out.map((node, i) => (
        <Fragment key={i}>{node}</Fragment>
      ))}
    </div>
  )
}

