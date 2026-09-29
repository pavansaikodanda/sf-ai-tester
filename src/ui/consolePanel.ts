import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadSuite, saveSuite } from "../core/suite";
import { runSuite } from "../core/runner";
import { authenticate } from "../core/auth";
import { generateCases } from "../core/generate";
import { readStatus, recordResult, forgetCase } from "../core/status";
import { LoginOptions, OrgConfig, TestCase, TestMode, TestSuite } from "../core/types";
import { SAMPLE_SUITE } from "../sample";

const ORGS_KEY = "sfAiTester.orgs";
const ACTIVE_ORG_KEY = "sfAiTester.activeOrg";
const SUITE_KEY = "sfAiTester.suiteFile";
const secretKey = (org: string) => `sfAiTester.password.${org}`;

type Busy = "run" | "gen" | "login" | null;
type Msg = { type: string; [k: string]: any };

/**
 * Host side of the Mission Control webview: owns orgs (globalState + SecretStorage), the active suite
 * file, per-case statuses and the run/generate/login jobs, and streams progress to the UI.
 */
export class ConsolePanel {
  static current: ConsolePanel | undefined;
  private busy: Busy = null;
  private abort: AbortController | undefined;
  /** Live phases for cases in the current run: "ID:mode" -> queued | running */
  private live = new Map<string, { phase: string; model?: string }>();
  private disposables: vscode.Disposable[] = [];

