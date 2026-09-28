import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { loadSuite } from "./core/suite";
import { runSuite } from "./core/runner";
import { authenticate } from "./core/auth";
import { CaseResult, LoginOptions, OrgConfig, TestMode } from "./core/types";
import { SAMPLE_SUITE } from "./sample";

const ORGS_KEY = "sfAiTester.orgs";
const secretKey = (org: string) => `sfAiTester.password.${org}`;

let output: vscode.OutputChannel;
let current: AbortController | undefined;
let lastReport: string | undefined;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("SF AI Tester");
  const reg = (id: string, fn: (...a: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("sfAiTester.configureOrg", () => configureOrg(context));
  reg("sfAiTester.removeOrg", () => removeOrg(context));
  reg("sfAiTester.runTests", (uri?: vscode.Uri) => runTests(context, uri));
  reg("sfAiTester.initProject", () => initProject());
  reg("sfAiTester.cancel", () => {
    current?.abort();
    vscode.window.showInformationMessage("SF AI Tester: cancelling run...");
  });
  reg("sfAiTester.openLastReport", () => {
    if (lastReport) vscode.env.openExternal(vscode.Uri.file(lastReport));
    else vscode.window.showInformationMessage("No report yet in this session.");
  });
  reg("sfAiTester.login", () => loginOrg(context));
  reg("sfAiTester.browserSettings", () => browserSettings());
  reg("sfAiTester.toggleHeadless", async () => {
    const cfg = vscode.workspace.getConfiguration("sfAiTester");
    await cfg.update("headless", !cfg.get("headless", false), true);
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "sfAiTester.browserSettings";
  refreshStatus(status);
  status.show();
  context.subscriptions.push(
    status,
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("sfAiTester") && refreshStatus(status)),
  );
}

export function deactivate() {
  current?.abort();
}

function getOrgs(ctx: vscode.ExtensionContext): OrgConfig[] {
  return ctx.globalState.get<OrgConfig[]>(ORGS_KEY, []);
}

async function configureOrg(ctx: vscode.ExtensionContext) {
  const name = await vscode.window.showInputBox({ prompt: "Org name (e.g. UAT, QA-Sandbox)", ignoreFocusOut: true });
  if (!name) return;
  const auth = await vscode.window.showQuickPick(
    [
      { label: "Username & password", value: "password" as const, detail: "Logs in through the Salesforce login page" },
      {
        label: "Interactive (passkey / SSO / MFA)",
        value: "interactive" as const,
        detail: "You log in yourself in a visible browser; the session is saved and reused until it expires",
      },
      { label: "Salesforce CLI (sf) alias", value: "sfcli" as const, detail: "Uses an org you already authorised with `sf org login web` - no passkey prompts" },
    ],
    { placeHolder: "How should the tester log in?", ignoreFocusOut: true },
  );
  if (!auth) return;

  const org: OrgConfig = { name, authMode: auth.value, loginUrl: "https://login.salesforce.com" };
  if (auth.value === "sfcli") {
    org.sfAlias = await vscode.window.showInputBox({ prompt: "sf CLI alias or username", ignoreFocusOut: true });
    if (!org.sfAlias) return;
  } else {
    const loginUrl = await vscode.window.showInputBox({
      prompt: "Login URL (production: login.salesforce.com, sandbox: test.salesforce.com, or your My Domain)",
      value: "https://test.salesforce.com",
      ignoreFocusOut: true,
      validateInput: (v) => (/^https:\/\/[^\s]+$/.test(v) ? undefined : "Must be an https:// URL"),
    });
    if (!loginUrl) return;
    org.loginUrl = loginUrl.replace(/\/$/, "");
    if (auth.value === "interactive") {
      org.username = (await vscode.window.showInputBox({ prompt: "Username to pre-fill (optional)", ignoreFocusOut: true })) || undefined;
      await saveOrg(ctx, org);
      const now = await vscode.window.showInformationMessage(`Log in to "${name}" now so the session is ready?`, "Log In Now");
      if (now) await loginOrg(ctx, org);
      return;
    }
    org.username = await vscode.window.showInputBox({ prompt: "Username", ignoreFocusOut: true });
    if (!org.username) return;
    const password = await vscode.window.showInputBox({ prompt: "Password (stored in VS Code SecretStorage)", password: true, ignoreFocusOut: true });
    if (!password) return;
    await ctx.secrets.store(secretKey(name), password);
  }

  await saveOrg(ctx, org);
}

async function saveOrg(ctx: vscode.ExtensionContext, org: OrgConfig) {
  const orgs = getOrgs(ctx).filter((o) => o.name !== org.name);
  await ctx.globalState.update(ORGS_KEY, [...orgs, org]);
  vscode.window.showInformationMessage(`SF AI Tester: org "${org.name}" saved.`);
}

function loginOptions(): LoginOptions {
  const cfg = vscode.workspace.getConfiguration("sfAiTester");
  return {
    browserMode: cfg.get("login.browserMode", "headed"),
    browser: cfg.get("login.browser", "default"),
    timeoutMinutes: cfg.get("login.timeoutMinutes", 5),
    sessionMaxAgeHours: cfg.get("login.sessionMaxAgeHours", 8),
  };
}

function notifyNeedsUser(message: string) {
  output.appendLine(`>>> ACTION NEEDED: ${message}`);
  vscode.window.showWarningMessage(`SF AI Tester: ${message}`);
}

/** Forces a fresh login in a visible browser - the way to satisfy a passkey/MFA before a run. */
async function loginOrg(ctx: vscode.ExtensionContext, preselected?: OrgConfig) {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspace) {
    vscode.window.showErrorMessage("Open your test folder first - the session is saved in it.");
    return;
  }
  const org = preselected ?? (await pickOrg(ctx));
  if (!org) return;
  output.show(true);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `SF AI Tester: logging in to ${org.name}` },
      () =>
        authenticate(
          org,
          path.join(workspace, ".sf-ai-tester", "auth"),
          { ...loginOptions(), browserMode: "headed" },
          { log: (m) => output.appendLine(m), needsUser: notifyNeedsUser },
          true,
        ),
    );
    vscode.window.showInformationMessage(`SF AI Tester: logged in to ${org.name}. The session will be reused for test runs.`);
  } catch (e) {
    vscode.window.showErrorMessage(`SF AI Tester: ${(e as Error).message}`);
  }
}

