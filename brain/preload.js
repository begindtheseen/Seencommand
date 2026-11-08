// preload — the only bridge between the sandboxed renderer and the main process. Exposes a tiny,
// read-only API: request the current graph, subscribe to live updates, and read source info.
// No Node, no fs in the renderer (contextIsolation stays on).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chronos', {
  // Pull the current unified graph (used once on mount).
  requestGraph: () => ipcRenderer.invoke('graph:request'),
  // Where the data is coming from (paths, whether each store was found).
  sourcesInfo: () => ipcRenderer.invoke('sources:info'),
  // Subscribe to live pushes whenever a watched file changes. Returns an unsubscribe fn.
  onGraph: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('graph:update', handler);
    return () => ipcRenderer.removeListener('graph:update', handler);
  },
  // Brain activity: every write newest-first, plus every request made of the brain.
  requestActivity: () => ipcRenderer.invoke('activity:request'),
  // Health: the Keeper's audit — current/total facts, contradictions, possibly-stale facts.
  requestHealth: () => ipcRenderer.invoke('health:request'),
  // Overnight: the 4am agents' digests, newest first, read from the vault's timeline day-notes.
  requestOvernight: () => ipcRenderer.invoke('overnight:request'),
  listAccessClients: () => ipcRenderer.invoke('access:list'),
  issueAccessClient: (input) => ipcRenderer.invoke('access:issue', input),
  revokeAccessClient: (id) => ipcRenderer.invoke('access:revoke', id),
  renewAccessClient: (id, expiresAt) => ipcRenderer.invoke('access:renew', id, expiresAt),
  rotateAccessClient: (id) => ipcRenderer.invoke('access:rotate', id),
  copyCredentialOnce: (secret) => ipcRenderer.invoke('access:copy-once', secret),
  // The Brain menu asks the renderer to open the panel on a section ('recent' | 'all' | 'requests').
  onOpenActivity: (cb) => {
    const handler = (_e, section) => cb(section);
    ipcRenderer.on('activity:open', handler);
    return () => ipcRenderer.removeListener('activity:open', handler);
  },
});
