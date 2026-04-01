const elements = {
  appRoot: document.querySelector('#app-root'),
  buildState: document.querySelector('#build-state'),
  streamState: document.querySelector('#stream-state'),
  sessionCount: document.querySelector('#session-count'),
  sessionList: document.querySelector('#session-list'),
  sessionItemTemplate: document.querySelector('#session-item-template'),
  sessionTitle: document.querySelector('#session-title'),
  sessionSubtitle: document.querySelector('#session-subtitle'),
  emptyState: document.querySelector('#empty-state'),
  messageList: document.querySelector('#message-list'),
  composer: document.querySelector('#composer'),
  promptInput: document.querySelector('#prompt-input'),
  composerHint: document.querySelector('#composer-hint'),
  sendPrompt: document.querySelector('#send-prompt'),
  interruptSession: document.querySelector('#interrupt-session'),
  deleteSession: document.querySelector('#delete-session'),
  sessionForm: document.querySelector('#session-form'),
  createSessionButton: document.querySelector('#create-session-button'),
  submitSession: document.querySelector('#submit-session'),
  gatewayForm: document.querySelector('#gateway-form'),
  gatewayBaseUrl: document.querySelector('#gateway-base-url'),
  gatewayBetaToken: document.querySelector('#gateway-beta-token'),
  gatewayAccessCode: document.querySelector('#gateway-access-code'),
  gatewayStatus: document.querySelector('#gateway-status'),
  gatewayCopy: document.querySelector('#gateway-copy'),
  gatewayConnect: document.querySelector('#gateway-connect'),
  gatewayRefresh: document.querySelector('#gateway-refresh'),
  gatewayDisconnect: document.querySelector('#gateway-disconnect'),
  apiKey: document.querySelector('#api-key'),
  modelPreset: document.querySelector('#model-preset'),
  model: document.querySelector('#model'),
  baseUrl: document.querySelector('#base-url'),
  modelCatalogCopy: document.querySelector('#model-catalog-copy'),
  serverKeyHint: document.querySelector('#server-key-hint'),
  systemPrompt: document.querySelector('#system-prompt'),
  bareMode: document.querySelector('#bare-mode'),
  openTerminal: document.querySelector('#open-terminal'),
  chooseWorkspace: document.querySelector('#choose-workspace'),
  workspaceName: document.querySelector('#workspace-name'),
  workspacePath: document.querySelector('#workspace-path'),
  workspaceBadge: document.querySelector('#workspace-badge'),
  recentWorkspaces: document.querySelector('#recent-workspaces'),
  permissionCount: document.querySelector('#permission-count'),
  permissionList: document.querySelector('#permission-list'),
  taskPill: document.querySelector('#task-pill'),
  taskButtons: Array.from(document.querySelectorAll('[data-task]')),
  taskLog: document.querySelector('#task-log'),
  sessionLog: document.querySelector('#session-log'),
  historyList: document.querySelector('#history-list'),
  historyItemTemplate: document.querySelector('#history-item-template'),
  openWorkspace: document.querySelector('#open-workspace'),
  refreshState: document.querySelector('#refresh-state'),
}

const state = {
  ui: null,
  activeSessionId: null,
  sessions: new Map(),
  eventSource: null,
  defaultsApplied: false,
}

function setActiveSession(sessionId) {
  state.activeSessionId = sessionId
  render()
  if (sessionId && !state.sessions.has(sessionId)) {
    loadSession(sessionId).catch(error => {
      window.alert(error.message)
    })
  }
}

function getActiveSession() {
  if (!state.activeSessionId) {
    return null
  }
  return state.sessions.get(state.activeSessionId) || null
}

function applyDefaults() {
  if (state.defaultsApplied || !state.ui?.defaults) {
    return
  }
  const defaultPreset =
    findMatchingPresetId(state.ui.defaults.model, state.ui.defaults.baseUrl) ||
    state.ui.modelCatalog?.items?.[0]?.id ||
    ''
  if (defaultPreset) {
    elements.modelPreset.value = defaultPreset
    applyPresetSelection(defaultPreset, { force: true })
  }
  elements.model.value = state.ui.defaults.model || 'gpt-4o'
  elements.baseUrl.value = state.ui.defaults.baseUrl || 'https://api.openai.com/v1'
  elements.bareMode.checked = Boolean(state.ui.defaults.bareMode)
  state.defaultsApplied = true
}

