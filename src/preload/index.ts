import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BridgeApi } from '../shared/types'

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
    onData: (id, cb) => {
      ipcRenderer.on(`terminal:data:${id}`, (_e: IpcRendererEvent, data: string) => cb(data))
    },
    offData: (id) => ipcRenderer.removeAllListeners(`terminal:data:${id}`),
    onExit: (id, cb) => {
      ipcRenderer.on(`terminal:exit:${id}`, (_e: IpcRendererEvent, code: number) => cb(code))
    },
    offExit: (id) => ipcRenderer.removeAllListeners(`terminal:exit:${id}`),
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
    onFsEvent: (cb) => {
      ipcRenderer.on('editor:fs-event', (_e: IpcRendererEvent, ev) => cb(ev))
    },
    offFsEvent: () => ipcRenderer.removeAllListeners('editor:fs-event'),
  },
  browser: {
    startDevServer: (workspaceId) => ipcRenderer.invoke('browser:startDevServer', workspaceId),
    stopDevServer: (workspaceId) => ipcRenderer.invoke('browser:stopDevServer', workspaceId),
    onDevLog: (cb) => {
      ipcRenderer.on('browser:dev-log', (_e: IpcRendererEvent, line: string) => cb(line))
    },
    offDevLog: () => ipcRenderer.removeAllListeners('browser:dev-log'),
    onNavigate: (cb) => {
      ipcRenderer.on('browser:navigate', (_e: IpcRendererEvent, data: { workspaceId: string; url: string }) => cb(data))
    },
    offNavigate: () => ipcRenderer.removeAllListeners('browser:navigate'),
    reportConsole: (data) => ipcRenderer.send('browser:console', data),
    onCapture: (cb) => {
      ipcRenderer.on('browser:capture', (_e: IpcRendererEvent, data: { workspaceId: string; reqId: string }) => cb(data))
    },
    offCapture: () => ipcRenderer.removeAllListeners('browser:capture'),
    sendCaptureResult: (reqId, png, error) => ipcRenderer.send('browser:capture-result', { reqId, png, error }),
  },
  orchestrator: {
    listTasks: (workspaceId) => ipcRenderer.invoke('orchestrator:listTasks', workspaceId),
    listMailbox: (workspaceId) => ipcRenderer.invoke('orchestrator:listMailbox', workspaceId),
    updateTaskStatus: (taskId, status) =>
      ipcRenderer.invoke('orchestrator:updateTaskStatus', taskId, status),
    stop: (workspaceId) => ipcRenderer.invoke('orchestrator:stop', workspaceId),
    onEvent: (cb) => {
      ipcRenderer.on('orchestrator:event', (_e: IpcRendererEvent, ev) => cb(ev))
    },
    offEvent: () => ipcRenderer.removeAllListeners('orchestrator:event'),
  },
  settings: {
    getApp: () => ipcRenderer.invoke('settings:getApp'),
    setApp: (key, value) => ipcRenderer.invoke('settings:setApp', key, value),
    onAppChanged: (cb) => {
      ipcRenderer.on('settings:appChanged', (_e: IpcRendererEvent, p) => cb(p))
    },
    offAppChanged: () => ipcRenderer.removeAllListeners('settings:appChanged'),
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
    onCommandKey: (cb) => {
      ipcRenderer.on('voice:command-key', () => cb())
    },
    offCommandKey: () => ipcRenderer.removeAllListeners('voice:command-key'),
    onToggle: (cb) => {
      ipcRenderer.on('voice:toggle', () => cb())
    },
    offToggle: () => ipcRenderer.removeAllListeners('voice:toggle'),
    onHold: (cb) => {
      ipcRenderer.on('voice:hold', (_e: IpcRendererEvent, down: boolean) => cb(down))
    },
    offHold: () => ipcRenderer.removeAllListeners('voice:hold'),
    requestToggle: () => ipcRenderer.send('voice:requestToggle'),
    reportState: (state) => ipcRenderer.send('voice:stateChanged', state),
    onState: (cb) => {
      ipcRenderer.on('voice:state', (_e: IpcRendererEvent, s) => cb(s))
    },
    offState: () => ipcRenderer.removeAllListeners('voice:state'),
    setWidget: (visible) => ipcRenderer.invoke('voice:setWidget', visible),
    reregisterHotkeys: () => ipcRenderer.invoke('voice:reregisterHotkeys'),
    getHotkeyConflicts: () => ipcRenderer.invoke('voice:getHotkeyConflicts'),
    onHotkeyConflict: (cb) => {
      ipcRenderer.on('voice:hotkeyConflict', (_e: IpcRendererEvent, info) => cb(info))
    },
    offHotkeyConflict: () => ipcRenderer.removeAllListeners('voice:hotkeyConflict'),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.send('update:install'),
    setChannel: (channel) => ipcRenderer.invoke('update:setChannel', channel),
    getState: () => ipcRenderer.invoke('update:getState'),
    onEvent: (cb) => {
      ipcRenderer.on('update:event', (_e: IpcRendererEvent, ev) => cb(ev))
    },
    offEvent: () => ipcRenderer.removeAllListeners('update:event'),
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
    onChanged: (cb) => {
      ipcRenderer.on('memory:changed', () => cb())
    },
    offChanged: () => ipcRenderer.removeAllListeners('memory:changed'),
  },
  docs: {
    list: (tag) => ipcRenderer.invoke('docs:list', tag),
    read: (slug) => ipcRenderer.invoke('docs:read', slug),
    search: (query, opts) => ipcRenderer.invoke('docs:search', query, opts),
    import: (args) => ipcRenderer.invoke('docs:import', args),
    reimport: (slug) => ipcRenderer.invoke('docs:reimport', slug),
    delete: (slug) => ipcRenderer.invoke('docs:delete', slug),
    onChanged: (cb) => {
      ipcRenderer.on('docs:changed', () => cb())
    },
    offChanged: () => ipcRenderer.removeAllListeners('docs:changed'),
    onProgress: (cb) => {
      ipcRenderer.on('docs:import-progress', (_e: IpcRendererEvent, p) => cb(p))
    },
    offProgress: () => ipcRenderer.removeAllListeners('docs:import-progress'),
  },
  calendar: {
    status: () => ipcRenderer.invoke('calendar:status'),
    setCredentials: (clientId, clientSecret) => ipcRenderer.invoke('calendar:setCredentials', clientId, clientSecret),
    connect: () => ipcRenderer.invoke('calendar:connect'),
    disconnect: () => ipcRenderer.invoke('calendar:disconnect'),
    listCalendars: () => ipcRenderer.invoke('calendar:listCalendars'),
    events: (opts) => ipcRenderer.invoke('calendar:events', opts),
    onChanged: (cb) => {
      ipcRenderer.on('calendar:changed', () => cb())
    },
    offChanged: () => ipcRenderer.removeAllListeners('calendar:changed'),
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
