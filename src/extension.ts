import * as vscode from "vscode";
import { ConsolePanel } from "./ui/consolePanel";
import { LauncherView } from "./ui/launcher";
import { ACTIVE_ORG_KEY, ProjectOrgSync } from "./ui/projectOrg";

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("SF AI Tester");
  migrateModels();
  // Proactively follow the open Salesforce project default org - no console or login needed.
  const projectOrg = new ProjectOrgSync(context);
  context.subscriptions.push(projectOrg);
  const open = () => ConsolePanel.show(context, output, projectOrg);
  const reg = (id: string, fn: (...a: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("sfAiTester.openConsole", open);
  reg("sfAiTester.runTests", async (uri?: vscode.Uri) => {
    if (uri) await context.workspaceState.update("sfAiTester.suiteFile", uri.fsPath);
    open();
  });
  reg("sfAiTester.cancel", () => ConsolePanel.cancel());
  reg("sfAiTester.toggleHeadless", async () => {
    const cfg = vscode.workspace.getConfiguration("sfAiTester");
    await cfg.update("headless", !cfg.get("headless", false), true);
  });

  const launcher = new LauncherView(context, open);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(LauncherView.id, launcher));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "sfAiTester.openConsole";
  const refresh = () => {
    const headless = vscode.workspace.getConfiguration("sfAiTester").get("headless", false);
    const org = context.globalState.get<string>(ACTIVE_ORG_KEY);
    const p = projectOrg.state;
    const orgLabel = p?.status === "checking" ? " · $(sync~spin) org" : org ? ` · ${org}` : "";
    status.text = `$(rocket) SF AI Tester${orgLabel} $(${headless ? "eye-closed" : "eye"})`;
    status.tooltip = `Open Mission Control · test browser ${headless ? "headless" : "visible"}${p ? `
Project org: ${p.target} (${p.status})` : ""}`;
  };
  refresh();
  status.show();
  projectOrg.onDidChange((msg) => {
    refresh();
    launcher.refresh();
    // Without the console open, surface the outcome unobtrusively (warnings stay visible).
    if (msg && !ConsolePanel.current) {
      if (msg.level === "warn") vscode.window.showWarningMessage(`SF AI Tester: ${msg.text}`);
      else vscode.window.setStatusBarMessage(`$(check) SF AI Tester: ${msg.text}`, 8000);
    }
  }, null, context.subscriptions);
  void projectOrg.sync();
  context.subscriptions.push(
    status,
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("sfAiTester") && refresh()),
  );
}

export function deactivate() {
  ConsolePanel.cancel();
}

/** One-time move of saved model settings to their successors (e.g. Sonnet 5 -> Sonnet 5.5). */
function migrateModels() {
  const cfg = vscode.workspace.getConfiguration("sfAiTester");
  const renames: Record<string, string> = { "claude-sonnet-5": "claude-sonnet-5-5" };
  for (const key of ["primaryModel", "fallbackModel"]) {
    const saved = cfg.inspect<string>(key)?.globalValue;
    if (saved && renames[saved]) cfg.update(key, renames[saved], vscode.ConfigurationTarget.Global);
  }
}
