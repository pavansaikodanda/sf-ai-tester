import * as vscode from "vscode";

/** Activity-bar sidebar: a compact launch pad for the Mission Control console. */
export class LauncherView implements vscode.WebviewViewProvider {
  static readonly id = "sfAiTester.launcher";

  constructor(
    private ctx: vscode.ExtensionContext,
    private open: () => unknown,
  ) {}

  private view: vscode.WebviewView | undefined;

  /** Re-renders after the org list changes (e.g. the project org was picked up). */
  refresh() {
    if (this.view) this.resolveWebviewView(this.view);
  }

  resolveWebviewView(view: vscode.WebviewView) {
    const first = !this.view;
    this.view = view;
    view.webview.options = { enableScripts: true };
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join("");
    const orgs = this.ctx.globalState.get<{ name: string; source?: string }[]>("sfAiTester.orgs", []);
    const activeName = this.ctx.globalState.get<string>("sfAiTester.activeOrg");
    const active = orgs.find((o) => o.name === activeName) ?? orgs[0];
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{margin:0;padding:16px 12px;font-family:var(--vscode-font-family);color:#cfe9ff;background:transparent}
.card{position:relative;border:1px solid #1ee3ff55;border-radius:10px;padding:16px 14px;background:linear-gradient(160deg,#07121fcc,#0b0620cc);overflow:hidden}
.card:before{content:"";position:absolute;inset:-40%;background:conic-gradient(from 0deg,transparent 0 70%,#1ee3ff33 80%,transparent 90%);animation:spin 6s linear infinite}
.inner{position:relative}
h1{font-size:13px;letter-spacing:.25em;margin:0 0 4px;color:#1ee3ff;text-shadow:0 0 8px #1ee3ff99}
p{font-size:11.5px;opacity:.75;margin:0 0 14px;line-height:1.5}
button{width:100%;padding:11px 8px;font-weight:700;letter-spacing:.2em;font-size:11.5px;color:#02040a;border:0;border-radius:6px;cursor:pointer;
background:linear-gradient(90deg,#1ee3ff,#b44cff);box-shadow:0 0 18px #1ee3ff66;transition:transform .15s,box-shadow .15s}
button:hover{transform:translateY(-1px);box-shadow:0 0 28px #b44cffaa}
.orgs{margin-top:14px;font-size:11px;opacity:.8}.orgs b{color:#1ee3ff}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#21ff9a;box-shadow:0 0 8px #21ff9a;margin-right:6px;animation:pulse 1.6s infinite}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style></head><body>
<div class="card"><div class="inner">
<h1>MISSION CONTROL</h1>
<p>Configure orgs, generate &amp; manage test cases, and run AI manual + automation testing.</p>
<button id="go">LAUNCH CONSOLE</button>
<div class="orgs">${active ? `<span class="dot"></span>Active org: <b>${esc(active.name)}</b>${active.source === "project" ? " · from this Salesforce project" : ""}${orgs.length > 1 ? `<br><span style="opacity:.7">${orgs.length} orgs linked</span>` : ""}` : "No orgs linked yet"}</div>
</div></div>
<script nonce="${nonce}">const vs=acquireVsCodeApi();document.getElementById('go').onclick=()=>vs.postMessage('open');</script>
</body></html>`;
    if (first) view.webview.onDidReceiveMessage(() => this.open());
  }
}
