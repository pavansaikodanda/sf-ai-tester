// SF AI Tester — Mission Control webview. Vanilla JS, state pushed from the extension host.
(() => {
  const vs = acquireVsCodeApi();
  const saved = vs.getState() || {};
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** @type {any} host state */
  let S = null;
  const ui = {
    selected: new Set(saved.selected || []),
    expanded: new Set(saved.expanded || []),
    collapsed: new Set(saved.collapsed || []),
    filter: saved.filter || "",
    orgDraft: null,
    showPw: false,
    needsUser: null,
    logs: [],
    run: null, // { total, done }
    modal: null,
    gen: { prompt: saved.genPrompt || "", count: 5, explore: false, results: null, busy: false, picked: new Set(), model: "" },
    counts: {},
    adi: { roll: 0, pitch: 0 },
  };
  const persist = () =>
    vs.setState({ selected: [...ui.selected], expanded: [...ui.expanded], collapsed: [...ui.collapsed], filter: ui.filter, genPrompt: ui.gen.prompt, theme: ui.theme });

  // ---------- utils ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const post = (type, data = {}) => vs.postMessage({ type, ...data });
  const $ = (sel, root = document) => root.querySelector(sel);
  const modelShort = (m) => {
    if (!m || m === "default") return "DEFAULT";
    const x = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(m);
    return x ? `${x[1].toUpperCase()} ${x[2]}${x[3] && x[3].length < 3 ? "." + x[3] : ""}` : m.toUpperCase();
  };
  const ago = (t) => {
    if (!t) return "";
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };
  const dur = (ms) => (ms ? (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`) : "");
  const ICON = { idle: "◇", queued: "◌", running: "◈", escalated: "⇪", passed: "✔", failed: "✖", blocked: "⧗", error: "⚠" };
  const LABEL = { idle: "STANDBY", queued: "QUEUED", running: "RUNNING", escalated: "ESCALATED", passed: "PASSED", failed: "FAILED", blocked: "BLOCKED", error: "ERROR" };
  const MODELS = [
    ["claude-haiku-4-5", "Haiku 4.5 — fast, follows instructions"],
    ["claude-sonnet-5-5", "Sonnet 5.5 — stronger reasoning"],
    ["claude-opus-5", "Opus 5 — most thorough"],
  ];

  // ---------- toasts ----------
  const toasts = document.createElement("div");
  toasts.className = "toasts";
  document.body.appendChild(toasts);
  function toast(level, text) {
    const t = document.createElement("div");
    t.className = `toast ${level}`;
    t.textContent = text;
    toasts.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, level === "error" ? 7000 : 3500);
  }

  // ---------- terminal (persistent element) ----------
  const term = document.createElement("div");
  term.className = "term";
  term.innerHTML = '<div class="dim">// telemetry link idle. awaiting mission...</div>';
  function addLog(line) {
    const cls = /^\s*=== .*(PASSED)/.test(line) ? "ok" : /^\s*=== .*(FAILED|ERROR)/.test(line) ? "bad" : /^\s*===/.test(line) ? "h"
      : /^>>>/.test(line) ? "w" : /^\s+(->|\|)/.test(line) ? "dim" : "";
    const stick = term.scrollTop + term.clientHeight >= term.scrollHeight - 30;
    for (const l of String(line).split("\n")) {
      const d = document.createElement("div");
      if (cls) d.className = cls;
      d.textContent = l;
      term.appendChild(d);
    }
    while (term.childElementCount > 600) term.firstElementChild.remove();
    if (stick) term.scrollTop = term.scrollHeight;
  }

  // ---------- derived data ----------
  function podState(id, mode) {
    const live = S.live[`${id}:${mode}`];
    if (live) return { state: live.phase, model: live.model, live: true };
    const st = S.status[id]?.[mode];
    return st ? { state: st.status, ...st } : { state: "idle" };
  }
  function tally() {
    const t = { passed: 0, failed: 0, blocked: 0, error: 0, manual: { passed: 0, run: 0 }, automation: { passed: 0, run: 0 } };
    for (const c of S.suite?.cases || []) {
      for (const m of ["manual", "automation"]) {
        const st = S.status[c.id]?.[m];
        if (!st) continue;
        t[st.status]++;
        t[m].run++;
        if (st.status === "passed") t[m].passed++;
      }
    }
    return t;
  }
  const visibleCases = () => {
    const q = ui.filter.trim().toLowerCase();
    return (S.suite?.cases || []).filter((c) => !q || `${c.id} ${c.title} ${(c.tags || []).join(" ")}`.toLowerCase().includes(q));
  };

  // ---------- render ----------
  function render() {
    if (!S) return;
    const app = $("#app");
    const scroll = window.scrollY;
    applyTheme(S.settings.theme);
    app.innerHTML = [alertBanner(), hud(), hero(), infoBanners(), `<div class="grid">
      <div class="col">${orgPanel()}${paramsPanel()}</div>
      <div class="col">${matrixPanel()}</div>
      <div class="col col-right">${telemetryPanel()}${logPanel()}</div>
    </div>`].join("");
    $("#term-slot").appendChild(term);
    window.scrollTo(0, scroll);
    animateCounts();
    tickClock();
  }

  function alertBanner() {
    if (!ui.needsUser) return "";
    return `<div class="alert"><div class="radar"></div><div><div class="big">AWAITING PILOT INPUT</div><div>${esc(ui.needsUser)}</div></div></div>`;
  }

  // ---------- themes ----------
  const THEMES = [["neon", "NEON"], ["flight", "FLIGHT"], ["stoic", "STOIC"]];
  const QUOTES = [
    "“The impediment to action advances action. What stands in the way becomes the way.” — Marcus Aurelius",
    "“It is not that we have a short time to live, but that we waste a lot of it.” — Seneca",
    "“First say to yourself what you would be; then do what you have to do.” — Epictetus",
    "“Waste no more time arguing what a good test should be. Be one.” — after Marcus Aurelius",
  ];
  function applyTheme(t) {
    const theme = THEMES.some(([id]) => id === t) ? t : "neon";
    if (document.body.dataset.theme !== theme) {
      document.body.dataset.theme = theme;
      ui.theme = theme;
      if (ui.canvasReady) startLoop();
      vs.setState({ ...(vs.getState() || {}), theme });
    }
  }
  applyTheme(saved.theme); // before the first state arrives, so there is no flash of the wrong theme
  const subtitle = () =>
    ui.theme === "stoic" ? QUOTES[Math.floor(Date.now() / 86400000) % QUOTES.length]
    : ui.theme === "flight" ? "SF-AI AVIONICS · COMBAT TEST SYSTEM"
    : "SALESFORCE QA · MISSION CONTROL";

  /** Flight theme only: mission callsign + cockpit instrument cluster (attitude, heading = pass rate, throttle = progress). */
  function hero() {
    if (ui.theme !== "flight") return "";
    const t = tally();
    const executed = t.passed + t.failed + t.blocked + t.error;
    const pct = executed ? Math.round((t.passed / executed) * 100) : 0;
    const total = (S.suite?.cases || []).length;
    const org = S.orgs.find((o) => o.name === S.activeOrg);
    const running = S.busy === "run";
    const thr = running && ui.run?.total ? (ui.run.done / ui.run.total) * 100 : pct;
    const status = running ? "ENGAGED" : S.busy === "gen" ? "PLOTTING" : S.busy === "login" ? "UPLINKING" : "STANDBY";
    return `<div class="hero">
      <div>
        <div class="k">MISSION <b>//</b> ${esc(S.suite?.name || "NO SUITE")} <b>//</b> ${org ? `UPLINK ${esc(org.name.toUpperCase())}` : "NO UPLINK"}</div>
        <div class="big1">${esc((S.suite?.name || "SF AI").toUpperCase())}</div>
        <div class="big2">SORTIE ${String(executed).padStart(3, "0")} · ${total} TARGETS<span class="st ${running ? "hot" : ""}">${status}</span></div>
      </div>
      <div class="cluster">
        <div class="inst"><span class="lbl">ATT</span><div class="adi"><div class="ball" id="adi-ball" style="--roll:${ui.adi.roll}deg;--pitch:${ui.adi.pitch}px"></div><div class="wings"></div></div></div>
        <div class="inst"><span class="lbl">HDG · PASS</span><div class="hdg" style="--hdg:${Math.round(pct * 3.6)}deg"><b>${String(pct).padStart(3, "0")}</b></div></div>
        <div class="inst"><span class="lbl">THR</span><div class="thr" style="--thr:${Math.round(thr)}%"><span></span></div><span class="val">${Math.round(thr)}%</span></div>
        <div class="inst wide"><span class="lbl">SYS</span><div class="rows">
          PRI <b>${esc(modelShort(S.settings.primaryModel))}</b><br>
          SEC <b>${esc(modelShort(S.settings.fallbackModel))}</b><br>
          HIT <b>${t.passed}</b> MISS <b>${t.failed}</b><br>
          JAM <b>${t.blocked}</b> ERR <b>${t.error}</b></div></div>
      </div></div>`;
  }

  // Flight-only overlays: target lock reticle, avionics boot sequence, master caution.
  const lock = document.createElement("div");
  lock.id = "lock";
  lock.innerHTML = "<i></i><i></i><i></i><i></i><span></span>";
  const boot = document.createElement("div");
  boot.id = "boot";
  const caution = document.createElement("div");
  caution.id = "caution";
  caution.innerHTML = "<span>MASTER CAUTION</span>";
  document.body.append(lock, boot, caution);
  function bootSequence() {
    if (reduced) return;
    const lines = [
      "SF-AI AVIONICS <b>v0.4</b> ............ BOOT",
      "INERTIAL NAV ALIGN ............ <b>OK</b>",
      "HUD SYMBOLOGY ................. <b>OK</b>",
      "CLAUDE FLIGHT COMPUTER ........ <b>OK</b>",
      "PLAYWRIGHT WEAPONS BUS ........ <b>ARMED</b>",
      "UPLINK .......................... <b>READY</b>",
    ];
    boot.innerHTML = `<pre>${lines.map((l, i) => `<div class="line" style="animation-delay:${i * 0.18}s">${l}</div>`).join("")}</pre>`;
    boot.classList.remove("on");
    void boot.offsetWidth;
    boot.classList.add("on");
    setTimeout(() => boot.classList.remove("on"), 2000);
  }
  function masterCaution() {
    if (ui.theme !== "flight" || reduced) return;
    caution.classList.remove("on");
    void caution.offsetWidth;
    caution.classList.add("on");
    setTimeout(() => caution.classList.remove("on"), 1500);
  }

  function hud() {
    const org = S.orgs.find((o) => o.name === S.activeOrg);
    const busyTxt = { run: "MISSION ACTIVE", gen: "SYNTHESIZING", login: "ESTABLISHING UPLINK" }[S.busy] || "";
    return `<div class="hud">
      <div><div class="logo"><span class="a">SF</span><span class="b">//</span><span class="a">AI</span> TESTER</div><div class="sub">${esc(subtitle())}</div></div>
      <span class="chip ${org ? "on" : ""}"><span class="dot"></span>${org ? `UPLINK · ${esc(org.name)}` : "NO ORG LINKED"}</span>
      <span class="chip chain" title="Cases run on the primary model; anything short of PASSED is re-run on the fallback model">MODEL <b>${esc(modelShort(S.settings.primaryModel))}</b> <i>⟶</i> <b>${esc(modelShort(S.settings.fallbackModel))}</b></span>
      ${busyTxt ? `<span class="chip warn"><span class="dot"></span>${busyTxt}</span>` : ""}
      <span class="chip" title="Test cases, reports, sessions and generated specs are stored here. Any folder works.">▣ <span style="max-width:220px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:bottom">${esc(S.workspace)}</span>
        <button class="ghost sm" data-act="folder:reveal" title="Open in Explorer">↗</button><button class="ghost sm" data-act="folder:pick">CHANGE</button></span>
      <span class="spacer"></span>
      <span class="theme-switch" title="Theme">${THEMES.map(([id, l]) => `<button class="${ui.theme === id ? "on" : ""}" data-act="set:theme" data-v="${id}">${l}</button>`).join("")}</span>
      <span class="switch ${S.settings.headless ? "on" : ""}" data-act="set:headless" title="Test-execution browser. The login window always appears when you need to verify a passkey.">
        <span>${S.settings.headless ? "HEADLESS" : "VISIBLE"}</span><span class="track"><span class="knob"></span></span></span>
      <span class="clock" id="clock"></span>
    </div>`;
  }

  function infoBanners() {
    const out = [];
    if (S.suiteError) out.push(`<div class="info-banner" style="border-color:var(--red)"><b style="color:var(--red)">Suite file error:</b><span>${esc(S.suiteError)}</span><button class="sm" data-act="suite:file">OPEN FILE</button></div>`);
    return out.join("");
  }

  function orgPanel() {
    const d = ui.orgDraft;
    const tiles = S.orgs.map((o) => `
      <div class="org ${o.name === S.activeOrg ? "active" : ""}" data-act="org:select" data-name="${esc(o.name)}">
        <div class="ico">${esc(o.name.slice(0, 2).toUpperCase())}</div>
        <div class="meta"><div class="n">${esc(o.name)}</div><div class="u">${esc(o.username || o.sfAlias || o.loginUrl)}</div></div>
        <span class="tag">${{ password: "PASSWORD", interactive: "PASSKEY", sfcli: "SF CLI" }[o.authMode]}</span>
        <button class="ghost sm" data-act="org:edit" data-name="${esc(o.name)}" title="Edit">✎</button>
      </div>`).join("");
    const active = S.orgs.find((o) => o.name === S.activeOrg);
    return `<div class="panel">
      <div class="ptitle"><span class="idx">01</span>ORG UPLINK<span class="grow"></span><button class="sm" data-act="org:new">＋ NEW</button></div>
      ${S.orgs.length ? `<div class="orgs">${tiles}</div>` : ""}
      ${!d && active ? `<div class="row"><button class="primary" style="flex:1" data-act="org:login" ${S.busy ? "disabled" : ""}>⟁ ESTABLISH UPLINK</button></div>
        <div class="muted" style="font-size:12.5px;margin-top:8px">Opens the login window. Username &amp; password are typed for you — verify your passkey there. The session is reused for later runs.</div>` : ""}
      ${d ? orgForm(d) : !S.orgs.length ? `<div class="empty"><div class="big">NO ORG LINKED</div>Add the Salesforce org you want to test.<br><br><button class="primary" data-act="org:new">＋ LINK AN ORG</button></div>` : ""}
    </div>`;
  }

  function orgForm(d) {
    const seg = (v, l) => `<button class="${d.authMode === v ? "on" : ""}" data-act="org:auth" data-v="${v}">${l}</button>`;
    return `<div style="border-top:1px dashed var(--line);padding-top:12px;margin-top:4px">
      <label class="f"><span>Org name</span><input type="text" data-bind="org.name" value="${esc(d.name)}" placeholder="UAT, QA Sandbox..."></label>
      <div class="seg">${seg("password", "USER + PASS")}${seg("interactive", "PASSKEY / SSO")}${seg("sfcli", "SF CLI")}</div>
      ${d.authMode !== "sfcli" ? `
        <label class="f"><span>Login URL</span><input type="url" data-bind="org.loginUrl" value="${esc(d.loginUrl)}"></label>
        <div class="presets"><button class="sm" data-act="org:preset" data-v="https://login.salesforce.com">PRODUCTION</button><button class="sm" data-act="org:preset" data-v="https://test.salesforce.com">SANDBOX</button></div>
        <label class="f"><span>Username${d.authMode === "interactive" ? " (optional, pre-filled)" : ""}</span><input type="text" data-bind="org.username" value="${esc(d.username)}" autocomplete="off"></label>` : ""}
      ${d.authMode === "password" ? `<label class="f"><span>Password</span><div class="pw"><input type="${ui.showPw ? "text" : "password"}" data-bind="org.password" value="${esc(d.password)}" placeholder="${d.previousName ? "•••••• unchanged" : ""}" autocomplete="off"><button class="ghost sm" data-act="org:pw">${ui.showPw ? "HIDE" : "SHOW"}</button></div></label>
        <div class="muted" style="font-size:12px;margin:-4px 0 10px">Stored in VS Code SecretStorage. Never sent to the AI.</div>` : ""}
      ${d.authMode === "sfcli" ? `<label class="f"><span>sf CLI alias / username</span><input type="text" data-bind="org.sfAlias" value="${esc(d.sfAlias)}" placeholder="my-uat"></label>
        <div class="muted" style="font-size:12px;margin:-4px 0 10px">Authorise first with <span class="mono">sf org login web -a my-uat</span>. No passkey prompts.</div>` : ""}
      <div class="row end">
        ${d.previousName ? `<button class="danger sm" data-act="org:delete" data-name="${esc(d.previousName)}">DELETE</button><span class="spacer" style="flex:1"></span>` : ""}
        <button class="ghost sm" data-act="org:cancel">CANCEL</button>
        <button class="primary sm" data-act="org:save">SAVE ORG</button>
      </div></div>`;
  }

  function paramsPanel() {
    const st = S.settings;
    const opts = (cur) => {
      const list = MODELS.some(([id]) => id === cur) ? MODELS : [[cur, cur], ...MODELS];
      return list.map(([id, l]) => `<option value="${esc(id)}" ${id === cur ? "selected" : ""}>${esc(l)}</option>`).join("");
    };
    const seg = (v, l) => `<button class="${st.loginMode === v ? "on" : ""}" data-act="set:loginMode" data-v="${v}">${l}</button>`;
    return `<div class="panel">
      <div class="ptitle"><span class="idx">02</span>MISSION PARAMETERS<span class="grow"></span></div>
      <label class="f"><span>Primary model</span><select data-set="primaryModel">${opts(st.primaryModel)}</select></label>
      <label class="f"><span>Fallback model (auto-escalation)</span><select data-set="fallbackModel">${opts(st.fallbackModel)}</select></label>
      <div class="muted" style="font-size:12.5px;margin:-4px 0 12px">Every case runs on the primary model first. Anything that doesn't pass is re-run on the fallback to retry flaky runs and confirm real defects.</div>
      <label class="f"><span>Login window</span></label>
      <div class="seg">${seg("headed", "VISIBLE")}${seg("auto", "AUTO")}${seg("headless", "HIDDEN")}</div>
      <label class="f"><span>Max agent turns per case · <b style="color:var(--cyan)">${st.maxTurns}</b></span><input type="range" min="20" max="200" step="10" value="${st.maxTurns}" data-set="maxTurns" style="width:100%;accent-color:var(--cyan)"></label>
    </div>`;
  }

  function matrixPanel() {
    const cases = visibleCases();
    const all = S.suite?.cases || [];
    const sel = [...ui.selected].filter((id) => all.some((c) => c.id === id));
    const busy = !!S.busy;
    const suites = S.suites.map((s) => `<option value="${esc(s.file)}" ${s.file === S.suiteFile ? "selected" : ""}>${esc(s.label)}</option>`).join("");
    const t = tally();
    return `<div class="panel">
      <div class="ptitle"><span class="idx">03</span>TEST MATRIX<span class="grow"></span>
        <button class="sm" data-act="gen:open" ${busy ? "disabled" : ""}>✦ GENERATE WITH AI</button>
        <button class="sm" data-act="case:new">＋ NEW CASE</button></div>
      <div class="suitebar">
        <select data-act-change="suite:select" title="Suite file">${suites || "<option>No suites</option>"}</select>
        <button class="sm" data-act="suite:new">＋ SUITE</button>
        <button class="sm" data-act="suite:context" title="Shared context sent with every case">CONTEXT</button>
        <button class="sm" data-act="suite:file" title="Open YAML">YAML ↗</button>
      </div>
      ${S.suite?.context ? `<div class="muted" style="font-size:12.5px;margin:-2px 0 10px">◆ ${esc(S.suite.context)}</div>` : ""}
      <div class="toolbar">
        <input type="checkbox" class="check" data-act="sel:all" ${sel.length && sel.length === all.length ? "checked" : ""} title="Select all">
        <input type="text" class="search" data-bind="filter" value="${esc(ui.filter)}" placeholder="⌕  filter by id, title, tag">
        <span class="muted mono" style="font-size:11px">${sel.length} SELECTED</span>
        <button class="sm" data-act="run:sel" data-mode="manual" ${!sel.length || busy ? "disabled" : ""}>▶ MANUAL</button>
        <button class="sm" data-act="run:sel" data-mode="automation" ${!sel.length || busy ? "disabled" : ""}>▶ AUTO</button>
        <button class="primary sm" data-act="run:sel" data-mode="both" ${!sel.length || busy ? "disabled" : ""}>▶▶ RUN BOTH</button>
        ${S.busy === "run" ? `<button class="danger sm" data-act="cancel">■ ABORT</button>` : ""}
        ${sel.length ? `<button class="danger sm" data-act="case:delete-sel" ${busy ? "disabled" : ""}>DELETE</button>` : ""}
      </div>
      ${all.length ? runAllBar(cases, busy) : ""}
      <div class="stats-line">${all.length} CASES · MANUAL <b>${t.manual.passed}/${t.manual.run}</b> PASSED · AUTOMATION <b>${t.automation.passed}/${t.automation.run}</b> PASSED</div>
      <div class="cards">${sectioned(cases) || (all.length ? `<div class="empty">No cases match “${esc(ui.filter)}”.</div>`
        : `<div class="empty"><div class="big">MATRIX EMPTY</div>Generate test cases from a requirement, or write one yourself.<br><br>
            <button class="primary" data-act="gen:open">✦ GENERATE WITH AI</button> <button data-act="case:new">＋ NEW CASE</button></div>`)}</div>
    </div>`;
  }

  /** Section = explicit "section" field, else the ID prefix (ACC-001 -> ACC). */
  const sectionOf = (c) => (c.section && c.section.trim()) || (c.id.includes("-") ? c.id.split("-")[0] : "GENERAL");
  const execCount = (ids, mode) => ids.length * (mode === "both" ? 2 : 1);

  function modeStats(cases, m) {
    const s = { passed: 0, failed: 0, blocked: 0, error: 0 };
    for (const c of cases) {
      const st = S.status[c.id]?.[m]?.status;
      if (st) s[st]++;
    }
    return s;
  }
  function miniBar(cases, m) {
    const s = modeStats(cases, m);
    const n = cases.length || 1;
    const seg = (k, c) => `<span style="width:${(s[k] / n) * 100}%;background:${c}"></span>`;
    return `<span class="minibar" title="${m}: ${s.passed} passed, ${s.failed} failed, ${s.blocked} blocked, ${s.error} error">${seg("passed", "var(--green)")}${seg("failed", "var(--red)")}${seg("blocked", "var(--amber)")}${seg("error", "var(--purple)")}</span>`;
  }

  function runAllBar(cases, busy) {
    const ids = esc(cases.map((c) => c.id).join(","));
    const scope = ui.filter.trim() ? "FILTERED" : "ALL";
    const dis = busy || !cases.length ? "disabled" : "";
    return `<div class="runall">
      <div class="runall-title"><span class="pulse-dot"></span>RUN ${scope} · ${cases.length} CASE${cases.length === 1 ? "" : "S"}</div>
      <div class="row">
        <button class="sm" data-act="run:ids" data-ids="${ids}" data-mode="manual" data-label="${scope} MANUAL" ${dis}>▶ ${scope} MANUAL</button>
        <button class="sm" data-act="run:ids" data-ids="${ids}" data-mode="automation" data-label="${scope} AUTOMATION" ${dis}>▶ ${scope} AUTOMATION</button>
        <button class="primary sm" data-act="run:ids" data-ids="${ids}" data-mode="both" data-label="EVERYTHING" ${dis}>▶▶ RUN EVERYTHING</button>
        ${S.busy === "run" ? `<button class="danger sm" data-act="cancel">■ ABORT</button>` : ""}
      </div></div>`;
  }

  function sectioned(cases) {
    if (!cases.length) return "";
    const groups = new Map();
    for (const c of cases) {
      const k = sectionOf(c);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const busy = !!S.busy;
    let i = 0;
    return [...groups]
      .map(([name, list]) => {
        const ids = esc(list.map((c) => c.id).join(","));
        const closed = ui.collapsed.has(name);
        const allSel = list.every((c) => ui.selected.has(c.id));
        const running = list.some((c) => S.live[`${c.id}:manual`] || S.live[`${c.id}:automation`]);
        const mp = modeStats(list, "manual").passed;
        const ap = modeStats(list, "automation").passed;
        const btn = (mode, label, cls = "") =>
          `<button class="sm ${cls}" data-act="run:ids" data-ids="${ids}" data-mode="${mode}" data-label="${esc(name)} ${label}" ${busy ? "disabled" : ""}>${mode === "both" ? "▶▶" : "▶"} ${label}</button>`;
        const body = closed ? "" : list.map((c) => card(c, i++)).join("");
        return `<section class="section ${running ? "live" : ""}">
          <div class="section-head">
            <input type="checkbox" class="check" data-act="sel:section" data-ids="${ids}" ${allSel ? "checked" : ""} title="Select section">
            <button class="ghost sm" data-act="section:toggle" data-name="${esc(name)}">${closed ? "＋" : "－"}</button>
            <div class="section-name" data-act="section:toggle" data-name="${esc(name)}">${esc(name)}<small>${list.length} case${list.length === 1 ? "" : "s"} · MANUAL ${mp}/${list.length} ${miniBar(list, "manual")} · AUTO ${ap}/${list.length} ${miniBar(list, "automation")}</small></div>
            <div class="row">${btn("manual", "MANUAL")}${btn("automation", "AUTO")}${btn("both", "BOTH", "primary")}</div>
          </div>
          ${closed ? "" : `<div class="section-body">${body}</div>`}
        </section>`;
      })
      .join("");
  }

  function pod(c, mode) {
    const p = podState(c.id, mode);
    const meta = p.live
      ? p.state === "queued" ? "waiting in queue" : `${modelShort(p.model)} · ${p.state === "escalated" ? "second opinion" : "executing"}`
      : p.state === "idle" ? "click to run" : `${modelShort(p.model)} · ${dur(p.durationMs)} · ${ago(p.at)}`;
    return `<div class="pod ${p.state}" data-act="run:pod" data-id="${esc(c.id)}" data-mode="${mode}" data-pod="${esc(c.id)}:${mode}" title="${esc(p.summary || `Run ${mode} test`)}">
      <div class="ring">${ICON[p.state] || "◇"}</div>
      <div class="info"><div class="lbl">${mode === "manual" ? "MANUAL" : "AUTOMATION"}</div><div class="st">${LABEL[p.state] || p.state}</div><div class="mt">${esc(meta)}</div></div>
      <span class="play">${p.live ? "" : "▶ RUN"}</span>
    </div>`;
  }

  function card(c, i) {
    const hot = S.live[`${c.id}:manual`] || S.live[`${c.id}:automation`];
    const open = ui.expanded.has(c.id);
    const st = S.status[c.id] || {};
    const res = (m) => {
      const r = st[m];
      if (!r) return "";
      return `<div class="result-box ${r.status}"><div class="h">${m.toUpperCase()} · ${r.status.toUpperCase()} · ${esc(modelShort(r.model))}${r.defects ? ` · ${r.defects} DEFECT${r.defects > 1 ? "S" : ""}` : ""}</div>
        <div>${esc(r.summary)}</div>
        <div class="row" style="margin-top:6px"><button class="sm" data-act="report:open" data-dir="${esc(r.runDir)}">REPORT ↗</button>${r.specFile ? `<button class="sm" data-act="spec:open" data-file="${esc(r.specFile)}">SPEC ↗</button>` : ""}</div></div>`;
    };
    return `<div class="card ${ui.selected.has(c.id) ? "selected" : ""} ${hot ? "hot" : ""}" data-card="${esc(c.id)}" style="animation-delay:${Math.min(i, 12) * 35}ms">
      <div class="card-head">
        <input type="checkbox" class="check" data-act="sel:one" data-id="${esc(c.id)}" ${ui.selected.has(c.id) ? "checked" : ""}>
        <span class="cid">${esc(c.id)}</span>
        <div class="ctitle" data-act="case:expand" data-id="${esc(c.id)}">${esc(c.title)}<small>${c.steps.length} steps · ${c.expected.length} checks${(c.tags || []).length ? " · " + c.tags.map(esc).join(" · ") : ""}</small></div>
        <div class="cactions"><button class="ghost sm" data-act="case:expand" data-id="${esc(c.id)}">${open ? "－" : "＋"}</button><button class="ghost sm" data-act="case:edit" data-id="${esc(c.id)}" title="Edit">✎</button><button class="ghost sm" data-act="case:delete" data-id="${esc(c.id)}" title="Delete">✕</button></div>
      </div>
      <div class="pods">${pod(c, "manual")}${pod(c, "automation")}</div>
      ${open ? `<div class="detail">
        <div><h4>STEPS</h4><ol>${c.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>
        <div><h4>EXPECTED</h4><ul>${c.expected.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
          ${(c.preconditions || []).length ? `<h4 style="margin-top:10px">PRECONDITIONS</h4><ul>${c.preconditions.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}</div>
        ${st.manual || st.automation ? `<div class="full"><h4>LAST RESULTS</h4>${res("manual")}${res("automation")}</div>` : ""}
      </div>` : ""}
    </div>`;
  }

  function telemetryPanel() {
    const t = tally();
    const executed = t.passed + t.failed + t.blocked + t.error;
    let pct, cap;
    if (ui.run && S.busy === "run") { pct = ui.run.total ? Math.round((ui.run.done / ui.run.total) * 100) : 0; cap = `${ui.run.done}/${ui.run.total} COMPLETE`; }
    else { pct = executed ? Math.round((t.passed / executed) * 100) : 0; cap = executed ? "PASS RATE" : "NO DATA"; }
    const C = 2 * Math.PI * 52;
    const counter = (k, v, c) => `<div class="counter" style="--c:${c}"><div class="v" data-count="${k}">${v}</div><div class="k">${k.toUpperCase()}</div></div>`;
    const bar = (label, m) => {
      const total = (S.suite?.cases || []).length || 1;
      const seg = (s, c) => { const n = (S.suite?.cases || []).filter((x) => S.status[x.id]?.[m]?.status === s).length; return `<span style="width:${(n / total) * 100}%;background:${c};box-shadow:0 0 8px ${c}"></span>`; };
      return `<div class="bar"><div class="k"><span>${label}</span><span>${t[m].passed}/${(S.suite?.cases || []).length}</span></div><div class="t">${seg("passed", "var(--green)")}${seg("failed", "var(--red)")}${seg("blocked", "var(--amber)")}${seg("error", "var(--purple)")}</div></div>`;
    };
    return `<div class="panel">
      <div class="ptitle"><span class="idx">04</span>TELEMETRY<span class="grow"></span></div>
      <div class="ringwrap">
        <div class="bigring"><svg viewBox="0 0 120 120"><defs><linearGradient id="rg" x1="0" x2="1"><stop offset="0" style="stop-color:var(--ring-a)"/><stop offset="1" style="stop-color:var(--ring-b)"/></linearGradient></defs>
          <circle class="orbit" cx="60" cy="60" r="58"/><circle class="track" cx="60" cy="60" r="52"/>
          <circle class="val" cx="60" cy="60" r="52" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/></svg>
          <div class="center"><div><div class="pct"><span data-count="pct">${pct}</span>%</div><div class="cap">${cap}</div></div></div></div>
        <div class="counters">${counter("passed", t.passed, "var(--green)")}${counter("failed", t.failed, "var(--red)")}${counter("blocked", t.blocked, "var(--amber)")}${counter("error", t.error, "var(--purple)")}</div>
      </div>
      <div class="bars">${bar("MANUAL", "manual")}${bar("AUTOMATION", "automation")}</div>
      ${!S.hasPlaywright && S.workspace ? `<div class="info-banner" style="margin:12px 0 0"><span style="font-size:13px">Automation needs <span class="mono">@playwright/test</span> in this folder.</span><button class="sm" data-act="setup:playwright">INSTALL PLAYWRIGHT</button></div>` : ""}
    </div>`;
  }

  function logPanel() {
    return `<div class="panel"><div class="ptitle"><span class="idx">05</span>LIVE FEED<span class="grow"></span><button class="ghost sm" data-act="log:clear">CLEAR</button></div><div id="term-slot"></div></div>`;
  }

  // ---------- count-up ----------
  function animateCounts() {
    document.querySelectorAll("[data-count]").forEach((el) => {
      const k = el.dataset.count;
      const to = Number(el.textContent) || 0;
      const from = ui.counts[k] ?? 0;
      ui.counts[k] = to;
      if (from === to || reduced) return;
      const t0 = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - t0) / 700);
        el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  function tickClock() {
    const el = $("#clock");
    if (el) el.textContent = new Date().toLocaleTimeString([], { hour12: false });
  }
  setInterval(tickClock, 1000);

  // ---------- modals ----------
  let modalRoot = document.createElement("div");
  document.body.appendChild(modalRoot);
  function openModal(html, onMount) {
    modalRoot.innerHTML = `<div class="modal-back" data-act="modal:backdrop"><div class="modal">${html}</div></div>`;
    ui.modal = true;
    onMount?.(modalRoot.querySelector(".modal"));
    modalRoot.querySelector("input,textarea,select")?.focus();
  }
  function closeModal() {
    modalRoot.innerHTML = "";
    ui.modal = null;
  }

  function editor(c) {
    const isNew = !c;
    c = c || { id: nextId(), title: "", steps: [], expected: [], preconditions: [], tags: [] };
    openModal(`<h2>${isNew ? "NEW TEST CASE" : `EDIT ${esc(c.id)}`}</h2>
      <div class="two"><label class="f"><span>ID</span><input type="text" id="e-id" value="${esc(c.id)}"></label>
      <label class="f"><span>Tags (comma separated)</span><input type="text" id="e-tags" value="${esc((c.tags || []).join(", "))}"></label></div>
      <label class="f"><span>Section (groups cases; empty = ID prefix)</span><input type="text" id="e-section" list="e-sections" value="${esc(c.section || "")}" placeholder="${esc(c.id.includes("-") ? c.id.split("-")[0] : "GENERAL")}">
        <datalist id="e-sections">${[...new Set((S.suite?.cases || []).map(sectionOf))].map((s) => `<option value="${esc(s)}">`).join("")}</datalist></label>
      <label class="f"><span>Title</span><input type="text" id="e-title" value="${esc(c.title)}" placeholder="Create a new Account"></label>
      <label class="f"><span>Description</span><input type="text" id="e-desc" value="${esc(c.description || "")}"></label>
      <label class="f"><span>Preconditions — one per line</span><textarea id="e-pre" rows="2">${esc((c.preconditions || []).join("\n"))}</textarea></label>
      <div class="two"><label class="f"><span>Steps — one per line</span><textarea id="e-steps" rows="8" placeholder="Open the Accounts tab&#10;Click New">${esc(c.steps.join("\n"))}</textarea></label>
      <label class="f"><span>Expected results — one per line</span><textarea id="e-exp" rows="8" placeholder="A success toast appears">${esc(c.expected.join("\n"))}</textarea></label></div>
      <div class="row end"><button class="ghost" data-act="modal:close">CANCEL</button><button class="primary" data-act="editor:save" data-orig="${isNew ? "" : esc(c.id)}">SAVE CASE</button></div>`);
  }
  function nextId() {
    const ids = new Set((S.suite?.cases || []).map((c) => c.id));
    for (let n = ids.size + 1; ; n++) { const id = `TC-${String(n).padStart(3, "0")}`; if (!ids.has(id)) return id; }
  }
  const lines = (id) => $(id).value.split("\n").map((s) => s.trim()).filter(Boolean);

  function generator() {
    const g = ui.gen;
    const body = g.busy
      ? `<div class="scanning"><div class="orb"></div><div class="txt">SYNTHESIZING TEST CASES</div><div class="muted">${g.explore ? "Exploring the org read-only, then drafting cases…" : "Drafting cases from your requirement…"} Usually 20–60 seconds.</div><div class="term" id="gen-feed" style="height:130px;width:100%"></div><button class="danger sm" data-act="cancel">ABORT</button></div>`
      : g.results
        ? `<div class="muted">Generated ${g.results.length} case(s) with <b style="color:var(--cyan)">${esc(modelShort(g.model))}</b>. Pick the ones to import:</div>
          <div class="gen-list">${g.results.map((c, i) => `<label class="gen-item" style="animation-delay:${i * 60}ms"><input type="checkbox" class="check" data-act="gen:pick" data-i="${i}" ${g.picked.has(i) ? "checked" : ""}>
            <div><div class="t"><span class="cid">${esc(c.id)}</span> ${esc(c.title)}</div><ol>${c.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
            <div class="muted" style="font-size:12.5px;margin-top:4px">✓ ${c.expected.map(esc).join(" · ")}</div></div></label>`).join("")}</div>
          <div class="row end"><button class="ghost" data-act="gen:back">← REFINE</button><button class="primary" data-act="gen:import" ${g.picked.size ? "" : "disabled"}>IMPORT ${g.picked.size} CASE${g.picked.size === 1 ? "" : "S"}</button></div>`
        : `<label class="f"><span>What should be tested? Requirement, user story or feature</span>
            <textarea id="g-prompt" rows="6" placeholder="As a sales rep, when I convert a qualified Lead, an Account, Contact and optional Opportunity are created. Company and Last Name are required...">${esc(g.prompt)}</textarea></label>
          <div class="two"><label class="f"><span>Number of cases · <b style="color:var(--cyan)" id="g-count-v">${g.count}</b></span><input type="range" id="g-count" min="1" max="15" value="${g.count}" style="width:100%;accent-color:var(--cyan)"></label>
          <label class="f"><span>Ground in the live org</span><span class="switch ${g.explore ? "on" : ""}" data-act="gen:explore" style="margin-top:6px"><span class="track"><span class="knob"></span></span><span>${g.explore ? "EXPLORE ORG (READ-ONLY)" : "FROM REQUIREMENT ONLY"}</span></span></label></div>
          <div class="muted" style="font-size:12.5px;margin-bottom:12px">Uses ${esc(modelShort(S.settings.primaryModel))}, falling back to ${esc(modelShort(S.settings.fallbackModel))}. Exploring the org reads real field labels and picklists but needs a login.</div>
          <div class="row end"><button class="ghost" data-act="modal:close">CANCEL</button><button class="primary" data-act="gen:run">✦ GENERATE  <span class="muted" style="color:#02040a99">Ctrl+↵</span></button></div>`;
    openModal(`<h2>✦ AI TEST SYNTHESIS</h2>${body}`);
  }

  function prompter(title, label, value, onOk) {
    openModal(`<h2>${esc(title)}</h2><label class="f"><span>${esc(label)}</span><textarea id="p-val" rows="3">${esc(value || "")}</textarea></label>
      <div class="row end"><button class="ghost" data-act="modal:close">CANCEL</button><button class="primary" data-act="prompt:ok">CONFIRM</button></div>`);
    ui.onPrompt = onOk;
  }
  function confirmBox(text, onOk, okLabel) {
    openModal(`<h2>${okLabel ? "LAUNCH SEQUENCE" : "CONFIRM"}</h2><p>${esc(text)}</p><div class="row end"><button class="ghost" data-act="modal:close">CANCEL</button><button class="${okLabel ? "primary" : "danger"}" data-act="confirm:ok">${okLabel || "CONFIRM"}</button></div>`);
    ui.onConfirm = onOk;
  }

  // ---------- events ----------
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const a = el.dataset.act;
    if (a === "modal:backdrop" && e.target !== el) return;
    const id = el.dataset.id;
    const find = (i) => S.suite?.cases.find((c) => c.id === i);
    switch (a) {
      case "modal:backdrop": case "modal:close": return closeModal();
      case "org:new": ui.orgDraft = { name: "", authMode: "password", loginUrl: "https://test.salesforce.com", username: "", password: "", sfAlias: "", previousName: null }; return render();
      case "org:edit": { e.stopPropagation(); const o = S.orgs.find((x) => x.name === el.dataset.name); ui.orgDraft = { ...o, username: o.username || "", sfAlias: o.sfAlias || "", password: "", previousName: o.name }; return render(); }
      case "org:cancel": ui.orgDraft = null; return render();
      case "org:auth": ui.orgDraft.authMode = el.dataset.v; return render();
      case "org:preset": ui.orgDraft.loginUrl = el.dataset.v; return render();
      case "org:pw": ui.showPw = !ui.showPw; return render();
      case "org:select": if (el.dataset.name !== S.activeOrg) post("org:select", { name: el.dataset.name }); return;
      case "org:save": { const { previousName, password, ...org } = ui.orgDraft; ui.orgSaving = org.name.trim(); post("org:save", { org, password, previousName }); return; }
      case "org:delete": return confirmBox(`Remove org "${el.dataset.name}" and its stored password?`, () => { ui.orgDraft = null; post("org:delete", { name: el.dataset.name }); });
      case "org:login": return post("org:login", { name: S.activeOrg });
      case "set:headless": return post("settings:update", { key: "headless", value: !S.settings.headless });
      case "set:loginMode": return post("settings:update", { key: "loginMode", value: el.dataset.v });
      case "set:theme":
        // Switch instantly; the host persists it and echoes it back in the next state.
        if (el.dataset.v === "flight" && ui.theme !== "flight") setTimeout(bootSequence, 0);
        S.settings.theme = el.dataset.v;
        render();
        return post("settings:update", { key: "theme", value: el.dataset.v });
      case "folder:pick": return post("folder:pick");
      case "folder:reveal": return post("folder:reveal");
      case "setup:playwright": return post("setup:playwright");
      case "suite:new": return prompter("NEW SUITE", "Suite name", "", (v) => v && post("suite:new", { name: v }));
      case "suite:context": return prompter("SUITE CONTEXT", "Shared context sent with every test (org setup, user profile, apps...)", S.suite?.context, (v) => post("suite:context", { context: v }));
      case "suite:file": return post("suite:openFile");
      case "sel:all": { const all = S.suite?.cases || []; if (el.checked) all.forEach((c) => ui.selected.add(c.id)); else ui.selected.clear(); persist(); return render(); }
      case "sel:one": if (el.checked) ui.selected.add(id); else ui.selected.delete(id); persist(); return render();
      case "case:expand": ui.expanded.has(id) ? ui.expanded.delete(id) : ui.expanded.add(id); persist(); return render();
      case "case:new": return editor(null);
      case "case:edit": return editor(find(id));
      case "case:delete": return confirmBox(`Delete test case ${id}?`, () => post("case:delete", { ids: [id] }));
      case "case:delete-sel": { const ids = [...ui.selected]; return confirmBox(`Delete ${ids.length} selected test case(s)?`, () => { ui.selected.clear(); persist(); post("case:delete", { ids }); }); }
      case "editor:save": {
        const tc = { id: $("#e-id").value, title: $("#e-title").value, description: $("#e-desc").value, preconditions: lines("#e-pre"), steps: lines("#e-steps"), expected: lines("#e-exp"), tags: $("#e-tags").value.split(",").map((s) => s.trim()).filter(Boolean), section: $("#e-section").value.trim() || undefined };
        ui.pendingClose = true;
        return post("case:save", { case: tc, originalId: el.dataset.orig || undefined });
      }
      case "run:pod": {
        if (S.busy) return toast("warn", "A mission is already running — wait for it or abort.");
        if (S.live[`${id}:${el.dataset.mode}`]) return;
        return startRun([id], el.dataset.mode);
      }
      case "run:sel": return startRun([...ui.selected].filter((i) => find(i)), el.dataset.mode);
      case "run:ids": {
        const ids = el.dataset.ids.split(",").filter((i) => find(i));
        const n = execCount(ids, el.dataset.mode);
        if (n > 6) return confirmBox(`Run ${el.dataset.label}: ${n} executions across ${ids.length} case(s)? Each one usually takes 1–3 minutes.`, () => startRun(ids, el.dataset.mode), "LAUNCH");
        return startRun(ids, el.dataset.mode);
      }
      case "section:toggle": {
        const n = el.dataset.name;
        ui.collapsed.has(n) ? ui.collapsed.delete(n) : ui.collapsed.add(n);
        persist();
        return render();
      }
      case "sel:section":
        for (const i of el.dataset.ids.split(",")) el.checked ? ui.selected.add(i) : ui.selected.delete(i);
        persist();
        return render();
      case "cancel": return post("cancel");
      case "report:open": return post("report:open", { runDir: el.dataset.dir });
      case "spec:open": return post("spec:open", { file: el.dataset.file });
      case "log:clear": term.innerHTML = ""; return;
      case "gen:open": ui.gen.results = null; return generator();
      case "gen:explore": ui.gen.prompt = $("#g-prompt")?.value ?? ui.gen.prompt; ui.gen.explore = !ui.gen.explore; return generator();
      case "gen:run": return runGen();
      case "gen:back": ui.gen.results = null; return generator();
      case "gen:pick": { const i = Number(el.dataset.i); el.checked ? ui.gen.picked.add(i) : ui.gen.picked.delete(i); return generator(); }
      case "gen:import": { const cases = ui.gen.results.filter((_, i) => ui.gen.picked.has(i)); closeModal(); ui.gen.results = null; return post("case:import", { cases }); }
      case "prompt:ok": { const v = $("#p-val").value.trim(); closeModal(); return ui.onPrompt?.(v); }
      case "confirm:ok": closeModal(); return ui.onConfirm?.();
    }
  });

  function startRun(ids, mode) {
    if (!ids.length) return;
    if (!S.activeOrg) return toast("warn", "Link an org in ORG UPLINK first.");
    post("run", { ids, mode });
  }
  function runGen() {
    ui.gen.prompt = $("#g-prompt").value;
    ui.gen.count = Number($("#g-count").value);
    persist();
    if (!ui.gen.prompt.trim()) return toast("warn", "Describe what should be tested.");
    ui.gen.busy = true;
    generator();
    post("gen:run", { prompt: ui.gen.prompt, count: ui.gen.count, explore: ui.gen.explore });
  }

  document.addEventListener("input", (e) => {
    const el = e.target;
    const b = el.dataset?.bind;
    if (b?.startsWith("org.")) ui.orgDraft[b.slice(4)] = el.value;
    else if (b === "filter") {
      ui.filter = el.value;
      persist();
      const pos = el.selectionStart;
      render();
      const s = $(".search");
      s.focus();
      s.setSelectionRange(pos, pos);
    } else if (el.id === "g-count") $("#g-count-v").textContent = el.value;
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset?.set) post("settings:update", { key: el.dataset.set, value: el.type === "range" ? Number(el.value) : el.value });
    if (el.dataset?.actChange === "suite:select") post("suite:select", { file: el.value });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ui.modal && !ui.gen.busy) closeModal();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && $("#g-prompt")) runGen();
  });

  // ripple on buttons
  document.addEventListener("pointerdown", (e) => {
    const b = e.target.closest("button, .pod");
    if (!b || b.disabled || reduced) return;
    const r = b.getBoundingClientRect();
    const s = document.createElement("span");
    const size = Math.max(r.width, r.height);
    s.className = "ripple";
    s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    b.appendChild(s);
    setTimeout(() => s.remove(), 600);
  });

  /** Flight: attitude indicator banks/pitches with the mouse; lock-on brackets snap to the hovered pod or card. */
  function flightPointer(e) {
    const ball = document.getElementById("adi-ball");
    if (ball) {
      ui.adi = { roll: Math.round(((e.clientX / innerWidth) - 0.5) * -50), pitch: Math.round(((e.clientY / innerHeight) - 0.5) * 36) };
      ball.style.setProperty("--roll", `${ui.adi.roll}deg`);
      ball.style.setProperty("--pitch", `${ui.adi.pitch}px`);
    }
    const target = !ui.modal && (e.target.closest?.(".pod") || e.target.closest?.(".card"));
    if (!target) { lock.classList.remove("on"); lock.dataset.key = ""; return; }
    const r = target.getBoundingClientRect();
    const key = target.dataset.pod || target.dataset.card;
    Object.assign(lock.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    if (lock.dataset.key !== key) {
      lock.dataset.key = key;
      lock.querySelector("span").textContent = `LOCK ▸ ${key.replace(":", " / ").toUpperCase()}`;
      lock.classList.remove("on");
      void lock.offsetWidth; // restart the lock-in animation
    }
    lock.classList.add("on");
  }
  addEventListener("scroll", () => lock.classList.remove("on"), { passive: true });

  // card tilt + cursor glow
  const glow = $("#cursor-glow");
  document.addEventListener("pointermove", (e) => {
    glow.style.left = `${e.clientX}px`;
    glow.style.top = `${e.clientY}px`;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (reduced) return;
    if (ui.theme === "flight") flightPointer(e);
    const card = e.target.closest?.(".card");
    document.querySelectorAll(".card[data-tilt]").forEach((c) => { if (c !== card) { c.style.transform = ""; delete c.dataset.tilt; } });
    if (card && !ui.modal && ui.theme !== "stoic") {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = `perspective(900px) rotateY(${x * 3}deg) rotateX(${-y * 3}deg)`;
      card.dataset.tilt = "1";
    }
  });

  // ---------- host messages ----------
  window.addEventListener("message", ({ data: m }) => {
    switch (m.type) {
      case "state":
        S = m;
        if (ui.orgSaving && S.orgs.some((o) => o.name === ui.orgSaving)) { ui.orgDraft = null; ui.orgSaving = null; ui.showPw = false; }
        if (ui.pendingClose) { ui.pendingClose = false; closeModal(); }
        return render();
      case "busy":
        if (S) S.busy = m.busy;
        if (m.busy !== "gen" && ui.gen.busy) { ui.gen.busy = false; }
        return render();
      case "log": {
        addLog(m.line);
        const gf = $("#gen-feed");
        if (gf) { const d = document.createElement("div"); d.textContent = m.line; gf.appendChild(d); gf.scrollTop = gf.scrollHeight; }
        return;
      }
      case "toast":
        if (m.level === "error") { ui.pendingClose = false; ui.orgSaving = null; }
        return toast(m.level, m.text);
      case "needsUser": ui.needsUser = m.message; return render();
      case "run:start": ui.run = { total: m.total, done: 0 }; addLog(`>>> MISSION START · ${m.total} execution(s) · org ${m.org}`); return;
      case "live": {
        S.live[`${m.id}:${m.mode}`] = { phase: m.phase, model: m.model };
        if (m.phase === "escalated") toast("warn", `${m.id} ${m.mode}: escalating to ${modelShort(m.model)}`);
        return render();
      }
      case "caseDone": {
        if (ui.run) ui.run.done++;
        const r = m.result;
        const flightWord = { passed: "SPLASH — TARGET DOWN", failed: "MISS — DEFECT CONFIRMED", blocked: "JAMMED", error: "SYSTEM FAULT" }[r.status];
        toast(r.status === "passed" ? "ok" : r.status === "failed" ? "error" : "warn", ui.theme === "flight"
          ? `${r.id} ${r.mode.toUpperCase()}: ${flightWord} (${modelShort(r.model)})`
          : `${r.id} ${r.mode}: ${r.status.toUpperCase()} (${modelShort(r.model)})`);
        if (r.status === "failed" || r.status === "error") masterCaution();
        requestAnimationFrame(() => document.querySelector(`[data-pod="${CSS.escape(`${r.id}:${r.mode}`)}"]`)?.classList.add("flash"));
        return;
      }
      case "run:end": {
        const p = m.results.filter((r) => r.status === "passed").length;
        toast(p === m.results.length ? "ok" : "warn", `Mission complete · ${p}/${m.results.length} passed`);
        ui.run = null;
        return;
      }
      case "gen:result":
        ui.gen.busy = false;
        if (m.error) { ui.gen.results = null; if (ui.modal) generator(); toast("error", m.error); return; }
        ui.gen.results = m.cases;
        ui.gen.model = m.model;
        ui.gen.picked = new Set(m.cases.map((_, i) => i));
        return generator();
      case "needsPlaywright": return render();
    }
  });

  // ---------- background: reactive particle field ----------
  const cv = $("#bg");
  const ctx = cv.getContext("2d");
  const mouse = { x: -9999, y: -9999 };
  let W = 0, H = 0, pts = [];
  function resize() {
    W = cv.width = innerWidth * devicePixelRatio;
    H = cv.height = innerHeight * devicePixelRatio;
    cv.style.width = innerWidth + "px";
    cv.style.height = innerHeight + "px";
    const n = Math.min(110, Math.round((innerWidth * innerHeight) / 16000));
    pts = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25, r: Math.random() * 1.6 + 0.4 }));
  }
  /** Exactly one animation loop at a time (theme switches and tab visibility restart it). */
  let looping = false;
  function startLoop() {
    if (looping || reduced || document.hidden || ui.theme === "stoic") return;
    looping = true;
    requestAnimationFrame(frame);
  }

  // Flight theme: stratosphere with a 3D wireframe terrain flying toward the viewer (afterburner while a mission
  // runs) and a live HUD layer - pitch ladder, flight-path marker, heading / speed / altitude tapes - driven by the mouse.
  const stars = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random() * 0.55, r: Math.random() * 1.2 + 0.2, p: Math.random() * 6 }));
  const fly = { z: 0, speed: 0, fpmX: 0.5, fpmY: 0.45, roll: 0, alt: 32800 };
  const HUD = (a) => `rgba(88,245,196,${a})`;
  const terrainH = (x, z) => {
    const valley = Math.min(1, Math.abs(x) * 1.6) ** 1.6; // flat corridor down the middle, ridges at the sides
    return (Math.sin(x * 7.3 + z * 0.9) * 0.5 + Math.sin(x * 17.1 - z * 1.7) * 0.25 + Math.sin(z * 0.45 + x * 3.1) * 0.6 + 1.2) * valley;
  };
  function flightFrame(t, d, mx, my, active) {
    const tx = mx / Math.max(W, 1), ty = my / Math.max(H, 1);
    fly.speed += ((active ? 0.09 : 0.025) - fly.speed) * 0.02;
    fly.z += fly.speed;
    fly.fpmX += ((mx > 0 ? tx : 0.5) - fly.fpmX) * 0.05;
    fly.fpmY += ((my > 0 ? ty : 0.45) - fly.fpmY) * 0.05;
    fly.roll += (((mx > 0 ? tx : 0.5) - 0.5) * -0.5 - fly.roll) * 0.05;
    fly.alt += (active ? 3 : 0.6) * Math.sin(t / 2000);
    const horizon = H * (0.3 + (fly.fpmY - 0.45) * 0.1);

    // stars (twinkle, fade toward the horizon)
    for (const s of stars) {
      const a = (0.35 + 0.35 * Math.sin(t / 700 + s.p)) * (1 - s.y / 0.6);
      ctx.fillStyle = `rgba(210,255,240,${a})`;
      ctx.fillRect(s.x * W, s.y * horizon, s.r * d, s.r * d);
    }
    // horizon glow
    const hg = ctx.createLinearGradient(0, horizon - 60 * d, 0, horizon + 40 * d);
    hg.addColorStop(0, "rgba(255,138,31,0)"); hg.addColorStop(0.7, "rgba(255,138,31,0.18)"); hg.addColorStop(1, "rgba(255,138,31,0)");
    ctx.fillStyle = hg; ctx.fillRect(0, horizon - 60 * d, W, 100 * d);

    // wireframe terrain: rows of a height field projected in perspective, scrolling toward the viewer
    const rows = 56, cols = 56, depth = 26, camH = 1.1, fov = W * 0.55, cx = W / 2 + (fly.fpmX - 0.5) * -W * 0.1;
    const K = (H - horizon) * 0.55; // near rows reach the bottom of the screen
    const zOff = fly.z % 1;
    const proj = [];
    for (let r = 0; r < rows; r++) {
      const zRel = (r - zOff) * (depth / rows) + 0.6;
      const zWorld = Math.floor(fly.z) + r;
      const row = [];
      for (let c = 0; c <= cols; c++) {
        const xn = (c / cols - 0.5) * 2;
        const h = terrainH(xn, zWorld * 0.35);
        row.push([cx + (xn * fov) / zRel, horizon + ((camH - h * 0.55) * K) / zRel]);
      }
      proj.push({ row, fade: 1 - r / rows });
    }
    ctx.lineWidth = d;
    for (const { row, fade } of proj) {
      ctx.strokeStyle = HUD(0.05 + fade * 0.35);
      ctx.beginPath();
      row.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    for (let c = 0; c <= cols; c += 2) {
      ctx.strokeStyle = HUD(0.12);
      ctx.beginPath();
      proj.forEach(({ row }, r) => (r ? ctx.lineTo(row[c][0], row[c][1]) : ctx.moveTo(row[c][0], row[c][1])));
      ctx.stroke();
    }
    // afterburner speed streaks while a mission runs
    if (fly.speed > 0.04) {
      for (let i = 0; i < 26; i++) {
        const ang = (i / 26) * Math.PI * 2 + i;
        const p = ((t / 6 + i * 97) % 400) / 400;
        const r0 = (40 + p * 900) * d, r1 = r0 + 60 * p * d;
        ctx.strokeStyle = `rgba(255,170,90,${0.35 * p})`;
        ctx.beginPath(); ctx.moveTo(W / 2 + Math.cos(ang) * r0, H * 0.5 + Math.sin(ang) * r0 * 0.6);
        ctx.lineTo(W / 2 + Math.cos(ang) * r1, H * 0.5 + Math.sin(ang) * r1 * 0.6); ctx.stroke();
      }
    }

    // HUD: pitch ladder rotating with roll, centered on the flight-path marker
    const fx = fly.fpmX * W, fy = fly.fpmY * H;
    ctx.save();
    ctx.translate(W / 2, H * 0.5);
    ctx.rotate(fly.roll);
    ctx.strokeStyle = HUD(0.22); ctx.fillStyle = HUD(0.35);
    ctx.font = `${10 * d}px "Share Tech Mono", monospace`; ctx.textAlign = "left";
    for (let p = -30; p <= 30; p += 10) {
      const y = (p + (fly.fpmY - 0.45) * 40) * 7 * d;
      if (p === 0) { ctx.beginPath(); ctx.moveTo(-W * 0.4, y); ctx.lineTo(W * 0.4, y); ctx.stroke(); continue; }
      ctx.setLineDash(p < 0 ? [8 * d, 6 * d] : []);
      ctx.beginPath(); ctx.moveTo(-140 * d, y); ctx.lineTo(-50 * d, y); ctx.lineTo(-50 * d, y + (p > 0 ? 8 : -8) * d);
      ctx.moveTo(140 * d, y); ctx.lineTo(50 * d, y); ctx.lineTo(50 * d, y + (p > 0 ? 8 : -8) * d); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(String(Math.abs(p)), 146 * d, y + 4 * d);
    }
    ctx.restore();
    // flight-path marker
    ctx.strokeStyle = HUD(0.7); ctx.lineWidth = 2 * d;
    ctx.beginPath(); ctx.arc(fx, fy, 9 * d, 0, 7);
    ctx.moveTo(fx - 26 * d, fy); ctx.lineTo(fx - 9 * d, fy); ctx.moveTo(fx + 9 * d, fy); ctx.lineTo(fx + 26 * d, fy);
    ctx.moveTo(fx, fy - 9 * d); ctx.lineTo(fx, fy - 18 * d); ctx.stroke();
    ctx.lineWidth = d;

    // heading tape (top), speed tape (left), altitude tape (right)
    const heading = (fly.fpmX * 360 + t / 500) % 360;
    const y0 = 6 * d, step = 10 * d;
    ctx.strokeStyle = HUD(0.45); ctx.fillStyle = HUD(0.6); ctx.textAlign = "center";
    for (let deg = Math.floor(heading - 40); deg <= heading + 40; deg++) {
      const x = W / 2 + (deg - heading) * step;
      const major = ((deg % 10) + 10) % 10 === 0;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + (major ? 9 : 4) * d); ctx.stroke();
      if (major) ctx.fillText(String(((deg % 360) + 360) % 360).padStart(3, "0"), x, y0 + 20 * d);
    }
    const speed = Math.round(420 + fly.speed * 6000);
    const tape = (x, value, unit, alignRight) => {
      ctx.textAlign = alignRight ? "right" : "left";
      for (let k = -6; k <= 6; k++) {
        const y = H * 0.5 + (k * 26 - (value % 26)) * d;
        ctx.strokeStyle = HUD(0.3 - Math.abs(k) * 0.035);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (alignRight ? -10 : 10) * d, y); ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,138,31,0.9)";
      ctx.font = `${13 * d}px "Oxanium", sans-serif`;
      ctx.fillText(`${Math.round(value)} ${unit}`, x + (alignRight ? -14 : 14) * d, H * 0.5 + 4 * d);
      ctx.font = `${10 * d}px "Share Tech Mono", monospace`;
    };
    tape(8 * d, speed, "KT", false);
    tape(W - 8 * d, fly.alt, "FT", true);
  }

  function frame(t) {
    ctx.clearRect(0, 0, W, H);
    const d = devicePixelRatio;
    const mx = mouse.x * d, my = mouse.y * d;
    const active = S?.busy === "run" || S?.busy === "gen";
    if (ui.theme === "stoic" || document.hidden) { looping = false; return; } // Stoic is still; restarted on theme change
    if (ui.theme === "flight") {
      flightFrame(t, d, mx, my, active);
      requestAnimationFrame(frame);
      return;
    }
    // perspective grid floor
    ctx.strokeStyle = "rgba(30,227,255,0.06)";
    ctx.lineWidth = 1;
    const horizon = H * 0.62, off = ((t / (active ? 18 : 60)) % 40) * d;
    for (let y = horizon; y < H; y += 40 * d * ((y - horizon) / H + 0.25)) {
      ctx.beginPath(); ctx.moveTo(0, y + off * ((y - horizon) / H)); ctx.lineTo(W, y + off * ((y - horizon) / H)); ctx.stroke();
    }
    for (let i = -20; i <= 20; i++) { ctx.beginPath(); ctx.moveTo(W / 2 + i * 12 * d, horizon); ctx.lineTo(W / 2 + i * 140 * d, H); ctx.stroke(); }
    // particles
    for (const p of pts) {
      const dx = mx - p.x, dy = my - p.y, dist = Math.hypot(dx, dy);
      if (dist < 180 * d) { p.vx += (dx / dist) * 0.012; p.vy += (dy / dist) * 0.012; }
      const speed = active ? 2.2 : 1;
      p.x += p.vx * speed; p.y += p.vy * speed;
      p.vx *= 0.995; p.vy *= 0.995;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      for (let j = i + 1; j < pts.length; j++) {
        const b = pts[j], dd = Math.hypot(a.x - b.x, a.y - b.y);
        if (dd < 130 * d) { ctx.strokeStyle = `rgba(${active ? "180,76,255" : "30,227,255"},${0.14 * (1 - dd / (130 * d))})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      }
      ctx.fillStyle = "rgba(160,240,255,0.7)";
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r * d, 0, 7); ctx.fill();
    }
    requestAnimationFrame(frame);
  }
  addEventListener("resize", resize);
  document.addEventListener("visibilitychange", startLoop);
  resize();
  ui.canvasReady = true;
  startLoop();

  post("ready");
})();
