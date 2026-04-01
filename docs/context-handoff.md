# OpenClaude Desktop Beta Handoff

Updated: 2026-04-01
Workspace: `/Users/tkanduev/Documents/GigaWork/openclaude`
Branch: `main`

## 1. User Goal

The target is no longer "a simple launcher".

The user wants a real installable desktop product that behaves more like Codex / Claude Desktop:

- downloadable app
- opens as a desktop application
- wraps OpenClaude on the backend
- usable by a very small closed beta group (about 5-10 people)
- no full sign-in flow required for beta
- design must be rebuilt to feel much closer to Codex / ChatGPT product quality
- model access should be centralized behind the user's own backend and billing

Important product constraints from the user:

1. Sign-in is not important right now. Beta speed matters more than account infrastructure.
2. Current design is unacceptable and should be replaced after studying Codex / ChatGPT visual patterns and flows.
3. The user wants centralized billing and routing:
   - users should choose model presets
   - real provider API keys live on the user's backend
   - switching a model on the client should effectively switch backend routing / key selection

## 2. Product Direction Chosen

The working direction is:

- `Electron` as the desktop shell
- local runtime manager inside the app
- one or more OpenClaude child sessions running in `stream-json` mode
- later: central OpenAI-compatible gateway for model routing and billing

Why Electron:

- fastest path to an installable beta
- existing backend is Node/process based
- existing UI is already browser-oriented
- easier packaging path for `.app` / `.dmg`

Tauri was discussed and intentionally not chosen for beta because it would slow down delivery and add Rust/runtime integration work before the product is proven.

## 2.1 Decisions Already Locked

These decisions should be treated as intentional unless the user explicitly changes direction.

- `Electron`, not `Tauri`, for the first beta build.
- macOS-first beta is acceptable.
- no full sign-in flow in MVP beta
- centralized model routing is required
- real provider keys should live on the user's backend, not in the desktop app
- the app should become workspace-first, not repo-tool-first
- the product shell should talk to OpenClaude via structured `stream-json` events, not terminal scraping or terminal embedding
- current shell can be used as a stepping stone, but the final UX target is much closer to Codex / ChatGPT than to a debug launcher

## 3. What Has Already Been Built

### 3.1 Browser app shell over OpenClaude backend

Implemented a working browser shell that is no longer just a button-based launcher:

- multi-session backend shell
- each session maps to a real OpenClaude child process
- session communication happens via `stream-json`
- chat transcript is rendered in the browser
- permission requests can be shown and responded to
- task panel still exposes build/doctor/tests

Key files:

- [scripts/app-launcher.mjs](/Users/tkanduev/Documents/GigaWork/openclaude/scripts/app-launcher.mjs)
- [launcher-ui/index.html](/Users/tkanduev/Documents/GigaWork/openclaude/launcher-ui/index.html)
- [launcher-ui/app.js](/Users/tkanduev/Documents/GigaWork/openclaude/launcher-ui/app.js)
- [launcher-ui/styles.css](/Users/tkanduev/Documents/GigaWork/openclaude/launcher-ui/styles.css)

What it does today:

- create backend sessions
- send multi-turn prompts into the same backend process
- receive streamed backend events
- keep transcript state in the runtime
- render pending permissions
- expose task controls

What it does **not** do yet:

- complete workspace-first UX polish
- polished Codex-like design
- backend model catalog
- desktop-native packaging UX

Important implementation detail:

- the shell is using real OpenClaude child processes in structured mode
- this is the right foundation for a Codex-like wrapper
- do **not** regress to terminal emulation unless there is a hard blocker

New progress since the first version of this handoff:

- current workspace can now be selected and persisted
- recent workspaces are stored locally
- new sessions inherit the selected workspace as their `cwd`
- session summaries now expose `workspacePath`
- the shell can no longer accidentally create a new session without a workspace selected
- the main session form now starts from a temporary model catalog instead of raw API-key-first UX
- direct provider fields now live in a secondary developer override surface
- gateway URL, beta token, and access code flow now exist in the UI
- the runtime can now exchange `POST /beta-access`, fetch `GET /models`, persist gateway config, and launch sessions using the saved beta token

### 3.2 Electron desktop scaffold

Added a first desktop shell scaffold:

- [desktop/main.mjs](/Users/tkanduev/Documents/GigaWork/openclaude/desktop/main.mjs)
- [desktop/preload.cjs](/Users/tkanduev/Documents/GigaWork/openclaude/desktop/preload.cjs)
- [electron-builder.yml](/Users/tkanduev/Documents/GigaWork/openclaude/electron-builder.yml)

