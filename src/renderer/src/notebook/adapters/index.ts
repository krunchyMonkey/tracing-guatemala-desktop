import type { NotebookAdapters } from '../NotebookAdapters'
import { plainTextAdapter } from './plain/plainTextAdapter'

// Composition root: the only place that picks concrete editor and canvas adapters.
// To switch libraries, change the lines below (docs/architecture/research-notebook.md).
export const defaultNotebookAdapters: NotebookAdapters = {
  editor: plainTextAdapter,
  canvas: null
}
