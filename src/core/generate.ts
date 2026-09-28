import type { Options } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { agentEnv, playwrightMcp } from "./agent";
import { AuthSession } from "./auth";
import { TestCase } from "./types";

export interface GenerateRequest {
  /** Feature / user story / requirement to cover */
  prompt: string;
  count: number;
  suiteContext?: string;
  existingIds: string[];
  /** When set, the agent may look around the logged-in org (read-only) to ground the cases */
  explore?: { auth: AuthSession; toolRoot: string; evidenceDir: string; headless: boolean };
  models: string[];
  useSubscription: boolean;
  workspaceDir: string;
  abort: AbortController;
  log: (m: string) => void;
}

const CASES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cases"],
  properties: {
    cases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "steps", "expected"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          preconditions: { type: "array", items: { type: "string" } },
          steps: { type: "array", items: { type: "string" } },
          expected: { type: "array", items: { type: "string" } },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/** Drafts Salesforce test cases from a requirement. Tries each model in order until one returns cases. */
export async function generateCases(req: GenerateRequest): Promise<{ cases: TestCase[]; model: string }> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const prompt = `You are a senior Salesforce QA lead. Write ${req.count} high-value test cases for this requirement:

"""
${req.prompt}
"""
${req.suiteContext ? `\nOrg / suite context: ${req.suiteContext}\n` : ""}
Guidelines:
- Cover the happy path first, then validation rules, negative paths, permissions and edge cases.
- Steps must be concrete UI actions in Salesforce Lightning Experience (tabs, buttons, field labels) that a
  tester can follow literally. Expected results must be observable and checkable.
- Prefix any record names the tests create with "AI-TEST".
- ids: short, uppercase, letters/digits/dashes (e.g. OPP-003); do NOT reuse: ${req.existingIds.join(", ") || "(none)"}.
${
  req.explore
    ? `- A browser logged in to the org is available (${req.explore.auth.instanceUrl}). Look at the relevant pages
  to use the real field labels, picklist values and layouts. This is READ-ONLY reconnaissance: never click
  Save, Delete, Submit or anything that changes data.`
    : "- Use standard Salesforce field labels unless the requirement says otherwise."
}
Return the cases in the required JSON format.`;

  const tried: string[] = [];
  for (const model of req.models.length ? req.models : [""]) {
    tried.push(model || "default");
    req.log(`Generating ${req.count} test cases with ${model || "default model"}...`);
    const options: Options = {
      cwd: req.workspaceDir,
      env: agentEnv(req.useSubscription),
      model: model || undefined,
      maxTurns: req.explore ? 40 : 6,
      abortController: req.abort,
      settingSources: [],
      permissionMode: "default",
      allowedTools: req.explore ? ["mcp__playwright"] : [],
      canUseTool: async (name, input) =>
        name === "StructuredOutput" || name === "ToolSearch"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: `${name} is not available while generating test cases.` },
      mcpServers: req.explore ? { playwright: playwrightMcp(req.explore) } : {},
      outputFormat: { type: "json_schema", schema: CASES_SCHEMA },
    };
    try {
      for await (const msg of query({ prompt, options })) {
        if (msg.type === "assistant") {
          for (const b of msg.message.content) if (b.type === "tool_use") req.log(`  -> ${b.name.replace("mcp__playwright__", "browser:")}`);
        }
        if (msg.type === "result" && msg.subtype === "success" && msg.structured_output) {
          const cases = sanitize((msg.structured_output as { cases: TestCase[] }).cases, req.existingIds);
          if (cases.length) return { cases, model: model || "default" };
        }
      }
    } catch (e) {
      if (req.abort.signal.aborted) throw new Error("Cancelled");
      req.log(`  ${model || "default"} failed: ${(e as Error).message}`);
    }
    req.log(`  ${model || "default"} returned no usable cases - trying the next model.`);
  }
  throw new Error(`No test cases could be generated (tried ${tried.join(", ")})`);
}

function sanitize(cases: TestCase[], existing: string[]): TestCase[] {
  const used = new Set(existing.map((i) => i.toUpperCase()));
  return cases
    .filter((c) => c.title && c.steps?.length && c.expected?.length)
    .map((c, i) => {
      let id = (c.id || `TC-${i + 1}`).toUpperCase().replace(/[^A-Z0-9_-]/g, "-");
      if (used.has(id)) {
        const base = id.replace(/-\d+$/, "");
        for (let n = 1; used.has(id); n++) id = `${base}-${String(n).padStart(3, "0")}`;
      }
      used.add(id);
      return { ...c, id };
    });
}