function getWorkspace() {
  return (
    state.ui?.workspace || {
      currentPath: null,
      recentPaths: [],
    }
  )
}

function getPathLabel(path) {
  if (!path) {
    return 'No workspace selected'
  }

  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) || path
}

function syncInputValue(input, value) {
  if (!input) {
    return
  }
  if (document.activeElement === input) {
    return
  }
  input.value = value || ''
}

function getGateway() {
  return (
    state.ui?.gateway || {
      baseUrl: '',
      hasToken: false,
      status: 'disconnected',
      lastError: null,
      lastSyncAt: null,
      source: 'local-fallback',
    }
  )
}

function getModelCatalog() {
  return state.ui?.modelCatalog?.items || []
}

function findPresetById(presetId) {
  return getModelCatalog().find(item => item.id === presetId) || null
}

function findMatchingPresetId(model, baseUrl) {
  const match = getModelCatalog().find(
    item => item.model === model && item.baseUrl === baseUrl,
  )
  return match?.id || ''
}

function applyPresetSelection(presetId, { force = false } = {}) {
  const preset = findPresetById(presetId)
  if (!preset) {
    return
  }

  if (force || !elements.model.value.trim()) {
    elements.model.value = preset.model
  }
  if (force || !elements.baseUrl.value.trim()) {
    elements.baseUrl.value = preset.baseUrl
  }
}

function renderModelCatalog() {
  const catalog = state.ui?.modelCatalog
  const items = catalog?.items || []
  const preferredValue =
    elements.modelPreset.value ||
    findMatchingPresetId(elements.model.value.trim(), elements.baseUrl.value.trim()) ||
    findMatchingPresetId(state.ui?.defaults?.model, state.ui?.defaults?.baseUrl) ||
    items[0]?.id ||
    ''

  elements.modelPreset.innerHTML = ''
  for (const item of items) {
    const option = document.createElement('option')
    option.value = item.id
    option.textContent = item.label || item.model
    elements.modelPreset.append(option)
  }

  if (preferredValue) {
    elements.modelPreset.value = preferredValue
    applyPresetSelection(preferredValue)
  }

  elements.modelCatalogCopy.textContent = catalog
    ? catalog.source === 'local-fallback'
      ? 'Using a temporary local catalog until the centralized model gateway is connected.'
      : 'Model catalog loaded from the gateway.'
    : 'Loading model catalog...'

  const gateway = getGateway()
  elements.serverKeyHint.textContent = gateway.hasToken
    ? 'Gateway beta token is saved. New preset-based sessions will route through the gateway.'
    : state.ui?.defaults?.hasServerKey
      ? 'Runtime server key detected. Presets can still run directly while the gateway is disconnected.'
      : 'No gateway token or runtime server key detected. Use a local provider or add a developer override key.'
}

