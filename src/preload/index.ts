import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type TracingGuatemalaApi } from '../shared/ipc'

// Expose named, fixed-argument functions only; never ipcRenderer itself or a
// generic invoke(channel, ...args), which would hand the renderer every channel.
const api: TracingGuatemalaApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.getAppInfo)
}

contextBridge.exposeInMainWorld('tracingGuatemala', api)
