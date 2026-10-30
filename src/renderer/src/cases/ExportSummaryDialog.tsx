import { useState } from 'react'
import { composeCaseSummary, summaryFileName } from '../../../shared/case-summary'
import { Alert, ConfirmDialog } from '../clients/components'
import { useAppRuntime } from '../runtime/AppRuntime'
import { downloadText } from './downloadText'
import { loadCaseSummaryData } from './exportSummary'
import { localDateString } from './model'

// "Export summary…" (#20): says what the file will contain, warns that it is not
// encrypted, then builds it in the browser from this case's own data and saves it
// with a download. Read-only: exporting never changes the case or any other record.

interface Props {
  caseId: string
  caseTitle: string
  /** Called with a short message after the file was handed to the browser. */
  onExported(message: string): void
  onCancel(): void
}

export function ExportSummaryDialog({ caseId, caseTitle, onExported, onCancel }: Props) {
  const runtime = useAppRuntime()
  const [fileName] = useState(() => summaryFileName(caseTitle, localDateString(new Date())))
  const [working, setWorking] = useState(false)
  const [failure, setFailure] = useState<'failed' | 'missing' | null>(null)

  async function download() {
    setWorking(true)
    setFailure(null)
    try {
      const data = await loadCaseSummaryData(runtime, caseId)
      if (data === null) {
        setFailure('missing')
        return
      }
      const now = new Date()
      const text = composeCaseSummary(data, {
        generatedAt: now,
        localToday: localDateString(now),
        demo: runtime.mode === 'demo'
      })
      downloadText(fileName, text)
      onExported('Summary prepared. Your browser will save it or ask where to save it.')
    } catch {
      // Never put the error or any text into the page or the console: it may carry case content.
      setFailure('failed')
    } finally {
      setWorking(false)
    }
  }

  return (
    <ConfirmDialog
      title="Export case summary"
      confirmLabel="Download"
      confirmDisabled={working}
      onCancel={onCancel}
      onConfirm={() => void download()}
    >
      {failure && (
        <Alert tone="error" title="The summary couldn’t be created">
          <p>
            {failure === 'missing'
              ? 'This case or its client couldn’t be found any more, so nothing was exported.'
              : 'The case’s details couldn’t be read, so nothing was exported. Nothing was changed. Please try again.'}
          </p>
        </Alert>
      )}
      <p>
        Creates a Markdown file (.md) from <strong>this case only</strong>. It includes:
      </p>
      <ul className="export-includes">
        <li>The client’s name only — no contact details</li>
        <li>The requested outcome and the research brief</li>
        <li>Next steps</li>
        <li>The research journal</li>
        <li>The case history</li>
      </ul>
      <p>
        File name: <code className="export-file-name">{fileName}</code>
      </p>
      <p>
        <strong>The file is not encrypted.</strong> Anyone who can open it can read it, so keep it private and delete it
        when you no longer need it.
      </p>
      <p className="hint">
        Your browser will save or ask where to save it. This app can’t see where the file ends up. Exporting changes
        nothing in your cases.
      </p>
    </ConfirmDialog>
  )
}