function renderGateway() {
  const gateway = getGateway()
  syncInputValue(elements.gatewayBaseUrl, gateway.baseUrl)
  if (!gateway.hasToken && document.activeElement !== elements.gatewayBetaToken) {
    elements.gatewayBetaToken.value = ''
  }

  const statusText =
    gateway.status === 'connected'
      ? 'Gateway live'
      : gateway.status === 'syncing'
        ? 'Syncing'
        : gateway.status === 'error'
          ? 'Gateway error'
          : 'Local fallback'

  elements.gatewayStatus.textContent = statusText
  elements.gatewayStatus.classList.toggle(
    'muted-badge',
    gateway.status !== 'connected',
  )
  elements.gatewayConnect.disabled = gateway.status === 'syncing'
  elements.gatewayRefresh.disabled =
    gateway.status === 'syncing' || !gateway.baseUrl
  elements.gatewayDisconnect.disabled =
    gateway.status === 'syncing' ||
    (!gateway.baseUrl && !gateway.hasToken && gateway.source === 'local-fallback')

  if (gateway.status === 'connected') {
    const syncedAt = gateway.lastSyncAt
      ? new Date(gateway.lastSyncAt).toLocaleString()
      : 'just now'
    elements.gatewayCopy.textContent = `Connected to ${gateway.baseUrl}. Catalog synced ${syncedAt}.`
  } else if (gateway.status === 'syncing') {
    elements.gatewayCopy.textContent =
      'Refreshing model presets from your gateway...'
  } else if (gateway.status === 'error') {
    elements.gatewayCopy.textContent =
      gateway.lastError ||
      'The gateway could not be reached. Falling back to local presets.'
  } else {
    elements.gatewayCopy.textContent =
      'Point this app at your centralized model gateway.'
  }
}

function renderWorkspace() {
  const workspace = getWorkspace()
  const hasWorkspace = Boolean(workspace.currentPath)

  elements.workspaceName.textContent = getPathLabel(workspace.currentPath)
  elements.workspacePath.textContent = hasWorkspace
    ? workspace.currentPath
    : 'Choose a project folder before starting a session.'
  elements.workspaceBadge.textContent = hasWorkspace ? 'Ready' : 'Pick a folder'
  elements.workspaceBadge.classList.toggle('muted-badge', !hasWorkspace)

  elements.createSessionButton.disabled = !hasWorkspace
  elements.submitSession.disabled = !hasWorkspace
  elements.openTerminal.disabled = !hasWorkspace
  elements.openWorkspace.disabled = !hasWorkspace

  elements.recentWorkspaces.innerHTML = ''
  if (!workspace.recentPaths?.length) {
    const empty = document.createElement('p')
    empty.className = 'muted'
    empty.textContent = 'Recent folders will show up here.'
    elements.recentWorkspaces.append(empty)
    return
  }

  for (const path of workspace.recentPaths) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'workspace-chip'
    button.textContent = getPathLabel(path)
    button.title = path
    if (path === workspace.currentPath) {
      button.classList.add('active')
    }
    button.addEventListener('click', async () => {
      try {
        await postJson('/api/workspace', { path })
      } catch (error) {
        window.alert(error.message)
      }
    })
    elements.recentWorkspaces.append(button)
  }
}

function renderHistory(history) {
  elements.historyList.innerHTML = ''
  for (const item of history) {
    const node = elements.historyItemTemplate.content.cloneNode(true)
    node.querySelector('.history-label').textContent = item.label
    node.querySelector('.history-copy').textContent =
      `${item.status.toUpperCase()} · code ${item.code} · ${new Date(item.finishedAt).toLocaleString()}`
    elements.historyList.append(node)
  }
}

function renderSessionList() {
  const sessions = state.ui?.sessions || []
  elements.sessionCount.textContent = String(sessions.length)
  elements.sessionList.innerHTML = ''

  for (const session of sessions) {
    const node = elements.sessionItemTemplate.content.cloneNode(true)
    const button = node.querySelector('.session-item')
    const title = node.querySelector('.session-item-title')
    const copy = node.querySelector('.session-item-copy')
    title.textContent = session.title || session.model
    const workspaceLabel = getPathLabel(session.workspacePath)
    copy.textContent = `${session.status.toUpperCase()} · ${session.model} · ${workspaceLabel}`
    button.dataset.sessionId = session.id
    if (session.id === state.activeSessionId) {
      button.classList.add('active')
    }
    button.addEventListener('click', () => {
      setActiveSession(session.id)
    })
    elements.sessionList.append(button)
  }
}

