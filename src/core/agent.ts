import * as fs from "fs";
import * as path from "path";
import type { CanUseTool, McpServerConfig, Options, SDKMessage, WarmQuery } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { AgentVerdict, CaseResult, TestCase, TestSuite } from "./types";
import { AuthSession } from "./auth";
import { Target } from "./target";

export interface AgentContext {
  suite: TestSuite;
  auth: AuthSession;
  workspaceDir: string;
  /** Directory the extension/CLI is installed in (holds node_modules/@playwright/mcp) */
  toolRoot: string;
  evidenceDir: string;
  headless: boolean;
  model?: string;
  maxTurns: number;
  useSubscription: boolean;
  abort: AbortController;
  log: (m: string) => void;
  /** Runner-owned browser for this case (shared across model attempts) */
  cdpEndpoint?: string;
  /** Continue a previous model attempt: same conversation (and, with cdpEndpoint, the same browser page) */
  resume?: { sessionId: string; model: string; status: string; summary: string };
  /** Bulk runs: this case shares its first steps with the previous case, whose session (and page) it picks up */
  carryOver?: { fromCase: string; sharedSteps: number; prevStatus: string };
  /** Bulk runs: the browser is still open from this earlier case (fresh session, same browser) */
  browserContinues?: string;
  /** Automation: a previously passing spec failed on replay - heal it or confirm a defect */
  replayFailure?: { specFile: string; output: string };
  /** Org metadata relevant to this case (from the sf CLI) */
  orgContext?: string;
  /** What this case runs against (see resolveTarget) */
  target?: Target;
  /** Starting URL for web cases */
  baseUrl?: string;
  /** Agent process pre-started with these same options (see prewarmAgent) */
  warm?: Promise<WarmQuery | undefined>;
  /** Manual re-run: the steps were just replayed from a recording - only judge the expected results */
  verifyReplay?: { actions: number; seconds: number };
}

export const SPEC_DIR = "tests/sf-ai";
export const PW_CONFIG = "playwright.sf-ai.config.ts";
/** A Salesforce spec run often takes over a minute; a shorter tool timeout moves it to the background and the
 *  agent then burns turns polling for its output. */
const RUN_NOTE = "(exactly this command - nothing chained or redirected - with the shell tool's timeout set to 300000 so it runs in the foreground)";

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "steps", "defects", "evidence"],
  properties: {
    status: { enum: ["passed", "failed", "blocked", "error"] },
    summary: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "status", "actual"],
        properties: {
          step: { type: "string" },
          status: { enum: ["passed", "failed", "blocked", "error"] },
          actual: { type: "string" },
        },
      },
    },
    defects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "severity", "details"],
        properties: {
          title: { type: "string" },
          severity: { enum: ["critical", "major", "minor", "trivial"] },
          details: { type: "string" },
        },
      },
    },
    evidence: { type: "array", items: { type: "string" } },
    specFile: { type: "string" },
  },
};

/** Role + target-specific guidance; shared rules follow. */
function systemAppend(target: Target): string {
  return (target === "web" ? WEB_INTRO : SALESFORCE_INTRO) + SHARED_RULES;
}

const WEB_INTRO = `
You are a senior QA engineer testing a web application (NOT Salesforce) through a real browser using the
Playwright MCP tools (mcp__playwright__*). Do NOT open Salesforce or any org - go only where the test steps say.
Start at the URL in the first step (or the base URL given in the test case) and follow the steps from there.

Web UI guidance:
- Chat widgets / agents (e.g. Agentforce, Embedded Messaging, any AI assistant) stream their replies and can be
  longer than the visible panel. Wait until the reply has finished (browser_wait_for a few seconds, then check the text stopped
  changing), and read the COMPLETE reply text before judging it - a snapshot scoped to the chat panel shows it all,
  including content inside an iframe. Use fullPage screenshots for evidence.
- Do not log in, sign up or submit real data unless a step tells you to.
`;

