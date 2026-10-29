import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type TracingGuatemalaApi } from '../shared/ipc'

// Expose named, fixed-argument functions only; never ipcRenderer itself or a
// generic invoke(channel, ...args), which would hand the renderer every channel.
const api: TracingGuatemalaApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.getAppInfo),
  listClients: (query) => ipcRenderer.invoke(IpcChannel.listClients, query),
  getClient: (id) => ipcRenderer.invoke(IpcChannel.getClient, id),
  createClient: (input) => ipcRenderer.invoke(IpcChannel.createClient, input),
  updateClient: (id, input) => ipcRenderer.invoke(IpcChannel.updateClient, id, input),
  archiveClient: (id) => ipcRenderer.invoke(IpcChannel.archiveClient, id),
  restoreClient: (id) => ipcRenderer.invoke(IpcChannel.restoreClient, id),
  listNotes: (clientId) => ipcRenderer.invoke(IpcChannel.listNotes, clientId),
  createNote: (clientId, input) => ipcRenderer.invoke(IpcChannel.createNote, clientId, input),
  updateNote: (clientId, noteId, input) => ipcRenderer.invoke(IpcChannel.updateNote, clientId, noteId, input)
}

contextBridge.exposeInMainWorld('tracingGuatemala', api)
