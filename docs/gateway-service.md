# OpenClaude Beta Gateway Service

Updated: 2026-04-01

## What Exists Now

The repo now contains a minimal gateway server:

- [gateway-server.mjs](/Users/tkanduev/Documents/GigaWork/openclaude/scripts/gateway-server.mjs)

It exposes:

- `GET /health`
- `POST /beta-access`
- `GET /models`
- `GET /v1/models`
- `POST /v1/chat/completions`

## Current Behavior

What is working now:

- beta access codes can be exchanged for a signed beta token
- the gateway returns only configured model entries to the desktop app
- unresolved providers remain as placeholder slots in the server config
- ChatGPT routes can already be enabled by setting the OpenAI key env var

What is intentionally still placeholder-only:

- DeepSeek
- Yandex
- GigaChat

Those providers already have catalog slots in the service, but they are not returned by `GET /models` until their upstream model IDs and auth details are filled in.

## Required Environment Variables

Minimum for local beta testing:

```bash
export GATEWAY_OPENAI_API_KEY=...
export GATEWAY_TOKEN_SECRET=change-me
export BETA_ACCESS_CODES=invite-42,invite-43
```

Optional:

```bash
export PORT=8787
export GATEWAY_PUBLIC_BASE_URL=https://your-gateway.example.com
export GATEWAY_TOKEN_TTL_SECONDS=2592000
```

On Render, the gateway now auto-binds to `0.0.0.0`. You only need to set
`OPENCLAUDE_GATEWAY_HOST` if you want to override that default.

If `BETA_ACCESS_CODES` is omitted outside production, the default local access code is:

```text
openclaude-beta
```

## Run Locally

```bash
bun run gateway:dev
```

or

```bash
node scripts/gateway-server.mjs
```

## Placeholder Strategy

The current gateway config keeps empty slots for providers we have not fully specified yet.

That means we can move forward with:

- gateway deployment
- beta token flow
- desktop integration
- ChatGPT-backed testing

Then later fill in:

- exact DeepSeek model ID
- exact Yandex API model ID
- exact GigaChat API model ID

without redesigning the service.
