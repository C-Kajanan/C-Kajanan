import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildToolSpecs } from "../skill/buildSpec.js";
import { checkArgs, type ToolSpec } from "../skill/spec.js";

const skillDir = fileURLToPath(new URL("../../../skill/primavera-p6/", import.meta.url));
const script = skillDir + "scripts/p6.mjs";
const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: skillDir, encoding: "utf8" });
const specOf = (name: string) => buildToolSpecs().find((tool) => tool.name === name)!;

test("committed skill files are up to date with the tool definitions", () => {
  const committed: ToolSpec[] = JSON.parse(readFileSync(skillDir + "scripts/tools.json", "utf8"));
  assert.deepEqual(committed, buildToolSpecs(), "run `npm run build:skill`");
});

test("argument checker applies defaults and rejects bad input", () => {
  const spec = specOf("xer_list_activities");
  const args = checkArgs(spec, { file: "a.xer", status: "Completed", maxFloat: "-1" });
  assert.deepEqual(args.status, ["Completed"]);
  assert.equal(args.maxFloat, -1);
  assert.equal(args.limit, 200);
  assert.throws(() => checkArgs(spec, {}), /Missing required argument "file"/);
  assert.throws(() => checkArgs(spec, { file: "a.xer", status: ["Done"] }), /a list of: Not Started, In Progress, Completed/);
  assert.throws(() => checkArgs(spec, { file: "a.xer", limit: 0 }), /at least 1/);
  assert.throws(() => checkArgs(spec, { file: "a.xer", bogus: 1 }), /Unknown argument bogus/);
  assert.deepEqual(checkArgs(specOf("xer_query_table"), { file: "a", table: "TASK", where: { proj_id: "1" } }).where, { proj_id: "1" });
});

test("bundled skill script runs the XER tools", () => {
  const listed = JSON.parse(run(["list"]).stdout);
  assert.ok(listed.length === 13 && listed.every((tool: { name: string }) => tool.name.startsWith("xer_")));

  const health = run(["xer_schedule_health", "--file", "examples/office-building-update1.xer"]);
  assert.equal(health.status, 0, health.stderr);
  assert.equal(JSON.parse(health.stdout).checks.length, 14);

  const json = run(["xer_list_activities", JSON.stringify({ file: "examples/office-building-update1.xer", status: ["Completed"] })]);
  assert.equal(JSON.parse(json.stdout).total, 3);

  const bad = run(["xer_lookahead", "--file", "examples/office-building-update1.xer", "--days", "abc"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /"days" must be a number/);

  assert.match(run(["p6_list_projects"]).stderr, /Unknown tool/);
});

test("bundled skill script has no network, environment or process access", () => {
  const source = readFileSync(script, "utf8");
  for (const pattern of [/fetch\(/, /process\.env/, /base64/i, /https?:\/\//, /child_process/, /\beval\(/, /new Function/, /\.exec\(/, /writeFile/]) {
    assert.doesNotMatch(source, pattern);
  }
});
