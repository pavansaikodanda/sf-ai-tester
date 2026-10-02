# SF AI Tester

A VS Code extension (and CLI) for testing Salesforce orgs with AI. You give it org credentials and test
cases in YAML. Claude runs through **your Claude Code login (Pro/Max subscription)** and drives a real
browser with **Playwright MCP**, in two modes:

| Mode | What the AI does |
|---|---|
| **manual** | Executes each step in a live browser like a manual tester, checks every expected result, reports defects, takes screenshots |
| **automation** | Explores the UI, writes a Playwright spec to `tests/sf-ai/<id>.spec.ts`, runs it and fixes it until it passes. The tester then **re-runs the spec independently**, so an AI "passed" is backed by a real green run |
| **both** | Manual first, then automation |

## How it works

```
YAML test cases ─► Runner ─► Login once (Playwright, in code) ─► storageState.json (session cookies)
                              │
                              └─► per test case: Claude Agent SDK query()
                                     ├─ auth: your `claude` login (ANTHROPIC_API_KEY is ignored)
                                     ├─ tools: Playwright MCP (browser pre-logged-in via storageState)
                                     ├─ automation only: write tests/sf-ai/*.spec.ts, run `npx playwright test`
                                     └─ returns a JSON verdict (schema-enforced) ─► results.json + report.html
```

* **Your password never reaches the model.** The code logs in and the agent only gets a logged-in browser
  session. Generated specs use `storageState` and don't contain credentials.
* **Tools are locked down.** Manual mode can only use the browser. Automation mode can also write
  `*.spec.ts` files under `tests/sf-ai/` and run `npx playwright test ...`, and every other tool call is
  denied (see `canUseTool` in `src/core/agent.ts`).
* Session cookies and run output go to `.sf-ai-tester/`, which is git-ignored automatically.

## Setup

Prerequisites: Node 20+, and Claude Code logged in with your subscription (`claude` → `/login`).

```bash
npm install
npm run setup      # installs the browsers for Playwright and Playwright MCP
npm run build
```

Open this folder in VS Code and press **F5** to launch a development window with the extension loaded.
(`npm run package` builds a `.vsix` you can install permanently.)

### Mission Control

Click the **SF AI Tester** icon in the activity bar (or **$(rocket) SF AI Tester** in the status bar, or run
**SF AI Tester: Open Mission Control**) to open the console:

| Panel | What you do there |
|---|---|
| **01 Org Uplink** | Add orgs (user + password, passkey/SSO, or `sf` CLI alias) and **Establish Uplink** to log in and verify your passkey |
| **02 Mission Parameters** | Primary and fallback model, login window mode, and max agent turns |
| **03 Test Matrix** | Suites, **Generate with AI**, create/edit/delete cases. Each case has a **Manual** and an **Automation** status pod. Click a pod to run it, or select cases and run Manual / Auto / Both |
| **04 Telemetry** | Pass rate, run progress, and per-mode status bars |
| **05 Live Feed** | The agent's actions as they happen |

The **Visible / Headless** switch in the header controls the test browser. Test cases are stored as YAML in
`test-cases/`, so you can also edit them by hand or keep them in git.

### Export report
Click **EXPORT REPORT** in the Test Matrix (or run `node dist/cli.js export` in your data folder) to download a summary of
all suites ("sheets") or just the current one:

- **Excel workbook (.xlsx):** a *Summary* sheet (manual and automation passed / failed / blocked / error / not run and pass
  rates per suite, plus totals), one sheet per suite, a *Failure Analysis* sheet (what was tried step by step with what the AI
  observed, expected results, the model attempt chain, the agent action log, defects and evidence) and a *Defects* register.
- **PDF document:** an overview, results by suite, and a documented write-up for every run that did not pass, optionally with
  embedded screenshots.

Every run records the agent's action trail (browser actions, commands and reasoning notes), so even a run that errors out
before reaching a verdict documents what it tried.

### Salesforce or plain web: the suite target
Not every test is about Salesforce. Click **TARGET** in the Test Matrix (or set `target` / `baseUrl` in the YAML):

| Target | Behaviour |
|---|---|
| **Auto** (default) | Per case: **WEB** when its steps/preconditions open a non-Salesforce URL (e.g. `http://localhost:8080`) or the suite base URL is not Salesforce; otherwise **SF**. |
| **Salesforce** | Every case runs against the connected org (logged in automatically), with org metadata. |
| **Web app** | No Salesforce login, no org metadata, generic web-QA instructions; the agent starts from the base URL or the URL in step 1. |

```yaml
name: Website agent
target: web
baseUrl: http://localhost:8080/conscendoIndex.html
cases:
  - id: CWA-001
    target: salesforce   # optional per-case override
```