function renderPermissions(session) {
  const pending = session?.pendingPermissions || []
  elements.permissionCount.textContent = String(pending.length)
  elements.permissionList.innerHTML = ''

  if (pending.length === 0) {
    elements.permissionList.innerHTML =
      '<p class="muted">No pending tool permissions.</p>'
    return
  }

  for (const permission of pending) {
    const wrapper = document.createElement('article')
    wrapper.className = 'permission-card'

    const title = document.createElement('strong')
    title.textContent = permission.title || permission.toolName

    const description = document.createElement('p')
    description.className = 'muted'
    description.textContent =
      permission.description || `Allow ${permission.toolName} to continue?`

    const code = document.createElement('pre')
    code.textContent = JSON.stringify(permission.input || {}, null, 2)

    const actions = document.createElement('div')
    actions.className = 'row-actions'

    const allow = document.createElement('button')
    allow.className = 'primary compact'
    allow.type = 'button'
    allow.textContent = 'Allow'
    allow.addEventListener('click', async () => {
      try {
        await postJson(
          `/api/sessions/${session.id}/permissions/${permission.requestId}`,
          { decision: 'allow' },
        )
      } catch (error) {
        window.alert(error.message)
      }
    })

    const deny = document.createElement('button')
    deny.className = 'ghost compact'
    deny.type = 'button'
    deny.textContent = 'Deny'
    deny.addEventListener('click', async () => {
      try {
        await postJson(
          `/api/sessions/${session.id}/permissions/${permission.requestId}`,
          { decision: 'deny' },
        )
      } catch (error) {
        window.alert(error.message)
      }
    })

    actions.append(allow, deny)
    wrapper.append(title, description, code, actions)
    elements.permissionList.append(wrapper)
  }
}

function buildMessageNode(message) {
  const wrapper = document.createElement('article')
  wrapper.className = `message ${message.role} ${message.state || 'final'}`

  const meta = document.createElement('div')
  meta.className = 'message-meta'
  meta.textContent = `${message.kind || message.role} · ${new Date(message.createdAt).toLocaleTimeString()}`

  const body = document.createElement('div')
  body.className = 'message-body'
  body.textContent = message.text || ''

  wrapper.append(meta, body)
  return wrapper
}

function renderMessages(session) {
  const shouldStick =
    elements.messageList.scrollHeight -
      elements.messageList.scrollTop -
      elements.messageList.clientHeight <
    140

  elements.messageList.innerHTML = ''

  if (!session || session.transcript.length === 0) {
    elements.emptyState.hidden = false
    elements.messageList.hidden = true
    return
  }

  elements.emptyState.hidden = true
  elements.messageList.hidden = false

  for (const message of session.transcript) {
    elements.messageList.append(buildMessageNode(message))
  }

  if (shouldStick) {
    elements.messageList.scrollTop = elements.messageList.scrollHeight
  }
}

function renderActiveSession() {
  const session = getActiveSession()
  const workspace = getWorkspace()
  const canInteract =
    session &&
    session.status !== 'starting' &&
    session.status !== 'exited' &&
    session.status !== 'error'

  if (!session) {
    elements.sessionTitle.textContent = 'No session selected'
    elements.sessionSubtitle.textContent =
      workspace.currentPath
        ? `Current workspace: ${workspace.currentPath}`
        : 'Choose a workspace, then create a backend session.'
    elements.sessionLog.textContent =
      'Select a session to inspect backend logs.'
  } else {
    elements.sessionTitle.textContent = session.title || session.model
    elements.sessionSubtitle.textContent =
      `${session.model} · ${getPathLabel(session.workspacePath)} · ${session.status.toUpperCase()}` +
      (session.liveStatus ? ` · ${session.liveStatus}` : '')
    elements.sessionLog.textContent =
      session.logs || 'No backend stderr output yet.'
  }

  elements.promptInput.disabled = !canInteract || session?.status === 'needs-permission'
  elements.sendPrompt.disabled =
    !canInteract ||
    session?.status === 'running' ||
    session?.status === 'needs-permission'
  elements.interruptSession.disabled = !session || session.status !== 'running'
  elements.deleteSession.disabled = !session

  elements.composerHint.textContent = session
    ? session.status === 'needs-permission'
      ? 'A tool action is waiting for permission.'
      : session.status === 'running'
        ? 'Backend is streaming a response.'
        : 'Prompt goes straight to the live backend session.'
    : 'Select or create a session to start.'

  renderPermissions(session)
  renderMessages(session)
}

