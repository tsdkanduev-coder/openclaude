import crypto from 'node:crypto'
import express from 'express'
import { fileURLToPath } from 'node:url'

const defaultPort = Number(
  process.env.PORT || process.env.OPENCLAUDE_GATEWAY_PORT || '8787',
)
const host =
  process.env.OPENCLAUDE_GATEWAY_HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1')
const isProduction = process.env.NODE_ENV === 'production'
const defaultDevAccessCode = 'openclaude-beta'
const defaultDevSecret = 'openclaude-beta-dev-secret'
const tokenLifetimeSeconds = Number(
  process.env.GATEWAY_TOKEN_TTL_SECONDS || String(60 * 60 * 24 * 30),
)

const MODEL_SLOTS = [
  {
    id: 'chatgpt-gpt-5.4',
    alias: 'chatgpt-gpt-5.4',
    label: 'ChatGPT · GPT-5.4',
    provider: 'chatgpt',
    description: 'OpenAI flagship model for complex reasoning and coding.',
    upstreamProvider: 'openai',
    upstreamModel: 'gpt-5.4',
    upstreamBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'GATEWAY_OPENAI_API_KEY',
    maxOutputTokens: 128_000,
  },
  {
    id: 'chatgpt-gpt-4o',
    alias: 'chatgpt-gpt-4o',
    label: 'ChatGPT · GPT-4o',
    provider: 'chatgpt',
    description: 'Explicit ChatGPT model choice for broader high-quality tasks.',
    upstreamProvider: 'openai',
    upstreamModel: 'gpt-4o',
    upstreamBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'GATEWAY_OPENAI_API_KEY',
    maxOutputTokens: 16_384,
  },
  {
    id: 'chatgpt-o4-mini',
    alias: 'chatgpt-o4-mini',
    label: 'ChatGPT · o4-mini',
    provider: 'chatgpt',
    description: 'Explicit ChatGPT reasoning model choice.',
    upstreamProvider: 'openai',
    upstreamModel: 'o4-mini',
    upstreamBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'GATEWAY_OPENAI_API_KEY',
    maxOutputTokens: 100_000,
  },
  {
    id: 'deepseek-slot',
    alias: 'deepseek-slot',
    label: 'DeepSeek · pending exact model',
    provider: 'deepseek',
    description: 'Placeholder slot for the DeepSeek model that will be wired later.',
    upstreamProvider: 'deepseek',
    upstreamModel: '',
    upstreamBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'GATEWAY_DEEPSEEK_API_KEY',
    maxOutputTokens: null,
  },
  {
    id: 'yandex-slot',
    alias: 'yandex-slot',
    label: 'Yandex · 5.1 Pro (placeholder)',
    provider: 'yandex',
    description: 'Placeholder slot for the Yandex model that will be wired later.',
    upstreamProvider: 'yandex',
    upstreamModel: '',
    upstreamBaseUrl: '',
    apiKeyEnv: 'GATEWAY_YANDEX_API_KEY',
    maxOutputTokens: null,
  },
  {
    id: 'gigachat-slot',
    alias: 'gigachat-slot',
    label: 'GigaChat · Ultra (placeholder)',
    provider: 'gigachat',
    description: 'Placeholder slot for the GigaChat model that will be wired later.',
    upstreamProvider: 'gigachat',
    upstreamModel: '',
    upstreamBaseUrl: '',
    apiKeyEnv: 'GATEWAY_GIGACHAT_API_KEY',
    maxOutputTokens: null,
  },
]

function sanitizeSecret(value) {
  const trimmed = String(value || '').trim()
  return trimmed && trimmed !== 'SUA_CHAVE' ? trimmed : ''
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlDecode(value) {
  const normalized = String(value)
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8')
}

function getTokenSecret() {
  const configured = sanitizeSecret(process.env.GATEWAY_TOKEN_SECRET)
  if (configured) {
    return configured
  }
  return defaultDevSecret
}

function getAcceptedAccessCodes() {
  const configured = String(process.env.BETA_ACCESS_CODES || '')
    .split(',')
    .map(entry => sanitizeSecret(entry))
    .filter(Boolean)

  if (configured.length > 0) {
    return configured
  }

  return isProduction ? [] : [defaultDevAccessCode]
}

function signToken(payload) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const encodedHeader = base64UrlEncode(JSON.stringify(header))
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const input = `${encodedHeader}.${encodedPayload}`
  const signature = crypto
    .createHmac('sha256', getTokenSecret())
    .update(input)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')

  return `${input}.${signature}`
}

function verifyToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid beta token format.')
  }

  const [encodedHeader, encodedPayload, signature] = parts
  const expectedSignature = crypto
    .createHmac('sha256', getTokenSecret())
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')

  const left = Buffer.from(signature)
  const right = Buffer.from(expectedSignature)
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new Error('Beta token signature is invalid.')
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload))
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw new Error('Beta token expired.')
  }
  return payload
}

function issueBetaToken(accessCode) {
  const now = Math.floor(Date.now() / 1000)
  return signToken({
    sub: `beta:${accessCode}`,
    scope: 'desktop-beta',
    iat: now,
    exp: now + tokenLifetimeSeconds,
  })
}

