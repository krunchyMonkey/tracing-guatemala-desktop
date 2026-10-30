import { createContext, useContext, type ReactNode } from 'react'
import type { CanvasSurfaceAdapter, RichTextEditorAdapter } from './ports'

// React seam for the notebook's replaceable parts (#146). The composition root
// (adapters/index.ts) picks the concrete adapters; tests and entries can inject others.

export interface NotebookAdapters {
  editor: RichTextEditorAdapter
  /** Null until a canvas ships (Release B). */
  canvas: CanvasSurfaceAdapter | null
}

const NotebookAdaptersContext = createContext<NotebookAdapters | null>(null)

export function NotebookAdaptersProvider({ adapters, children }: { adapters: NotebookAdapters; children: ReactNode }) {
  return <NotebookAdaptersContext.Provider value={adapters}>{children}</NotebookAdaptersContext.Provider>
}

export function useNotebookAdapters(): NotebookAdapters {
  const adapters = useContext(NotebookAdaptersContext)
  if (!adapters) throw new Error('useNotebookAdapters must be used inside a NotebookAdaptersProvider.')
  return adapters
}
