import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";

/** A Salesforce CLI org with sensitive fields (tokens) already dropped. */
export interface SfOrg {
  alias?: string;
  username: string;
  instanceUrl?: string;
  connected: boolean;
  status: string;
  isSandbox?: boolean;
}

export interface ProjectOrg {
  /** Alias or username configured as the project's default org */
  target: string;
  /** Where the default came from, for display */
  source: string;
}

const SAFE_TARGET = /^[\w.@+-]+$/;

function sf(args: string[], timeoutMs = 60_000): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile("sf", [...args, "--json"], { shell: process.platform === "win32", timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      // sf exits non-zero for "not connected" but still prints JSON; prefer the JSON when present.
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(err ?? new Error("Unexpected output from sf CLI"));
      }
    });
  });
}

const readJson = (file: string) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * If `dir` is a Salesforce DX project, returns its default org: the project config (.sf, then legacy .sfdx),
 * falling back to the user's global default. Returns undefined for non-project folders.
 */
export function detectProjectOrg(dir: string): ProjectOrg | undefined {
  if (!fs.existsSync(path.join(dir, "sfdx-project.json"))) return;
  const home = os.homedir();
  const candidates: [string, string, string][] = [
    [path.join(dir, ".sf", "config.json"), "target-org", "project .sf/config.json"],
    [path.join(dir, ".sfdx", "sfdx-config.json"), "defaultusername", "project .sfdx/sfdx-config.json"],
    [path.join(home, ".sf", "config.json"), "target-org", "global sf default"],
    [path.join(home, ".sfdx", "sfdx-config.json"), "defaultusername", "global sfdx default"],
  ];
  for (const [file, key, source] of candidates) {
    const target = readJson(file)?.[key];
    if (typeof target === "string" && target.trim()) return { target: target.trim(), source };
  }
}

/** Resolves an alias/username to an org and checks its connection (sf org display). */
export async function describeOrg(target: string): Promise<SfOrg | undefined> {
  // Aliases can contain anything and are passed through a shell on Windows, so map unsafe ones to their
  // username via the CLI's local alias file (instant), falling back to the full org list.
  if (!SAFE_TARGET.test(target)) {
    const home = os.homedir();
    const username = [path.join(home, ".sfdx", "alias.json"), path.join(home, ".sf", "alias.json")]
      .map((f) => readJson(f)?.orgs?.[target])
      .find((u) => typeof u === "string" && SAFE_TARGET.test(u));
    if (username) {
      const org = await describeOrg(username);
      return org && { ...org, alias: org.alias ?? target };
    }
    const all = await listOrgs();
    return all.find((o) => o.alias === target || o.username === target);
  }
  let out = await sf(["org", "display", "--target-org", target]).catch(() => undefined);
  // The CLI reports transient network blips ("fetch failed", timeouts) as the connection status; retry once.
  if (/fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up/i.test(String(out?.result?.connectedStatus ?? ""))) {
    out = await sf(["org", "display", "--target-org", target]).catch(() => out);
  }
  const r = out?.result;
  if (!r?.username) return;
  return {
    alias: r.alias || undefined,
    username: r.username,
    instanceUrl: r.instanceUrl,
    connected: r.connectedStatus === "Connected",
    status: String(r.connectedStatus ?? "Unknown"),
    isSandbox: r.isSandbox,
  };
}

/** Every org the CLI knows about, de-duplicated, connected ones first. */
export async function listOrgs(): Promise<SfOrg[]> {
  const out = await sf(["org", "list"], 120_000);
  const seen = new Map<string, SfOrg>();
  for (const group of Object.values<any[]>(out?.result ?? {})) {
    if (!Array.isArray(group)) continue;
    for (const o of group) {
      if (!o?.username || seen.has(o.username)) continue;
      const status = String(o.connectedStatus ?? o.status ?? "Unknown").split("\n")[0];
      seen.set(o.username, {
        alias: o.alias || undefined,
        username: o.username,
        instanceUrl: o.instanceUrl,
        connected: status === "Connected" || o.status === "Active",
        status,
        isSandbox: o.isSandbox,
      });
    }
  }
  return [...seen.values()].sort((a, b) => Number(b.connected) - Number(a.connected) || (a.alias ?? a.username).localeCompare(b.alias ?? b.username));
}

/** True when `sf` is on PATH. */
export async function hasSfCli(): Promise<boolean> {
  return sf(["version"], 20_000).then(() => true, () => false);
}
