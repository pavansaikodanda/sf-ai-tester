import * as fs from "fs";
import * as path from "path";
import { sf } from "./sfcli";

/** Compact, test-relevant description of one sObject in the live org. */
export interface ObjectMeta {
  name: string;
  label: string;
  required: { name: string; label: string }[];
  picklists: { name: string; label: string; values: string[] }[];
  validationRules: { name: string; message: string; field?: string }[];
  fieldCount: number;
}

interface Entity {
  name: string;
  label: string;
  plural: string;
}

const SAFE = /^[\w.@+-]+$/;
const DAY = 24 * 3600 * 1000;

/**
 * Reads org metadata through the Salesforce CLI (the same authorisation the project already uses) so the AI works
 * from the org's real rules: which fields are required, the actual picklist values, and active validation rules.
 * Results are cached per org for a day under .sf-ai-tester/meta/.
 */
export class OrgMeta {
  private entities: Entity[] | undefined;
  private cacheFile: string;
  private cache: { savedAt: number; entities?: Entity[]; objects: Record<string, ObjectMeta> };

  constructor(
    private target: string,
    cacheDir: string,
  ) {
    if (!SAFE.test(target)) throw new Error(`Unsupported org target "${target}"`);
    fs.mkdirSync(cacheDir, { recursive: true });
    this.cacheFile = path.join(cacheDir, `${target.replace(/[^\w.-]/g, "_")}.json`);
    let cached: OrgMeta["cache"] | undefined;
    try {
      cached = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
    } catch {
      cached = undefined;
    }
    this.cache = cached && Date.now() - cached.savedAt < DAY ? cached : { savedAt: Date.now(), objects: {} };
  }

  private save() {
    fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache));
  }

  /** All customizable objects with their labels (used to spot which objects a test talks about). */
  private async loadEntities(): Promise<Entity[]> {
    if (this.entities) return this.entities;
    if (this.cache.entities?.length) return (this.entities = this.cache.entities);
    const out = await sf(
      ["data", "query", "--target-org", this.target, "--query",
       "SELECT QualifiedApiName, Label, PluralLabel FROM EntityDefinition WHERE IsCustomizable = true AND IsDeprecatedAndHidden = false"],
      120_000,
    );
    const rows: any[] = out?.result?.records ?? [];
    this.entities = rows
      .map((r) => ({ name: String(r.QualifiedApiName), label: String(r.Label ?? ""), plural: String(r.PluralLabel ?? "") }))
      .filter((e) => /^\w+$/.test(e.name));
    this.cache.entities = this.entities;
    this.save();
    return this.entities;
  }

  /** Objects mentioned in free text (labels, plural labels or API names), most-mentioned first, at most `max`. */
  async detectObjects(text: string, max = 4): Promise<string[]> {
    const entities = await this.loadEntities();
    const hay = ` ${text.toLowerCase()} `;
    const scored: [string, number][] = [];
    for (const e of entities) {
      let score = 0;
      for (const term of new Set([e.label, e.plural, e.name].map((t) => t.toLowerCase()).filter((t) => t.length >= 4))) {
        const re = new RegExp(`[^a-z0-9_]${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^a-z0-9_]`, "g");
        score += (hay.match(re) ?? []).length;
      }
      if (score) scored.push([e.name, score]);
    }
    return scored.sort((a, b) => b[1] - a[1]).slice(0, max).map(([n]) => n);
  }

  /** Describe + active validation rules for the given objects (cached). Objects that fail to describe are skipped. */
  async describe(objects: string[]): Promise<ObjectMeta[]> {
    const missing = objects.filter((o) => /^\w+$/.test(o) && !this.cache.objects[o]);
    // One at a time: concurrent sf processes contend for the CLI's shared config/auth files and fail.
    for (const o of missing) {
      await (async () => {
        const d = await sf(["sobject", "describe", "--sobject", o, "--target-org", this.target], 120_000).catch(() => undefined);
        const r = d?.result;
        if (!r?.fields) return;
        const fields: any[] = r.fields;
        this.cache.objects[o] = {
          name: o,
          label: r.label ?? o,
          fieldCount: fields.length,
          required: fields
            .filter((f) => f.createable && !f.nillable && !f.defaultedOnCreate && f.type !== "boolean")
            .map((f) => ({ name: f.name, label: f.label })),
          picklists: fields
            .filter((f) => (f.type === "picklist" || f.type === "multipicklist") && f.createable)
            .map((f) => ({ name: f.name, label: f.label, values: (f.picklistValues ?? []).filter((v: any) => v.active).map((v: any) => v.label) }))
            .filter((p) => p.values.length),
          validationRules: [],
        };
        this.save();
      })();
    }
    const needRules = missing.filter((o) => this.cache.objects[o]);
    if (needRules.length) {
      const list = needRules.map((o) => `'${o}'`).join(",");
      const vr = await sf(
        ["data", "query", "--use-tooling-api", "--target-org", this.target, "--query",
         `SELECT ValidationName, ErrorMessage, ErrorDisplayField, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = true AND EntityDefinition.QualifiedApiName IN (${list})`],
        120_000,
      ).catch(() => undefined);
      for (const r of vr?.result?.records ?? []) {
        const obj = r.EntityDefinition?.QualifiedApiName;
        this.cache.objects[obj]?.validationRules.push({ name: r.ValidationName, message: r.ErrorMessage ?? "", field: r.ErrorDisplayField || undefined });
      }
    }
    if (missing.length) this.save();
    return objects.map((o) => this.cache.objects[o]).filter(Boolean) as ObjectMeta[];
  }

  /** Detect + describe, returned as compact text for a prompt (empty when nothing relevant was found). */
  async contextFor(text: string): Promise<{ text: string; objects: ObjectMeta[] }> {
    const names = await this.detectObjects(text);
    if (!names.length) return { text: "", objects: [] };
    const objects = await this.describe(names);
    return { text: formatMeta(objects), objects };
  }
}