const SALESFORCE_INTRO = `
You are a senior Salesforce QA engineer. You test Salesforce Lightning Experience orgs through a real browser
using the Playwright MCP tools (mcp__playwright__*). The browser is ALREADY LOGGED IN to the org - never try to
log in, log out, change passwords or view credentials.

Salesforce UI guidance:
- Lightning pages load asynchronously: after navigation or a save, browser_wait_for the text you expect next
  (a heading, button or toast) before acting, instead of snapshotting repeatedly.
- Prefer direct URLs where possible: <instance>/lightning/o/<Object>/list, /lightning/o/<Object>/new,
  /lightning/r/<Object>/<Id>/view, /lightning/setup/SetupOneHome/home. "Open the <Object> tab" means: navigate to
  <instance>/lightning/o/<Object API name>/list (e.g. Account, Lead, Opportunity) - that IS following the step; do
  not click through the app launcher or navigation menu unless the step is about them.
- Toast messages confirm saves and show errors - read them.
- Chat widgets / agents (e.g. Agentforce, Embedded Messaging) stream their replies and can be longer than the
  visible panel. Wait until the reply has finished (browser_wait_for a few seconds, then check the text stopped
  changing), and read the COMPLETE reply text before judging it - a snapshot scoped to the chat panel shows it all,
  including content inside an iframe. Use fullPage screenshots for evidence.
- Lookups need typing then picking an option from the dropdown; picklists are comboboxes.
`;

const SHARED_RULES = `
Speed - every tool call is a round trip, so use as few as the steps allow:
- Actions do NOT return a page snapshot. When a step names the element ("click New", "enter X in First Name"), act on it
  directly with a locator as the target - no snapshot first. Snapshot only when you do not know the element, an
  action fails, or you must read the page to judge an expected result.
- "target" takes exactly one of: a ref copied from the latest snapshot as-is (e.g. e698 - no brackets, no "ref="), or
  a Playwright locator: getByRole('button', { name: 'New' }), getByRole('textbox', { name: 'First Name' }),
  getByRole('option', { name: 'All Open Leads' }), getByLabel('Company'), getByText('Saved'). Never CSS or :has-text.
  After a failed target, take a snapshot and use its ref instead of guessing another selector.
- A locator target is looked up once, without waiting: if it "does not match any elements" because the page is
  still loading, browser_wait_for its text and retry once before snapshotting.
- Prefer browser_find (search the page for text) over a full browser_snapshot when you only need one element, and
  scope snapshots with "target" (e.g. the dialog, form or chat panel) - Salesforce pages are very large.
- Fill several fields of one form in a single browser_fill_form call.
- Wait with browser_wait_for (text to appear/disappear) - never by repeating snapshots.
- Once a snapshot or find has shown an expected result, it is verified: do not check it again another way.

Rules:
- Follow the test steps LITERALLY and IN ORDER. Do not add steps, skip steps, or navigate anywhere a step does not
  say. If a step is impossible as written, mark it "blocked" and explain - do not improvise a different route.
- Only create/modify data the test case asks for. Prefix any records you create with "AI-TEST" when the test
  lets you choose a name.
- Judge every expected result strictly against what you actually observed. If a step cannot be performed
  because of the environment (missing permission, missing data, page not found) mark it "blocked", not
  "failed". Use "failed" only when the application behaves differently from the expected result.
- Screenshots (browser_take_screenshot): one when the final expected result is on screen, and one at every
  failure - not after every step. List the saved file names in "evidence".
- Raise a defect for every genuine application failure, with reproduction details. Judge what the page shows the
  user: browser console messages and network errors (Salesforce logs many harmless ones; resource errors come from
  the test browser) are not defects and not a reason to fail - only look at them when a step or expected result is
  about errors.`;

