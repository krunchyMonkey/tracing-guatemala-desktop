import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { ClientStoreProvider } from './clients/ClientStore'
import { ClientsLoaded } from './clients/components'
import { AppLayout } from './components/AppLayout'
import { CaseFormScreen } from './screens/CaseFormScreen'
import { CaseBriefScreen } from './screens/CaseBriefScreen'
import { CaseScreen } from './screens/CaseScreen'
import { CasesScreen } from './screens/CasesScreen'
import { ClientFormScreen } from './screens/ClientFormScreen'
import { ClientProfileScreen } from './screens/ClientProfileScreen'
import { ClientsScreen } from './screens/ClientsScreen'
import { HomeScreen } from './screens/HomeScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { DraftStoreProvider } from './notebook/DraftStoreContext'
import { NotebookScreen } from './notebook/NotebookScreen'
import { NotebookAdaptersProvider, type NotebookAdapters } from './notebook/NotebookAdapters'
import { defaultNotebookAdapters } from './notebook/adapters'
import { AppRuntimeProvider, desktopRuntime, type AppRuntime } from './runtime/AppRuntime'

// Hash routing keeps every screen on the single app://renderer/index.html document.
// Client screens read and save through `runtime`: the main process on the desktop,
// or the in-memory fictional data of the browser demo (#100). Notebook editors come
// from `notebookAdapters`, so a test or entry can swap the editing library (#146).
export function App({
  runtime = desktopRuntime,
  notebookAdapters = defaultNotebookAdapters
}: {
  runtime?: AppRuntime
  notebookAdapters?: NotebookAdapters
}) {
  return (
    <AppRuntimeProvider runtime={runtime}>
      <NotebookAdaptersProvider adapters={notebookAdapters}>
        <DraftStoreProvider>
          <HashRouter>
            <ClientStoreProvider>
              <Routes>
                <Route element={<AppLayout />}>
                  <Route index element={<HomeScreen />} />
                  <Route path="clients" element={<ClientsLoaded />}>
                    <Route index element={<ClientsScreen />} />
                    <Route path="new" element={<ClientFormScreen />} />
                    <Route path=":id" element={<ClientProfileScreen />} />
                    <Route path=":id/edit" element={<ClientFormScreen />} />
                  </Route>
                  {runtime.cases && (
                    <Route path="cases" element={<ClientsLoaded />}>
                      <Route index element={<CasesScreen />} />
                      <Route path="new" element={<CaseFormScreen />} />
                      <Route path=":caseId" element={<CaseScreen />} />
                      <Route path=":caseId/edit" element={<CaseFormScreen />} />
                      <Route path=":caseId/brief" element={<CaseBriefScreen />} />
                      <Route path=":caseId/notebook" element={<NotebookScreen />} />
                      <Route path=":caseId/notebook/:pageId" element={<NotebookScreen />} />
                    </Route>
                  )}
                  <Route path="settings" element={<SettingsScreen />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </ClientStoreProvider>
          </HashRouter>
        </DraftStoreProvider>
      </NotebookAdaptersProvider>
    </AppRuntimeProvider>
  )
}
