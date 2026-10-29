import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { ClientStoreProvider } from './clients/ClientStore'
import { ClientsLoaded } from './clients/components'
import { AppLayout } from './components/AppLayout'
import { ClientFormScreen } from './screens/ClientFormScreen'
import { ClientProfileScreen } from './screens/ClientProfileScreen'
import { ClientsScreen } from './screens/ClientsScreen'
import { HomeScreen } from './screens/HomeScreen'
import { SettingsScreen } from './screens/SettingsScreen'

// Hash routing keeps every screen on the single app://renderer/index.html document.
// Client screens read and save through the main process (window.tracingGuatemala).
export function App() {
  return (
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
            <Route path="settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </ClientStoreProvider>
    </HashRouter>
  )
}
