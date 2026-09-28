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

In the window that opens, open the folder where your tests will live, then use the Command Palette:

1. **SF AI Tester: Initialize Test Project**: creates `test-cases/sample.sf-tests.yaml` and installs `@playwright/test`
2. **SF AI Tester: Configure Org**: username/password (stored in VS Code SecretStorage), interactive (passkey/SSO), or an `sf` CLI alias
3. **SF AI Tester: Run Test Cases**: pick the suite, the cases and the mode. You can also right-click a YAML file.

The live log is in the *SF AI Tester* output panel. The HTML report (steps, observations, defects,
screenshots) opens when the run finishes.

### Settings
| Setting | Default | |
|---|---|---|
| `sfAiTester.headless` | `false` | Test-execution browser headless (status bar toggle) |
| `sfAiTester.login.browserMode` | `headed` | Login window: `headed` (visible, so you verify the passkey) / `auto` / `headless` |
| `sfAiTester.login.browser` | `default` | `default` (Edge on Windows) / `msedge` / `chrome` / `chromium` |
| `sfAiTester.login.timeoutMinutes` | `5` | Time allowed to finish a passkey/MFA login |
| `sfAiTester.login.sessionMaxAgeHours` | `8` | How long a saved session is reused |
| `sfAiTester.model` | `""` | Empty means your Claude Code default. Examples: `claude-opus-5`, `claude-sonnet-5` |
| `sfAiTester.maxTurns` | `80` | Maximum agent turns per test case |
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
  node dist/cli.js run test-cases/sample.sf-tests.yaml --mode both
# or sf CLI auth
SF_ALIAS=my-uat node dist/cli.js run test-cases/sample.sf-tests.yaml --headed

# run the generated specs yourself, without AI:
node dist/cli.js auth            # prints SF_INSTANCE_URL / SF_STORAGE_STATE to export
npx playwright test --config playwright.sf-ai.config.ts
```
The exit code is non-zero if any case isn't `passed`.

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