function caseBrief(tc: TestCase, ctx: AgentContext): string {
  const lines = [
    ctx.target === "web"
      ? `Target: web application (not Salesforce).${ctx.baseUrl ? ` Base URL: ${ctx.baseUrl}` : " Start from the URL in the steps."}`
      : `Salesforce org instance URL: ${ctx.auth.instanceUrl}`,
    ctx.suite.context ? `Suite context: ${ctx.suite.context}` : "",
    `Test case ${tc.id}: ${tc.title}`,
    tc.description ? `Description: ${tc.description}` : "",
    tc.preconditions?.length ? `Preconditions:\n${tc.preconditions.map((p) => `- ${p}`).join("\n")}` : "",
    `Steps:\n${tc.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    `Expected results:\n${tc.expected.map((e) => `- ${e}`).join("\n")}`,
    tc.data ? `Test data (JSON): ${JSON.stringify(tc.data)}` : "",
    ctx.orgContext
      ? `Org metadata for the objects in this test (from the live org - use the exact labels, required fields,
picklist values and validation-rule messages below when acting and when checking expected results):\n${ctx.orgContext}`
      : "",
    `Save every screenshot with an absolute filename inside ${ctx.evidenceDir.replace(/\\/g, "/")}/ ` +
      `(e.g. ${ctx.evidenceDir.replace(/\\/g, "/")}/${tc.id}-step1.png).`,
  ];
  return lines.filter(Boolean).join("\n\n");
}

/** Fresh session on a browser that is still open from the previous case in a bulk run. */
function browserNote(mode: "manual" | "automation", ctx: AgentContext): string {
  if (!ctx.browserContinues) return "";
  return `

BROWSER STATE: the browser is still open (and logged in) from the previous test case ${ctx.browserContinues}. Do not
log in again. Start from wherever it is: if the current page is already the starting point this test needs, use it;
otherwise navigate.${mode === "automation" ? " The spec you write must still be self-contained (it navigates from scratch)." : ""}`;
}

/**
 * Bulk runs: the next case starts with the same steps as the previous one, which were just performed in this
 * session and browser - continue after them instead of repeating them.
 */
function continuationPrompt(tc: TestCase, ctx: AgentContext): string {
  const { fromCase, sharedSteps } = ctx.carryOver!;
  const range = sharedSteps === 1 ? "Step 1 is" : `Steps 1-${sharedSteps} are`;
  return `NEXT TEST CASE (new verdict, separate from ${fromCase}).

${caseBrief(tc, ctx)}

${range} identical to test case ${fromCase} and were already performed in this browser during this conversation.
Do not repeat them: take one snapshot to confirm the page is still in the state those steps produced, then continue
from step ${sharedSteps + 1}. If the page is not in that state (e.g. it navigated away or a dialog closed), redo only
what is needed to get back there.

Verify every expected result of THIS test case against what you observe now. Report all steps in "steps": for the
carried-over ones use the outcome from ${fromCase} and start "actual" with "Carried over from ${fromCase}: ".
Return the verdict in the required JSON format.`;
}

function manualPrompt(tc: TestCase, ctx: AgentContext): string {
  return `${caseBrief(tc, ctx)}

TASK (manual/exploratory execution): Execute this test case yourself in the browser, step by step, exactly as a
manual tester would. For each step record what you actually observed. Then verify every expected result.
While doing so, note anything a user would see is wrong (error messages, broken layouts, wrong labels) and report it
as a defect even if it is outside the expected results. Return your verdict in the required JSON format with one
entry in "steps" per numbered step.`;
}

function automationPrompt(tc: TestCase, ctx: AgentContext): string {
  const spec = `${SPEC_DIR}/${tc.id}.spec.ts`;
  if (ctx.replayFailure) {
    // Self-healing: the spec used to pass and was replayed without AI; it now fails.
    return `${caseBrief(tc, ctx)}

TASK (self-heal automation): "${ctx.replayFailure.specFile}" passed before and was just replayed with plain Playwright,
but it now FAILS. Last part of the Playwright output:
"""
${ctx.replayFailure.output.slice(-3500)}
"""

Decide which it is:
- The SCRIPT broke (a locator, label, timing or page structure changed while the app still meets the expected
  results): read the spec, inspect the page with the Playwright MCP browser, make the smallest fix that restores it,
  and re-run ${RUN_NOTE}: npx playwright test --config ${PW_CONFIG} ${ctx.replayFailure.specFile}
- The APPLICATION no longer meets an expected result: do not change the assertions to hide it - report "failed"
  with a defect describing what changed.
Never weaken assertions to make it pass. Return your verdict in the required JSON format with "specFile" set to
"${ctx.replayFailure.specFile}"; in "summary" say whether you healed the script (and what changed) or found a defect.`;
  }
  return `${caseBrief(tc, ctx)}

TASK (test automation): Write a robust, reusable Playwright Test spec for this test case at "${spec}".

Process:
1. Use the Playwright MCP browser to walk through the flow and discover reliable locators
   (prefer getByRole / getByLabel / getByText; avoid auto-generated ids like "input-123" and deep CSS).
2. Write the spec with the Write tool (if the file already exists, Read it first). Requirements:
   - import { test, expect } from '@playwright/test';
   - One test() titled "${tc.id}: ${tc.title.replace(/'/g, "")}", using test.step() for each numbered step.
   ${ctx.target === "web"
     ? `- Navigate with the absolute URLs from the steps${ctx.baseUrl ? ` (base URL ${ctx.baseUrl})` : ""}. This is not a Salesforce
     test: do not add any Salesforce login or org navigation.`
     : `- Navigate with relative URLs (baseURL is the org instance). The session is provided by the config's
     storageState - never add login code and never hardcode credentials or the instance URL.`}
   - Assert every expected result with web-first assertions (expect(locator).toBeVisible()/toHaveText()...).
   - Make created record names unique, e.g. \`AI-TEST ${tc.id} \${Date.now()}\`.
3. Run it ${RUN_NOTE}: npx playwright test --config ${PW_CONFIG} ${spec}
4. If it fails because of the SCRIPT (bad locator, timing), fix it and re-run. Iterate until it passes or you
   are confident the failure is a genuine APPLICATION defect. Do not weaken assertions to make it pass.
Return your verdict in the required JSON format with "specFile" set to "${spec}". "passed" means the spec passes.`;
}

/** Manual re-run after a replay: the browser already went through the steps at Playwright speed. */
function verifyPrompt(tc: TestCase, ctx: AgentContext): string {
  const { actions, seconds } = ctx.verifyReplay!;
  return `${caseBrief(tc, ctx)}

TASK (verify a replayed run): every step of this test case was just performed in this browser by replaying the
${actions} recorded browser actions of an earlier passing run (took ${seconds}s). Do NOT perform the steps again.

Check every expected result against the page as it is now: browser_find or a snapshot scoped to the relevant area,
then one fullPage screenshot as evidence. If the page is not in the state the steps should have produced, or you
cannot judge an expected result from it, return "error" with the reason - do not try to redo the steps.
Report every numbered step in "steps" with "actual" starting "Replayed from recording: " (status "passed" unless the
page shows that step did not take effect). Return the verdict in the required JSON format.`;
}

/** Instructions for a fallback model continuing a previous attempt in the same session (and browser). */
function handoverPrompt(tc: TestCase, mode: "manual" | "automation", ctx: AgentContext): string {
  const prev = ctx.resume!;
  const where = ctx.cdpEndpoint
    ? "The same browser is still open on the page where that attempt stopped."
    : "The browser had to be restarted, so navigate back to where that attempt got to.";
  const auto = mode === "automation"
    ? ` If the problem is the SCRIPT, fix ${SPEC_DIR}/${tc.id}.spec.ts in place and re-run it ${RUN_NOTE}: npx playwright test --config ${PW_CONFIG} ${SPEC_DIR}/${tc.id}.spec.ts`
    : "";
  return `HANDOVER: you are now taking over test case ${tc.id} (${mode}) from the previous model (${prev.model}), whose attempt ended as "${prev.status}": ${prev.summary}

${where} The conversation above shows everything it did and observed. Continue from the current state - do not log in again and do not restart from step 1 unless the current page makes that necessary.

Independently re-verify every step and expected result the previous attempt did not pass; do not just repeat its conclusion - it may have been a mistake or a timing problem.${auto}
Save screenshots with absolute filenames inside ${ctx.evidenceDir.replace(/\\/g, "/")}/.
Return your own complete verdict in the required JSON format, with one entry in "steps" per numbered step of the test case.`;
}

/**
 * Speed: screenshots are written to disk as evidence but not streamed into the model (it reads pages through
 * text snapshots), and the browser tools are loaded up front (alwaysLoad) so no turn is spent searching for them.
 * No page snapshot is captured after every action: the model only sees snapshots it asks for, and capturing a
 * Lightning page each time costs time and writes a large file per action.
 */
const FAST_ARGS = ["--image-responses", "omit", "--snapshot-mode", "none"];

export function playwrightMcp(ctx: {
  toolRoot: string;
  auth: AuthSession;
  evidenceDir: string;
  headless: boolean;
  cdpEndpoint?: string;
}): McpServerConfig {
  const cli = path.join(ctx.toolRoot, "node_modules", "@playwright", "mcp", "cli.js");
  if (ctx.cdpEndpoint) {
    // Attach to the runner-owned browser: pages survive when this agent session ends.
    return { type: "stdio", command: "node", args: [cli, "--cdp-endpoint", ctx.cdpEndpoint, ...FAST_ARGS, "--output-dir", ctx.evidenceDir], alwaysLoad: true };
  }
  return {
    type: "stdio",
    command: "node",
    args: [
      cli,
      "--browser", "chromium",
      "--isolated",
      "--storage-state", ctx.auth.storageStatePath,
      "--output-dir", ctx.evidenceDir,
      "--viewport-size", "1920,1080",
      ...(ctx.headless ? ["--headless"] : []),
      ...FAST_ARGS,
    ],
    alwaysLoad: true,
  };
}

/** Environment for the Claude Code process. */
export function agentEnv(useSubscription: boolean, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extra, CLAUDE_AGENT_SDK_CLIENT_APP: "sf-ai-tester/0.2.0" };
  if (useSubscription) {
    // Force the Claude Code login (Pro/Max subscription) instead of API-key billing.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

/**
 * Starts the agent process for a case ahead of time (spawn + handshake take ~15-20 s), so it is ready the moment the
 * previous case ends. Pass the result as ctx.warm to runCaseWithAgent with the same ctx; close() it if unused.
 */
export async function prewarmAgent(tc: TestCase, mode: "manual" | "automation", ctx: AgentContext): Promise<WarmQuery> {
  const { startup } = await import("@anthropic-ai/claude-agent-sdk");
  return startup({ options: agentOptions(tc, mode, ctx), initializeTimeoutMs: 120_000 });
}

/** SDK options for one agent session. A pre-warmed process is started with exactly these. */
function agentOptions(tc: TestCase, mode: "manual" | "automation", ctx: AgentContext): Options {
  const env = agentEnv(ctx.useSubscription, {
    SF_STORAGE_STATE: ctx.auth.storageStatePath,
    SF_INSTANCE_URL: ctx.auth.instanceUrl,
    // The agent's own `npx playwright test` runs must not share an output folder with other workers.
    SF_PW_OUTPUT_DIR: path.join(ctx.evidenceDir, "playwright"),
  });

  const allowedTools = mode === "manual" ? ["mcp__playwright"] : ["mcp__playwright", "Read", "Glob", "Grep"];
  const specDir = path.resolve(ctx.workspaceDir, SPEC_DIR) + path.sep;

  // Everything not pre-approved above lands here. Automation mode may write specs under
  // tests/sf-ai and run `npx playwright test`; every other tool call is denied.
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName === "StructuredOutput" || toolName === "ToolSearch") return { behavior: "allow", updatedInput: input };
    if (mode === "automation") {
      if (toolName === "Write" || toolName === "Edit") {
        const file = path.resolve(ctx.workspaceDir, String(input.file_path ?? ""));
        if (file.startsWith(specDir) && file.endsWith(".spec.ts")) return { behavior: "allow", updatedInput: input };
        return { behavior: "deny", message: `Only *.spec.ts files under ${SPEC_DIR}/ may be written.` };
      }
      if (toolName === "Bash" || toolName === "PowerShell") {
        const cmd = String(input.command ?? "").trim();
        if (/^npx playwright test( [\w./:=@-]+)*$/.test(cmd)) return { behavior: "allow", updatedInput: input };
        return { behavior: "deny", message: `Only "npx playwright test --config ${PW_CONFIG} <spec>" may be run (no chaining or redirection).` };
      }
    }
    return { behavior: "deny", message: `${toolName} is not available in ${mode} mode.` };
  };

  return {
    cwd: ctx.workspaceDir,
    env,
    model: ctx.model || undefined,
    maxTurns: ctx.maxTurns,
    abortController: ctx.abort,
    mcpServers: { playwright: playwrightMcp(ctx) },
    allowedTools,
    canUseTool,
    permissionMode: "default",
    settingSources: [],
    systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend(ctx.target ?? "salesforce") },
    outputFormat: { type: "json_schema", schema: VERDICT_SCHEMA },
    // Escalation: pick up the previous model conversation instead of starting a new session.
    ...(ctx.resume ? { resume: ctx.resume.sessionId } : {}),
  };
}

