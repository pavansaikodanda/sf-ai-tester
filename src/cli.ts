#!/usr/bin/env node
/**
 * CLI for CI / terminal use. Org details come from environment variables:
 *   SF_ORG_NAME (default "default"), and either
 *   SF_LOGIN_URL + SF_USERNAME + SF_PASSWORD      (password auth), or
 *   SF_ALIAS                                      (sf CLI auth), or
 *   SF_INTERACTIVE=1 [+ SF_LOGIN_URL, SF_USERNAME] (you log in yourself: passkey / SSO / MFA)
 *
 *   sf-ai-tester run <suite.yaml> [--mode manual|automation|both] [--headed] [--login auto|headed|headless] [--models haiku-id,sonnet-id] [--max-turns N] [--fresh] [--api-key]
 *   sf-ai-tester auth [--login auto|headed|headless]    # saves a session so generated specs can run with plain `npx playwright test`
 *   sf-ai-tester export [--out <path-without-extension>] [--format xlsx,pdf] [--no-screenshots]   # summary of all suites in test-cases/
 */
import * as path from "path";
import { loadSuite } from "./core/suite";
import { runSuite } from "./core/runner";
import { authenticate } from "./core/auth";
import { collectReport, writeExcel, writePdf } from "./core/export";
import { readAll } from "./core/status";
import * as fs from "fs";
import { LoginOptions, OrgConfig, TestMode } from "./core/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function orgFromEnv(): OrgConfig {
  const e = process.env;
  if (e.SF_ALIAS) return { name: e.SF_ORG_NAME ?? e.SF_ALIAS, authMode: "sfcli", loginUrl: "", sfAlias: e.SF_ALIAS };
  if (e.SF_INTERACTIVE) {
    return { name: e.SF_ORG_NAME ?? "default", authMode: "interactive", loginUrl: e.SF_LOGIN_URL ?? "https://login.salesforce.com", username: e.SF_USERNAME };
  }
  if (!e.SF_USERNAME || !e.SF_PASSWORD) throw new Error("Set SF_ALIAS, SF_INTERACTIVE=1, or SF_USERNAME + SF_PASSWORD (+ SF_LOGIN_URL)");
  return {
    name: e.SF_ORG_NAME ?? "default",
    authMode: "password",
    loginUrl: e.SF_LOGIN_URL ?? "https://login.salesforce.com",
    username: e.SF_USERNAME,
    password: e.SF_PASSWORD,
  };
}

async function main() {
  const [cmd, file] = process.argv.slice(2);
  const workspaceDir = process.cwd();
  const headless = !flag("headed");

  if (cmd === "export") {
    const dir = path.join(workspaceDir, "test-cases");
    const suites = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /.ya?ml$/.test(x)).map((x) => path.join(dir, x)) : [];
    if (!suites.length) throw new Error(`No suites found in ${dir}`);
    const base = arg("out") ?? path.join(workspaceDir, `SF-AI-Test-Report-${new Date().toISOString().slice(0, 10)}`);
    const formats = (arg("format") ?? "xlsx,pdf").split(",");
    const data = collectReport(workspaceDir, suites, readAll(workspaceDir));
    if (formats.includes("xlsx")) { await writeExcel(data, `${base}.xlsx`); console.log(`wrote ${base}.xlsx`); }
    if (formats.includes("pdf")) { await writePdf(data, `${base}.pdf`, { screenshots: !flag("no-screenshots") }); console.log(`wrote ${base}.pdf`); }
    return;
  }

  const org = orgFromEnv();
  const login: LoginOptions = {
    browserMode: (arg("login") as LoginOptions["browserMode"]) ?? "auto",
    browser: (arg("login-browser") as LoginOptions["browser"]) ?? "default",
    timeoutMinutes: Number(arg("login-timeout") ?? 5),
    sessionMaxAgeHours: 8,
  };

  if (cmd === "auth") {
    const s = await authenticate(org, path.join(workspaceDir, ".sf-ai-tester", "auth"), login, { log: console.log, needsUser: console.log }, true);
    console.log(`\nexport SF_INSTANCE_URL=${s.instanceUrl}\nexport SF_STORAGE_STATE=${s.storageStatePath}`);
    return;
  }
  if (cmd !== "run" || !file) {
    console.log("usage: sf-ai-tester run <suite.yaml> [--mode manual|automation|both] [--headed] [--models a,b] | sf-ai-tester auth | sf-ai-tester export [--out path] [--format xlsx,pdf]");
    process.exit(2);
  }

  const abort = new AbortController();
  process.on("SIGINT", () => abort.abort());
  const results = await runSuite(
    loadSuite(path.resolve(file)),
    org,
    {
      mode: (arg("mode") as TestMode) ?? "manual",
      workspaceDir,
      toolRoot: path.resolve(__dirname, ".."),
      headless,
      login,
      models: (arg("models") ?? "claude-haiku-4-5,claude-sonnet-5-5").split(",").map((m) => m.trim()).filter(Boolean),
      maxTurns: Number(arg("max-turns") ?? 80),
      useSubscription: !flag("api-key"),
      continuity: flag("fresh") ? "fresh" : "continue",
    },
    (e) => (e.type === "log" || e.type === "needsUser") && console.log(e.message),
    abort,
  );
  process.exit(results.every((r) => r.status === "passed") ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
