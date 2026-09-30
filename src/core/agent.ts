import * as fs from "fs";
import * as path from "path";
import type { CanUseTool, McpServerConfig, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { AgentVerdict, CaseResult, TestCase, TestSuite } from "./types";
import { AuthSession } from "./auth";

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
}

export const SPEC_DIR = "tests/sf-ai";
export const PW_CONFIG = "playwright.sf-ai.config.ts";

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

const SYSTEM_APPEND = `
You are a senior Salesforce QA engineer. You test Salesforce Lightning Experience orgs through a real browser
using the Playwright MCP tools (mcp__playwright__*). The browser is ALREADY LOGGED IN to the org - never try to
log in, log out, change passwords or view credentials.

Salesforce UI guidance:
- Lightning pages load asynchronously. After navigation or saves, take a fresh browser_snapshot before acting,
  and wait for spinners/toasts to settle.
- Prefer direct URLs where possible: <instance>/lightning/o/<Object>/list, /lightning/o/<Object>/new,
  /lightning/r/<Object>/<Id>/view, /lightning/setup/SetupOneHome/home.
- Toast messages confirm saves and show errors - read them.
- Lookups need typing then picking an option from the dropdown; picklists are comboboxes.

Rules:
- Only create/modify data the test case asks for. Prefix any records you create with "AI-TEST" when the test
  lets you choose a name.
- Judge every expected result strictly against what you actually observed. If a step cannot be performed
  because of the environment (missing permission, missing data, page not found) mark it "blocked", not
  "failed". Use "failed" only when the application behaves differently from the expected result.
- Take a screenshot (browser_take_screenshot) at each key checkpoint and on every failure; list the saved
  file names in "evidence".
- Raise a defect for every genuine application failure, with reproduction details.`;

