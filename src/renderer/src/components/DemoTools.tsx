import { createContext, useContext, type ReactNode } from 'react'

// Slot for the demo's own actions (tour and feedback buttons) beside the Demo Mode
// banner (#102). Only the demo entry fills it, so none of that code is imported by,
// or bundled into, the Live web app or the desktop app.
const DemoToolsContext = createContext<ReactNode>(null)

export function DemoToolsProvider({ tools, children }: { tools: ReactNode; children: ReactNode }) {
  return <DemoToolsContext.Provider value={tools}>{children}</DemoToolsContext.Provider>
}

export function useDemoTools(): ReactNode {
  return useContext(DemoToolsContext)
}