function renderStatus() {
  if (!state.ui) {
    return
  }

  elements.appRoot.textContent = `App runtime · ${state.ui.appRoot}`
  elements.buildState.textContent = state.ui.distExists
    ? 'Build ready'
    : 'Build missing'
  elements.taskLog.textContent = state.ui.log || 'Waiting for the first action...'
  renderHistory(state.ui.history || [])

  if (state.ui.currentTask?.status === 'running') {
    elements.taskPill.textContent = `Running · ${state.ui.currentTask.label}`
  } else if (state.ui.currentTask?.status) {
    elements.taskPill.textContent =
      `${state.ui.currentTask.status.toUpperCase()} · ${state.ui.currentTask.label}`
  } else {
    elements.taskPill.textContent = 'Idle'
  }

  for (const button of elements.taskButtons) {
    button.disabled = state.ui.currentTask?.status === 'running'
  }
}

function render() {
  renderGateway()
  renderModelCatalog()
  applyDefaults()
  renderWorkspace()
  renderStatus()
  renderSessionList()
  renderActiveSession()
}

async function postJson(url, payload = {}, method = 'POST') {
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: method === 'DELETE' ? undefined : JSON.stringify(payload),
  })
  const data = await response.json()
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || 'Request failed.')
  }
  if (data.state) {
    state.ui = data.state
  }
  if (data.session) {
    state.sessions.set(data.session.id, data.session)
  }
  render()
  return data
}

async function loadState() {
  const response = await fetch('/api/state')
  const data = await response.json()
  state.ui = data

  if (!state.activeSessionId && data.sessions?.length) {
    state.activeSessionId = data.sessions[0].id
  }

  render()
}

