import express from 'express'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { marked } from 'marked'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appRoot = process.env.OPENCLAUDE_APP_ROOT
  ? resolve(process.env.OPENCLAUDE_APP_ROOT)
  : dirname(scriptDir)
const repoRoot = appRoot
const staticDir = join(appRoot, 'launcher-ui')
const distCliPath = join(appRoot, 'dist', 'cli.mjs')
const readmePath = join(appRoot, 'README.md')
const playbookPath = join(appRoot, 'PLAYBOOK.md')
const defaultPort = Number(process.env.OPENCLAUDE_LAUNCHER_PORT || '8080')
const host = process.env.OPENCLAUDE_LAUNCHER_HOST || '127.0.0.1'
const bunBin = join(os.homedir(), '.bun', 'bin', 'bun')
const nodeBin = process.env.OPENCLAUDE_RUNTIME_BIN || process.execPath
const launchpadTmpDir = join(os.tmpdir(), 'openclaude-launcher')
const launcherDataDir = resolve(
  process.env.OPENCLAUDE_DATA_DIR || join(os.homedir(), '.openclaude-launcher'),
)
const workspaceStatePath = join(launcherDataDir, 'workspace-state.json')
const gatewayStatePath = join(launcherDataDir, 'gateway-state.json')
const shouldUseElectronAsNode = Boolean(process.versions.electron)

const MAX_TASK_LOG = 120_000
const MAX_SESSION_LOG = 48_000
const MAX_RAW_EVENTS = 600
const MAX_TRANSCRIPT_ITEMS = 240
const MAX_ACTIVITY_ITEMS = 24
const MAX_RECENT_WORKSPACES = 8

const LOCAL_MODEL_CATALOG = [
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    description: 'Balanced general-purpose model.',
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    description: 'Fast and inexpensive default for broad tasks.',
  },
  {
    id: 'o4-mini',
    label: 'o4-mini',
    model: 'o4-mini',
    baseUrl: 'https://api.openai.com/v1',
    description: 'Reasoning-oriented preset for harder problems.',
  },
  {
    id: 'deepseek-chat',
    label: 'DeepSeek Chat',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    description: 'OpenAI-compatible preset for DeepSeek chat.',
  },
]

const taskCatalog = {
  build: {
    label: 'Build',
    command: bunBin,
    args: ['run', 'build'],
  },
  doctor: {
    label: 'Runtime Doctor',
    command: bunBin,
    args: ['run', 'doctor:runtime'],
  },
  smoke: {
    label: 'Smoke Check',
    command: bunBin,
    args: ['run', 'smoke'],
  },
  providerTests: {
    label: 'Provider Tests',
    command: bunBin,
    args: [
      'test',
      'src/services/api/openaiShim.test.ts',
      'src/services/api/codexShim.test.ts',
      'src/utils/context.test.ts',
    ],
  },
  recommendationTests: {
    label: 'Profile Tests',
    command: bunBin,
    args: ['run', 'test:provider-recommendation'],
  },
  typecheck: {
    label: 'Typecheck',
    command: bunBin,
    args: ['run', 'typecheck'],
  },
}

const taskState = {
  current: null,
  log: '',
  history: [],
  lastLaunch: null,
}

const webSessions = new Map()
const eventClients = new Set()

function sanitizeSecret(value) {
  const trimmed = String(value || '').trim()
  return trimmed && trimmed !== 'SUA_CHAVE' ? trimmed : ''
}

function normalizeHttpUrl(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) {
    return ''
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return ''
    }
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

function buildUrl(baseUrl, path) {
  return new URL(path, `${baseUrl}/`).toString()
}

function defaultGatewayInferenceBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl)
    if (parsed.pathname === '/' || parsed.pathname === '') {
      parsed.pathname = '/v1'
    }
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return baseUrl
  }
}

function normalizeGatewayCatalogItem(item, gatewayBaseUrl) {
  if (!item || typeof item !== 'object') {
    return null
  }

  const model = String(item.model || item.id || '').trim()
  if (!model) {
    return null
  }

  const baseUrl = normalizeHttpUrl(
    item.baseUrl ||
      item.inferenceBaseUrl ||
      item.gatewayBaseUrl ||
      defaultGatewayInferenceBaseUrl(gatewayBaseUrl),
  )

  if (!baseUrl) {
    return null
  }

  return {
    id: String(item.id || model).trim(),
    label: String(item.label || item.displayName || model).trim(),
    model,
    baseUrl,
    description: String(item.description || item.copy || '').trim(),
    provider: String(item.provider || 'gateway').trim(),
    transport: 'gateway',
  }
}

function loadGatewayState() {
  if (!existsSync(gatewayStatePath)) {
    return {
      baseUrl: '',
      betaToken: '',
      status: 'disconnected',
      lastError: null,
      lastSyncAt: null,
      catalogItems: [],
      source: 'local-fallback',
    }
  }

  try {
    const parsed = JSON.parse(readFileSync(gatewayStatePath, 'utf8'))
    return {
      baseUrl: normalizeHttpUrl(parsed.baseUrl),
      betaToken: sanitizeSecret(parsed.betaToken),
      status: 'idle',
      lastError: null,
      lastSyncAt: null,
      catalogItems: [],
      source: 'local-fallback',
    }
  } catch {
    return {
      baseUrl: '',
      betaToken: '',
      status: 'disconnected',
      lastError: null,
      lastSyncAt: null,
      catalogItems: [],
      source: 'local-fallback',
    }
  }
}

const gatewayState = loadGatewayState()

function isDirectoryPath(value) {
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

function normalizeWorkspacePath(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) {
    return null
  }

  const resolvedPath = resolve(trimmed)
  return isDirectoryPath(resolvedPath) ? resolvedPath : null
}

function dedupeWorkspacePaths(paths) {
  const seen = new Set()
  const result = []

  for (const entry of paths) {
    const normalized = normalizeWorkspacePath(entry)
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }

  return result.slice(0, MAX_RECENT_WORKSPACES)
}

