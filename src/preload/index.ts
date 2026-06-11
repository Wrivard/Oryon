import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BridgeApi } from '../shared/types'

// Abonnements CIBLÉS : offX(cb) ne retire QUE le wrapper de ce cb. L'ancien off
// global (purge de tout le canal) tuait les abonnés des AUTRES composants montés sur
// le même canal (ex. vue Calendar + section Réglages Calendar sur 'calendar:changed').
// offX() SANS argument garde l'ancien comportement (purge totale) en compat/debug.
type AnyCb = (...args: never[]) => void
type Wrapped = (e: IpcRendererEvent, ...args: any[]) => void
const subs = new Map<string, Map<AnyCb, Wrapped>>()
function sub(channel: string, cb: AnyCb, wrapped: Wrapped): void {
  let m = subs.get(channel)
  if (!m) {
    m = new Map()
    subs.set(channel, m)
  }
  m.set(cb, wrapped)
  ipcRenderer.on(channel, wrapped)
}
function unsub(channel: string, cb?: AnyCb): void {
  const m = subs.get(channel)
  if (!cb) {
    ipcRenderer.removeAllListeners(channel)
    m?.clear()
    return
  }
  const wrapped = m?.get(cb)
  if (wrapped) {
    ipcRenderer.off(channel, wrapped)
    m?.delete(cb)
  }
}

