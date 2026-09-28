import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";
import { TestCase, TestSuite } from "./types";

/** Loads a suite from .yaml/.yml/.json. Accepts either a suite object or a bare list of cases. */
export function loadSuite(file: string): TestSuite {
  const raw = fs.readFileSync(file, "utf8");
  const parsed = file.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
  const suite: TestSuite = Array.isArray(parsed)
    ? { name: path.basename(file), cases: parsed }
    : { name: parsed.name ?? path.basename(file), context: parsed.context, cases: parsed.cases ?? [] };

  if (!suite.cases.length) throw new Error(`${file}: no test cases found (expected a "cases" list)`);
  suite.cases.forEach((c, i) => validateCase(c, `${file} case #${i + 1}`));
  const ids = new Set<string>();
  for (const c of suite.cases) {
    if (ids.has(c.id)) throw new Error(`${file}: duplicate test case id "${c.id}"`);
    ids.add(c.id);
  }
  return suite;
}

function validateCase(c: TestCase, where: string) {
  if (!c || typeof c !== "object") throw new Error(`${where}: not an object`);
  if (!c.id) throw new Error(`${where}: missing "id"`);
  if (!/^[A-Za-z0-9_-]+$/.test(c.id)) throw new Error(`${where}: id "${c.id}" may only contain letters, digits, _ and -`);
  if (!c.title) throw new Error(`${where}: missing "title"`);
  if (!Array.isArray(c.steps) || !c.steps.length) throw new Error(`${where}: "steps" must be a non-empty list`);
  if (!Array.isArray(c.expected) || !c.expected.length) throw new Error(`${where}: "expected" must be a non-empty list`);
}
