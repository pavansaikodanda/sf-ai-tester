import * as fs from "fs";
import * as path from "path";
import type ExcelJS from "exceljs";
import { loadSuite } from "./suite";
import { ModeStatus, SuiteStatus } from "./status";
import { CaseResult, Status, TestCase } from "./types";
import type { RunAnalysis } from "./analyst";

type Mode = "manual" | "automation";
const MODES: Mode[] = ["manual", "automation"];

export interface ExecRecord {
  status: ModeStatus;
  /** Full verdict from the run's results.json (steps, attempts, defects, evidence) when still on disk */
  result?: CaseResult;
  org?: string;
}
export interface CaseRecord {
  tc: TestCase;
  section: string;
  manual?: ExecRecord;
  automation?: ExecRecord;
}
export interface SuiteRecord {
  file: string;
  key: string;
  name: string;
  context?: string;
  cases: CaseRecord[];
  /** Latest AI run analysis for this suite, if any */
  analysis?: RunAnalysis;
}
export interface ReportData {
  generatedAt: Date;
  workspaceDir: string;
  suites: SuiteRecord[];
  orgs: string[];
}

const sectionOf = (c: TestCase) => c.section?.trim() || (c.id.includes("-") ? c.id.split("-")[0] : "GENERAL");

/** Gathers every suite in test-cases/ with its latest manual/automation outcome and the full run details. */
export function collectReport(workspaceDir: string, suiteFiles: string[], statusAll: Record<string, SuiteStatus>): ReportData {
  const runCache = new Map<string, { org?: string; results: CaseResult[] } | null>();
  const loadRun = (runDir: string) => {
    if (!runCache.has(runDir)) {
      try {
        runCache.set(runDir, JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8")));
      } catch {
        runCache.set(runDir, null);
      }
    }
    return runCache.get(runDir);
  };
  const orgs = new Set<string>();
  const suites: SuiteRecord[] = [];
  let analyses: Record<string, RunAnalysis> = {};
  try {
    analyses = JSON.parse(fs.readFileSync(path.join(workspaceDir, ".sf-ai-tester", "analysis.json"), "utf8"));
  } catch {
    analyses = {};
  }
  for (const file of suiteFiles) {
    let suite;
    try {
      suite = loadSuite(file, { allowEmpty: true });
    } catch {
      continue; // unreadable suite files are skipped rather than failing the whole export
    }
    const key = path.relative(workspaceDir, file).replace(/\\/g, "/");
    const st = statusAll[key] ?? {};
    suites.push({
      file,
      key,
      name: suite.name,
      context: suite.context,
      analysis: analyses[key],
      cases: suite.cases.map((tc) => {
        const rec: CaseRecord = { tc, section: sectionOf(tc) };
        for (const m of MODES) {
          const s = st[tc.id]?.[m];
          if (!s) continue;
          const run = loadRun(s.runDir);
          const result = run?.results.filter((r) => r.id === tc.id && r.mode === m).pop();
          if (run?.org) orgs.add(run.org);
          rec[m] = { status: s, result, org: run?.org };
        }
        return rec;
      }),
    });
  }
  return { generatedAt: new Date(), workspaceDir, suites, orgs: [...orgs] };
}

// ---------- shared helpers ----------

const STATUSES: Status[] = ["passed", "failed", "blocked", "error"];
const modelName = (m?: string) => {
  const x = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(m ?? "");
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] && x[3].length < 3 ? "." + x[3] : ""}` : m || "default";
};
const dur = (ms?: number) => (!ms ? "" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const when = (t?: number) => (t ? new Date(t).toLocaleString() : "");

function tallies(cases: CaseRecord[], m: Mode) {
  const t = { passed: 0, failed: 0, blocked: 0, error: 0, notRun: 0 };
  for (const c of cases) {
    const s = c[m]?.status.status;
    if (s) t[s]++;
    else t.notRun++;
  }
  return t;
}
const passRate = (t: ReturnType<typeof tallies>) => {
  const ran = t.passed + t.failed + t.blocked + t.error;
  return ran ? t.passed / ran : null;
};
/** Every execution that did not pass, in suite order - the subject of the failure documentation. */
export function failures(data: ReportData) {
  const out: { suite: SuiteRecord; c: CaseRecord; mode: Mode; exec: ExecRecord }[] = [];
  for (const suite of data.suites)
    for (const c of suite.cases)
      for (const m of MODES) {
        const e = c[m];
        if (e && e.status.status !== "passed") out.push({ suite, c, mode: m, exec: e });
      }
  return out;
}
const attemptChain = (e: ExecRecord) =>
  e.result?.attempts?.length
    ? e.result.attempts.map((a) => `${modelName(a.model)}: ${a.status}`).join(" → ")
    : `${modelName(e.status.model)}: ${e.status.status}`;

/** Per-model action trails (what the agent actually did); falls back to the final run's trail. */
function trails(e: ExecRecord): { model: string; status: string; lines: string[] }[] {
  const res = e.result;
  const withTrail = (res?.attempts ?? []).filter((a) => a.trail?.length);
  if (withTrail.length) return withTrail.map((a) => ({ model: modelName(a.model), status: a.status, lines: a.trail! }));
  return res?.trail?.length ? [{ model: modelName(res.model ?? e.status.model), status: e.status.status, lines: res.trail }] : [];
}
const trailText = (e: ExecRecord) =>
  trails(e)
    .map((t) => `— ${t.model} (${t.status}) —\n${t.lines.slice(-40).map((l, k) => `${k + 1}. ${l}`).join("\n")}`)
    .join("\n\n") || "(not recorded for this run)";

// ---------- Excel ----------

const FILL: Record<string, string> = { passed: "FFD6F5DD", failed: "FFFAD4D4", blocked: "FFFDEBC8", error: "FFE6DDF7", "not run": "FFEDEDED" };
const FONT: Record<string, string> = { passed: "FF1B6B35", failed: "FF9B1C1C", blocked: "FF8A5A00", error: "FF5B3A99", "not run": "FF777777" };

export async function writeExcel(data: ReportData, outFile: string) {
  const Excel = (await import("exceljs")).default;
  const wb = new Excel.Workbook();
  wb.creator = "SF AI Tester";
  wb.created = data.generatedAt;

  const header = (ws: ExcelJS.Worksheet, row: number) => {
    const r = ws.getRow(row);
    r.font = { bold: true, color: { argb: "FFFFFFFF" } };
    r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
    r.alignment = { vertical: "middle", wrapText: true };
    r.height = 22;
  };
  const statusCell = (cell: ExcelJS.Cell, s: string) => {
    cell.value = s.toUpperCase();
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[s] ?? FILL["not run"] } };
    cell.font = { bold: true, color: { argb: FONT[s] ?? FONT["not run"] } };
    cell.alignment = { horizontal: "center", vertical: "top" };
  };
  const wrapAll = (ws: ExcelJS.Worksheet, from: number) =>
    ws.eachRow((row, n) => n >= from && row.eachCell((c) => (c.alignment = { ...c.alignment, wrapText: true, vertical: "top" })));

  // 1. Summary
  const sum = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 6 }] });
  sum.getCell("A1").value = "SF AI Tester — Test Execution Summary";
  sum.getCell("A1").font = { bold: true, size: 16 };
  sum.getCell("A2").value = `Generated ${data.generatedAt.toLocaleString()}  ·  Org(s): ${data.orgs.join(", ") || "n/a"}  ·  Folder: ${data.workspaceDir}`;
  sum.getCell("A2").font = { color: { argb: "FF666666" } };
  sum.getCell("A3").value = "Status is the latest verdict per case and mode. Failed = application defect; Blocked = environment issue (access, data); Error = agent/tooling problem.";
  sum.getCell("A3").font = { italic: true, color: { argb: "FF666666" } };
  sum.mergeCells("B5:G5");
  sum.mergeCells("H5:M5");
  sum.getCell("B5").value = "MANUAL";
  sum.getCell("H5").value = "AUTOMATION";
  for (const a of ["B5", "H5"]) {
    sum.getCell(a).alignment = { horizontal: "center" };
    sum.getCell(a).font = { bold: true };
  }
  const cols = ["Suite", "Passed", "Failed", "Blocked", "Error", "Not run", "Pass rate", "Passed", "Failed", "Blocked", "Error", "Not run", "Pass rate", "Cases"];
  sum.getRow(6).values = cols;
  header(sum, 6);
  sum.columns = [{ width: 38 }, ...Array(12).fill({ width: 10 }), { width: 9 }];
  const grand = { manual: tallies([], "manual"), automation: tallies([], "automation"), cases: 0 };
  let row = 7;
  for (const s of data.suites) {
    const tm = tallies(s.cases, "manual"), ta = tallies(s.cases, "automation");
    for (const k of Object.keys(tm) as (keyof typeof tm)[]) {
      grand.manual[k] += tm[k];
      grand.automation[k] += ta[k];
    }
    grand.cases += s.cases.length;
    const pr = (t: typeof tm) => (passRate(t) === null ? "—" : passRate(t));
    sum.getRow(row).values = [s.name, tm.passed, tm.failed, tm.blocked, tm.error, tm.notRun, pr(tm), ta.passed, ta.failed, ta.blocked, ta.error, ta.notRun, pr(ta), s.cases.length];
    row++;
  }
  const pr = (t: typeof grand.manual) => (passRate(t) === null ? "—" : passRate(t));
  sum.getRow(row).values = ["TOTAL", grand.manual.passed, grand.manual.failed, grand.manual.blocked, grand.manual.error, grand.manual.notRun, pr(grand.manual),
    grand.automation.passed, grand.automation.failed, grand.automation.blocked, grand.automation.error, grand.automation.notRun, pr(grand.automation), grand.cases];
  sum.getRow(row).font = { bold: true };
  sum.getRow(row).border = { top: { style: "medium" } };
  for (let r = 7; r <= row; r++) {
    for (const c of [7, 13]) sum.getCell(r, c).numFmt = "0%";
    for (const [c, s] of [[2, "passed"], [3, "failed"], [4, "blocked"], [5, "error"], [8, "passed"], [9, "failed"], [10, "blocked"], [11, "error"]] as const) {
      if (Number(sum.getCell(r, c).value) > 0) sum.getCell(r, c).font = { bold: true, color: { argb: FONT[s] } };
    }
  }

  // 2. One sheet per suite
  const used = new Set<string>(["Summary", "Failure Analysis", "Defects"]);
  for (const s of data.suites) {
    let name = s.name.replace(/[\\/*?:[\]]/g, " ").slice(0, 31).trim() || "Suite";
    for (let n = 2; used.has(name); n++) name = `${name.slice(0, 27)} (${n})`;
    used.add(name);
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, xSplit: 3 }] });
    ws.columns = [
      { header: "Section", width: 16 }, { header: "ID", width: 12 }, { header: "Title", width: 40 },
      { header: "Manual", width: 11 }, { header: "Manual model", width: 13 }, { header: "Manual result", width: 60 }, { header: "Manual run", width: 20 },
      { header: "Automation", width: 12 }, { header: "Auto model", width: 13 }, { header: "Automation result", width: 60 }, { header: "Spec file", width: 30 }, { header: "Auto run", width: 20 },
      { header: "Defects", width: 9 },
    ];
    header(ws, 1);
    for (const c of s.cases) {
      const r = ws.addRow([
        c.section, c.tc.id, c.tc.title,
        "", modelName(c.manual?.status.model), c.manual?.status.summary ?? "", when(c.manual?.status.at),
        "", modelName(c.automation?.status.model), c.automation?.status.summary ?? "", c.automation?.status.specFile ?? "", when(c.automation?.status.at),
        (c.manual?.status.defects ?? 0) + (c.automation?.status.defects ?? 0),
      ]);
      statusCell(r.getCell(4), c.manual?.status.status ?? "not run");
      statusCell(r.getCell(8), c.automation?.status.status ?? "not run");
      if (!c.manual) r.getCell(5).value = "";
      if (!c.automation) r.getCell(9).value = "";
    }
    ws.autoFilter = { from: "A1", to: "M1" };
    wrapAll(ws, 2);
  }

  // 3. Failure analysis
  const fa = wb.addWorksheet("Failure Analysis", { views: [{ state: "frozen", ySplit: 1, xSplit: 3 }] });
  fa.columns = [
    { header: "Suite", width: 22 }, { header: "ID", width: 11 }, { header: "Title", width: 32 }, { header: "Mode", width: 12 },
    { header: "Final status", width: 11 }, { header: "Model attempts", width: 30 }, { header: "What was tried (step → observed)", width: 70 },
    { header: "Expected results", width: 40 }, { header: "Why it did not pass", width: 55 }, { header: "Agent action log", width: 70 }, { header: "Defects raised", width: 45 },
    { header: "Evidence", width: 34 }, { header: "Report", width: 40 },
  ];
  header(fa, 1);
  for (const { suite, c, mode, exec } of failures(data)) {
    const res = exec.result;
    const tried = res?.steps?.length
      ? res.steps.map((s, i) => `${i + 1}. [${s.status.toUpperCase()}] ${s.step}\n    → ${s.actual}`).join("\n")
      : c.tc.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n(step-level detail not available for this run)";
    const r = fa.addRow([
      suite.name, c.tc.id, c.tc.title, mode === "manual" ? "Manual" : "Automation", "",
      attemptChain(exec), tried, c.tc.expected.map((e) => `• ${e}`).join("\n"), exec.status.summary, trailText(exec),
      (res?.defects ?? []).map((d) => `[${d.severity.toUpperCase()}] ${d.title}: ${d.details}`).join("\n\n"),
      (res?.evidence ?? []).map((e) => path.join(exec.status.runDir, "evidence", `${c.tc.id}-${mode}`, path.basename(e))).join("\n"),
      path.join(exec.status.runDir, "report.html"),
    ]);
    statusCell(r.getCell(5), exec.status.status);
  }
  if (fa.rowCount === 1) fa.addRow(["No failures, blocked or errored executions."]);
  wrapAll(fa, 2);

  // AI root-cause analysis (latest per suite)
  if (data.suites.some((s) => s.analysis)) {
    const an = wb.addWorksheet("AI Analysis", { views: [{ state: "frozen", ySplit: 1 }] });
    an.columns = [
      { header: "Suite", width: 24 }, { header: "Root cause", width: 14 }, { header: "Group", width: 36 },
      { header: "Cases", width: 22 }, { header: "Explanation", width: 70 }, { header: "Next step", width: 50 },
    ];
    header(an, 1);
    for (const s of data.suites) {
      if (!s.analysis) continue;
      const head = an.addRow([s.name, "SUMMARY", s.analysis.headline, `${s.analysis.failures}/${s.analysis.total} not passed`, s.analysis.summary, ""]);
      head.font = { bold: true };
      for (const g of s.analysis.groups) an.addRow([s.name, g.kind.toUpperCase(), g.title, g.cases.join(", "), g.explanation, g.nextStep]);
    }
    wrapAll(an, 2);
  }

  // 4. Defect register
  const df = wb.addWorksheet("Defects", { views: [{ state: "frozen", ySplit: 1 }] });
  df.columns = [
    { header: "Suite", width: 22 }, { header: "ID", width: 11 }, { header: "Mode", width: 12 }, { header: "Severity", width: 11 },
    { header: "Defect", width: 40 }, { header: "Details / reproduction", width: 80 }, { header: "Confirmed by", width: 14 },
  ];
  header(df, 1);
  const sevColor: Record<string, string> = { critical: "FF9B1C1C", major: "FFC2410C", minor: "FF8A5A00", trivial: "FF666666" };
  for (const suite of data.suites)
    for (const c of suite.cases)
      for (const m of MODES)
        for (const d of c[m]?.result?.defects ?? []) {
          const r = df.addRow([suite.name, c.tc.id, m === "manual" ? "Manual" : "Automation", d.severity.toUpperCase(), d.title, d.details, modelName(c[m]!.status.model)]);
          r.getCell(4).font = { bold: true, color: { argb: sevColor[d.severity] ?? "FF333333" } };
        }
  if (df.rowCount === 1) df.addRow(["No defects raised."]);
  wrapAll(df, 2);

  await wb.xlsx.writeFile(outFile);
}

// ---------- PDF / HTML document ----------

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pill = (s?: string) => `<span class="pill ${esc(s ?? "none")}">${esc((s ?? "not run").toUpperCase())}</span>`;

function evidenceImages(exec: ExecRecord, id: string, mode: Mode, max: number): string {
  const dir = path.join(exec.status.runDir, "evidence", `${id}-${mode}`);
  const imgs: string[] = [];
  for (const e of exec.result?.evidence ?? []) {
    const f = path.join(dir, path.basename(e));
    if (!/\.(png|jpe?g)$/i.test(f) || !fs.existsSync(f) || fs.statSync(f).size > 4_000_000) continue;
    imgs.push(`<figure><img src="data:image/${f.endsWith("png") ? "png" : "jpeg"};base64,${fs.readFileSync(f).toString("base64")}"><figcaption>${esc(path.basename(f))}</figcaption></figure>`);
    if (imgs.length >= max) break;
  }
  return imgs.join("");
}

export function buildDocument(data: ReportData, opts: { screenshots: boolean }): string {
  const allCases = data.suites.flatMap((s) => s.cases);
  const tm = tallies(allCases, "manual"), ta = tallies(allCases, "automation");
  const fails = failures(data);
  const rate = (t: typeof tm) => (passRate(t) === null ? "—" : `${Math.round(passRate(t)! * 100)}%`);
  const statBlock = (label: string, t: typeof tm) => `
    <div class="stat"><h3>${label}</h3><div class="big">${rate(t)}</div><div class="muted">pass rate</div>
      <table class="mini"><tr><td>Passed</td><td>${t.passed}</td></tr><tr><td>Failed</td><td>${t.failed}</td></tr>
      <tr><td>Blocked</td><td>${t.blocked}</td></tr><tr><td>Error</td><td>${t.error}</td></tr><tr><td>Not run</td><td>${t.notRun}</td></tr></table></div>`;

  const suiteTables = data.suites.map((s) => `
    <h2>${esc(s.name)}</h2>
    <p class="muted">${esc(s.key)}${s.context ? ` · ${esc(s.context)}` : ""}</p>
    <table class="grid"><thead><tr><th>ID</th><th>Title</th><th>Section</th><th>Manual</th><th>Automation</th><th>Notes</th></tr></thead><tbody>
    ${s.cases.map((c) => `<tr><td class="mono">${esc(c.tc.id)}</td><td>${esc(c.tc.title)}</td><td>${esc(c.section)}</td>
      <td>${pill(c.manual?.status.status)}<div class="muted small">${esc(c.manual ? modelName(c.manual.status.model) : "")}</div></td>
      <td>${pill(c.automation?.status.status)}<div class="muted small">${esc(c.automation ? modelName(c.automation.status.model) : "")}</div></td>
      <td class="small">${esc([c.manual?.status.status !== "passed" ? c.manual?.status.summary : "", c.automation?.status.status !== "passed" ? c.automation?.status.summary : ""].filter(Boolean).join(" / "))}</td></tr>`).join("")}
    </tbody></table>`).join("");

  const failureDocs = fails.map(({ suite, c, mode, exec }, i) => {
    const res = exec.result;
    return `<section class="failure">
      <h3>F-${String(i + 1).padStart(3, "0")} · ${esc(c.tc.id)} — ${esc(c.tc.title)} ${pill(exec.status.status)}</h3>
      <table class="kv">
        <tr><td>Suite</td><td>${esc(suite.name)} (${esc(c.section)})</td></tr>
        <tr><td>Mode</td><td>${mode === "manual" ? "Manual (AI-executed in a live browser)" : "Automation (AI-generated Playwright spec)"}</td></tr>
        <tr><td>Executed</td><td>${esc(when(exec.status.at))} · ${esc(dur(exec.status.durationMs))}${exec.org ? ` · org ${esc(exec.org)}` : ""}</td></tr>
        <tr><td>Model attempts</td><td>${esc(attemptChain(exec))}</td></tr>
        ${exec.status.specFile ? `<tr><td>Spec file</td><td class="mono">${esc(exec.status.specFile)}</td></tr>` : ""}
      </table>
      ${c.tc.description ? `<p>${esc(c.tc.description)}</p>` : ""}
      ${(c.tc.preconditions ?? []).length ? `<h4>Preconditions</h4><ul>${c.tc.preconditions!.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      ${res?.steps?.length
        ? `<h4>What was tried</h4><table class="grid"><thead><tr><th>#</th><th>Step</th><th>Result</th><th>Observed</th></tr></thead><tbody>${res.steps.map((s, k) => `<tr><td>${k + 1}</td><td>${esc(s.step)}</td><td>${pill(s.status)}</td><td>${esc(s.actual)}</td></tr>`).join("")}</tbody></table>`
        : `<h4>Planned steps</h4><ol>${c.tc.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><p class="muted small">The agent did not reach a step-by-step verdict${trails(exec).length ? " — the action log below shows what it actually did" : ""}.</p>`}
      <h4>Expected results</h4><ul>${c.tc.expected.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
      <h4>Why it did not pass</h4><p>${esc(exec.status.summary)}</p>
      ${res?.attempts && res.attempts.length > 1 ? `<h4>Attempt history</h4><table class="grid"><thead><tr><th>Model</th><th>Verdict</th><th>Summary</th></tr></thead><tbody>${res.attempts.map((a) => `<tr><td>${esc(modelName(a.model))}</td><td>${pill(a.status)}</td><td>${esc(a.summary)}</td></tr>`).join("")}</tbody></table>` : ""}
      ${trails(exec).map((t) => `<h4>Agent action log · ${esc(t.model)} (${esc(t.status)})</h4><ol class="trail">${t.lines.map((l) => `<li class="${l.startsWith("»") ? "note" : ""}">${esc(l)}</li>`).join("")}</ol>`).join("")}
      ${res?.defects?.length ? `<h4>Defects raised</h4>${res.defects.map((d) => `<div class="defect ${esc(d.severity)}"><b>[${esc(d.severity.toUpperCase())}] ${esc(d.title)}</b><p>${esc(d.details)}</p></div>`).join("")}` : ""}
      ${opts.screenshots ? (() => { const imgs = evidenceImages(exec, c.tc.id, mode, 4); return imgs ? `<h4>Evidence</h4><div class="shots">${imgs}</div>` : ""; })() : ""}
    </section>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>SF AI Tester — Test Report</title><style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font: 10.5pt/1.5 "Segoe UI", Arial, sans-serif; color: #1f2328; margin: 0; }
  h1 { font-size: 22pt; margin: 0 0 4px; } h2 { font-size: 14pt; margin: 22px 0 2px; border-bottom: 2px solid #1f2328; padding-bottom: 3px; }
  h3 { font-size: 12pt; margin: 0 0 8px; } h4 { font-size: 10pt; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: .06em; color: #555; }
  .muted { color: #6b7280; } .small { font-size: 9pt; } .mono { font-family: Consolas, monospace; }
  .cover { border-bottom: 3px solid #1f2328; padding-bottom: 10px; margin-bottom: 14px; }
  .stats { display: flex; gap: 14px; margin: 14px 0; } .stat { flex: 1; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px 14px; }
  .stat h3 { margin: 0; font-size: 10pt; letter-spacing: .08em; color: #555; } .stat .big { font-size: 26pt; font-weight: 700; }
  table { border-collapse: collapse; width: 100%; } .grid th, .grid td { border: 1px solid #d0d7de; padding: 5px 7px; text-align: left; vertical-align: top; }
  .grid th { background: #f3f4f6; font-size: 9pt; } .grid tr { page-break-inside: avoid; }
  .mini td { padding: 1px 0; font-size: 9.5pt; } .mini td:last-child { text-align: right; font-weight: 600; }
  .kv td { padding: 2px 8px 2px 0; vertical-align: top; } .kv td:first-child { color: #6b7280; width: 120px; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 8pt; font-weight: 700; letter-spacing: .04em; white-space: nowrap; }
  .pill.passed { background: #d6f5dd; color: #1b6b35; } .pill.failed { background: #fad4d4; color: #9b1c1c; }
  .pill.blocked { background: #fdebc8; color: #8a5a00; } .pill.error { background: #e6ddf7; color: #5b3a99; } .pill.none { background: #ededed; color: #777; }
  .failure { border: 1px solid #d0d7de; border-left: 4px solid #9b1c1c; border-radius: 6px; padding: 12px 14px; margin: 14px 0; page-break-inside: auto; }
  .defect { border-left: 3px solid #c2410c; padding: 4px 10px; margin: 6px 0; background: #fff7ed; } .defect p { margin: 2px 0 0; }
  .shots { display: flex; flex-wrap: wrap; gap: 8px; } figure { margin: 0; width: 48%; } figure img { width: 100%; border: 1px solid #d0d7de; } figcaption { font-size: 8pt; color: #6b7280; }
  .pb { page-break-before: always; }
  .trail { font: 8.5pt/1.45 Consolas, monospace; color: #374151; background: #f8fafc; border: 1px solid #e5e7eb; padding: 6px 6px 6px 34px; margin: 0; }
  .trail li { word-break: break-word; } .trail li.note { color: #6b7280; font-style: italic; font-family: "Segoe UI", Arial, sans-serif; }
  </style></head><body>
  <div class="cover"><h1>Salesforce Test Execution Report</h1>
    <div class="muted">Generated ${esc(data.generatedAt.toLocaleString())} by SF AI Tester · Org(s): ${esc(data.orgs.join(", ") || "n/a")} · ${data.suites.length} suite(s), ${allCases.length} test case(s)</div></div>
  <div class="stats">${statBlock("MANUAL TESTING", tm)}${statBlock("AUTOMATION", ta)}
    <div class="stat"><h3>ATTENTION</h3><div class="big">${fails.length}</div><div class="muted">execution(s) not passed</div>
      <table class="mini"><tr><td>Defects raised</td><td>${fails.reduce((n, f) => n + (f.exec.result?.defects.length ?? f.exec.status.defects), 0)}</td></tr>
      <tr><td>Escalated to fallback model</td><td>${allCases.flatMap((c) => MODES.map((m) => c[m])).filter((e) => (e?.result?.attempts?.length ?? 0) > 1).length}</td></tr></table></div></div>
  <p class="muted small">Passed = expected results verified. Failed = the application behaved differently from the expected result (confirmed by the fallback model when escalation is on). Blocked = the test could not run because of the environment (permissions, data, access). Error = an agent or tooling problem. Automation passes are verified by an independent re-run of the generated spec.</p>
  ${data.suites.filter((s) => s.analysis).map((s) => `<h2>AI analysis · ${esc(s.name)}</h2><p><b>${esc(s.analysis!.headline)}</b></p><p>${esc(s.analysis!.summary)}</p>${s.analysis!.groups.map((g) => `<div class="defect"><b>[${esc(g.kind.toUpperCase())}] ${esc(g.title)}</b> <span class="muted">(${esc(g.cases.join(", "))})</span><p>${esc(g.explanation)}</p><p><b>Next step:</b> ${esc(g.nextStep)}</p></div>`).join("")}`).join("")}
  <h2>Results by suite</h2>${suiteTables}
  ${fails.length ? `<h2 class="pb">Failure documentation</h2><p class="muted">Each execution that did not pass, with what the AI tried, what it observed, and why it concluded as it did.</p>${failureDocs}` : `<h2>Failure documentation</h2><p>All executed tests passed.</p>`}
  </body></html>`;
}

/** Renders the document to PDF with the bundled Chromium; also returns the HTML path it rendered from. */
export async function writePdf(data: ReportData, outFile: string, opts: { screenshots: boolean }) {
  const html = buildDocument(data, opts);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({
      path: outFile,
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="font-size:8px;color:#888;width:100%;padding:0 14mm;display:flex;justify-content:space-between"><span>SF AI Tester · Test Execution Report</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  } finally {
    await browser.close();
  }
}