export async function runCaseWithAgent(
  tc: TestCase,
  mode: "manual" | "automation",
  ctx: AgentContext,
): Promise<CaseResult> {
  // ESM-only package: load it lazily so the CommonJS extension bundle can use it.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const started = Date.now();

  const prompt = ctx.verifyReplay
    ? verifyPrompt(tc, ctx)
    : ctx.carryOver
      ? continuationPrompt(tc, ctx)
      : ctx.resume
        ? handoverPrompt(tc, mode, ctx)
        : (mode === "manual" ? manualPrompt(tc, ctx) : automationPrompt(tc, ctx)) + browserNote(mode, ctx);
  // A pre-warmed process only fits a fresh session (resume/carry-over need options chosen at run time).
  const warm = ctx.warm && !ctx.resume ? await ctx.warm.catch(() => undefined) : undefined;
  if (warm) ctx.log("  (agent was pre-started - no startup wait)");
  else ctx.warm?.then((w) => w?.close(), () => undefined);
  let sessionId: string | undefined;
  let verdict: AgentVerdict | undefined;
  let costUsd = 0;
  let turns = 0;
  let failure = "";
  const trail: string[] = [];
  const tape = new Tape(path.resolve(ctx.workspaceDir, SPEC_DIR));

  try {
    for await (const msg of warm ? warm.query(prompt) : query({ prompt, options: agentOptions(tc, mode, ctx) })) {
      logMessage(msg, ctx.log);
      recordTrail(msg, trail);
      tape.observe(msg, ctx.workspaceDir);
      if ("session_id" in msg && msg.session_id) sessionId = msg.session_id;
      if (msg.type === "result") {
        costUsd = msg.total_cost_usd;
        turns = msg.num_turns;
        if (msg.subtype === "success" && msg.structured_output) {
          verdict = msg.structured_output as AgentVerdict;
        } else {
          failure = msg.subtype === "success" ? "Agent returned no structured verdict" : `Agent stopped: ${msg.subtype}`;
        }
      }
    }
  } catch (e) {
    failure = ctx.abort.signal.aborted ? "Cancelled" : `Agent error: ${(e as Error).message}`;
  }

  const base = {
    id: tc.id, title: tc.title, mode, durationMs: Date.now() - started, costUsd, turns, trail: trail.slice(-TRAIL_MAX), sessionId,
    recorded: tape.unsafe ? undefined : tape.actions,
  };
  if (!verdict) {
    return { ...base, status: "error", summary: failure, steps: [], defects: [], evidence: [] };
  }
  const specGreen = !!verdict.specFile && tape.greenSpecs.has(path.resolve(ctx.workspaceDir, verdict.specFile));
  return { ...base, ...verdict, specGreen, evidence: collectEvidence(verdict.evidence, ctx) };
}