function loadWorkspaceState() {
  if (!existsSync(workspaceStatePath)) {
    return {
      currentPath: null,
      recentPaths: [],
    }
  }

  try {
    const parsed = JSON.parse(readFileSync(workspaceStatePath, 'utf8'))
    const currentPath = normalizeWorkspacePath(parsed.currentPath)
    const recentPaths = dedupeWorkspacePaths([
      currentPath,
      ...(Array.isArray(parsed.recentPaths) ? parsed.recentPaths : []),
    ])

    return {
      currentPath,
      recentPaths,
    }
  } catch {
    return {
      currentPath: null,
      recentPaths: [],
    }
  }
}

const workspaceState = loadWorkspaceState()

function nowIso() {
  return new Date().toISOString()
}

function truncateTail(value, maxLength) {
  return value.length > maxLength ? value.slice(-maxLength) : value
}

function getWorkspaceState() {
  workspaceState.currentPath = normalizeWorkspacePath(workspaceState.currentPath)
  workspaceState.recentPaths = dedupeWorkspacePaths([
    workspaceState.currentPath,
    ...workspaceState.recentPaths,
  ])
  return {
    currentPath: workspaceState.currentPath,
    recentPaths: [...workspaceState.recentPaths],
  }
}

async function persistWorkspaceState() {
  const snapshot = getWorkspaceState()
  await mkdir(launcherDataDir, { recursive: true })
  await writeFile(
    workspaceStatePath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  )
}

async function setCurrentWorkspace(path) {
  const normalized = normalizeWorkspacePath(path)
  if (!normalized) {
    throw new Error('Choose an existing workspace folder.')
  }

  workspaceState.currentPath = normalized
  workspaceState.recentPaths = dedupeWorkspacePaths([
    normalized,
    ...workspaceState.recentPaths,
  ])
  await persistWorkspaceState()
  return getWorkspaceState()
}

function requireCurrentWorkspacePath() {
  const { currentPath } = getWorkspaceState()
  if (!currentPath) {
    throw new Error('Choose a workspace folder before starting a session.')
  }
  return currentPath
}

function sanitizeApiKey(value) {
  return sanitizeSecret(value)
}

function isLocalBaseUrl(value) {
  const normalized = String(value || '').trim()
  return (
    normalized.startsWith('http://localhost') ||
    normalized.startsWith('http://127.0.0.1')
  )
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`
}

function appendLog(chunk) {
  taskState.log = truncateTail(taskState.log + chunk, MAX_TASK_LOG)
}

function getPathEnv() {
  const bunPath = join(os.homedir(), '.bun', 'bin')
  const currentPath = process.env.PATH || ''
  if (currentPath.split(':').includes(bunPath)) {
    return currentPath
  }
  return `${bunPath}:${currentPath}`
}

function getRuntimeEnv(extra = {}) {
  const env = {
    ...process.env,
    ...extra,
    PATH: getPathEnv(),
    OPENCLAUDE_APP_ROOT: appRoot,
  }

  if (shouldUseElectronAsNode) {
    env.ELECTRON_RUN_AS_NODE = '1'
  }

  return env
}

function pushHistory(entry) {
  taskState.history.unshift(entry)
  taskState.history = taskState.history.slice(0, 12)
}

function getGatewayPublicState() {
  return {
    baseUrl: gatewayState.baseUrl,
    hasToken: Boolean(gatewayState.betaToken),
    status: gatewayState.status,
    lastError: gatewayState.lastError,
    lastSyncAt: gatewayState.lastSyncAt,
    source: gatewayState.source,
  }
}

async function persistGatewayState() {
  await mkdir(launcherDataDir, { recursive: true })
  await writeFile(
    gatewayStatePath,
    `${JSON.stringify(
      {
        baseUrl: gatewayState.baseUrl,
        betaToken: gatewayState.betaToken,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

async function saveGatewayConfig({ baseUrl, betaToken }) {
  gatewayState.baseUrl = normalizeHttpUrl(baseUrl)
  gatewayState.betaToken = sanitizeSecret(betaToken)
  gatewayState.status = gatewayState.baseUrl ? 'idle' : 'disconnected'
  gatewayState.lastError = null
  await persistGatewayState()
  return getGatewayPublicState()
}

function clearGatewayCatalog() {
  gatewayState.catalogItems = []
  gatewayState.source = 'local-fallback'
  gatewayState.lastSyncAt = null
}

async function disconnectGateway() {
  gatewayState.baseUrl = ''
  gatewayState.betaToken = ''
  gatewayState.status = 'disconnected'
  gatewayState.lastError = null
  clearGatewayCatalog()
  await persistGatewayState()
  return getGatewayPublicState()
}

function getSessionDefaults() {
  const envModel = String(process.env.OPENAI_MODEL || '').trim()
  const envBaseUrl = String(process.env.OPENAI_BASE_URL || '').trim()
  return {
    model: envModel || 'gpt-4o',
    baseUrl: envBaseUrl || 'https://api.openai.com/v1',
    hasServerKey: Boolean(sanitizeApiKey(process.env.OPENAI_API_KEY)),
    bareMode: false,
  }
}

function buildCatalogPayload(rawItems, source) {
  const defaults = getSessionDefaults()
  const items = rawItems
    .map(item => ({
      provider: item.provider || 'direct',
      transport: item.transport || 'direct',
      ...item,
    }))
    .filter(item => item.model && item.baseUrl)

  if (
    source !== 'gateway' &&
    defaults.model &&
    defaults.baseUrl &&
    !items.some(
      item =>
        item.model === defaults.model &&
        item.baseUrl === defaults.baseUrl,
    )
  ) {
    items.unshift({
      id: 'server-default',
      label: 'Server Default',
      model: defaults.model,
      baseUrl: defaults.baseUrl,
      description: 'Pulled from the current runtime environment.',
      provider: 'direct',
      transport: 'direct',
    })
  }

  return {
    source,
    items,
  }
}

function getModelCatalog() {
  if (gatewayState.catalogItems.length > 0) {
    return buildCatalogPayload(gatewayState.catalogItems, gatewayState.source)
  }

  return buildCatalogPayload(LOCAL_MODEL_CATALOG, 'local-fallback')
}

function getCatalogItemById(presetId) {
  if (!presetId) {
    return null
  }
  return getModelCatalog().items.find(item => item.id === presetId) || null
}

function buildGatewayAuthHeaders(betaToken) {
  const token = sanitizeSecret(betaToken)
  return token
    ? {
        Authorization: `Bearer ${token}`,
      }
    : {}
}

async function fetchGatewayCatalog({
  baseUrl = gatewayState.baseUrl,
  betaToken = gatewayState.betaToken,
} = {}) {
  const normalizedBaseUrl = normalizeHttpUrl(baseUrl)
  if (!normalizedBaseUrl) {
    throw new Error('Gateway URL is required.')
  }

  const response = await fetch(buildUrl(normalizedBaseUrl, './models'), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...buildGatewayAuthHeaders(betaToken),
    },
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      payload?.error ||
      payload?.message ||
      `Gateway catalog request failed with ${response.status}.`
    throw new Error(message)
  }

  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.models)
        ? payload.models
        : []

  const catalogItems = rawItems
    .map(item => normalizeGatewayCatalogItem(item, normalizedBaseUrl))
    .filter(Boolean)

  if (catalogItems.length === 0) {
    throw new Error('Gateway returned no usable model presets.')
  }

  return catalogItems
}

async function exchangeGatewayAccessCode({
  baseUrl,
  accessCode,
}) {
  const normalizedBaseUrl = normalizeHttpUrl(baseUrl)
  const normalizedCode = sanitizeSecret(accessCode)
  if (!normalizedBaseUrl) {
    throw new Error('Gateway URL is required.')
  }
  if (!normalizedCode) {
    throw new Error('Beta access code is required.')
  }

  const response = await fetch(buildUrl(normalizedBaseUrl, './beta-access'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ code: normalizedCode }),
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      payload?.error ||
      payload?.message ||
      `Gateway beta access exchange failed with ${response.status}.`
    throw new Error(message)
  }

  const betaToken = sanitizeSecret(
    payload?.betaToken || payload?.token || payload?.accessToken,
  )
  if (!betaToken) {
    throw new Error('Gateway did not return a beta token.')
  }

  const inlineItems = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.models)
      ? payload.models
      : []

  return {
    betaToken,
    catalogItems: inlineItems
      .map(item => normalizeGatewayCatalogItem(item, normalizedBaseUrl))
      .filter(Boolean),
  }
}

