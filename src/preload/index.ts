import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BridgeApi } from '../shared/types'

const bridge: BridgeApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
  },
  workspaces: {
    list: () => ipcRenderer.invoke('workspaces:list'),
    create: (data) => ipcRenderer.invoke('workspaces:create', data),
    delete: (id) => ipcRenderer.invoke('workspaces:delete', id),
    update: (id, data) => ipcRenderer.invoke('workspaces:update', id, data),
    open: (id) => ipcRenderer.invoke('workspaces:open', id),
    listTerminals: (workspaceId) => ipcRenderer.invoke('workspaces:listTerminals', workspaceId),
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
  },
  orchestrator: {
    submit: (workspaceId, goal, mode) => ipcRenderer.invoke('orchestrator:submit', workspaceId, goal, mode),
    approvePlan: (workspaceId) => ipcRenderer.invoke('orchestrator:approvePlan', workspaceId),
    listTasks: (workspaceId) => ipcRenderer.invoke('orchestrator:listTasks', workspaceId),
    listMailbox: (workspaceId) => ipcRenderer.invoke('orchestrator:listMailbox', workspaceId),
    updateTaskStatus: (taskId, status) =>
      ipcRenderer.invoke('orchestrator:updateTaskStatus', taskId, status),
    runTask: (taskId) => ipcRenderer.invoke('orchestrator:runTask', taskId),
    stop: (workspaceId) => ipcRenderer.invoke('orchestrator:stop', workspaceId),
    onEvent: (cb) => {
      ipcRenderer.on('orchestrator:event', (_e: IpcRendererEvent, ev) => cb(ev))
    },
    offEvent: () => ipcRenderer.removeAllListeners('orchestrator:event'),
  },
  settings: {
    getApp: () => ipcRenderer.invoke('settings:getApp'),
    setApp: (key, value) => ipcRenderer.invoke('settings:setApp', key, value),
    listConnectors: (projectId) => ipcRenderer.invoke('settings:listConnectors', projectId),
    addConnector: (input) => ipcRenderer.invoke('settings:addConnector', input),
    toggleConnector: (id, enabled) => ipcRenderer.invoke('settings:toggleConnector', id, enabled),
    deleteConnector: (id) => ipcRenderer.invoke('settings:deleteConnector', id),
    listSkills: () => ipcRenderer.invoke('settings:listSkills'),
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
    onCommandKey: (cb) => {
      ipcRenderer.on('voice:command-key', () => cb())
    },
    offCommandKey: () => ipcRenderer.removeAllListeners('voice:command-key'),
    onToggle: (cb) => {
      ipcRenderer.on('voice:toggle', () => cb())
    },
    offToggle: () => ipcRenderer.removeAllListeners('voice:toggle'),
    requestToggle: () => ipcRenderer.send('voice:requestToggle'),
    reportState: (state) => ipcRenderer.send('voice:stateChanged', state),
    onState: (cb) => {
      ipcRenderer.on('voice:state', (_e: IpcRendererEvent, s) => cb(s))
    },
    offState: () => ipcRenderer.removeAllListeners('voice:state'),
    setWidget: (visible) => ipcRenderer.invoke('voice:setWidget', visible),
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
