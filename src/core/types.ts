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
}

export interface TestSuite {
  name: string;
  /** Free-text context about the org/app shared with every test case */
  context?: string;
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
  /** Models tried, in order, with their verdicts */
  attempts?: { model: string; status: Status; summary: string }[];
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
}

export type RunEvent =
  | { type: "log"; message: string }
  | { type: "needsUser"; message: string }
  | { type: "caseStart"; id: string; title: string; mode: "manual" | "automation"; model: string }
  | { type: "escalate"; id: string; mode: "manual" | "automation"; from: string; to: string; reason: string }
  | { type: "caseEnd"; result: CaseResult; runDir: string }
  | { type: "runEnd"; runDir: string; results: CaseResult[] };