// ---- Browser visibility controls (status bar) ----

const LOGIN_MODE_LABEL = { auto: "Login: auto", headed: "Login: visible", headless: "Login: headless" };

function refreshStatus(item: vscode.StatusBarItem) {
  const cfg = vscode.workspace.getConfiguration("sfAiTester");
  const headless = cfg.get("headless", false);
  const loginMode = cfg.get<keyof typeof LOGIN_MODE_LABEL>("login.browserMode", "headed");
  item.text = `$(${headless ? "eye-closed" : "eye"}) SF Tester: ${headless ? "Headless" : "Visible"}`;
  item.tooltip = `Test browser: ${headless ? "headless" : "visible"} · ${LOGIN_MODE_LABEL[loginMode]}\nClick to change`;
}

async function browserSettings() {
  const cfg = vscode.workspace.getConfiguration("sfAiTester");
  const headless = cfg.get("headless", false);
  const loginMode = cfg.get<string>("login.browserMode", "headed");
  const mark = (on: boolean) => (on ? "$(check) " : "      ");
  const pick = await vscode.window.showQuickPick(
    [
      { label: "Test execution", kind: vscode.QuickPickItemKind.Separator },
      { label: `${mark(!headless)}Visible browser`, detail: "Watch the AI click through the org", apply: () => cfg.update("headless", false, true) },
      { label: `${mark(headless)}Headless browser`, detail: "Faster, runs in the background", apply: () => cfg.update("headless", true, true) },
      { label: "Login (passkey / MFA)", kind: vscode.QuickPickItemKind.Separator },
      { label: `${mark(loginMode === "auto")}Auto`, detail: "Try hidden first; open a window only if Salesforce asks (orgs without passkeys)", apply: () => cfg.update("login.browserMode", "auto", true) },
      { label: `${mark(loginMode === "headed")}Visible (recommended for passkeys)`, detail: "Username & password are typed for you - you verify the passkey", apply: () => cfg.update("login.browserMode", "headed", true) },
      { label: `${mark(loginMode === "headless")}Always headless`, detail: "Never show a window (fails if a passkey/MFA is required)", apply: () => cfg.update("login.browserMode", "headless", true) },
    ] as (vscode.QuickPickItem & { apply?: () => Thenable<void> })[],
    { placeHolder: "SF AI Tester browser settings" },
  );
  await pick?.apply?.();
}