/** Browser tools whose code is not part of the user flow (reading the page, evidence, closing the browser). */
const NOT_RECORDED = new Set([
  "snapshot", "take_screenshot", "find", "close", "resize", "console_messages", "console_clear", "network_requests",
  "generate_locator", "highlight", "hide_highlight", "get_config", "annotate",
].map((t) => `mcp__playwright__browser_${t}`));

/**
 * Watches an agent session's tool calls and results:
 * - actions: the Playwright code of every browser action that succeeded, in order - a manual run that passes can be
 *   replayed from these at Playwright speed (Playwright MCP reports the code it ran in a "Ran Playwright code" section);
 * - greenSpecs: specs whose last `npx playwright test` run in this session passed and that were not edited after it.
 */
class Tape {
  actions: string[] = [];
  greenSpecs = new Set<string>();
  /** The session ran free-form Playwright code: never turn it into a recording (replay runs in-process). */
  unsafe = false;
  private calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  constructor(private specDir: string) {}

  observe(msg: SDKMessage, cwd: string) {
    if (msg.type === "assistant") {
      for (const b of msg.message.content) {
        if (b.type !== "tool_use") continue;
        const input = (b.input ?? {}) as Record<string, unknown>;
        this.calls.set(b.id, { name: b.name, input });
        if (b.name.startsWith("mcp__playwright__browser_run_code")) this.unsafe = true;
        if ((b.name === "Write" || b.name === "Edit") && input.file_path) this.greenSpecs.delete(path.resolve(cwd, String(input.file_path)));
      }
      return;
    }
    if (msg.type !== "user" || typeof msg.message.content === "string") return;
    for (const b of msg.message.content) {
      if (b.type !== "tool_result") continue;
      const call = this.calls.get(b.tool_use_id);
      if (!call) continue;
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
      if (call.name.startsWith("mcp__playwright__browser_") && !NOT_RECORDED.has(call.name)) {
        const code = /### Ran Playwright code\s*\n```\w*\n([\s\S]*?)\n```/.exec(text)?.[1];
        if (code && !b.is_error && !/^### Error/m.test(text)) this.actions.push(code.trim());
      } else if (call.name === "Bash" || call.name === "PowerShell") {
        const cmd = String(call.input.command ?? "");
        if (!/^npx playwright test\b/.test(cmd.trim())) continue;
        const green = !b.is_error && /\b\d+ passed\b/.test(text) && !/\b\d+ (failed|flaky|interrupted)\b/.test(text);
        for (const arg of cmd.split(/\s+/).filter((a) => a.endsWith(".spec.ts"))) {
          const spec = path.resolve(cwd, arg);
          if (!spec.startsWith(this.specDir)) continue;
          if (green) this.greenSpecs.add(spec);
          else this.greenSpecs.delete(spec);
        }
      }
    }
  }
}

/** Moves evidence the agent saved elsewhere (e.g. relative to cwd) into the case's evidence folder. */
function collectEvidence(items: string[], ctx: AgentContext): string[] {
  const out: string[] = [];
  for (const item of items) {
    const name = path.basename(item);
    const target = path.join(ctx.evidenceDir, name);
    if (!fs.existsSync(target)) {
      const candidate = [item, path.join(ctx.workspaceDir, item)].find((p) => path.isAbsolute(p) && fs.existsSync(p));
      if (!candidate) continue;
      fs.renameSync(candidate, target);
    }
    out.push(name);
  }
  return out;
}

/** Keeps what the agent actually did (tool calls + short reasoning notes) for failure documentation. */
const TRAIL_MAX = 80;
function recordTrail(msg: SDKMessage, trail: string[]) {
  if (msg.type !== "assistant") return;
  for (const block of msg.message.content) {
    if (block.type === "tool_use" && block.name !== "StructuredOutput" && block.name !== "ToolSearch") {
      trail.push(`${block.name.replace("mcp__playwright__", "browser:")} ${brief(block.input)}`);
    } else if (block.type === "text" && block.text.trim()) {
      const t = block.text.trim().replace(/s+/g, " ");
      trail.push(`» ${t.length > 220 ? t.slice(0, 220) + "…" : t}`);
    }
  }
  if (trail.length > TRAIL_MAX * 2) trail.splice(0, trail.length - TRAIL_MAX);
}

function logMessage(msg: SDKMessage, log: (m: string) => void) {
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text.trim()) log(`  ${block.text.trim()}`);
      if (block.type === "tool_use") log(`  -> ${block.name.replace("mcp__playwright__", "browser:")} ${brief(block.input)}`);
    }
  } else if (msg.type === "system" && msg.subtype === "init") {
    const pw = msg.mcp_servers.find((s) => s.name === "playwright");
    log(`  agent ready (model ${msg.model}, playwright MCP: ${pw?.status ?? "missing"})`);
  }
}

function brief(input: unknown): string {
  const s = JSON.stringify(input) ?? "";
  return s.length > 160 ? `${s.slice(0, 160)}...` : s;
}