function resolveGatewayBaseUrl(req) {
  const configured = sanitizeSecret(process.env.GATEWAY_PUBLIC_BASE_URL)
  if (configured) {
    return configured.replace(/\/$/, '')
  }

  const protocol =
    (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim() ||
    req.protocol ||
    'http'
  const hostHeader =
    (req.headers['x-forwarded-host'] || '').toString().split(',')[0].trim() ||
    req.get('host') ||
    `${host}:${defaultPort}`

  return `${protocol}://${hostHeader}`.replace(/\/$/, '')
}

function getCatalogSlots() {
  return MODEL_SLOTS.map(slot => {
    const apiKey = sanitizeSecret(process.env[slot.apiKeyEnv])
    const configured =
      Boolean(apiKey) &&
      Boolean(slot.upstreamModel) &&
      Boolean(slot.upstreamBaseUrl)

    return {
      ...slot,
      configured,
      apiKey,
    }
  })
}

function buildPublicModel(slot, req) {
  const baseUrl = `${resolveGatewayBaseUrl(req)}/v1`
  return {
    id: slot.id,
    label: slot.label,
    provider: slot.provider,
    model: slot.alias,
    baseUrl,
    description: slot.description,
    maxOutputTokens: slot.maxOutputTokens ?? null,
  }
}

function getPublicModels(req) {
  return getCatalogSlots()
    .filter(slot => slot.configured)
    .map(slot => buildPublicModel(slot, req))
}

function getPlaceholderSlots() {
  return getCatalogSlots()
    .filter(slot => !slot.configured)
    .map(slot => ({
      id: slot.id,
      label: slot.label,
      provider: slot.provider,
      description: slot.description,
      configured: false,
    }))
}

function getSlotByAlias(alias) {
  return getCatalogSlots().find(slot => slot.alias === alias) || null
}

function getBearerToken(req) {
  const authHeader = String(req.headers.authorization || '')
  if (!authHeader.startsWith('Bearer ')) {
    return ''
  }
  return authHeader.slice('Bearer '.length).trim()
}

function requireBetaAuth(req, res, next) {
  const acceptedAccessCodes = getAcceptedAccessCodes()
  if (acceptedAccessCodes.length === 0 && !sanitizeSecret(process.env.GATEWAY_TOKEN_SECRET)) {
    return next()
  }

  const token = getBearerToken(req)
  if (!token) {
    res.status(401).json({
      error: 'Missing beta token.',
    })
    return
  }

  try {
    req.betaTokenPayload = verifyToken(token)
    next()
  } catch (error) {
    res.status(401).json({
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function proxyChatCompletion(req, res) {
  const requestedAlias = String(req.body?.model || '').trim()
  const slot = getSlotByAlias(requestedAlias)

  if (!slot || !slot.configured) {
    res.status(400).json({
      error: `Model '${requestedAlias}' is not configured in the gateway.`,
    })
    return
  }

  const upstreamBody = {
    ...req.body,
    model: slot.upstreamModel,
  }

  // Enforce upstream output-token ceilings centrally so the desktop app can keep
  // a stable product flow even when the runtime sends a generic 32k default.
  if (
    typeof slot.maxOutputTokens === 'number' &&
    Number.isFinite(slot.maxOutputTokens) &&
    typeof upstreamBody.max_tokens === 'number'
  ) {
    upstreamBody.max_tokens = Math.min(upstreamBody.max_tokens, slot.maxOutputTokens)
  }

  const upstreamResponse = await fetch(`${slot.upstreamBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${slot.apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
  })

  res.status(upstreamResponse.status)
  const contentType = upstreamResponse.headers.get('content-type')
  if (contentType) {
    res.setHeader('Content-Type', contentType)
  }
  const cacheControl = upstreamResponse.headers.get('cache-control')
  if (cacheControl) {
    res.setHeader('Cache-Control', cacheControl)
  }

  if (!upstreamResponse.body) {
    res.end()
    return
  }

  const reader = upstreamResponse.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    res.write(Buffer.from(value))
  }
  res.end()
}

export function createGatewayApp() {
  const app = express()
  app.set('trust proxy', true)
  app.use(express.json({ limit: '1mb' }))

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'openclaude-beta-gateway',
      configuredModels: getCatalogSlots().filter(slot => slot.configured).length,
      placeholderSlots: getCatalogSlots().filter(slot => !slot.configured).length,
    })
  })

  app.post('/beta-access', (req, res) => {
    const accessCode = sanitizeSecret(req.body?.code)
    if (!accessCode) {
      res.status(400).json({ error: 'Access code is required.' })
      return
    }

    const acceptedAccessCodes = getAcceptedAccessCodes()
    if (acceptedAccessCodes.length > 0 && !acceptedAccessCodes.includes(accessCode)) {
      res.status(403).json({ error: 'Access code is not valid.' })
      return
    }

    const token = issueBetaToken(accessCode)
    res.json({
      token,
      items: [],
    })
  })

  app.get('/models', requireBetaAuth, (req, res) => {
    res.json({
      items: getPublicModels(req),
      placeholders: getPlaceholderSlots(),
    })
  })

  app.get('/v1/models', requireBetaAuth, (req, res) => {
    res.json({
      object: 'list',
      data: getPublicModels(req).map(item => ({
        id: item.model,
        object: 'model',
        owned_by: item.provider,
      })),
    })
  })

  app.post('/v1/chat/completions', requireBetaAuth, async (req, res) => {
    try {
      await proxyChatCompletion(req, res)
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  return app
}

export function startGatewayServer({
  bindHost = host,
  bindPort = defaultPort,
} = {}) {
  const app = createGatewayApp()
  return app.listen(bindPort, bindHost, () => {
    console.log(
      `OpenClaude beta gateway listening at http://${bindHost}:${bindPort}`,
    )
  })
}

const isMainModule =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]

if (isMainModule) {
  startGatewayServer()
}
