import * as fs from "fs";
import * as path from "path";
import { CaseResult, Status } from "./types";

export interface ModeStatus {
  status: Status;
  summary: string;
  model?: string;
  at: number;
  durationMs: number;
  runDir: string;
  specFile?: string;
  defects: number;
}

/** caseId -> latest manual / automation result, per suite file */
export type SuiteStatus = Record<string, { manual?: ModeStatus; automation?: ModeStatus }>;

const file = (workspaceDir: string) => path.join(workspaceDir, ".sf-ai-tester", "status.json");

export function readAll(workspaceDir: string): Record<string, SuiteStatus> {
  try {
    return JSON.parse(fs.readFileSync(file(workspaceDir), "utf8"));
  } catch {
    return {};
  }
}

export function readStatus(workspaceDir: string, suiteKey: string): SuiteStatus {
  return readAll(workspaceDir)[suiteKey] ?? {};
}

export function recordResult(workspaceDir: string, suiteKey: string, result: CaseResult, runDir: string) {
  const all = readAll(workspaceDir);
  const suite = (all[suiteKey] ??= {});
  const entry = (suite[result.id] ??= {});
  entry[result.mode] = {
    status: result.status,
    summary: result.summary,
    model: result.model,
    at: Date.now(),
    durationMs: result.durationMs,
    runDir,
    specFile: result.specFile,
    defects: result.defects.length,
  };
  fs.mkdirSync(path.dirname(file(workspaceDir)), { recursive: true });
  fs.writeFileSync(file(workspaceDir), JSON.stringify(all, null, 2));
}

export function forgetCase(workspaceDir: string, suiteKey: string, id: string) {
  const all = readAll(workspaceDir);
  if (all[suiteKey]?.[id]) {
    delete all[suiteKey][id];
    fs.writeFileSync(file(workspaceDir), JSON.stringify(all, null, 2));
  }
}
