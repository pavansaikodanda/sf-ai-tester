/** password: we type the credentials; sfcli: token-based frontdoor (no passkey/MFA);
 *  interactive: the user logs in themselves in a visible browser (passkeys, SSO, MFA). */
export type AuthMode = "password" | "sfcli" | "interactive";

export interface LoginOptions {
  /** auto: headless first, visible window only when Salesforce asks for a passkey/MFA */
  browserMode: "auto" | "headed" | "headless";
  /** default: Edge on Windows, Chrome elsewhere (best OS passkey support) */
  browser: "default" | "chromium" | "chrome" | "msedge";
  /** How long to wait for the user to finish a passkey/MFA login */
  timeoutMinutes: number;
  /** Reuse a saved session this long (it is re-validated before each run) */
  sessionMaxAgeHours: number;
}

export interface OrgConfig {
  /** Display name for the org, e.g. "UAT" */
  name: string;
  authMode: AuthMode;
  /** https://login.salesforce.com, https://test.salesforce.com or a My Domain URL */
  loginUrl: string;
  username?: string;
  password?: string;
  /** sf CLI alias/username when authMode === "sfcli" */
  sfAlias?: string;
  /** "project" = picked up automatically from the open Salesforce DX project default org */
  source?: "project";
}

export type TestMode = "manual" | "automation" | "both";

export interface TestCase {
  id: string;
  title: string;
  description?: string;
  preconditions?: string[];
  steps: string[];
  expected: string[];
  /** Overrides the run-level mode for this case */
  mode?: TestMode;
  tags?: string[];
  /** Group shown in the console (e.g. "Lead Conversion"); defaults to the ID prefix */
  section?: string;
  /** Test data the agent may use (record names, field values, ...) */
  data?: Record<string, unknown>;
  /** What this case runs against; overrides the suite (default: the suite target, else auto-detected) */
  target?: "salesforce" | "web";
}

export interface TestSuite {
  name: string;
  /** Free-text context about the org/app shared with every test case */
  context?: string;
  /** auto (default): per case - web if it points at a non-Salesforce URL; salesforce: the connected org; web: any site/app */
  target?: "auto" | "salesforce" | "web";
  /** Starting URL for web tests, e.g. http://localhost:8080 */
  baseUrl?: string;
  cases: TestCase[];
}

export type Status = "passed" | "failed" | "blocked" | "error";

export interface StepResult {
  step: string;
  status: Status;
  actual: string;
}

export interface Defect {
  title: string;
  severity: "critical" | "major" | "minor" | "trivial";
  details: string;
}

/** Shape the agent must return (enforced via the SDK's JSON-schema output format). */
export interface AgentVerdict {
  status: Status;
  summary: string;
  steps: StepResult[];
  defects: Defect[];
  evidence: string[];
  specFile?: string;
}

export interface CaseResult extends AgentVerdict {
  id: string;
  title: string;
  mode: "manual" | "automation";
  durationMs: number;
  costUsd: number;
  turns: number;
  /** Model that produced this verdict */
  model?: string;
  /** Fingerprint of the case definition this result was produced for (see caseHash) */
  caseHash?: string;
  /** Agent SDK session, so a fallback model can resume it */
  sessionId?: string;
  /** What the agent actually did (tool calls and short notes), most recent last */
  trail?: string[];
  /** Models tried, in order, with their verdicts */
  attempts?: { model: string; status: Status; summary: string; trail?: string[] }[];
  /** Playwright code of the browser actions this session ran (internal: turned into a recording, not reported) */
  recorded?: string[];
  /** The agent's own last run of specFile passed and the spec was not changed afterwards (internal) */
  specGreen?: boolean;
}

export interface RunOptions {
  mode: TestMode;
  /** Workspace root; generated specs and run artifacts are written under it */
  workspaceDir: string;
  headless: boolean;
  login: LoginOptions;
  /** Models to try in order: the first one runs every case; later ones re-run a case that did not pass
   *  (agent error, script instability or a reported failure) so defects are confirmed by a stronger model. */
  models: string[];
  maxTurns: number;
  /** Strip ANTHROPIC_API_KEY so the Claude Code subscription login is used */
  useSubscription: boolean;
  /** continue: one browser for the whole run, cases pick up where the previous left off (default); fresh: clean browser per case */
  continuity?: "continue" | "fresh";
  /** Run up to this many chains of cases at the same time (1-4), each with its own browser and agent */
  workers?: number;
  /** Automation re-runs: spec to replay with plain Playwright (no AI) for this case, if it has a passing, unchanged one */
  replay?: (tc: TestCase) => string | undefined;
  /** After the run, one AI pass that groups failures by root cause (default true) */
  analyze?: boolean;
  /** Org metadata (fields, required fields, picklists, validation rules) relevant to this case, for the agent */
  orgContext?: (tc: TestCase) => string | undefined;
  /** Manual re-runs replay the recorded browser actions of the last pass, then the AI only checks the results (default true) */
  replayManual?: boolean;
}

export type RunEvent =
  | { type: "log"; message: string }
  | { type: "needsUser"; message: string }
  | { type: "caseStart"; id: string; title: string; mode: "manual" | "automation"; model: string }
  | { type: "escalate"; id: string; mode: "manual" | "automation"; from: string; to: string; reason: string }
  | { type: "caseEnd"; result: CaseResult; runDir: string }
  | { type: "runEnd"; runDir: string; results: CaseResult[] }
  | { type: "analysis"; runDir: string; analysis: import("./analyst").RunAnalysis };