Also updated:

- [package.json](/Users/tkanduev/Documents/GigaWork/openclaude/package.json)
- [bun.lock](/Users/tkanduev/Documents/GigaWork/openclaude/bun.lock)

Scripts added:

- `bun run desktop:dev`
- `bun run desktop:beta`
- `bun run desktop:pack`
- `bun run desktop:dist`

### 3.3 Electron-aware runtime changes

Updated [scripts/app-launcher.mjs](/Users/tkanduev/Documents/GigaWork/openclaude/scripts/app-launcher.mjs) so it is more likely to work from a packaged Electron app:

- runtime root can be overridden via `OPENCLAUDE_APP_ROOT`
- runtime binary can be overridden via `OPENCLAUDE_RUNTIME_BIN`
- child OpenClaude sessions can run via Electron with `ELECTRON_RUN_AS_NODE=1`
- packaging assumptions were moved away from hardcoded "repo script dir = app root"

This is important because packaged Electron apps cannot be treated exactly like a normal `node scripts/...` repo run.

### 3.4 Architecture document

Created:

- [desktop-beta-architecture.md](/Users/tkanduev/Documents/GigaWork/openclaude/docs/desktop-beta-architecture.md)
- [gateway-contract.md](/Users/tkanduev/Documents/GigaWork/openclaude/docs/gateway-contract.md)

This captures the intended product architecture:

- Electron shell
- local runtime manager
- OpenClaude child sessions
- future central model gateway
- beta auth model
- packaging path
- milestones

## 3.5 Working Status Board

This section is the fastest way for a new agent to understand where things stand.

### Track A: Local runtime / session engine

Status: `in progress`

Done:

- session creation
- multi-turn prompts against a persistent child process
- transcript accumulation
- raw event capture
- pending permission handling
- task runner endpoints
- session `cwd` now follows the selected workspace
- session summaries expose workspace metadata

Next:

- persist session metadata
- persist transcript/session restoration if desired for beta
- keep app-maintenance actions clearly separated from user-workspace actions

Definition of done for this track:

- a session can be created for any selected workspace
- prompts, permissions, and tool actions all operate inside that workspace

### Track B: Desktop shell

Status: `in progress`

Done:

- Electron `main` process exists
- preload bridge exists
- single-instance handling exists
- BrowserWindow loads the local runtime URL
- native folder picker IPC exists
- runtime data directory is now passed down from Electron
- renderer can now trigger workspace selection and persist it via the runtime

Next:

- move from raw browser shell behavior to desktop product behavior
- verify the workspace chooser inside a live Electron window
- improve first-launch empty state and onboarding around workspace selection

Definition of done for this track:

- installable app opens directly into the desktop shell and does not require manual local server startup

### Track C: Model gateway / centralized billing

Status: `adapter in progress`

Done:

- architecture decision is documented
- temporary local model catalog exists in the runtime
- renderer is now wired to a preset-driven session form
- direct provider fields are demoted to developer overrides
- persisted gateway config exists
- beta access code exchange exists
- remote model catalog fetch exists
- gateway preset sessions reuse the saved beta token as the OpenAI-compatible credential path

Next:

- define beta auth token shape
- connect the app to a real deployed gateway instead of mocked responses
- decide whether gateway tokens should stay in local JSON for beta or move to keychain next

Definition of done for this track:

- user chooses a model preset only
- desktop app never asks for a provider API key

### Track D: UI / design system

Status: `structure only`

Done:

- structural app shell exists
- official Codex / ChatGPT references were reviewed

Next:

- formalize design tokens
- redesign layout and states
- build component patterns for sidebar, thread, permission cards, and review states

Definition of done for this track:

- the shell feels like a product surface, not a developer panel

### Track E: Packaging / release

Status: `partially scaffolded`

Done:

- Electron scripts added
- `electron-builder.yml` added
- packaging assumptions adapted in runtime

Next:

- finish Electron binary install
- verify `desktop:dev`
- verify `desktop:pack`
- verify `desktop:dist`

Definition of done for this track:

- first installable `.app` / `.dmg` produced for beta

### Track F: QA / reliability

Status: `mixed`

Done:

- build passes
- runtime doctor passes
- syntax checks pass on new desktop files

Known red / unstable:

- repo-wide `typecheck`
- at least one Bun test around context sizing
- Python tests / version compatibility

Definition of done for this track:

- beta-critical runtime flows are green even if unrelated legacy checks remain noisy