async function removeOrg(ctx: vscode.ExtensionContext) {
  const pick = await vscode.window.showQuickPick(getOrgs(ctx).map((o) => o.name), { placeHolder: "Org to remove" });
  if (!pick) return;
  await ctx.globalState.update(ORGS_KEY, getOrgs(ctx).filter((o) => o.name !== pick));
  await ctx.secrets.delete(secretKey(pick));
}

async function pickOrg(ctx: vscode.ExtensionContext): Promise<OrgConfig | undefined> {
  let orgs = getOrgs(ctx);
  if (!orgs.length) {
    await configureOrg(ctx);
    orgs = getOrgs(ctx);
    if (!orgs.length) return;
  }
  const pick =
    orgs.length === 1
      ? orgs[0]
      : (await vscode.window.showQuickPick(orgs.map((o) => ({ label: o.name, description: o.username ?? o.sfAlias, org: o })), { placeHolder: "Target org" }))?.org;
  if (!pick) return;
  if (pick.authMode === "password") {
    const password = await ctx.secrets.get(secretKey(pick.name));
    if (!password) {
      vscode.window.showErrorMessage(`No password stored for "${pick.name}". Run "SF AI Tester: Configure Org" again.`);
      return;
    }
    return { ...pick, password };
  }
  return pick;
}

