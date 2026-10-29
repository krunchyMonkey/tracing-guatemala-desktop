import { Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * Replaces Electron's default menu, whose Help items open external websites.
 * Reload and developer tools are only offered in development.
 */
export function buildApplicationMenu(isDevelopment: boolean): Menu {
  const viewItems: MenuItemConstructorOptions[] = [
    ...(isDevelopment
      ? ([{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as const)
      : []),
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: viewItems },
    { role: 'windowMenu' }
  ]
  return Menu.buildFromTemplate(template)
}