async function refreshGatewayCatalog() {
  if (!gatewayState.baseUrl) {
    clearGatewayCatalog()
    gatewayState.status = 'disconnected'
    gatewayState.lastError = null
    return getModelCatalog()
  }

  gatewayState.status = 'syncing'
  gatewayState.lastError = null

  try {
    gatewayState.catalogItems = await fetchGatewayCatalog()
    gatewayState.source = 'gateway'
    gatewayState.status = 'connected'
    gatewayState.lastSyncAt = nowIso()
    return getModelCatalog()
  } catch (error) {
    clearGatewayCatalog()
    gatewayState.status = 'error'
    gatewayState.lastError =
      error instanceof Error ? error.message : String(error)
    throw error
  }
}

async function connectGateway({
  baseUrl,
  betaToken,
  accessCode,
}) {
  const normalizedBaseUrl = normalizeHttpUrl(baseUrl)
  if (!normalizedBaseUrl) {
    throw new Error('Gateway URL is required.')
  }

  let resolvedToken = sanitizeSecret(betaToken)
  let inlineCatalogItems = []

  if (!resolvedToken && accessCode) {
    const exchanged = await exchangeGatewayAccessCode({
      baseUrl: normalizedBaseUrl,
      accessCode,
    })
    resolvedToken = exchanged.betaToken
    inlineCatalogItems = exchanged.catalogItems
  }

  await saveGatewayConfig({
    baseUrl: normalizedBaseUrl,
    betaToken: resolvedToken,
  })

  if (inlineCatalogItems.length > 0) {
    gatewayState.catalogItems = inlineCatalogItems
    gatewayState.source = 'gateway'
    gatewayState.status = 'connected'
    gatewayState.lastSyncAt = nowIso()
    gatewayState.lastError = null
    return getModelCatalog()
  }

  return refreshGatewayCatalog()
}

function extractAssistantText(content) {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }

  const textParts = []
  const toolNames = new Set()

  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
      continue
    }
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      toolNames.add(block.name)
    }
  }

  let text = textParts.join('\n\n').trim()
  if (toolNames.size > 0) {
    const summary = `Used tools: ${Array.from(toolNames).join(', ')}`
    text = text ? `${text}\n\n${summary}` : summary
  }
  return text
}

function extractStreamDeltaText(event) {
  if (!event || typeof event !== 'object') {
    return ''
  }

  if (typeof event.text === 'string') {
    return event.text
  }

  if (event.delta && typeof event.delta === 'object') {
    if (typeof event.delta.text === 'string') {
      return event.delta.text
    }
    if (typeof event.delta.partial_json === 'string') {
      return event.delta.partial_json
    }
  }

  if (event.content_block && typeof event.content_block === 'object') {
    if (typeof event.content_block.text === 'string') {
      return event.content_block.text
    }
  }

  return ''
}

function makeTranscriptItem({
  id = randomUUID(),
  role,
  text,
  kind = role,
  state = 'final',
  createdAt = nowIso(),
  meta = null,
}) {
  return {
    id,
    role,
    kind,
    text,
    state,
    createdAt,
    meta,
  }
}

