import type { Options } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { agentEnv } from "./agent";
import { CaseResult, TestSuite } from "./types";

export type RootCause = "app-defect" | "environment" | "test-design" | "flaky" | "tooling";

export interface RunAnalysis {
  headline: string;
  summary: string;
  groups: { title: string; kind: RootCause; cases: string[]; explanation: string; nextStep: string }[];
  model: string;
  generatedAt: number;
  failures: number;
  total: number;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "groups"],
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "kind", "cases", "explanation", "nextStep"],
        properties: {
          title: { type: "string" },
          kind: { enum: ["app-defect", "environment", "test-design", "flaky", "tooling"] },
          cases: { type: "array", items: { type: "string" } },
          explanation: { type: "string" },
          nextStep: { type: "string" },
        },
      },
    },
  },
};

/** Compact evidence for one non-passing execution. */
function describe(r: CaseResult): string {
  const failedSteps = r.steps.filter((s) => s.status !== "passed").map((s) => `    - [${s.status}] ${s.step} -> ${s.actual}`);
  const attempts = (r.attempts ?? []).map((a) => `${a.model}: ${a.status}`).join(" -> ");
  return [
    `* ${r.id} [${r.mode}] "${r.title}" => ${r.status.toUpperCase()}${attempts ? ` (${attempts})` : ""}`,
    `  summary: ${r.summary}`,
    failedSteps.length ? `  steps that did not pass:\n${failedSteps.join("\n")}` : "",
    r.defects.length ? `  defects: ${r.defects.map((d) => `[${d.severity}] ${d.title}: ${d.details}`).join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * One AI pass over a whole run: groups failures by root cause (a single broken component behind many failures,
 * environment/permission problems, flaky timing, badly specified tests) and says what to do next.
 */
export async function analyzeRun(
  suite: TestSuite,
  results: CaseResult[],
  opts: { model?: string; useSubscription: boolean; workspaceDir: string; abort: AbortController },
): Promise<RunAnalysis | undefined> {
  const bad = results.filter((r) => r.status !== "passed");
  if (!bad.length) return;
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const passed = results.filter((r) => r.status === "passed").map((r) => `${r.id}[${r.mode}]`);
  const prompt = `You are the QA lead reviewing an automated test run of suite "${suite.name}".
${suite.context ? `Context: ${suite.context}\n` : ""}
${results.length} executions: ${passed.length} passed${passed.length ? ` (${passed.join(", ")})` : ""}, ${bad.length} did not pass:

${bad.map(describe).join("\n\n")}

Group the executions that did not pass by ROOT CAUSE - several failures often share one cause (the same broken page,
component or org setting). For each group give:
- kind: app-defect (the application is wrong), environment (permissions, missing data, org configuration, access),
  test-design (the test's steps or expected results are wrong or ambiguous), flaky (timing / intermittent),
  tooling (the test agent or script itself failed),
- the case ids it covers, a short explanation grounded in the evidence above, and one concrete next step.
Every non-passing case must appear in exactly one group. Then write a one-line headline and a 2-4 sentence summary
a QA manager can act on. Do not invent facts beyond the evidence. Return the required JSON.`;

  const options: Options = {
    cwd: opts.workspaceDir,
    env: agentEnv(opts.useSubscription),
    model: opts.model || undefined,
    maxTurns: 3,
    abortController: opts.abort,
    settingSources: [],
    allowedTools: [],
    permissionMode: "default",
    canUseTool: async (name, input) =>
      name === "StructuredOutput" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "No tools are needed." },
    outputFormat: { type: "json_schema", schema: SCHEMA },
  };
  for await (const msg of query({ prompt, options })) {
    if (msg.type === "result" && msg.subtype === "success" && msg.structured_output) {
      const out = msg.structured_output as Omit<RunAnalysis, "model" | "generatedAt" | "failures" | "total">;
      return { ...out, model: opts.model || "default", generatedAt: Date.now(), failures: bad.length, total: results.length };
    }
  }
  return undefined;
}