  static show(ctx: vscode.ExtensionContext, output: vscode.OutputChannel) {
    if (ConsolePanel.current) {
      ConsolePanel.current.panel.reveal();
      return ConsolePanel.current;
    }
    const panel = vscode.window.createWebviewPanel("sfAiTester.console", "SF AI Tester · Mission Control", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media")],
    });
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "logo.png");
    ConsolePanel.current = new ConsolePanel(panel, ctx, output);
    return ConsolePanel.current;
  }

  static cancel() {
    ConsolePanel.current?.abort?.abort();
  }

  private constructor(
    private panel: vscode.WebviewPanel,
    private ctx: vscode.ExtensionContext,
    private output: vscode.OutputChannel,
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((m: Msg) => this.handle(m).catch((e) => this.toast("error", (e as Error).message)), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("sfAiTester") && this.pushState(), null, this.disposables);
    this.watch();
  }

  private watcher: vscode.FileSystemWatcher | undefined;
  /** Re-renders when the active suite YAML is edited by hand. */
  private watch() {
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.workspace()), "**/*.{yaml,yml}"));
    this.watcher.onDidChange((u) => u.fsPath === this.suiteFile() && this.pushState());
    this.disposables.push(this.watcher);
  }

  private dispose() {
    ConsolePanel.current = undefined;
    this.abort?.abort();
    this.disposables.forEach((d) => d.dispose());
  }

  // ---------- helpers ----------

  /**
   * Where suites, reports, sessions and generated specs live - any folder works, no Salesforce project needed:
   * the sfAiTester.dataFolder setting, else the open VS Code folder, else ~/SF-AI-Tester.
   */
  private workspace(): string {
    const dir = this.cfg().get<string>("dataFolder") || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.join(os.homedir(), "SF-AI-Tester");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  private cfg() {
    return vscode.workspace.getConfiguration("sfAiTester");
  }
  private orgs(): OrgConfig[] {
    return this.ctx.globalState.get<OrgConfig[]>(ORGS_KEY, []);
  }
  private activeOrgName(): string | undefined {
    const name = this.ctx.globalState.get<string>(ACTIVE_ORG_KEY);
    return this.orgs().some((o) => o.name === name) ? name : this.orgs()[0]?.name;
  }
  private models(): string[] {
    const cfg = this.cfg();
    return [cfg.get("primaryModel", "claude-haiku-4-5"), cfg.get("fallbackModel", "claude-sonnet-5")].filter(
      (m, i, a) => m && a.indexOf(m) === i,
    );
  }
  private loginOptions(): LoginOptions {
    const cfg = this.cfg();
    return {
      browserMode: cfg.get("login.browserMode", "headed"),
      browser: cfg.get("login.browser", "default"),
      timeoutMinutes: cfg.get("login.timeoutMinutes", 5),
      sessionMaxAgeHours: cfg.get("login.sessionMaxAgeHours", 8),
    };
  }

  private suites(): string[] {
    const ws = this.workspace();
    if (!ws) return [];
    const dir = path.join(ws, "test-cases");
    const found = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => /\.(ya?ml)$/.test(f)).map((f) => path.join(dir, f))
      : [];
    const cur = this.ctx.workspaceState.get<string>(SUITE_KEY);
    if (cur && fs.existsSync(cur) && !found.includes(cur)) found.push(cur);
    return found;
  }

  private suiteFile(): string | undefined {
    const ws = this.workspace();
    if (!ws) return;
    const cur = this.ctx.workspaceState.get<string>(SUITE_KEY);
    if (cur && fs.existsSync(cur)) return cur;
    const first = this.suites()[0];
    if (first) return first;
    // First launch in this folder: seed a sample suite so the matrix isn't empty.
    const file = path.join(ws, "test-cases", "sample.sf-tests.yaml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SAMPLE_SUITE);
    return file;
  }

  private suiteKey(file: string) {
    return path.relative(this.workspace(), file).replace(/\\/g, "/");
  }

  private loadCurrent(): { file: string; suite: TestSuite } | undefined {
    const file = this.suiteFile();
    if (!file) return;
    return { file, suite: loadSuite(file, { allowEmpty: true }) };
  }

  private post(m: Msg) {
    this.panel.webview.postMessage(m);
  }
  private toast(level: "info" | "ok" | "warn" | "error", text: string) {
    this.post({ type: "toast", level, text });
  }
  private log(line: string) {
    this.output.appendLine(line);
    this.post({ type: "log", line });
  }

  private pushState() {
    const ws = this.workspace();
    let suite: TestSuite | undefined;
    let file: string | undefined;
    let suiteError: string | undefined;
    try {
      const cur = this.loadCurrent();
      suite = cur?.suite;
      file = cur?.file;
    } catch (e) {
      suiteError = (e as Error).message;
      file = this.suiteFile();
    }
    const cfg = this.cfg();
    const hasPlaywright = !!ws && fs.existsSync(path.join(ws, "node_modules", "@playwright", "test"));
    this.post({
      type: "state",
      workspace: ws,
      hasPlaywright,
      orgs: this.orgs().map(({ password, ...o }) => o),
      activeOrg: this.activeOrgName() ?? null,
      suites: this.suites().map((f) => ({ file: f, label: path.basename(f) })),
      suiteFile: file ?? null,
      suite: suite ?? null,
      suiteError: suiteError ?? null,
      status: file && ws ? readStatus(ws, this.suiteKey(file)) : {},
      live: Object.fromEntries(this.live),
      busy: this.busy,
      settings: {
        headless: cfg.get("headless", false),
        loginMode: cfg.get("login.browserMode", "headed"),
        primaryModel: cfg.get("primaryModel", "claude-haiku-4-5"),
        fallbackModel: cfg.get("fallbackModel", "claude-sonnet-5"),
        maxTurns: cfg.get("maxTurns", 80),
      },
    });
  }

  private async orgWithSecret(name?: string): Promise<OrgConfig> {
    const org = this.orgs().find((o) => o.name === (name ?? this.activeOrgName()));
    if (!org) throw new Error("Configure an org first (ORG UPLINK panel).");
    if (org.authMode === "password") {
      const password = await this.ctx.secrets.get(secretKey(org.name));
      if (!password) throw new Error(`No password stored for "${org.name}". Re-enter it in ORG UPLINK.`);
      return { ...org, password };
    }
    return org;
  }

  // ---------- message handling ----------

  private async handle(m: Msg) {
    switch (m.type) {
      case "ready":
        return this.pushState();

      case "org:save": {
        const org = m.org as OrgConfig;
        if (!org.name?.trim()) throw new Error("Org name is required.");
        if (org.authMode !== "sfcli" && !/^https:\/\/\S+$/.test(org.loginUrl ?? "")) throw new Error("Login URL must start with https://");
        if (org.authMode === "password" && !org.username) throw new Error("Username is required.");
        if (org.authMode === "sfcli" && !org.sfAlias) throw new Error("sf CLI alias is required.");
        const clean: OrgConfig = {
          name: org.name.trim(),
          authMode: org.authMode,
          loginUrl: (org.loginUrl ?? "").replace(/\/$/, ""),
          username: org.username || undefined,
          sfAlias: org.sfAlias || undefined,
        };
        if (m.previousName && m.previousName !== clean.name) await this.deleteOrg(m.previousName);
        if (org.authMode === "password") {
          if (m.password) await this.ctx.secrets.store(secretKey(clean.name), m.password);
          else if (!(await this.ctx.secrets.get(secretKey(clean.name)))) throw new Error("Password is required.");
        }
        await this.ctx.globalState.update(ORGS_KEY, [...this.orgs().filter((o) => o.name !== clean.name), clean]);
        await this.ctx.globalState.update(ACTIVE_ORG_KEY, clean.name);
        this.toast("ok", `Org "${clean.name}" saved.`);
        return this.pushState();
      }
      case "org:delete":
        await this.deleteOrg(m.name);
        this.toast("info", `Org "${m.name}" removed.`);
        return this.pushState();
      case "org:select":
        await this.ctx.globalState.update(ACTIVE_ORG_KEY, m.name);
        return this.pushState();
      case "org:login":
        return this.login(m.name);

      case "suite:select":
        await this.ctx.workspaceState.update(SUITE_KEY, m.file);
        return this.pushState();
      case "suite:new": {
        const ws = this.workspace();
        const slug = String(m.name || "suite").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "suite";
        const file = path.join(ws, "test-cases", `${slug}.sf-tests.yaml`);
        if (fs.existsSync(file)) throw new Error(`${path.basename(file)} already exists.`);
        saveSuite(file, { name: m.name || slug, cases: [] });
        await this.ctx.workspaceState.update(SUITE_KEY, file);
        return this.pushState();
      }
      case "suite:context": {
        const cur = this.loadCurrent();
        if (!cur) return;
        saveSuite(cur.file, { ...cur.suite, context: m.context || undefined });
        this.toast("ok", "Suite context saved.");
        return this.pushState();
      }
      case "suite:openFile": {
        const file = this.suiteFile();
        if (file) await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside });
        return;
      }

      case "case:save": {
        const cur = this.loadCurrent();
        if (!cur) return;
        const tc = normaliseCase(m.case);
        const others = cur.suite.cases.filter((c) => c.id !== (m.originalId ?? tc.id));
        if (others.some((c) => c.id === tc.id)) throw new Error(`A case with id ${tc.id} already exists.`);
        const idx = cur.suite.cases.findIndex((c) => c.id === (m.originalId ?? tc.id));
        const cases = [...cur.suite.cases];
        if (idx >= 0) cases[idx] = tc;
        else cases.push(tc);
        saveSuite(cur.file, { ...cur.suite, cases });
        if (m.originalId && m.originalId !== tc.id) forgetCase(this.workspace(), this.suiteKey(cur.file), m.originalId);
        this.toast("ok", `${tc.id} saved.`);
        return this.pushState();
      }
      case "case:delete": {
        const cur = this.loadCurrent();
        if (!cur) return;
        saveSuite(cur.file, { ...cur.suite, cases: cur.suite.cases.filter((c) => !m.ids.includes(c.id)) });
        for (const id of m.ids) forgetCase(this.workspace(), this.suiteKey(cur.file), id);
        this.toast("info", `Deleted ${m.ids.join(", ")}.`);
        return this.pushState();
      }
      case "case:import": {
        const cur = this.loadCurrent();
        if (!cur) return;
        const ids = new Set(cur.suite.cases.map((c) => c.id));
        const incoming = (m.cases as TestCase[]).map(normaliseCase).filter((c) => !ids.has(c.id));
        saveSuite(cur.file, { ...cur.suite, cases: [...cur.suite.cases, ...incoming] });
        this.toast("ok", `Imported ${incoming.length} test case(s).`);
        return this.pushState();
      }

      case "gen:run":
        try {
          return await this.generate(m.prompt, m.count, m.explore);
        } catch (e) {
          // Always release the UI's "synthesizing" state, whatever failed.
          this.post({ type: "gen:result", cases: [], error: (e as Error).message });
          throw e;
        }

      case "run":
        return this.run(m.ids, m.mode);
      case "cancel":
        this.abort?.abort();
        this.log(">>> Abort requested.");
        return;

      case "report:open":
        if (m.runDir) await vscode.env.openExternal(vscode.Uri.file(path.join(m.runDir, "report.html")));
        return;
      case "spec:open":
        if (m.file) await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.workspace(), m.file)), { viewColumn: vscode.ViewColumn.Beside });
        return;
      case "setup:playwright": {
        const ws = this.workspace();
        if (!fs.existsSync(path.join(ws, "package.json"))) {
          fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: path.basename(ws).toLowerCase().replace(/[^a-z0-9-]/g, "-"), private: true }, null, 2));
        }
        const term = vscode.window.createTerminal({ name: "SF AI Tester setup", cwd: ws });
        term.show();
        term.sendText("npm i -D @playwright/test && npx playwright install chromium");
        return;
      }
      case "folder:pick": {
        const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Use for SF AI Tester", defaultUri: vscode.Uri.file(this.workspace()) });
        if (!pick?.[0]) return;
        await this.cfg().update("dataFolder", pick[0].fsPath, vscode.ConfigurationTarget.Global);
        await this.ctx.workspaceState.update(SUITE_KEY, undefined);
        this.watch();
        this.toast("ok", `Data folder: ${pick[0].fsPath}`);
        return this.pushState();
      }
      case "folder:reveal":
        return vscode.env.openExternal(vscode.Uri.file(this.workspace()));

      case "settings:update": {
        const allowed: Record<string, string> = {
          headless: "headless",
          loginMode: "login.browserMode",
          primaryModel: "primaryModel",
          fallbackModel: "fallbackModel",
          maxTurns: "maxTurns",
        };
        if (allowed[m.key]) await this.cfg().update(allowed[m.key], m.value, vscode.ConfigurationTarget.Global);
        return;
      }
    }
  }

  private async deleteOrg(name: string) {
    await this.ctx.globalState.update(ORGS_KEY, this.orgs().filter((o) => o.name !== name));
    await this.ctx.secrets.delete(secretKey(name));
  }

  private setBusy(b: Busy) {
    this.busy = b;
    this.post({ type: "busy", busy: b });
  }

  private needsUser = (message: string) => {
    this.log(`>>> ACTION NEEDED: ${message}`);
    this.post({ type: "needsUser", message });
    vscode.window.showWarningMessage(`SF AI Tester: ${message}`);
  };

  private async login(name?: string) {
    if (this.busy) throw new Error("Another operation is in progress.");
    const ws = this.workspace();
    const org = await this.orgWithSecret(name);
    this.setBusy("login");
    try {
      const s = await authenticate(
        org,
        path.join(ws, ".sf-ai-tester", "auth"),
        { ...this.loginOptions(), browserMode: this.loginOptions().browserMode === "headless" ? "headless" : "headed" },
        { log: (l) => this.log(l), needsUser: this.needsUser },
        true,
      );
      this.post({ type: "needsUser", message: null });
      this.toast("ok", `Uplink established: ${s.instanceUrl}`);
    } finally {
      this.post({ type: "needsUser", message: null });
      this.setBusy(null);
    }
  }

  private async generate(prompt: string, count: number, explore: boolean) {
    if (this.busy) throw new Error("Another operation is in progress.");
    if (!prompt?.trim()) throw new Error("Describe the feature or requirement to test.");
    const ws = this.workspace();
    const cur = this.loadCurrent();
    this.setBusy("gen");
    this.abort = new AbortController();
    try {
      let exploreCtx;
      if (explore) {
        const auth = await authenticate(await this.orgWithSecret(), path.join(ws, ".sf-ai-tester", "auth"), this.loginOptions(), {
          log: (l) => this.log(l),
          needsUser: this.needsUser,
        });
        this.post({ type: "needsUser", message: null });
        const evidenceDir = path.join(ws, ".sf-ai-tester", "generate");
        fs.mkdirSync(evidenceDir, { recursive: true });
        exploreCtx = { auth, toolRoot: this.ctx.extensionPath, evidenceDir, headless: this.cfg().get("headless", false) };
      }
      const { cases, model } = await generateCases({
        prompt,
        count: Math.max(1, Math.min(20, Number(count) || 5)),
        suiteContext: cur?.suite.context,
        existingIds: cur?.suite.cases.map((c) => c.id) ?? [],
        explore: exploreCtx,
        models: this.models(),
        useSubscription: this.cfg().get("useSubscription", true),
        workspaceDir: ws,
        abort: this.abort,
        log: (l) => this.log(l),
      });
      this.post({ type: "gen:result", cases, model });
    } finally {
      this.abort = undefined;
      this.setBusy(null);
    }
  }

  private async run(ids: string[], mode: TestMode) {
    if (this.busy) throw new Error("A run is already in progress.");
    const ws = this.workspace();
    const cur = this.loadCurrent();
    if (!cur) return;
    const cases = cur.suite.cases.filter((c) => ids.includes(c.id)).map((c) => ({ ...c, mode: undefined }));
    if (!cases.length) throw new Error("Select at least one test case.");
    if (mode !== "manual" && !fs.existsSync(path.join(ws, "node_modules", "@playwright", "test"))) {
      this.post({ type: "needsPlaywright" });
      throw new Error("Automation needs @playwright/test in this folder - click INSTALL PLAYWRIGHT.");
    }
    const org = await this.orgWithSecret();
    const suiteKey = this.suiteKey(cur.file);
    const modes = mode === "both" ? ["manual", "automation"] : [mode];

    this.live.clear();
    for (const c of cases) for (const md of modes) this.live.set(`${c.id}:${md}`, { phase: "queued" });
    this.abort = new AbortController();
    this.setBusy("run");
    this.post({ type: "run:start", total: cases.length * modes.length, org: org.name });
    this.pushState();
    this.output.appendLine(`\n##### Run ${new Date().toLocaleString()} - ${cases.length} case(s), ${mode}`);

    try {
      await runSuite(
        { ...cur.suite, cases },
        org,
        {
          mode,
          workspaceDir: ws,
          toolRoot: this.ctx.extensionPath,
          headless: this.cfg().get("headless", false),
          login: this.loginOptions(),
          models: this.models(),
          maxTurns: this.cfg().get("maxTurns", 80),
          useSubscription: this.cfg().get("useSubscription", true),
        },
        (e) => {
          switch (e.type) {
            case "log":
              return this.log(e.message);
            case "needsUser":
              return this.needsUser(e.message);
            case "caseStart":
              this.post({ type: "needsUser", message: null });
              this.live.set(`${e.id}:${e.mode}`, { phase: "running", model: e.model });
              return this.post({ type: "live", id: e.id, mode: e.mode, phase: "running", model: e.model });
            case "escalate":
              this.live.set(`${e.id}:${e.mode}`, { phase: "escalated", model: e.to });
              return this.post({ type: "live", id: e.id, mode: e.mode, phase: "escalated", model: e.to, reason: e.reason });
            case "caseEnd":
              this.live.delete(`${e.result.id}:${e.result.mode}`);
              recordResult(ws, suiteKey, e.result, e.runDir);
              this.post({ type: "caseDone", result: e.result, runDir: e.runDir });
              return this.pushState();
            case "runEnd":
              return this.post({ type: "run:end", runDir: e.runDir, results: e.results });
          }
        },
        this.abort,
      );
    } finally {
      this.live.clear();
      this.abort = undefined;
      this.post({ type: "needsUser", message: null });
      this.setBusy(null);
      this.pushState();
    }
  }

  // ---------- html ----------

  private html(): string {
    const w = this.panel.webview;
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", f));
    const nonce = Array.from({ length: 32 }, () => Math.random().toString(36)[2]).join("");
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource} 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Rajdhani:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<link href="${media("console.css")}" rel="stylesheet">
<title>SF AI Tester</title>
</head><body>
<canvas id="bg"></canvas><div class="scanlines"></div><div id="cursor-glow"></div>
<div id="app"></div>
<script nonce="${nonce}" src="${media("console.js")}"></script>
</body></html>`;
  }
}

function normaliseCase(c: any): TestCase {
  const list = (v: unknown) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
  const tc: TestCase = {
    id: String(c.id ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "-"),
    title: String(c.title ?? "").trim(),
    description: c.description ? String(c.description).trim() : undefined,
    preconditions: list(c.preconditions),
    steps: list(c.steps),
    expected: list(c.expected),
    tags: list(c.tags),
    section: c.section ? String(c.section).trim() : undefined,
  };
  if (!tc.id) throw new Error("Test case id is required.");
  if (!tc.title) throw new Error("Title is required.");
  if (!tc.steps.length) throw new Error("Add at least one step.");
  if (!tc.expected.length) throw new Error("Add at least one expected result.");
  return tc;
}