Each case shows a **WEB** or **SF** badge. A run with no Salesforce cases never logs in to the org. For every target the
agent is told to follow the steps literally and in order and not to navigate anywhere a step does not say.

### Faster runs, smarter AI
Where the AI is used - and where it is not (all in **Mission Parameters**):

| Feature | What it does |
|---|---|
| **Replay passing specs** (`sfAiTester.replaySpecs`, on) | An automation case that already has a passing generated spec re-runs it with plain Playwright - seconds, no AI. Only if the spec fails does the AI step in, to **self-heal** the script (locator/timing changes) or confirm a real defect. |
| **Parallel workers** (`sfAiTester.workers`, 2) | Runs up to 4 case chains at once, each with its own browser and agent. Cases that share opening steps stay on one worker so carry-over still works. |
| **Org-aware AI** (`sfAiTester.orgAware`, on) | Reads the objects a case or requirement mentions through the sf CLI - required fields, real picklist values, active validation rules - and gives them to the agent and to *Generate with AI* (which then adds a negative test per validation rule). Cached 24h; never blocks a run (60s budget). |
| **AI run analyst** (`sfAiTester.analyzeRuns`, on) | After a run with failures, one AI pass groups them by root cause (app defect / environment / test design / flaky / tooling) with a next step for each. Shown at the top of the Test Matrix and in exported reports. |

Agent sessions also load their browser tools up front and keep screenshots out of the model context (saved to disk
as evidence), which removes a wasted turn and a lot of tokens from every case.

### Bulk runs: continue instead of restarting
**Mission Parameters → Between test cases** (`sfAiTester.continuity`):

- **Continue** (default): one browser stays open for the whole run - no closing, reopening or logging in between
  cases. Each case starts on the page the previous one ended. When a case starts with the **same steps** as the
  previous manual case (e.g. both begin "open the site → open the chat"), it continues that agent session, confirms
  the page is still in that state, and goes straight to the first new step; skipped steps are reported as
  "Carried over from <case>". Chains restart after 5 cases so a conversation never grows without bound. Generated
  automation specs always stay self-contained.
- **Fresh**: a clean browser and session for every case, for fully independent tests (CLI: `--fresh`).

### Themes
Switch themes with **NEON / FLIGHT / STOIC** in the console header (or the `sfAiTester.theme` setting):

| Theme | Look |
|---|---|
| **Neon** (default) | Sci-fi mission control: dark space, cyan and violet glow, particle field |
| **Flight** | Fighter-cockpit HUD: 3D wireframe terrain (afterburner during runs), pitch ladder and speed/altitude/heading tapes that follow your mouse, attitude indicator, target-lock reticle on hover, avionics boot sequence, master-caution flash on failures |
| **Stoic** | Minimal: parchment, ink and bronze, Cormorant Garamond and IBM Plex, a daily Stoic quote, no glow or motion |

### Model escalation
Every case runs on **Haiku 4.5** first. If a run doesn't pass (agent error, unstable script or a reported
failure), it's automatically re-run on **Sonnet 5.5**. Flaky runs get a retry, and a defect is only reported once
the stronger model confirms it. The escalation is a handover, not a restart: the fallback model resumes the same agent session (it sees every step the first model took and what it observed) and continues in the same browser, on the page the first model stopped on, re-verifying anything that did not pass. The pod shows which model produced the verdict. Change the models in Mission
Parameters (`sfAiTester.primaryModel` / `sfAiTester.fallbackModel`).

### Settings
| Setting | Default | |
|---|---|---|
| `sfAiTester.headless` | `false` | Test-execution browser headless (status bar toggle) |
| `sfAiTester.login.browserMode` | `headed` | Login window: `headed` (visible, so you verify the passkey) / `auto` / `headless` |
| `sfAiTester.login.browser` | `default` | `default` (Edge on Windows) / `msedge` / `chrome` / `chromium` |
| `sfAiTester.login.timeoutMinutes` | `5` | Time allowed to finish a passkey/MFA login |
| `sfAiTester.login.sessionMaxAgeHours` | `8` | How long a saved session is reused |
| `sfAiTester.primaryModel` | `claude-haiku-4-5` | Runs every case first |
| `sfAiTester.fallbackModel` | `claude-sonnet-5-5` | Re-runs anything that didn't pass |
| `sfAiTester.maxTurns` | `80` | Maximum agent turns per test case |
| `sfAiTester.theme` | `neon` | `neon` / `flight` / `stoic` |
| `sfAiTester.useSubscription` | `true` | Ignore `ANTHROPIC_API_KEY` and use the Claude Code login |

## Test case format

