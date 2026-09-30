import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { detectProjectOrg, describeOrg } from "../core/sfcli";
import { OrgConfig } from "../core/types";

export const ORGS_KEY = "sfAiTester.orgs";
export const ACTIVE_ORG_KEY = "sfAiTester.activeOrg";

export interface ProjectOrgState {
  target: string;
  source: string;
  /** checking | connected | connected-unverified | not found | <sf CLI status> */
  status: string;
  orgName?: string;
}

/** Statuses that mean the stored CLI credentials are genuinely unusable (vs. a transient network check failure). */
const AUTH_FAILURE = /expired|invalid|refresh token|not found|no authorization|DomainNotFound|INVALID_SESSION|revoked/i;

/**
 * Keeps the tester's active org in step with the open Salesforce DX project: runs at startup, and again whenever
 * the project's (or the global) default org changes - e.g. `sf config set target-org` or the Salesforce
 * extension's org picker. No console needs to be open.
 */
export class ProjectOrgSync implements vscode.Disposable {
  state: ProjectOrgState | undefined;
  private emitter = new vscode.EventEmitter<{ level: "info" | "ok" | "warn"; text: string } | undefined>();
  /** Fires after every state change; carries a user-facing message when there is something to say. */
  readonly onDidChange = this.emitter.event;
  private disposables: vscode.Disposable[] = [this.emitter];
  private running: Promise<void> | undefined;
  private queued = false;
  private debounce: NodeJS.Timeout | undefined;

  constructor(private ctx: vscode.ExtensionContext) {
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()));
    // Project-level default org files (both CLI generations).
    const w = vscode.workspace.createFileSystemWatcher("**/{.sf/config.json,.sfdx/sfdx-config.json}");
    w.onDidChange(() => this.schedule());
    w.onDidCreate(() => this.schedule());
    w.onDidDelete(() => this.schedule());
    this.disposables.push(w);
    // Global defaults live outside the workspace.
    for (const dir of [path.join(os.homedir(), ".sf"), path.join(os.homedir(), ".sfdx")]) {
      const g = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), "{config.json,sfdx-config.json,alias.json}"));
      g.onDidChange(() => this.schedule());
      g.onDidCreate(() => this.schedule());
      this.disposables.push(g);
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }

  /** Coalesces bursts of file events into one sync. */
  schedule(delayMs = 800) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.sync(), delayMs);
  }

  /** Runs one sync at a time; a request during a run triggers exactly one more run afterwards. */
  sync(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return this.running;
    }
    this.running = this.doSync().finally(() => {
      this.running = undefined;
      if (this.queued) {
        this.queued = false;
        void this.sync();
      }
    });
    return this.running;
  }

  private orgs(): OrgConfig[] {
    return this.ctx.globalState.get<OrgConfig[]>(ORGS_KEY, []);
  }

  private async doSync() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const detected = folder ? detectProjectOrg(folder) : undefined;
    if (!detected) {
      const had = !!this.state;
      this.state = undefined;
      if (had) this.emitter.fire(undefined);
      return;
    }
    // Same target already in use: nothing to announce, just re-verify quietly.
    const sameTarget = this.state?.target === detected.target && this.state.orgName;
    if (!sameTarget) {
      this.state = { ...detected, status: "checking" };
      this.emitter.fire(undefined);
    }

    const org = await describeOrg(detected.target).catch(() => undefined);
    if (!org) {
      this.state = { ...detected, status: "not found" };
      return this.emitter.fire({ level: "warn", text: `Project org "${detected.target}" is not authorised in the sf CLI. Run: sf org login web --alias ${detected.target}` });
    }
    if (!org.connected && AUTH_FAILURE.test(org.status)) {
      this.state = { ...detected, status: org.status };
      return this.emitter.fire({ level: "warn", text: `Project org "${detected.target}" needs re-authorising (${org.status}). Run: sf org login web --alias ${detected.target}` });
    }

    // Name it after the project's configured alias (what the Salesforce extension shows), not the CLI's first alias.
    const preferred = detected.target.includes("@") ? org.alias ?? org.username : detected.target;
    const orgs = this.orgs();
    const existing = orgs.find((o) => o.authMode === "sfcli" && o.sfAlias === org.username);
    let name = existing?.name ?? preferred;
    if (!existing) for (let n = 2; orgs.some((o) => o.name === name); n++) name = `${preferred} (${n})`;
    const entry: OrgConfig = { name, authMode: "sfcli", sfAlias: org.username, username: org.username, loginUrl: org.instanceUrl ?? "", source: "project" };
    // Only one org carries the PROJECT marker: the current project's default.
    const others = orgs.filter((o) => o.name !== name).map(({ source, ...o }) => o as OrgConfig);
    await this.ctx.globalState.update(ORGS_KEY, [...others, entry]);
    await this.ctx.globalState.update(ACTIVE_ORG_KEY, name);

    const verified = org.connected;
    this.state = { ...detected, status: verified ? "connected" : "connected-unverified", orgName: name };
    this.emitter.fire(
      sameTarget
        ? undefined
        : {
            level: "ok",
            text: verified
              ? `Using "${name}" from this Salesforce project (sf CLI) - no login needed.`
              : `Using "${name}" from this Salesforce project (sf CLI). The CLI could not reach the org just now (${org.status}); it will be verified on the first run.`,
          },
    );
  }
}
