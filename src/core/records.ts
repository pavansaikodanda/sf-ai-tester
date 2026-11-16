import { OrgMeta } from "./orgmeta";
import { sf } from "./sfcli";

/**
 * A quoted name in a step: "Acme" or 'Acme' (Search the list for "Acme" and open that Account). Single quotes must
 * stand on their own, so the apostrophe in "the account's list" never opens a name.
 */
const QUOTED = /"([^"]{3,120})"|(?<![\w'])'([^']{3,120})'(?![\w'])/g;
const quotedNames = (s: string) => [...s.matchAll(QUOTED)].map((m) => (m[1] ?? m[2]).trim());
/** Steps that go to an existing record. */
const OPENS = /\b(open|find|search|go to|navigate)\b/i;
/** Values the Windows shell wrapper in sf() cannot pass safely. */
const UNSAFE = /["%^&\\]/;

/**
 * Resolves the records a case's steps name to direct Lightning URLs, before the run, through the sf CLI. Finding a
 * record through list views is the slowest thing an agent does on a Salesforce page (a record nobody has opened is not
 * in "Recently Viewed", list search needs Enter, etc.); one SOQL query per object replaces all of that.
 * Returns per-case prompt text. Anything not ready within the budget is skipped, so it can never stall a run.
 */
export async function recordLinks(
  meta: OrgMeta,
  target: string,
  /** May still be resolving (the browser login): the lookup runs alongside it and only waits for this at the end. */
  instanceUrl: string | Promise<string>,
  cases: { id: string; steps: string[] }[],
  budgetMs: number,
  log: (m: string) => void,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // The login can fail after the budget has returned and before this is awaited: observe it so that is never an
  // unhandled rejection (a later await still sees the error).
  if (typeof instanceUrl !== "string") instanceUrl.catch(() => undefined);
  const perCase = new Map<string, { object: string; name: string }[]>();
  const found = new Map<string, { id: string; count: number }>();
  // The budget covers the org queries only; waiting for the instance URL (the login) happens after it.
  // Past the deadline the caller has moved on, so no further sf query is started (they would only compete with the run).
  const deadline = Date.now() + budgetMs;
  const late = () => Date.now() >= deadline;
  const work = (async () => {
    const byObject = new Map<string, Set<string>>();
    for (const c of cases) {
      const refs: { object: string; name: string }[] = [];
      // Names an earlier step already used (entered, created, renamed...) may belong to a record this case makes or
      // replaces itself - a link looked up before the run would point at the wrong (or a deleted) record.
      const earlier = new Set<string>();
      for (const step of c.steps) {
        const inStep = quotedNames(step);
        const fresh = inStep.filter((n) => !earlier.has(n.toLowerCase()));
        inStep.forEach((n) => earlier.add(n.toLowerCase()));
        if (!OPENS.test(step)) continue;
        const names = fresh.filter((n) => !UNSAFE.test(n));
        if (!names.length) continue;
        // Detect the object from the step without its quoted names ("AI-TEST GST Flagged Quote" is an Account, not a Quote).
        const objects = await meta.detectObjects(step.replace(QUOTED, " "), 2);
        if (late()) return;
        for (const object of objects) {
          for (const name of names) {
            refs.push({ object, name });
            if (!byObject.has(object)) byObject.set(object, new Set());
            byObject.get(object)!.add(name);
          }
        }
      }
      if (refs.length) perCase.set(c.id, refs);
    }
    if (!byObject.size) return;

    // One object at a time: concurrent sf processes contend for the CLI's shared auth files.
    for (const [object, names] of byObject) {
      if (late()) return;
      if (!/^\w+$/.test(object)) continue;
      const list = [...names].map((n) => `'${n.replace(/'/g, "\\'")}'`).join(",");
      const res = await sf(
        ["data", "query", "--target-org", target, "--query", `SELECT Id, Name FROM ${object} WHERE Name IN (${list}) ORDER BY CreatedDate DESC LIMIT 200`],
        60_000,
      ).catch(() => undefined);
      for (const r of res?.result?.records ?? []) {
        const key = `${object}:${String(r.Name).toLowerCase()}`;
        const hit = found.get(key);
        if (hit) hit.count++;
        else found.set(key, { id: String(r.Id), count: 1 }); // newest first
      }
    }
  })();
  const ok = await Promise.race([
    work.then(() => true, (e) => { log(`  (record lookup skipped: ${(e as Error).message})`); return false; }),
    new Promise<boolean>((r) => setTimeout(() => r(false), budgetMs)),
  ]);
  if (!ok) {
    if (!found.size) log(`  (record lookup not ready after ${Math.round(budgetMs / 1000)}s - running without it)`);
    return out;
  }

  const base = (await instanceUrl).replace(/\/+$/, "");
  let total = 0;
  for (const [id, refs] of perCase) {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const { object, name } of refs) {
      const key = `${object}:${name.toLowerCase()}`;
      const hit = found.get(key);
      if (!hit || seen.has(key)) continue;
      seen.add(key);
      const dup = hit.count > 1 ? ` (${hit.count} records have this name - this is the newest)` : "";
      lines.push(`- ${object} "${name}": ${base}/lightning/r/${object}/${hit.id}/view${dup}`);
    }
    if (lines.length) {
      out[id] = lines.join("\n");
      total += lines.length;
    }
  }
  if (total) log(`Record links: ${total} record(s) named in the steps resolved to direct URLs.`);
  return out;
}