function caseBrief(tc: TestCase, ctx: AgentContext): string {
  const lines = [
    `Org instance URL: ${ctx.auth.instanceUrl}`,
    ctx.suite.context ? `Suite context: ${ctx.suite.context}` : "",
    `Test case ${tc.id}: ${tc.title}`,
    tc.description ? `Description: ${tc.description}` : "",
    tc.preconditions?.length ? `Preconditions:\n${tc.preconditions.map((p) => `- ${p}`).join("\n")}` : "",
    `Steps:\n${tc.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    `Expected results:\n${tc.expected.map((e) => `- ${e}`).join("\n")}`,
    tc.data ? `Test data (JSON): ${JSON.stringify(tc.data)}` : "",
    `Save every screenshot with an absolute filename inside ${ctx.evidenceDir.replace(/\\/g, "/")}/ ` +
      `(e.g. ${ctx.evidenceDir.replace(/\\/g, "/")}/${tc.id}-step1.png).`,
  ];
  return lines.filter(Boolean).join("\n\n");
}

function manualPrompt(tc: TestCase, ctx: AgentContext): string {
  return `${caseBrief(tc, ctx)}

TASK (manual/exploratory execution): Execute this test case yourself in the browser, step by step, exactly as a
manual tester would. For each step record what you actually observed. Then verify every expected result.
While doing so, watch for anything else that looks wrong (errors, broken layouts, wrong labels) and report it
as a defect even if it is outside the expected results. Return your verdict in the required JSON format with one
entry in "steps" per numbered step.`;
}

function automationPrompt(tc: TestCase, ctx: AgentContext): string {
  const spec = `${SPEC_DIR}/${tc.id}.spec.ts`;
  return `${caseBrief(tc, ctx)}

TASK (test automation): Write a robust, reusable Playwright Test spec for this test case at "${spec}".

Process:
1. Use the Playwright MCP browser to walk through the flow and discover reliable locators
   (prefer getByRole / getByLabel / getByText; avoid auto-generated ids like "input-123" and deep CSS).
2. Write the spec with the Write tool. Requirements:
   - import { test, expect } from '@playwright/test';
   - One test() titled "${tc.id}: ${tc.title.replace(/'/g, "")}", using test.step() for each numbered step.
   - Navigate with relative URLs (baseURL is the org instance). The session is provided by the config's
     storageState - never add login code and never hardcode credentials or the instance URL.
   - Assert every expected result with web-first assertions (expect(locator).toBeVisible()/toHaveText()...).
   - Make created record names unique, e.g. \`AI-TEST ${tc.id} \${Date.now()}\`.
3. Run it: npx playwright test --config ${PW_CONFIG} ${spec}
4. If it fails because of the SCRIPT (bad locator, timing), fix it and re-run. Iterate until it passes or you
   are confident the failure is a genuine APPLICATION defect. Do not weaken assertions to make it pass.
Return your verdict in the required JSON format with "specFile" set to "${spec}". "passed" means the spec passes.`;
}

/** Instructions for a fallback model continuing a previous attempt in the same session (and browser). */
function handoverPrompt(tc: TestCase, mode: "manual" | "automation", ctx: AgentContext): string {
  const prev = ctx.resume!;
  const where = ctx.cdpEndpoint
    ? "The same browser is still open on the page where that attempt stopped."
    : "The browser had to be restarted, so navigate back to where that attempt got to.";
  const auto = mode === "automation"
    ? ` If the problem is the SCRIPT, fix ${SPEC_DIR}/${tc.id}.spec.ts in place and re-run it with: npx playwright test --config ${PW_CONFIG} ${SPEC_DIR}/${tc.id}.spec.ts`
    : "";
  return `HANDOVER: you are now taking over test case ${tc.id} (${mode}) from the previous model (${prev.model}), whose attempt ended as "${prev.status}": ${prev.summary}

${where} The conversation above shows everything it did and observed. Continue from the current state - do not log in again and do not restart from step 1 unless the current page makes that necessary.

Independently re-verify every step and expected result the previous attempt did not pass; do not just repeat its conclusion - it may have been a mistake or a timing problem.${auto}
Save screenshots with absolute filenames inside ${ctx.evidenceDir.replace(/\\/g, "/")}/.
Return your own complete verdict in the required JSON format, with one entry in "steps" per numbered step of the test case.`;
}

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
    return { type: "stdio", command: "node", args: [cli, "--cdp-endpoint", ctx.cdpEndpoint, "--output-dir", ctx.evidenceDir] };
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
      "--viewport-size", "1440,900",
      ...(ctx.headless ? ["--headless"] : []),
    ],
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

export async function runCaseWithAgent(
  tc: TestCase,
  mode: "manual" | "automation",
  ctx: AgentContext,
): Promise<CaseResult> {
  // ESM-only package: load it lazily so the CommonJS extension bundle can use it.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const started = Date.now();

  const env = agentEnv(ctx.useSubscription, {
    SF_STORAGE_STATE: ctx.auth.storageStatePath,
    SF_INSTANCE_URL: ctx.auth.instanceUrl,
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

  const options: Options = {
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
    systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
    outputFormat: { type: "json_schema", schema: VERDICT_SCHEMA },
    // Escalation: pick up the previous model conversation instead of starting a new session.
    ...(ctx.resume ? { resume: ctx.resume.sessionId } : {}),
  };

  const prompt = ctx.resume ? handoverPrompt(tc, mode, ctx) : mode === "manual" ? manualPrompt(tc, ctx) : automationPrompt(tc, ctx);
  let sessionId: string | undefined;
  let verdict: AgentVerdict | undefined;
  let costUsd = 0;
  let turns = 0;
  let failure = "";
  const trail: string[] = [];

  try {
    for await (const msg of query({ prompt, options })) {
      logMessage(msg, ctx.log);
      recordTrail(msg, trail);
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

  const base = { id: tc.id, title: tc.title, mode, durationMs: Date.now() - started, costUsd, turns, trail: trail.slice(-TRAIL_MAX), sessionId };
  if (!verdict) {
    return { ...base, status: "error", summary: failure, steps: [], defects: [], evidence: [] };
  }
  return { ...base, ...verdict, evidence: collectEvidence(verdict.evidence, ctx) };
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
