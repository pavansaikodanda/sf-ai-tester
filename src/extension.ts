import * as vscode from "vscode";
import { ConsolePanel } from "./ui/consolePanel";
import { LauncherView } from "./ui/launcher";

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("SF AI Tester");
  migrateModels();
  const open = () => ConsolePanel.show(context, output);
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

  context.subscriptions.push(vscode.window.registerWebviewViewProvider(LauncherView.id, new LauncherView(context, open)));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "sfAiTester.openConsole";
  const refresh = () => {
    const headless = vscode.workspace.getConfiguration("sfAiTester").get("headless", false);
    status.text = `$(rocket) SF AI Tester $(${headless ? "eye-closed" : "eye"})`;
    status.tooltip = `Open Mission Control · test browser ${headless ? "headless" : "visible"}`;
  };
  refresh();
  status.show();
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
