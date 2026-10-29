import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { AppLayout } from './components/AppLayout'
import { ClientsScreen } from './screens/ClientsScreen'
import { HomeScreen } from './screens/HomeScreen'
import { SettingsScreen } from './screens/SettingsScreen'

// Hash routing keeps every screen on the single app://renderer/index.html document.
export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<HomeScreen />} />
          <Route path="clients" element={<ClientsScreen />} />
          <Route path="settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
