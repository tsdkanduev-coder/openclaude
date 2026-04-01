# OpenClaude Beta Gateway Contract

Updated: 2026-04-01

## Goal

The desktop app should not hold real upstream provider keys.

Instead, it connects to a small central gateway that:

- authenticates beta users with a simple token flow
- returns the list of model presets the app should show
- accepts OpenAI-compatible inference traffic
- routes each requested model to the correct upstream provider key

## Desktop App Behavior

The current app now supports this flow:

1. User enters `Gateway URL`.
2. User either enters a saved `Beta Token` or a one-time `Access Code`.
3. App exchanges the access code at `POST /beta-access` when needed.
4. App fetches model presets from `GET /models`.
5. When the user launches a session from a gateway preset, the runtime uses:
   - `OPENAI_BASE_URL=<gateway inference base URL>`
   - `OPENAI_API_KEY=<beta token>`
   - `OPENAI_MODEL=<selected preset model>`

This keeps OpenClaude on a normal OpenAI-compatible transport while moving billing and key selection to the gateway.

## Required Endpoints

### `POST /beta-access`

Purpose:

- exchange a short invite/access code for a reusable beta token

Request:

```json
{
  "code": "invite-42"
}
```

Successful response:

```json
{
  "token": "beta_tok_123"
}
```

Also accepted by the current desktop runtime:

- `betaToken`
- `accessToken`

Optional:

- the response may also include `items` or `models` to inline the first model catalog payload

### `GET /models`

Purpose:

- return the model presets shown in the desktop app

Headers:

- `Authorization: Bearer <beta token>` if a token exists

Successful response:

```json
{
  "items": [
    {
      "id": "fast",
      "label": "Fast",
      "model": "gateway-fast",
      "description": "Primary beta preset"
    },
    {
      "id": "deep",
      "label": "Deep Reasoning",
      "model": "gateway-deep",
      "baseUrl": "https://gateway.example.com/v1"
    }
  ]
}
```

The runtime also accepts:

- a top-level array
- `models` instead of `items`
- `displayName` instead of `label`
- `inferenceBaseUrl` instead of `baseUrl`

If a model item omits `baseUrl`, the app assumes the inference base is:

- `<gateway base URL>/v1`

## Model Item Shape

The normalized fields used by the app are:

```json
{
  "id": "fast",
  "label": "Fast",
  "model": "gateway-fast",
  "baseUrl": "https://gateway.example.com/v1",
  "description": "Primary beta preset"
}
```

Notes:

- `id` is the stable preset identifier used by the UI
- `label` is what the user sees
- `model` is what OpenClaude sends as `OPENAI_MODEL`
- `baseUrl` is the OpenAI-compatible inference root

## Inference Contract

The gateway should expose an OpenAI-compatible inference surface.

That means the desktop app can keep using the existing OpenClaude runtime without custom transport code.

Recommended shape:

- `POST /v1/chat/completions`
- `POST /v1/responses` if supported by the chosen runtime path
- `GET /v1/models` optional, but not required for the current desktop adapter

The important part is that the gateway accepts:

- `Authorization: Bearer <beta token>`
- `model: <gateway alias>`

Then the gateway internally decides:

- upstream provider
- upstream model
- upstream API key
- limits / billing bucket

## Minimal Beta Strategy

For a 5-10 person beta, this is enough:

- static invite/access codes
- one exchanged beta token per tester
- a small preset list
- centralized logging and rate limiting at the gateway

No full user account system is required for this version.