const bridge: BridgeApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    copyText: (text) => ipcRenderer.invoke('app:copyText', text),
  },
  workspaces: {
    list: () => ipcRenderer.invoke('workspaces:list'),
    create: (data) => ipcRenderer.invoke('workspaces:create', data),
    delete: (id) => ipcRenderer.invoke('workspaces:delete', id),
    update: (id, data) => ipcRenderer.invoke('workspaces:update', id, data),
    open: (id) => ipcRenderer.invoke('workspaces:open', id),
    listTerminals: (workspaceId) => ipcRenderer.invoke('workspaces:listTerminals', workspaceId),
    getOrchestrator: (workspaceId) => ipcRenderer.invoke('workspaces:getOrchestrator', workspaceId),
    terminalCounts: () => ipcRenderer.invoke('workspaces:terminalCounts'),
    addTerminal: (workspaceId) => ipcRenderer.invoke('workspaces:addTerminal', workspaceId),
    removeTerminal: (id) => ipcRenderer.invoke('workspaces:removeTerminal', id),
  },
  terminals: {
    create: (opts) => ipcRenderer.invoke('terminals:create', opts),
    write: (id, data) => ipcRenderer.send('terminals:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('terminals:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('terminals:kill', id),
    onData: (id, cb) => sub(`terminal:data:${id}`, cb, (_e: IpcRendererEvent, data: string) => cb(data)),
    offData: (id, cb) => unsub(`terminal:data:${id}`, cb),
    onExit: (id, cb) => sub(`terminal:exit:${id}`, cb, (_e: IpcRendererEvent, code: number) => cb(code)),
    offExit: (id, cb) => unsub(`terminal:exit:${id}`, cb),
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  },
  editor: {
    readDir: (path) => ipcRenderer.invoke('editor:readDir', path),
    readFile: (path) => ipcRenderer.invoke('editor:readFile', path),
    writeFile: (path, content, expect) => ipcRenderer.invoke('editor:writeFile', path, content, expect),
    listFiles: (rootPath) => ipcRenderer.invoke('editor:listFiles', rootPath),
    watch: (rootPath) => ipcRenderer.send('editor:watch', rootPath),
    unwatch: (rootPath) => ipcRenderer.send('editor:unwatch', rootPath),
    onFsEvent: (cb) => sub('editor:fs-event', cb, (_e: IpcRendererEvent, ev) => cb(ev)),
    offFsEvent: (cb) => unsub('editor:fs-event', cb),
  },
  browser: {
    startDevServer: (workspaceId) => ipcRenderer.invoke('browser:startDevServer', workspaceId),
    stopDevServer: (workspaceId) => ipcRenderer.invoke('browser:stopDevServer', workspaceId),
    onDevLog: (cb) => sub('browser:dev-log', cb, (_e: IpcRendererEvent, line: string) => cb(line)),
    offDevLog: (cb) => unsub('browser:dev-log', cb),
    onNavigate: (cb) =>
      sub('browser:navigate', cb, (_e: IpcRendererEvent, data: { workspaceId: string; url: string }) => cb(data)),
    offNavigate: (cb) => unsub('browser:navigate', cb),
    reportConsole: (data) => ipcRenderer.send('browser:console', data),
    onCapture: (cb) =>
      sub('browser:capture', cb, (_e: IpcRendererEvent, data: { workspaceId: string; reqId: string }) => cb(data)),
    offCapture: (cb) => unsub('browser:capture', cb),
    sendCaptureResult: (reqId, png, error) => ipcRenderer.send('browser:capture-result', { reqId, png, error }),
    getPrefs: (workspaceId) => ipcRenderer.invoke('browser:getPrefs', workspaceId),
    addRecent: (workspaceId, url, title) => ipcRenderer.invoke('browser:addRecent', workspaceId, url, title),
    toggleFavorite: (workspaceId, url, label) => ipcRenderer.invoke('browser:toggleFavorite', workspaceId, url, label),
    setLastUrl: (workspaceId, url) => ipcRenderer.invoke('browser:setLastUrl', workspaceId, url),
    setVercelToken: (token) => ipcRenderer.invoke('browser:setVercelToken', token),
    vercelStatus: () => ipcRenderer.invoke('browser:vercelStatus'),
    vercelProjects: () => ipcRenderer.invoke('browser:vercelProjects'),
    openExternal: (url) => ipcRenderer.invoke('browser:openExternal', url),
    clearConsole: (workspaceId) => ipcRenderer.invoke('browser:clearConsole', workspaceId),
  },
  orchestrator: {
    listTasks: (workspaceId) => ipcRenderer.invoke('orchestrator:listTasks', workspaceId),
    listMailbox: (workspaceId) => ipcRenderer.invoke('orchestrator:listMailbox', workspaceId),
    updateTaskStatus: (taskId, status) =>
      ipcRenderer.invoke('orchestrator:updateTaskStatus', taskId, status),
    stop: (workspaceId) => ipcRenderer.invoke('orchestrator:stop', workspaceId),
    onEvent: (cb) => sub('orchestrator:event', cb, (_e: IpcRendererEvent, ev) => cb(ev)),
    offEvent: (cb) => unsub('orchestrator:event', cb),
  },
  settings: {
    getApp: () => ipcRenderer.invoke('settings:getApp'),
    setApp: (key, value) => ipcRenderer.invoke('settings:setApp', key, value),
    onAppChanged: (cb) => sub('settings:appChanged', cb, (_e: IpcRendererEvent, p) => cb(p)),
    offAppChanged: (cb) => unsub('settings:appChanged', cb),
    listConnectors: (projectId) => ipcRenderer.invoke('settings:listConnectors', projectId),
    addConnector: (input) => ipcRenderer.invoke('settings:addConnector', input),
    toggleConnector: (id, enabled) => ipcRenderer.invoke('settings:toggleConnector', id, enabled),
    deleteConnector: (id) => ipcRenderer.invoke('settings:deleteConnector', id),
    updateConnector: (input) => ipcRenderer.invoke('settings:updateConnector', input),
    connectorSecrets: (id) => ipcRenderer.invoke('settings:connectorSecrets', id),
    testConnector: (input) => ipcRenderer.invoke('settings:testConnector', input),
    probeConnector: (id) => ipcRenderer.invoke('settings:probeConnector', id),
    listMcpCatalog: () => ipcRenderer.invoke('settings:listMcpCatalog'),
    importMcpCandidates: () => ipcRenderer.invoke('settings:importMcpCandidates'),
    importConnectors: (candidates, scope, projectPath) =>
      ipcRenderer.invoke('settings:importConnectors', candidates, scope, projectPath),
  },
  skills: {
    list: (projectPath) => ipcRenderer.invoke('skills:list', projectPath),
    read: (ref) => ipcRenderer.invoke('skills:read', ref),
    create: (input) => ipcRenderer.invoke('skills:create', input),
    importFolder: (input) => ipcRenderer.invoke('skills:importFolder', input),
    importGit: (input) => ipcRenderer.invoke('skills:importGit', input),
    update: (input) => ipcRenderer.invoke('skills:update', input),
    delete: (ref) => ipcRenderer.invoke('skills:delete', ref),
  },
  voice: {
    listReplacements: () => ipcRenderer.invoke('voice:listReplacements'),
    addReplacement: (spoken, replacement) => ipcRenderer.invoke('voice:addReplacement', spoken, replacement),
    deleteReplacement: (id) => ipcRenderer.invoke('voice:deleteReplacement', id),
    addHistory: (item) => ipcRenderer.invoke('voice:addHistory', item),
    listHistory: (limit) => ipcRenderer.invoke('voice:listHistory', limit),
    listVocab: () => ipcRenderer.invoke('voice:listVocab'),
    addVocab: (term, starred, source) => ipcRenderer.invoke('voice:addVocab', term, starred, source),
    toggleVocabStar: (id, starred) => ipcRenderer.invoke('voice:toggleVocabStar', id, starred),
    deleteVocab: (id) => ipcRenderer.invoke('voice:deleteVocab', id),
    listSnippets: () => ipcRenderer.invoke('voice:listSnippets'),
    addSnippet: (trigger, expansion) => ipcRenderer.invoke('voice:addSnippet', trigger, expansion),
    deleteSnippet: (id) => ipcRenderer.invoke('voice:deleteSnippet', id),
    learnFromEdit: (injected, edited, context) =>
      ipcRenderer.invoke('voice:learnFromEdit', injected, edited, context),
    stats: () => ipcRenderer.invoke('voice:stats'),
    format: (text, level) => ipcRenderer.invoke('voice:format', text, level),
    command: (command, selection) => ipcRenderer.invoke('voice:command', command, selection),
    injectText: (text) => ipcRenderer.invoke('voice:injectText', text),
    transcribeRemote: (pcm, opts) => ipcRenderer.invoke('voice:transcribeRemote', pcm, opts),
    cleanup: (text) => ipcRenderer.invoke('voice:cleanup', text),
    onCommandKey: (cb) => sub('voice:command-key', cb, () => cb()),
    offCommandKey: (cb) => unsub('voice:command-key', cb),
    onToggle: (cb) => sub('voice:toggle', cb, () => cb()),
    offToggle: (cb) => unsub('voice:toggle', cb),
    onHold: (cb) => sub('voice:hold', cb, (_e: IpcRendererEvent, down: boolean) => cb(down)),
    offHold: (cb) => unsub('voice:hold', cb),
    requestToggle: () => ipcRenderer.send('voice:requestToggle'),
    reportState: (state) => ipcRenderer.send('voice:stateChanged', state),
    onState: (cb) => sub('voice:state', cb, (_e: IpcRendererEvent, s) => cb(s)),
    offState: (cb) => unsub('voice:state', cb),
    setWidget: (visible) => ipcRenderer.invoke('voice:setWidget', visible),
    reregisterHotkeys: () => ipcRenderer.invoke('voice:reregisterHotkeys'),
    getHotkeyConflicts: () => ipcRenderer.invoke('voice:getHotkeyConflicts'),
    onHotkeyConflict: (cb) => sub('voice:hotkeyConflict', cb, (_e: IpcRendererEvent, info) => cb(info)),
    offHotkeyConflict: (cb) => unsub('voice:hotkeyConflict', cb),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.send('update:install'),
    setChannel: (channel) => ipcRenderer.invoke('update:setChannel', channel),
    getState: () => ipcRenderer.invoke('update:getState'),
    onEvent: (cb) => sub('update:event', cb, (_e: IpcRendererEvent, ev) => cb(ev)),
    offEvent: (cb) => unsub('update:event', cb),
  },
  memory: {
    list: (projectPath) => ipcRenderer.invoke('memory:list', projectPath),
    read: (projectPath, name) => ipcRenderer.invoke('memory:read', projectPath, name),
    write: (projectPath, name, content) => ipcRenderer.invoke('memory:write', projectPath, name, content),
    delete: (projectPath, name) => ipcRenderer.invoke('memory:delete', projectPath, name),
    graph: (projectPath) => ipcRenderer.invoke('memory:graph', projectPath),
    search: (projectPath, query, limit) => ipcRenderer.invoke('memory:search', projectPath, query, limit),
    append: (projectPath, name, content, author, role) =>
      ipcRenderer.invoke('memory:append', projectPath, name, content, author, role),
    rename: (projectPath, oldName, newName) => ipcRenderer.invoke('memory:rename', projectPath, oldName, newName),
    watch: (projectPath) => ipcRenderer.send('memory:watch', projectPath),
    unwatch: () => ipcRenderer.send('memory:unwatch'),
    onChanged: (cb) => sub('memory:changed', cb, () => cb()),
    offChanged: (cb) => unsub('memory:changed', cb),
  },
  docs: {
    list: (tag) => ipcRenderer.invoke('docs:list', tag),
    read: (slug) => ipcRenderer.invoke('docs:read', slug),
    search: (query, opts) => ipcRenderer.invoke('docs:search', query, opts),
    import: (args) => ipcRenderer.invoke('docs:import', args),
    reimport: (slug) => ipcRenderer.invoke('docs:reimport', slug),
    delete: (slug) => ipcRenderer.invoke('docs:delete', slug),
    onChanged: (cb) => sub('docs:changed', cb, () => cb()),
    offChanged: (cb) => unsub('docs:changed', cb),
    onProgress: (cb) => sub('docs:import-progress', cb, (_e: IpcRendererEvent, p) => cb(p)),
    offProgress: (cb) => unsub('docs:import-progress', cb),
  },
  calendar: {
    status: () => ipcRenderer.invoke('calendar:status'),
    setCredentials: (clientId, clientSecret) => ipcRenderer.invoke('calendar:setCredentials', clientId, clientSecret),
    connect: () => ipcRenderer.invoke('calendar:connect'),
    disconnect: () => ipcRenderer.invoke('calendar:disconnect'),
    listCalendars: () => ipcRenderer.invoke('calendar:listCalendars'),
    events: (opts) => ipcRenderer.invoke('calendar:events', opts),
    onChanged: (cb) => sub('calendar:changed', cb, () => cb()),
    offChanged: (cb) => unsub('calendar:changed', cb),
  },
  systemFeedback: {
    list: (filter) => ipcRenderer.invoke('system-feedback:list', filter),
    updateStatus: (id, status, note) => ipcRenderer.invoke('system-feedback:update-status', id, status, note),
    onChanged: (cb) => sub('system-feedback:changed', cb, () => cb()),
    offChanged: (cb) => unsub('system-feedback:changed', cb),
  },
  source: {
    status: (projectPath) => ipcRenderer.invoke('source:status', projectPath),
    diff: (projectPath, file) => ipcRenderer.invoke('source:diff', projectPath, file),
    accept: (projectPath, file) => ipcRenderer.invoke('source:accept', projectPath, file),
    reject: (projectPath, file) => ipcRenderer.invoke('source:reject', projectPath, file),
    acceptAll: (projectPath) => ipcRenderer.invoke('source:acceptAll', projectPath),
    rejectAll: (projectPath) => ipcRenderer.invoke('source:rejectAll', projectPath),
    log: (projectPath, file) => ipcRenderer.invoke('source:log', projectPath, file),
    fileAtRef: (projectPath, file, ref) => ipcRenderer.invoke('source:fileAtRef', projectPath, file, ref),
    revertFile: (projectPath, file, ref) => ipcRenderer.invoke('source:revertFile', projectPath, file, ref),
    branches: (projectPath) => ipcRenderer.invoke('source:branches', projectPath),
    branchDiff: (projectPath, branch) => ipcRenderer.invoke('source:branchDiff', projectPath, branch),
    mergeAgent: (projectPath, branch) => ipcRenderer.invoke('source:mergeAgent', projectPath, branch),
  },
}

contextBridge.exposeInMainWorld('bridge', bridge)