function pushTranscript(session, item) {
  session.transcript.push(item)
  if (session.transcript.length > MAX_TRANSCRIPT_ITEMS) {
    session.transcript = session.transcript.slice(-MAX_TRANSCRIPT_ITEMS)
  }
}

function pushActivity(session, text) {
  if (!text) {
    return
  }
  session.activity.unshift({
    id: randomUUID(),
    text,
    at: nowIso(),
  })
  session.activity = session.activity.slice(0, MAX_ACTIVITY_ITEMS)
}

function touchSession(session) {
  session.updatedAt = nowIso()
}

function ensureAssistantDraft(session) {
  if (session.currentAssistantDraftId) {
    const existing = session.transcript.find(
      item => item.id === session.currentAssistantDraftId,
    )
    if (existing) {
      return existing
    }
    session.currentAssistantDraftId = null
  }

  const draft = makeTranscriptItem({
    role: 'assistant',
    text: '',
    state: 'streaming',
  })
  pushTranscript(session, draft)
  session.currentAssistantDraftId = draft.id
  return draft
}

function finalizeAssistantDraft(session, text, meta = null) {
  const draft = ensureAssistantDraft(session)
  draft.text = text || draft.text || ''
  draft.state = 'final'
  draft.meta = meta
  session.currentAssistantDraftId = null
  return draft
}

function clearAssistantDraft(session) {
  session.currentAssistantDraftId = null
}

function summarizeSession(session) {
  const lastTranscript = [...session.transcript]
    .reverse()
    .find(item => item.text && item.text.trim())
  return {
    id: session.id,
    cliSessionId: session.cliSessionId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    model: session.model,
    baseUrl: session.baseUrl || 'https://api.openai.com/v1',
    workspacePath: session.workspacePath,
    liveStatus: session.liveStatus,
    lastPreview: lastTranscript ? lastTranscript.text.slice(0, 160) : '',
    hasApiKey: session.hasApiKey,
    pid: session.process?.pid ?? null,
    exitCode: session.exitCode,
  }
}

function publicSession(session) {
  return {
    ...summarizeSession(session),
    presetId: session.presetId,
    systemPrompt: session.systemPrompt,
    bareMode: session.bareMode,
    transcript: session.transcript,
    activity: session.activity,
    logs: session.stderrLog,
    pendingPermissions: session.pendingPermissions,
    metadata: session.metadata,
    lastResult: session.lastResult,
    lastError: session.lastError,
    provider: 'openai-compatible',
  }
}

function getUiState() {
  return {
    appRoot,
    repoRoot,
    host,
    port: defaultPort,
    bunInstalled: existsSync(bunBin),
    distExists: existsSync(distCliPath),
    currentTask: taskState.current,
    log: taskState.log,
    history: taskState.history.slice(0, 8),
    lastLaunch: taskState.lastLaunch,
    platform: process.platform,
    terminalStrategy:
      process.platform === 'darwin' ? 'terminal-app' : 'copy-command',
    workspace: getWorkspaceState(),
    gateway: getGatewayPublicState(),
    modelCatalog: getModelCatalog(),
    defaults: getSessionDefaults(),
    sessions: Array.from(webSessions.values())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(summarizeSession),
  }
}

function emitEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function broadcast(payload) {
  for (const response of eventClients) {
    emitEvent(response, payload)
  }
}

function broadcastState() {
  broadcast({ type: 'state', state: getUiState() })
}

function broadcastSession(session) {
  broadcast({ type: 'session', session: publicSession(session) })
}

function notifySessionChanged(session) {
  touchSession(session)
  broadcastSession(session)
  broadcastState()
}

function handleSessionInputError(session, error) {
  if (!webSessions.has(session.id)) {
    return
  }

  session.lastError = error.message
  session.liveStatus = null
  if (session.status !== 'exited') {
    session.status = 'error'
  }
  appendSessionLog(
    session,
    `[web-shell] Failed to write to backend stdin: ${error.message}\n`,
  )
  notifySessionChanged(session)
}

function removePendingPermission(session, requestId) {
  session.pendingPermissions = session.pendingPermissions.filter(
    item => item.requestId !== requestId,
  )
}

function writeSessionMessage(session, message) {
  if (!session.process || session.exitCode !== null) {
    throw new Error('Session process is not available.')
  }
  const stdin = session.process.stdin
  if (!stdin || stdin.destroyed || stdin.writableEnded) {
    throw new Error('Session process is not available.')
  }
  stdin.write(`${JSON.stringify(message)}\n`, error => {
    if (error) {
      handleSessionInputError(session, error)
    }
  })
}

function appendSessionLog(session, chunk) {
  session.stderrLog = truncateTail(
    `${session.stderrLog}${chunk}`,
    MAX_SESSION_LOG,
  )
}