async function runTests(ctx: vscode.ExtensionContext, uri?: vscode.Uri) {
  if (current) {
    vscode.window.showWarningMessage("A test run is already in progress.");
    return;
  }
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspace) {
    vscode.window.showErrorMessage("Open a folder first - generated specs and reports are saved in the workspace.");
    return;
  }

  const file = uri?.fsPath ?? (await pickSuiteFile());
  if (!file) return;
  let suite;
  try {
    suite = loadSuite(file);
  } catch (e) {
    vscode.window.showErrorMessage(`Invalid test suite: ${(e as Error).message}`);
    return;
  }

  const selected = await vscode.window.showQuickPick(
    suite.cases.map((c) => ({ label: c.id, description: c.title, picked: true, id: c.id })),
    { canPickMany: true, placeHolder: "Test cases to run" },
  );
  if (!selected?.length) return;
  const ids = new Set(selected.map((s) => s.id));
  suite = { ...suite, cases: suite.cases.filter((c) => ids.has(c.id)) };

  const modePick = await vscode.window.showQuickPick(
    [
      { label: "Manual", value: "manual" as TestMode, detail: "AI executes the steps in a live browser like a manual tester" },
      { label: "Automation", value: "automation" as TestMode, detail: "AI writes a Playwright spec, runs and fixes it until it passes" },
      { label: "Both", value: "both" as TestMode, detail: "Manual execution first, then generate the automation spec" },
    ],
    { placeHolder: "Execution mode (cases with their own `mode` keep it)" },
  );
  if (!modePick) return;

  const cfg = vscode.workspace.getConfiguration("sfAiTester");
  const wasHeadless = cfg.get("headless", false);
  const visible = { label: "$(eye) Visible browser", description: "headless = false", detail: "Watch the AI test the org", headless: false };
  const hidden = { label: "$(eye-closed) Headless browser", description: "headless = true", detail: "Runs in the background", headless: true };
  const browserPick = await vscode.window.showQuickPick(wasHeadless ? [hidden, visible] : [visible, hidden], {
    placeHolder: "Test browser for this run (the login window is always shown when you need to verify a passkey)",
  });
  if (!browserPick) return;
  if (browserPick.headless !== wasHeadless) await cfg.update("headless", browserPick.headless, true);

  const org = await pickOrg(ctx);
  if (!org) return;

  current = new AbortController();
  output.clear();
  output.show(true);
  const results: CaseResult[] = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `SF AI Tester: ${suite.name}`, cancellable: true },
    async (progress, token) => {
      token.onCancellationRequested(() => current?.abort());
      const total = suite.cases.reduce((n, c) => n + ((c.mode ?? modePick.value) === "both" ? 2 : 1), 0);
      try {
        await runSuite(
          suite,
          org,
          {
            mode: modePick.value,
            workspaceDir: workspace,
            toolRoot: ctx.extensionPath,
            headless: browserPick.headless,
            login: loginOptions(),
            model: cfg.get("model", ""),
            maxTurns: cfg.get("maxTurns", 80),
            useSubscription: cfg.get("useSubscription", true),
          },
          (e) => {
            if (e.type === "log") output.appendLine(e.message);
            if (e.type === "needsUser") notifyNeedsUser(e.message);
            if (e.type === "caseStart") progress.report({ message: `${e.id} (${e.mode})` });
            if (e.type === "caseEnd") {
              results.push(e.result);
              progress.report({ increment: 100 / total });
            }
            if (e.type === "runEnd") lastReport = path.join(e.runDir, "report.html");
          },
          current,
        );
      } catch (e) {
        output.appendLine(`\nRun failed: ${(e as Error).message}`);
        vscode.window.showErrorMessage(`SF AI Tester: ${(e as Error).message}`);
      } finally {
        current = undefined;
      }
    },
  );

  if (!lastReport || !results.length) return;
  const passed = results.filter((r) => r.status === "passed").length;
  const choice = await vscode.window.showInformationMessage(
    `SF AI Tester: ${passed}/${results.length} passed.`,
    "Open Report",
  );
  if (choice) vscode.env.openExternal(vscode.Uri.file(lastReport));
}

async function pickSuiteFile(): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (active && /\.(ya?ml|json)$/.test(active)) return active;
  const files = await vscode.workspace.findFiles("**/*.{yaml,yml}", "**/node_modules/**", 200);
  if (!files.length) {
    vscode.window.showErrorMessage('No YAML test suites found. Run "SF AI Tester: Initialize Test Project" to create a sample.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    files.map((f) => ({ label: vscode.workspace.asRelativePath(f), f })),
    { placeHolder: "Test suite file" },
  );
  return pick?.f.fsPath;
}

async function initProject() {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) {
    vscode.window.showErrorMessage("Open a folder first.");
    return;
  }
  const sample = path.join(ws, "test-cases", "sample.sf-tests.yaml");
  if (!fs.existsSync(sample)) {
    fs.mkdirSync(path.dirname(sample), { recursive: true });
    fs.writeFileSync(sample, SAMPLE_SUITE);
  }
  if (!fs.existsSync(path.join(ws, "package.json"))) fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: path.basename(ws).toLowerCase().replace(/[^a-z0-9-]/g, "-"), private: true }, null, 2));
  const term = vscode.window.createTerminal({ name: "SF AI Tester setup", cwd: ws });
  term.show();
  term.sendText("npm i -D @playwright/test && npx playwright install chromium");
  await vscode.window.showTextDocument(vscode.Uri.file(sample));
}
