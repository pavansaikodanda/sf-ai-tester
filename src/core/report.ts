import * as fs from "fs";
import * as path from "path";
import { CaseResult } from "./types";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function writeReport(runDir: string, suiteName: string, orgLabel: string, results: CaseResult[]): string {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const cost = results.reduce((a, r) => a + r.costUsd, 0);

  const cases = results
    .map((r) => {
      const evDir = `evidence/${r.id}-${r.mode}`;
      const evidence = r.evidence
        .map((e) => path.basename(e))
        .filter((e) => fs.existsSync(path.join(runDir, evDir, e)))
        .map((e) => `<a href="${esc(`${evDir}/${e}`)}" target="_blank"><img src="${esc(`${evDir}/${e}`)}" alt="${esc(e)}"></a>`)
        .join("");
      return `
<details class="case ${r.status}" ${r.status !== "passed" ? "open" : ""}>
  <summary><span class="pill ${r.status}">${r.status}</span> <b>${esc(r.id)}</b> ${esc(r.title)}
    <span class="meta">${r.mode} · ${(r.durationMs / 1000).toFixed(0)}s · ${r.turns} turns · $${r.costUsd.toFixed(2)}</span></summary>
  <p>${esc(r.summary)}</p>
  ${r.specFile ? `<p class="meta">Spec: <code>${esc(r.specFile)}</code></p>` : ""}
  ${r.steps.length ? `<table><tr><th>#</th><th>Step</th><th>Status</th><th>Observed</th></tr>${r.steps
    .map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.step)}</td><td><span class="pill ${s.status}">${s.status}</span></td><td>${esc(s.actual)}</td></tr>`)
    .join("")}</table>` : ""}
  ${r.defects.length ? `<h4>Defects</h4><ul>${r.defects
    .map((d) => `<li><b>[${esc(d.severity)}] ${esc(d.title)}</b><br>${esc(d.details)}</li>`)
    .join("")}</ul>` : ""}
  ${evidence ? `<div class="evidence">${evidence}</div>` : ""}
</details>`;
    })
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(suiteName)} – SF AI Tester</title>
<style>
:root{--bg:#fff;--fg:#1b1b1f;--muted:#6b6b76;--line:#e3e3e8;--pass:#1a7f37;--fail:#cf222e;--block:#9a6700;--err:#8250df}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#ececf1;--muted:#9a9aa5;--line:#2c2c33}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:24px 16px}
.meta{color:var(--muted);font-size:12px;margin-left:8px}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.stats div{border:1px solid var(--line);border-radius:8px;padding:8px 14px}
.case{border:1px solid var(--line);border-radius:8px;margin:10px 0;padding:10px 14px}summary{cursor:pointer}
.pill{font-size:11px;font-weight:600;text-transform:uppercase;padding:1px 7px;border-radius:10px;color:#fff}
.passed{--c:var(--pass)}.failed{--c:var(--fail)}.blocked{--c:var(--block)}.error{--c:var(--err)}.pill{background:var(--c)}
table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border-top:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}
.evidence{display:flex;gap:8px;flex-wrap:wrap}.evidence img{height:120px;border:1px solid var(--line);border-radius:4px}
</style></head><body>
<h1>${esc(suiteName)}</h1><div class="meta">${esc(orgLabel)} · ${new Date().toLocaleString()}</div>
<div class="stats"><div>Total <b>${results.length}</b></div><div style="color:var(--pass)">Passed <b>${count("passed")}</b></div>
<div style="color:var(--fail)">Failed <b>${count("failed")}</b></div><div style="color:var(--block)">Blocked <b>${count("blocked")}</b></div>
<div style="color:var(--err)">Error <b>${count("error")}</b></div><div>Est. cost <b>$${cost.toFixed(2)}</b></div></div>
${cases}
</body></html>`;
  const file = path.join(runDir, "report.html");
  fs.writeFileSync(file, html);
  return file;
}