```yaml
name: Sales Cloud smoke
context: Standard Sales Cloud org, test user is System Administrator.
cases:
  - id: ACC-001                # letters, digits, _ and -; also used as the spec file name
    title: Create a new Account
    preconditions: [User can create Accounts]
    steps:
      - Open the Accounts tab
      - Click New, enter Account Name "AI-TEST Acme" and Phone "0123456789", Save
    expected:
      - A success toast confirms the Account was created
      - The detail page shows the entered name and phone
    mode: both                 # optional per-case override
    data: { industry: Banking } # optional test data
```

Statuses: **passed**, **failed** (the app behaved differently from the expected result), **blocked**
(an environment problem such as a missing permission or missing data), **error** (the agent or tooling
failed).

## CLI / CI

```bash
# password auth
SF_LOGIN_URL=https://test.salesforce.com SF_USERNAME=... SF_PASSWORD=... \
  node dist/cli.js run test-cases/sample.sf-tests.yaml --mode both --models claude-haiku-4-5,claude-sonnet-5-5
# or sf CLI auth
SF_ALIAS=my-uat node dist/cli.js run test-cases/sample.sf-tests.yaml --headed

# run the generated specs yourself, without AI:
node dist/cli.js auth            # prints SF_INSTANCE_URL / SF_STORAGE_STATE to export
npx playwright test --config playwright.sf-ai.config.ts
```
The exit code is non-zero if any case isn't `passed`.

## Salesforce DX projects: no login needed

Open VS Code on a Salesforce DX project (a folder with `sfdx-project.json`). As soon as VS Code starts (no need to open the console), the tester reads the
project's default org (`.sf/config.json` → `target-org`, then the legacy `.sfdx/sfdx-config.json`, then your global
`sf` default), checks it with `sf org display`, and if it is connected:

- adds it as an **sf CLI** org marked **PROJECT** and makes it the active org (shown in the status bar and sidebar)
- follows changes automatically: switch the default org (`sf config set target-org`, or the Salesforce extension org picker) and the tester switches with it
- logs in through the CLI's token (`sf org open --url-only`) in the background: no password, no login form

If the project org isn't connected, the header shows **SFDX · … NOT CONNECTED** with the command to fix it
(`sf org login web --alias <org>`) and a **RECHECK** button. In the org form, **SF CLI → LOAD CONNECTED ORGS** lists every
org the CLI knows about so you can pick one instead of typing it.

Notes:
- Salesforce's optional "Add a passkey / phone number" prompts are skipped automatically. If an org **enforces** passkey
  registration, Salesforce requires it even for CLI logins: a window opens once for you to verify, and the saved session
  is reused afterwards.
- CLI access tokens and frontdoor URLs are never logged or written anywhere except the browser session file in
  `.sf-ai-tester/auth/` (git-ignored).

## Passkeys, MFA and SSO

Salesforce's login page now asks for the username first and then shows a password field, or a **passkey** prompt
for users who have enrolled one. The tester handles this in three ways:

| Org auth type | Passkey behaviour |
|---|---|
| **Username & password** | A visible browser opens, the username and password are typed for you, and **you verify the passkey** (or MFA) in that window |
| **Interactive (passkey / SSO / MFA)** | Always opens a visible browser with the username filled in. You log in however your org requires |
| **sf CLI alias** | No passkey prompts at all. The session comes from `sf org login web` tokens. This is the best choice for CI |

* A wrong password fails right away (in about 3 seconds) with Salesforce's own error message, instead of waiting for the timeout.
* After a successful login the session is **saved and reused** (up to `login.sessionMaxAgeHours`, default 8h,
  and checked before every run), so you only need a passkey when the session expires.
* The login browser keeps a persistent profile, so Salesforce's "remember this browser" also persists.
* The login uses your installed **Edge** on Windows (Chrome elsewhere), because branded browsers work best with
  Windows Hello, security keys and phone passkeys. You can change this with `sfAiTester.login.browser`.
* **SF AI Tester: Log In to Org (passkey / MFA)** does a visible login up front, before a run.

### Browser visibility controls
Click **SF Tester: Visible/Headless** in the status bar, or run **SF AI Tester: Browser Settings**:

* **Test execution (headless true/false):** asked at the start of every run, with your last choice first. You can also flip it from the status bar
* **Login:** `visible` (default: credentials are typed and you verify the passkey), `auto` (hidden first, for orgs without passkeys), or `always headless`

CLI equivalents: `--headed` (test browser), `--login auto|headed|headless`, `--login-browser msedge|chrome|chromium`,
and `SF_INTERACTIVE=1` for interactive auth.

## Notes
* **Subscription use:** running the Agent SDK on your own Claude Code login is fine for personal/team use on
  your machine. If you ever distribute this as a product to other users, Anthropic requires API-key
  authentication instead: set `useSubscription` to `false` and supply `ANTHROPIC_API_KEY`.
* The cost shown in reports is the SDK's API-equivalent estimate. On a subscription, runs count against
  your plan's usage limits instead.
