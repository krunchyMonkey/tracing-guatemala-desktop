import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { ClientStoreProvider } from './clients/ClientStore'
import { AppLayout } from './components/AppLayout'
import { ClientFormScreen } from './screens/ClientFormScreen'
import { ClientProfileScreen } from './screens/ClientProfileScreen'
import { ClientsScreen } from './screens/ClientsScreen'
import { HomeScreen } from './screens/HomeScreen'
import { SettingsScreen } from './screens/SettingsScreen'

// Hash routing keeps every screen on the single app://renderer/index.html document.
// Client screens are the #3 prototype: in-memory fictional data, nothing persisted.
export function App() {
  return (
    <HashRouter>
      <ClientStoreProvider>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<HomeScreen />} />
            <Route path="clients" element={<ClientsScreen />} />
            <Route path="clients/new" element={<ClientFormScreen />} />
            <Route path="clients/:id" element={<ClientProfileScreen />} />
            <Route path="clients/:id/edit" element={<ClientFormScreen />} />
            <Route path="settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </ClientStoreProvider>
    </HashRouter>
  )
}
