import type { NotebookAdapters } from '../NotebookAdapters'
import { tiptapAdapter } from './tiptap/tiptapAdapter'

// Composition root: the only place that picks concrete editor and canvas adapters.
// To switch libraries, change the lines below (docs/architecture/research-notebook.md).
// The plain-text adapter (./plain) stays as a dependency-free fallback and test double.
export const defaultNotebookAdapters: NotebookAdapters = {
  editor: tiptapAdapter,
  canvas: null
}