function applySessionEvent(session, message) {
  session.rawEvents.push(message)
  if (session.rawEvents.length > MAX_RAW_EVENTS) {
    session.rawEvents = session.rawEvents.slice(-MAX_RAW_EVENTS)
  }

  switch (message.type) {
    case 'control_response': {
      if (message.response?.request_id === session.initializeRequestId) {
        if (message.response.subtype === 'success') {
          session.metadata = message.response.response
          session.status = 'idle'
          session.liveStatus = null
          session.lastError = null
          pushActivity(session, 'Session initialized')
        } else {
          session.status = 'error'
          session.lastError = message.response.error || 'Initialization failed'
          pushTranscript(
            session,
            makeTranscriptItem({
              role: 'system',
              kind: 'error',
              text: session.lastError,
            }),
          )
        }
      }
      return
    }

    case 'control_request': {
      if (message.request?.subtype === 'can_use_tool') {
        const request = {
          requestId: message.request_id,
          toolName: message.request.tool_name,
          toolUseId: message.request.tool_use_id || null,
          title:
            message.request.title ||
            message.request.display_name ||
            message.request.tool_name,
          description:
            message.request.description ||
            message.request.action_description ||
            '',
          input: message.request.input || {},
          createdAt: nowIso(),
        }
        removePendingPermission(session, request.requestId)
        session.pendingPermissions.unshift(request)
        session.pendingPermissions = session.pendingPermissions.slice(0, 6)
        session.status = 'needs-permission'
        session.liveStatus = `Waiting for permission: ${request.toolName}`
        pushActivity(session, `Permission requested for ${request.toolName}`)
      }
      return
    }

    case 'stream_event': {
      const deltaText = extractStreamDeltaText(message.event)
      if (deltaText) {
        const draft = ensureAssistantDraft(session)
        draft.text += deltaText
        draft.state = 'streaming'
        session.status = 'running'
      }
      return
    }

    case 'assistant': {
      const assistantText = extractAssistantText(message.message?.content)
      finalizeAssistantDraft(session, assistantText, {
        model: message.message?.model || null,
        error: message.error || null,
      })
      session.status =
        session.pendingPermissions.length > 0 ? 'needs-permission' : 'running'
      session.liveStatus = null
      return
    }

    case 'tool_progress': {
      session.liveStatus = `Tool ${message.tool_name} running...`
      session.status = 'running'
      pushActivity(session, session.liveStatus)
      return
    }

    case 'system': {
      if (message.subtype === 'status') {
        session.liveStatus = message.status
          ? `Status: ${message.status}`
          : null
        if (session.pendingPermissions.length > 0) {
          session.status = 'needs-permission'
        } else if (message.status) {
          session.status = 'running'
        }
        return
      }

      if (message.subtype === 'local_command_output') {
        pushTranscript(
          session,
          makeTranscriptItem({
            role: 'system',
            kind: 'command',
            text: message.content,
          }),
        )
        return
      }

      if (message.subtype === 'api_retry') {
        pushTranscript(
          session,
          makeTranscriptItem({
            role: 'system',
            kind: 'retry',
            text: `Retrying API request (${message.attempt}/${message.max_retries})`,
          }),
        )
        return
      }

      if (message.subtype === 'compact_boundary') {
        pushTranscript(
          session,
          makeTranscriptItem({
            role: 'system',
            kind: 'status',
            text: 'Conversation compacted',
          }),
        )
        return
      }

      if (
        message.subtype === 'task_started' ||
        message.subtype === 'task_progress' ||
        message.subtype === 'task_notification'
      ) {
        const summary =
          message.summary ||
          message.title ||
          message.description ||
          message.status ||
          message.subtype
        pushActivity(session, String(summary))
      }
      return
    }

    case 'result': {
      session.lastResult = message
      session.status =
        session.pendingPermissions.length > 0
          ? 'needs-permission'
          : 'idle'
      session.liveStatus = null
      clearAssistantDraft(session)
      if (message.is_error) {
        const resultText =
          message.result ||
          (Array.isArray(message.errors) ? message.errors.join('\n') : '')
        if (resultText) {
          const lastAssistant = [...session.transcript]
            .reverse()
            .find(item => item.role === 'assistant')
          if (!lastAssistant || lastAssistant.text !== resultText) {
            pushTranscript(
              session,
              makeTranscriptItem({
                role: 'system',
                kind: 'error',
                text: resultText,
              }),
            )
          }
        }
      }
      return
    }

    case 'auth_status': {
      session.authStatus = message
      return
    }

    case 'rate_limit_event': {
      session.rateLimitInfo = message.rate_limit_info
      return
    }

    default:
      return
  }
}

function handleSessionStdout(session, chunk) {
  session.stdoutBuffer += chunk
  while (session.stdoutBuffer.includes('\n')) {
    const newline = session.stdoutBuffer.indexOf('\n')
    const line = session.stdoutBuffer.slice(0, newline)
    session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1)
    if (!line.trim()) {
      continue
    }
    try {
      const message = JSON.parse(line)
      applySessionEvent(session, message)
      notifySessionChanged(session)
    } catch (error) {
      appendSessionLog(
        session,
        `[web-shell] Failed to parse session event: ${String(error)}\n${line}\n`,
      )
      notifySessionChanged(session)
    }
  }
}

function getSessionOrThrow(sessionId) {
  const session = webSessions.get(sessionId)
  if (!session) {
    throw new Error('Session not found.')
  }
  return session
}