## 4. Product Research Already Used

The design / product direction was grounded in official OpenAI materials:

- [Codex](https://openai.com/codex/)
- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [ChatGPT desktop](https://chatgpt.com/features/desktop)
- [Codex in ChatGPT help](https://help.openai.com/en/articles/11369540-codex-in-chatgpt)

What was extracted from those references:

- left rail for workspaces / sessions / tasks
- central thread as the primary productivity surface
- side panel for context, permissions, review, artifacts, and status
- calmer, more product-like visual language
- multi-agent / long-running task framing for Codex
- fast native desktop entry for ChatGPT

Important note:

The current app shell is still only a structural stepping stone. It is **not** yet at the visual or interaction quality the user wants.

## 5. What Has Been Verified

### 5.1 Runtime checks

Verified previously:

- `bun run build` passed
- `node dist/cli.mjs --version` passed
- `bun run doctor:runtime` passed
- `node --test --experimental-strip-types src/utils/providerRecommendation.test.ts src/utils/providerProfile.test.ts` passed

Known test failures from earlier review phase:

- `bun test ... src/utils/context.test.ts` had a failing expectation around DeepSeek context size
- `bun run typecheck` is very noisy / red across the repo
- Python tests had failures / environment issues

### 5.2 Current app shell verification

Verified the new shell behavior locally through HTTP calls:

- `GET /api/state` works
- session creation works
- backend initialization works
- multi-turn prompt flow works against the same OpenClaude process
- session deletion works
- transcript state is persisted in runtime memory

Important limitation of that verification:

- prompts were tested using a fake key (`sk-test`), so backend responses were 401s from OpenAI
- that still verified the transport, session persistence, and transcript flow end-to-end

### 5.3 Syntax checks

Confirmed:

- `node --check scripts/app-launcher.mjs`
- `node --check desktop/main.mjs`
- `node --check desktop/preload.cjs`

### 5.4 Electron tooling state

Confirmed:

- `electron-builder --help` works
- Electron and electron-builder dependencies are present in `node_modules`
- `bun.lock` includes them

Not yet confirmed:

- a successful `electron` launch
- a packaged `.app`

Why not yet:

- downloading the actual Electron binary runtime hung / stalled in this environment
- scaffold is committed, but runtime download needs to be completed later on a machine / run where it finishes cleanly

## 6. Current Gaps

These are the most important missing pieces.

### 6.1 Workspace-first product flow

This was the biggest product mismatch, and the first functional slice is now done.

What is now working:

- the app can store a current workspace
- recent workspaces persist locally
- new sessions launch inside the selected workspace
- Electron now passes a dedicated app data directory to the runtime

What is still incomplete:

- some maintenance actions still point at the product repo root by design
- the UX still looks like a transitional launcher, not a true workspace-first product shell
- first-launch onboarding is still too raw

### 6.2 Model catalog and gateway integration

Progress made:

- the primary session flow is now preset-driven
- raw API key / model / base URL fields were moved into a developer override section
- a temporary local catalog now stands in for the future backend catalog
- gateway settings and token exchange plumbing now exist in the app
- the expected backend contract is documented in [gateway-contract.md](/Users/tkanduev/Documents/GigaWork/openclaude/docs/gateway-contract.md)

Still missing:

- a real deployed gateway that serves the catalog
- centralized routing on the live backend
- a final decision on token storage hardening for beta

### 6.3 UI / design quality

The current browser shell is structurally useful but visually still transitional.

Needed next:

- proper design tokens
- real layout pass
- better typography
- cleaner chat state design
- better session rail
- artifact / review / permissions states that feel more like a product

### 6.4 Persistence

Current session state is in memory.

Now implemented:

- persistent recent workspaces

Still missing:

- persistent recent sessions metadata
- app settings storage
- possibly local SQLite or JSON store for the desktop app

### 6.5 Safe beta auth / access model

Since the user does not need full sign-in, beta can stay lightweight.

Still needed:

- some minimal client authorization to protect the centralized gateway
- e.g. invite code, static beta token, or device-issued session token

For 5-10 trusted testers, this can stay intentionally simple.

## 6.6 Explicitly Out Of Scope For The First Beta

These items should not delay the first installable beta unless the user changes priorities.

- full account system
- polished multi-user billing cabinet
- complex cloud agent infrastructure
- marketplace / skills browser UI
- Windows / Linux parity
- migration to Tauri
- perfect repo-wide `typecheck` cleanup if it is unrelated to beta-critical flows

## 7. Recommended Next Plan

This is the proposed execution order from here.

### Phase 1: Make the shell product-correct

Goal: stop behaving like a repo tool and start behaving like a user app.

Status: `partially complete`

Completed:

1. Add explicit workspace selection flow in Electron.
2. Separate:
   - app root
   - workspace root
   - app data root
3. Store recent workspaces.
4. Make each session run with selected workspace as `cwd`.

Still needed:

5. Move repo-maintenance controls behind a dev-only or secondary surface.
6. Improve first-launch workspace onboarding and copy.

Deliverable:

- app opens
- user chooses a workspace
- session runs inside that chosen codebase

### Phase 2: Replace raw API-key UX with backend model catalog

Goal: match the user's centralized billing model.

Status: `started`

Completed:

1. Remove API-key-first UX from the app shell.
2. UI shows model choices / presets through a temporary local catalog.
3. Gateway URL + beta token/access code flow now exists in the shell.
4. Runtime can now fetch a real remote catalog if the gateway implements the expected contract.

Still needed:

5. Point the app at a real deployed gateway.
6. Runtime uses the gateway base URL and whatever lightweight access token is chosen for beta.
7. Backend handles real provider key selection and billing.

Suggested backend contract:

- `GET /models`
- `POST /session-token` or `POST /beta-access`
- OpenAI-compatible routed inference endpoint

Deliverable:

- user sees model presets only
- no real provider keys in app UI

### Phase 3: Real design-system pass

Goal: make the app feel closer to Codex / ChatGPT quality.

Tasks:

1. Build design tokens:
   - colors
   - type scale
   - radii
   - spacing
   - motion
   - semantic statuses
2. Rework shell layout:
   - left rail
   - central thread
   - right utility panel
3. Add proper states:
   - first launch
   - no workspace
   - session idle
   - streaming
   - permission needed
   - error
   - offline / backend unavailable

Deliverable:

- visually coherent shell
- stable product-grade information hierarchy

### Phase 4: Desktop packaging

Goal: installable beta app.

Tasks:

1. Finish Electron binary install.
2. Verify `desktop:dev`.
3. Verify `desktop:pack`.
4. Verify `desktop:dist`.
5. Produce first `.app` / `.dmg`.

Since this is a tiny closed beta:

- can start without full sign/notarization if the user accepts rough install UX
- later add signing/notarization if desired

Deliverable:

- installable macOS beta build

## 7.1 Immediate Execution Order

This is the exact order I would continue in on the next implementation pass.

1. Connect the app to a real deployed gateway that implements the documented contract.
2. Improve first-launch workspace onboarding and cleanly separate workspace actions from repo-maintenance actions.
3. Rebuild the shell layout and component styling around a cleaner design system.
4. Finish desktop boot verification and produce the first packaged beta build.

Reason for this order:

- workspace correctness is now good enough for the next slice
- gateway integration should happen before heavy UI polish, or the UX will be redesigned twice
- packaging should validate the actual product shape, not an intermediate developer tool

## 7.2 First Concrete Build Slice

If only one vertical slice can be done next, it should be this:

1. User opens desktop app.
2. User connects a beta gateway.
3. App exchanges an access code or saves a beta token.
4. App fetches the remote model catalog.
5. User picks a workspace folder.
6. User creates a session against that workspace.
7. App launches a real OpenClaude session through the gateway preset.

If that slice works, the product stops being "a cool demo shell" and starts being a real beta candidate.

## 8. Recommended Immediate Task for the Next Agent / Turn

If continuing from this handoff, the next best step is:

### Recommended next implementation target

Connect the desktop shell to a real deployed gateway implementation.

Concretely:

1. Implement the backend side of [gateway-contract.md](/Users/tkanduev/Documents/GigaWork/openclaude/docs/gateway-contract.md).
2. Point the app at the live gateway and validate the full flow with real responses.
3. Decide whether to keep beta tokens in local JSON for the first beta or move them to keychain immediately.
4. Keep the existing direct key fields only in a secondary dev/debug path if needed.

Why this is first:

- the first workspace-first slice is already implemented
- the preset-driven adapter layer is already in place
- centralized billing is the next big product requirement from the user
- the desktop side of that routing contract now exists, so the next blocker is the real backend integration
- packaging before this risks freezing the wrong product shape

## 8.1 Risks And Watchouts

These are the easiest ways to accidentally lose momentum.

- confusing `appRoot` with user workspace root
- hardcoding OpenClaude repo paths into user-facing session flows
- polishing the current launcher UI before the gateway and workspace model are correct
- spending too much time on repo-wide cleanup that does not affect the beta surface
- embedding real vendor API keys into the client instead of routing through the backend
- treating the Electron packaging scaffold as proof that the desktop app is already product-complete

## 9. Important Files To Read First

If context is compressed, read these first in order:

1. [context-handoff.md](/Users/tkanduev/Documents/GigaWork/openclaude/docs/context-handoff.md)
2. [desktop-beta-architecture.md](/Users/tkanduev/Documents/GigaWork/openclaude/docs/desktop-beta-architecture.md)
3. [gateway-contract.md](/Users/tkanduev/Documents/GigaWork/openclaude/docs/gateway-contract.md)
4. [app-launcher.mjs](/Users/tkanduev/Documents/GigaWork/openclaude/scripts/app-launcher.mjs)
5. [main.mjs](/Users/tkanduev/Documents/GigaWork/openclaude/desktop/main.mjs)
6. [index.html](/Users/tkanduev/Documents/GigaWork/openclaude/launcher-ui/index.html)
7. [app.js](/Users/tkanduev/Documents/GigaWork/openclaude/launcher-ui/app.js)
8. [styles.css](/Users/tkanduev/Documents/GigaWork/openclaude/launcher-ui/styles.css)
9. [package.json](/Users/tkanduev/Documents/GigaWork/openclaude/package.json)
10. [electron-builder.yml](/Users/tkanduev/Documents/GigaWork/openclaude/electron-builder.yml)

## 10. Current Git / File State

Current modified / added work includes:

- [bun.lock](/Users/tkanduev/Documents/GigaWork/openclaude/bun.lock)
- [package.json](/Users/tkanduev/Documents/GigaWork/openclaude/package.json)
- [scripts/app-launcher.mjs](/Users/tkanduev/Documents/GigaWork/openclaude/scripts/app-launcher.mjs)
- [launcher-ui/index.html](/Users/tkanduev/Documents/GigaWork/openclaude/launcher-ui/index.html)
- [launcher-ui/app.js](/Users/tkanduev/Documents/GigaWork/openclaude/launcher-ui/app.js)
- [launcher-ui/styles.css](/Users/tkanduev/Documents/GigaWork/openclaude/launcher-ui/styles.css)
- [desktop/main.mjs](/Users/tkanduev/Documents/GigaWork/openclaude/desktop/main.mjs)
- [desktop/preload.cjs](/Users/tkanduev/Documents/GigaWork/openclaude/desktop/preload.cjs)
- [electron-builder.yml](/Users/tkanduev/Documents/GigaWork/openclaude/electron-builder.yml)
- [desktop-beta-architecture.md](/Users/tkanduev/Documents/GigaWork/openclaude/docs/desktop-beta-architecture.md)
- [gateway-contract.md](/Users/tkanduev/Documents/GigaWork/openclaude/docs/gateway-contract.md)
- [context-handoff.md](/Users/tkanduev/Documents/GigaWork/openclaude/docs/context-handoff.md)

Unrelated / local environment note:

- `.venv/` is present and untracked; it is environment setup, not part of product code

## 11. Commands Likely Needed Next

Useful commands:

```bash
bun run build
```

```bash
bun run launcher
```

```bash
bun run desktop:dev
```

```bash
bun run desktop:pack
```

```bash
bun run desktop:dist
```

If Electron runtime is still missing:

```bash
node node_modules/electron/install.js
```

## 12. Final State Summary

The project has moved from:

- "connect GitHub repo"
- to "review the codebase"
- to "build a simple launcher"
- to "build a live browser shell over OpenClaude sessions"
- to "start the Electron desktop scaffold and architecture for a closed beta product"

The right next move is **not** "more launcher polish".

The right next move is:

- wire it to the user's central model gateway
- then do the proper Codex/ChatGPT-grade design pass
- then package the beta app

## 13. One-Paragraph Restart Prompt

If context is compressed and a new agent needs a fast restart, use this summary:

"We are turning OpenClaude into a macOS-first Electron desktop beta for 5-10 testers. The repo already contains a working browser shell over real OpenClaude `stream-json` child sessions, plus an Electron scaffold and packaging config. A first workspace-first slice is already implemented, and the desktop side of the gateway adapter now exists: gateway config persists, `beta-access` exchange works, remote `/models` catalogs are supported, and gateway presets launch with the saved beta token. The next priority is to connect this to a real deployed gateway, then redesign the shell to feel closer to Codex / ChatGPT, and only then finish packaging the first installable beta build."