/**
 * Per-case org context for a run, within a time budget: detects the objects each case mentions, describes their
 * union once (sequentially, cached), then formats each case slice. Anything not ready in time is skipped so
 * metadata can never stall a run.
 */
export async function contextsForCases(
  meta: OrgMeta,
  cases: { id: string; text: string }[],
  budgetMs: number,
  log: (m: string) => void,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const work = (async () => {
    const perCase: Record<string, string[]> = {};
    for (const c of cases) perCase[c.id] = await meta.detectObjects(c.text);
    const union = [...new Set(Object.values(perCase).flat())];
    if (!union.length) return;
    log(`Org metadata: reading ${union.join(", ")} (cached for 24h)...`);
    const described = await meta.describe(union);
    const byName = new Map(described.map((o) => [o.name, o]));
    for (const c of cases) {
      const objs = perCase[c.id].map((n) => byName.get(n)).filter(Boolean) as ObjectMeta[];
      if (objs.length) out[c.id] = formatMeta(objs);
    }
    const rules = described.reduce((n, o) => n + o.validationRules.length, 0);
    log(`Org metadata ready: ${described.length} object(s), ${rules} active validation rule(s).`);
  })();
  const timedOut = await Promise.race([work.then(() => false, (e) => { log(`  (org metadata skipped: ${(e as Error).message})`); return false; }), new Promise<boolean>((r) => setTimeout(() => r(true), budgetMs))]);
  if (timedOut) log(`  (org metadata still loading after ${Math.round(budgetMs / 1000)}s - running without it this time; it will be cached for the next run)`);
  return out;
}

/** Prompt-sized summary of object metadata. */
export function formatMeta(objects: ObjectMeta[]): string {
  return objects
    .map((o) => {
      const lines = [`- ${o.label} (${o.name}), ${o.fieldCount} fields`];
      if (o.required.length) lines.push(`  required on create: ${o.required.slice(0, 25).map((f) => `${f.label} (${f.name})`).join(", ")}`);
      for (const p of o.picklists.slice(0, 15)) {
        const vals = p.values.slice(0, 15).join(" | ") + (p.values.length > 15 ? ` | ...(${p.values.length - 15} more)` : "");
        lines.push(`  picklist ${p.label} (${p.name}): ${vals}`);
      }
      for (const v of o.validationRules.slice(0, 20)) {
        lines.push(`  validation rule ${v.name}${v.field ? ` on ${v.field}` : ""}: "${v.message.replace(/\s+/g, " ").slice(0, 200)}"`);
      }
      return lines.join("\n");
    })
    .join("\n");
}