function spawnWebSession({
  presetId,
  model,
  baseUrl,
  apiKey,
  bareMode,
  systemPrompt,
  workspacePath,
}) {
  if (!existsSync(distCliPath)) {
    throw new Error('Build is missing. Run Build first.')
  }
  if (!normalizeWorkspacePath(workspacePath)) {
    throw new Error('Workspace folder is unavailable.')
  }

  const session = {
    id: randomUUID(),
    cliSessionId: randomUUID(),
    initializeRequestId: randomUUID(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    title: `Session ${model}`,
    status: 'starting',
    presetId,
    model,
    baseUrl,
    workspacePath,
    hasApiKey: Boolean(apiKey),
    bareMode,
    systemPrompt,
    process: null,
    exitCode: null,
    stdoutBuffer: '',
    stderrLog: '',
    transcript: [],
    rawEvents: [],
    pendingPermissions: [],
    metadata: null,
    lastResult: null,
    lastError: null,
    liveStatus: 'Booting backend...',
    currentAssistantDraftId: null,
    activity: [],
    authStatus: null,
    rateLimitInfo: null,
  }

  const args = [
    distCliPath,
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--session-id',
    session.cliSessionId,
  ]

  if (bareMode) {
    args.push('--bare')
  }

  const child = spawn(nodeBin, args, {
    cwd: workspacePath,
    env: getRuntimeEnv({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_MODEL: model,
      ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
      ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  session.process = child
  webSessions.set(session.id, session)

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdin.on('error', error => {
    handleSessionInputError(session, error)
  })

  child.stdout.on('data', data => {
    handleSessionStdout(session, String(data))
  })

  child.stderr.on('data', data => {
    appendSessionLog(session, String(data))
    notifySessionChanged(session)
  })

  child.on('spawn', () => {
    pushActivity(session, `Workspace ${workspacePath}`)
    pushActivity(session, `Backend PID ${child.pid}`)
    writeSessionMessage(session, {
      type: 'control_request',
      request_id: session.initializeRequestId,
      request: {
        subtype: 'initialize',
        ...(systemPrompt ? { systemPrompt } : {}),
      },
    })
    notifySessionChanged(session)
  })

  child.on('error', error => {
    session.status = 'error'
    session.lastError = error.message
    appendSessionLog(session, `[web-shell] ${error.message}\n`)
    pushTranscript(
      session,
      makeTranscriptItem({
        role: 'system',
        kind: 'error',
        text: error.message,
      }),
    )
    notifySessionChanged(session)
  })

  child.on('close', (code, signal) => {
    session.exitCode = code ?? 1
    session.process = null
    session.liveStatus = null
    if (session.status !== 'error') {
      session.status = 'exited'
    }
    if (signal) {
      appendSessionLog(session, `[web-shell] Process ended via ${signal}\n`)
    }
    pushActivity(
      session,
      `Backend exited (${signal ? `signal ${signal}` : `code ${code ?? 1}`})`,
    )
    notifySessionChanged(session)
  })

  notifySessionChanged(session)
  return session
}

function sendUserPrompt(session, content) {
  const prompt = String(content || '').trim()
  if (!prompt) {
    throw new Error('Message is required.')
  }
  if (!session.process || session.exitCode !== null) {
    throw new Error('Session is no longer running.')
  }

  const userMessageId = randomUUID()
  pushTranscript(
    session,
    makeTranscriptItem({
      id: userMessageId,
      role: 'user',
      text: prompt,
    }),
  )
  if (session.transcript.filter(item => item.role === 'user').length === 1) {
    session.title = prompt.slice(0, 42)
  }
  session.status = 'running'
  session.liveStatus = 'Thinking...'
  writeSessionMessage(session, {
    type: 'user',
    message: {
      role: 'user',
      content: prompt,
    },
    parent_tool_use_id: null,
    session_id: '',
    uuid: userMessageId,
    timestamp: nowIso(),
  })
  notifySessionChanged(session)
}

function interruptSession(session) {
  if (!session.process || session.exitCode !== null) {
    throw new Error('Session is not running.')
  }
  writeSessionMessage(session, {
    type: 'control_request',
    request_id: randomUUID(),
    request: {
      subtype: 'interrupt',
    },
  })
  session.liveStatus = 'Interrupt requested'
  pushActivity(session, 'Interrupt requested')
  notifySessionChanged(session)
}

function resolvePermission(session, requestId, decision) {
  const pending = session.pendingPermissions.find(
    item => item.requestId === requestId,
  )
  if (!pending) {
    throw new Error('Permission request not found.')
  }
  if (!session.process || session.exitCode !== null) {
    throw new Error('Session is not running.')
  }

  const response =
    decision === 'allow'
      ? {
          behavior: 'allow',
          updatedInput: pending.input || {},
          toolUseID: pending.toolUseId,
        }
      : {
          behavior: 'deny',
          message: 'Denied from the web shell.',
          toolUseID: pending.toolUseId,
        }

  writeSessionMessage(session, {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response,
    },
  })

  removePendingPermission(session, requestId)
  session.status =
    session.pendingPermissions.length > 0 ? 'needs-permission' : 'running'
  session.liveStatus =
    decision === 'allow' ? `Allowed ${pending.toolName}` : `Denied ${pending.toolName}`
  pushActivity(session, session.liveStatus)
  notifySessionChanged(session)
}

function destroySession(session) {
  if (session.process && session.exitCode === null) {
    session.process.kill('SIGTERM')
  }
  webSessions.delete(session.id)
  broadcastState()
}

function runTask(taskId) {
  const task = taskCatalog[taskId]
  if (!task) {
    throw new Error(`Unknown task: ${taskId}`)
  }
  if (taskState.current?.status === 'running') {
    throw new Error(`Task already running: ${taskState.current.label}`)
  }
  if (!existsSync(task.command)) {
    throw new Error(`Missing command: ${task.command}`)
  }

  const displayCommand = [task.command, ...task.args].join(' ')
  const startedAt = nowIso()
  taskState.log = `$ ${displayCommand}\n\n`
  taskState.current = {
    id: taskId,
    label: task.label,
    startedAt,
    displayCommand,
    status: 'running',
  }
  broadcastState()

  const child = spawn(task.command, task.args, {
    cwd: repoRoot,
    env: getRuntimeEnv(),
  })

  child.stdout.on('data', data => {
    appendLog(String(data))
    broadcastState()
  })
  child.stderr.on('data', data => {
    appendLog(String(data))
    broadcastState()
  })
  child.on('error', error => {
    appendLog(`\n[launcher] ${error.message}\n`)
    broadcastState()
  })
  child.on('close', code => {
    const finishedAt = nowIso()
    const status = code === 0 ? 'passed' : 'failed'
    appendLog(`\n[launcher] ${task.label} finished with code ${code ?? 1}\n`)
    pushHistory({
      id: taskId,
      label: task.label,
      startedAt,
      finishedAt,
      code: code ?? 1,
      status,
    })
    taskState.current = {
      id: taskId,
      label: task.label,
      startedAt,
      finishedAt,
      displayCommand,
      status,
      code: code ?? 1,
    }
    broadcastState()
  })
}

async function createLaunchFiles({
  apiKey,
  model,
  baseUrl,
  workspacePath,
  buildBeforeLaunch,
}) {
  await mkdir(launchpadTmpDir, { recursive: true })
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const envPath = join(launchpadTmpDir, `openclaude-${token}.env`)
  const commandPath = join(launchpadTmpDir, `openclaude-${token}.command`)

  const envLines = [
    'export CLAUDE_CODE_USE_OPENAI=1',
    `export OPENAI_MODEL=${shellQuote(model)}`,
  ]
  if (apiKey) {
    envLines.push(`export OPENAI_API_KEY=${shellQuote(apiKey)}`)
  }
  if (baseUrl) {
    envLines.push(`export OPENAI_BASE_URL=${shellQuote(baseUrl)}`)
  }
  const envContents = `${envLines.join('\n')}\n`
  await writeFile(envPath, envContents, 'utf8')

  const buildStep = buildBeforeLaunch
    ? `cd ${shellQuote(appRoot)}\n${shellQuote(bunBin)} run build\n`
    : ''

  const electronAsNodeStep = shouldUseElectronAsNode
    ? `export ELECTRON_RUN_AS_NODE=1\n`
    : ''

  const commandContents = `#!/bin/zsh
set -e
source ${shellQuote(envPath)}
rm -f ${shellQuote(envPath)}
export PATH=${shellQuote(getPathEnv())}
${electronAsNodeStep}export OPENCLAUDE_APP_ROOT=${shellQuote(appRoot)}
clear
echo "OpenClaude app shell"
echo "Workspace: ${workspacePath}"
echo "Model: ${model}"
${buildStep}cd ${shellQuote(workspacePath)}
${shellQuote(nodeBin)} ${shellQuote(distCliPath)}
status=$?
echo
echo "OpenClaude exited with code $status."
echo "Press Enter to close this window."
read
rm -f ${shellQuote(commandPath)}
exit $status
`
  await writeFile(commandPath, commandContents, 'utf8')
  await chmod(commandPath, 0o700)

  return { envPath, commandPath }
}

async function launchTerminal(config) {
  const { commandPath } = await createLaunchFiles(config)
  if (process.platform === 'darwin') {
    const opener = spawn('open', [commandPath], {
      detached: true,
      stdio: 'ignore',
    })
    opener.unref()
    return {
      mode: 'terminal-app',
      message: 'OpenClaude is opening in Terminal.',
    }
  }

  return {
    mode: 'copy-command',
    message: 'Terminal auto-open is only implemented for macOS.',
    commandPreview: commandPath,
  }
}

async function renderMarkdownDocument(filePath, title) {
  const markdown = await readFile(filePath, 'utf8')
  const body = marked.parse(markdown)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0f172a;
        --panel: rgba(15, 23, 42, 0.84);
        --ink: #e2e8f0;
        --muted: #94a3b8;
        --accent: #f59e0b;
        --line: rgba(148, 163, 184, 0.25);
      }
      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        background:
          radial-gradient(circle at top, rgba(245, 158, 11, 0.16), transparent 28rem),
          linear-gradient(180deg, #020617, #0f172a);
        color: var(--ink);
      }
      main {
        max-width: 56rem;
        margin: 0 auto;
        padding: 3rem 1.5rem 5rem;
      }
      article {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 2rem;
        backdrop-filter: blur(18px);
      }
      a { color: #fbbf24; }
      code, pre {
        font-family: "SFMono-Regular", "JetBrains Mono", "Menlo", monospace;
      }
      pre {
        padding: 1rem;
        overflow: auto;
        border-radius: 16px;
        background: rgba(2, 6, 23, 0.75);
      }
      blockquote {
        margin: 0;
        padding-left: 1rem;
        border-left: 3px solid var(--accent);
        color: var(--muted);
      }
      img { max-width: 100%; }
    </style>
  </head>
  <body>
    <main>
      <article>${body}</article>
    </main>
  </body>
</html>`
}

function normalizeSessionPayload(body) {
  const defaults = getSessionDefaults()
  const presetId = String(body?.presetId || '').trim()
  const preset = getCatalogItemById(presetId)
  const model = String(body?.model || preset?.model || defaults.model).trim()
  const baseUrl = String(
    body?.baseUrl || preset?.baseUrl || defaults.baseUrl || '',
  ).trim()
  const apiKey = sanitizeApiKey(
    body?.apiKey ||
      (preset?.transport === 'gateway' ? gatewayState.betaToken : '') ||
      process.env.OPENAI_API_KEY,
  )
  const bareMode = body?.bareMode === true
  const systemPrompt = String(body?.systemPrompt || '').trim()
  return { presetId, model, baseUrl, apiKey, bareMode, systemPrompt }
}

function attachEventStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  res.write(': connected\n\n')
  emitEvent(res, { type: 'state', state: getUiState() })
  eventClients.add(res)
}

function closeAllSessions() {
  for (const session of webSessions.values()) {
    if (session.process && session.exitCode === null) {
      session.process.kill('SIGTERM')
    }
  }
}

export function createLauncherApp() {
  const app = express()

  app.use(express.json({ limit: '512kb' }))
  app.use(express.static(staticDir))

  if (gatewayState.baseUrl) {
    void refreshGatewayCatalog()
      .then(() => {
        broadcastState()
      })
      .catch(() => {
        broadcastState()
      })
  }

  app.get('/api/events', (req, res) => {
    attachEventStream(res)
    req.on('close', () => {
      eventClients.delete(res)
    })
  })

  app.get('/api/state', (_req, res) => {
    res.json(getUiState())
  })

  app.get('/api/sessions/:sessionId', (req, res) => {
    try {
      const session = getSessionOrThrow(req.params.sessionId)
      res.json({ ok: true, session: publicSession(session) })
    } catch (error) {
      res.status(404).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.post('/api/sessions', (req, res) => {
    try {
      const payload = normalizeSessionPayload(req.body)
      const workspacePath = requireCurrentWorkspacePath()
      if (!payload.model) {
        throw new Error('Model is required.')
      }
      if (!payload.apiKey && !isLocalBaseUrl(payload.baseUrl)) {
        throw new Error(
          'Add an API key, or point Base URL at a local provider.',
        )
      }

      const session = spawnWebSession({
        ...payload,
        workspacePath,
      })
      res.json({
        ok: true,
        state: getUiState(),
        session: publicSession(session),
      })
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.post('/api/sessions/:sessionId/messages', (req, res) => {
    try {
      const session = getSessionOrThrow(req.params.sessionId)
      sendUserPrompt(session, req.body?.content)
      res.json({
        ok: true,
        state: getUiState(),
        session: publicSession(session),
      })
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.post('/api/sessions/:sessionId/interrupt', (req, res) => {
    try {
      const session = getSessionOrThrow(req.params.sessionId)
      interruptSession(session)
      res.json({
        ok: true,
        state: getUiState(),
        session: publicSession(session),
      })
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.post('/api/sessions/:sessionId/permissions/:requestId', (req, res) => {
    try {
      const session = getSessionOrThrow(req.params.sessionId)
      const decision = String(req.body?.decision || '').trim()
      if (decision !== 'allow' && decision !== 'deny') {
        throw new Error('Decision must be "allow" or "deny".')
      }
      resolvePermission(session, req.params.requestId, decision)
      res.json({
        ok: true,
        state: getUiState(),
        session: publicSession(session),
      })
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.delete('/api/sessions/:sessionId', (req, res) => {
    try {
      const session = getSessionOrThrow(req.params.sessionId)
      destroySession(session)
      res.json({ ok: true, state: getUiState() })
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.post('/api/tasks/:taskId', (req, res) => {
    try {
      runTask(req.params.taskId)
      res.json({ ok: true, state: getUiState() })
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        state: getUiState(),
      })
    }
  })

  app.post('/api/workspace', async (req, res) => {
    try {
      await setCurrentWorkspace(req.body?.path)
      res.json({ ok: true, state: getUiState() })
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        state: getUiState(),
      })
    }
  })

  app.post('/api/gateway/connect', async (req, res) => {
    try {
      await connectGateway({
        baseUrl: req.body?.baseUrl,
        betaToken: req.body?.betaToken,
        accessCode: req.body?.accessCode,
      })
      res.json({ ok: true, state: getUiState() })
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        state: getUiState(),
      })
    }
  })

  app.post('/api/gateway/refresh', async (_req, res) => {
    try {
      await refreshGatewayCatalog()
      res.json({ ok: true, state: getUiState() })
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        state: getUiState(),
      })
    }
  })

  app.post('/api/gateway/disconnect', async (_req, res) => {
    try {
      await disconnectGateway()
      res.json({ ok: true, state: getUiState() })
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        state: getUiState(),
      })
    }
  })

  app.post('/api/open-terminal', async (req, res) => {
    const payload = normalizeSessionPayload(req.body)
    const buildBeforeLaunch = req.body?.buildBeforeLaunch !== false

    if (!payload.model) {
      res.status(400).json({ ok: false, error: 'Model is required.' })
      return
    }
    if (!payload.apiKey && !isLocalBaseUrl(payload.baseUrl)) {
      res.status(400).json({
        ok: false,
        error: 'Add an API key, or point Base URL at a local provider.',
      })
      return
    }

    try {
      const workspacePath = requireCurrentWorkspacePath()
      const launchResult = await launchTerminal({
        apiKey: payload.apiKey,
        model: payload.model,
        baseUrl: payload.baseUrl,
        workspacePath,
        buildBeforeLaunch,
      })
      taskState.lastLaunch = {
        at: nowIso(),
        model: payload.model,
        baseUrl: payload.baseUrl || 'https://api.openai.com/v1',
        workspacePath,
        buildBeforeLaunch,
        mode: launchResult.mode,
      }
      broadcastState()
      res.json({ ok: true, launchResult, state: getUiState() })
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.post('/api/open-workspace', (_req, res) => {
    const workspacePath = getWorkspaceState().currentPath
    if (!workspacePath) {
      res.status(400).json({
        ok: false,
        error: 'Choose a workspace folder first.',
      })
      return
    }
    if (process.platform !== 'darwin') {
      res.status(400).json({
        ok: false,
        error: 'Open workspace is currently wired for macOS Finder.',
      })
      return
    }

    const opener = spawn('open', [workspacePath], {
      detached: true,
      stdio: 'ignore',
    })
    opener.unref()
    res.json({ ok: true })
  })

  app.get('/docs/readme', async (_req, res, next) => {
    try {
      res.send(await renderMarkdownDocument(readmePath, 'OpenClaude README'))
    } catch (error) {
      next(error)
    }
  })

  app.get('/docs/playbook', async (_req, res, next) => {
    try {
      res.send(await renderMarkdownDocument(playbookPath, 'OpenClaude Playbook'))
    } catch (error) {
      next(error)
    }
  })

  app.use((error, _req, res, _next) => {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  })

  return app
}

export function startLauncherServer({
  bindHost = host,
  bindPort = defaultPort,
  openBrowser = process.env.OPENCLAUDE_LAUNCHER_OPEN === '1',
} = {}) {
  const app = createLauncherApp()
  const server = app.listen(bindPort, bindHost, () => {
    const url = `http://${bindHost}:${bindPort}`
    console.log(`OpenClaude app shell listening at ${url}`)

    if (openBrowser && process.platform === 'darwin') {
      const opener = spawn('open', [url], {
        detached: true,
        stdio: 'ignore',
      })
      opener.unref()
    }
  })

  server.on('close', () => {
    closeAllSessions()
  })

  return server
}

process.on('SIGINT', () => {
  closeAllSessions()
})

process.on('SIGTERM', () => {
  closeAllSessions()
})

const isMainModule =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url

if (isMainModule) {
  startLauncherServer()
}