async function loadSession(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}`)
  const data = await response.json()
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || 'Failed to load session.')
  }
  state.sessions.set(data.session.id, data.session)
  render()
}

function connectEventStream() {
  if (state.eventSource) {
    state.eventSource.close()
  }

  const source = new EventSource('/api/events')
  state.eventSource = source

  source.onopen = () => {
    elements.streamState.textContent = 'Live stream'
    elements.streamState.classList.remove('muted-badge')
  }

  source.onmessage = event => {
    const payload = JSON.parse(event.data)
    if (payload.type === 'state') {
      state.ui = payload.state
      if (!state.activeSessionId && payload.state.sessions?.length) {
        state.activeSessionId = payload.state.sessions[0].id
      }
      render()
      return
    }

    if (payload.type === 'session') {
      state.sessions.set(payload.session.id, payload.session)
      render()
    }
  }

  source.onerror = () => {
    elements.streamState.textContent = 'Reconnecting'
    elements.streamState.classList.add('muted-badge')
  }
}

function sessionPayloadFromForm() {
  const preset = findPresetById(elements.modelPreset.value)
  const modelValue = elements.model.value.trim()
  const baseUrlValue = elements.baseUrl.value.trim()
  return {
    presetId: elements.modelPreset.value,
    apiKey: elements.apiKey.value.trim(),
    model: preset && modelValue === preset.model ? '' : modelValue,
    baseUrl: preset && baseUrlValue === preset.baseUrl ? '' : baseUrlValue,
    systemPrompt: elements.systemPrompt.value.trim(),
    bareMode: elements.bareMode.checked,
  }
}

function gatewayPayloadFromForm() {
  return {
    baseUrl: elements.gatewayBaseUrl.value.trim(),
    betaToken: elements.gatewayBetaToken.value.trim(),
    accessCode: elements.gatewayAccessCode.value.trim(),
  }
}

async function chooseWorkspace() {
  let path = null

  if (window.openClaudeDesktop?.selectWorkspace) {
    const result = await window.openClaudeDesktop.selectWorkspace()
    if (result?.canceled) {
      return
    }
    path = result?.path || null
  } else {
    path = window.prompt(
      'Enter the full path to the workspace folder:',
      getWorkspace().currentPath || '',
    )
  }

  if (!path || !path.trim()) {
    return
  }

  await postJson('/api/workspace', { path: path.trim() })
}

elements.sessionForm.addEventListener('submit', async event => {
  event.preventDefault()
  try {
    const data = await postJson('/api/sessions', sessionPayloadFromForm())
    setActiveSession(data.session.id)
    elements.apiKey.value = ''
    elements.promptInput.focus()
  } catch (error) {
    window.alert(error.message)
  }
})

elements.createSessionButton.addEventListener('click', () => {
  elements.sessionForm.requestSubmit()
})

elements.chooseWorkspace.addEventListener('click', async () => {
  try {
    await chooseWorkspace()
  } catch (error) {
    window.alert(error.message)
  }
})

elements.modelPreset.addEventListener('change', () => {
  applyPresetSelection(elements.modelPreset.value, { force: true })
})

elements.gatewayForm.addEventListener('submit', async event => {
  event.preventDefault()
  try {
    await postJson('/api/gateway/connect', gatewayPayloadFromForm())
    elements.gatewayAccessCode.value = ''
    elements.gatewayBetaToken.value = ''
  } catch (error) {
    window.alert(error.message)
  }
})

elements.gatewayRefresh.addEventListener('click', async () => {
  try {
    await postJson('/api/gateway/refresh')
  } catch (error) {
    window.alert(error.message)
  }
})

elements.gatewayDisconnect.addEventListener('click', async () => {
  try {
    await postJson('/api/gateway/disconnect')
    elements.gatewayAccessCode.value = ''
    elements.gatewayBetaToken.value = ''
  } catch (error) {
    window.alert(error.message)
  }
})

elements.openTerminal.addEventListener('click', async () => {
  try {
    const result = await postJson('/api/open-terminal', {
      ...sessionPayloadFromForm(),
      buildBeforeLaunch: false,
    })
    window.alert(result.launchResult.message)
  } catch (error) {
    window.alert(error.message)
  }
})

elements.composer.addEventListener('submit', async event => {
  event.preventDefault()
  const session = getActiveSession()
  if (!session) {
    window.alert('Create or select a session first.')
    return
  }

  const content = elements.promptInput.value.trim()
  if (!content) {
    return
  }

  try {
    await postJson(`/api/sessions/${session.id}/messages`, { content })
    elements.promptInput.value = ''
    elements.promptInput.focus()
  } catch (error) {
    window.alert(error.message)
  }
})

elements.interruptSession.addEventListener('click', async () => {
  const session = getActiveSession()
  if (!session) {
    return
  }
  try {
    await postJson(`/api/sessions/${session.id}/interrupt`)
  } catch (error) {
    window.alert(error.message)
  }
})

elements.deleteSession.addEventListener('click', async () => {
  const session = getActiveSession()
  if (!session) {
    return
  }
  try {
    await postJson(`/api/sessions/${session.id}`, {}, 'DELETE')
    state.sessions.delete(session.id)
    state.activeSessionId = state.ui?.sessions?.[0]?.id || null
    if (state.activeSessionId) {
      await loadSession(state.activeSessionId)
    } else {
      render()
    }
  } catch (error) {
    window.alert(error.message)
  }
})

for (const button of elements.taskButtons) {
  button.addEventListener('click', async () => {
    try {
      await postJson(`/api/tasks/${button.dataset.task}`)
    } catch (error) {
      window.alert(error.message)
    }
  })
}

elements.openWorkspace.addEventListener('click', async () => {
  try {
    await postJson('/api/open-workspace')
  } catch (error) {
    window.alert(error.message)
  }
})

elements.refreshState.addEventListener('click', async () => {
  try {
    await loadState()
    if (state.activeSessionId) {
      await loadSession(state.activeSessionId)
    }
  } catch (error) {
    window.alert(error.message)
  }
})

elements.promptInput.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    elements.composer.requestSubmit()
  }
})

await loadState()
if (state.activeSessionId) {
  await loadSession(state.activeSessionId)
}
connectEventStream()
