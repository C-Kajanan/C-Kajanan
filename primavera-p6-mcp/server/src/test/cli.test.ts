import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const run = (args: string[], env: Record<string, string> = {}) => {
  const base = { ...(process.env as Record<string, string>) };
  for (const k of Object.keys(base)) if (k.startsWith("P6_")) delete base[k];
  return spawnSync(process.execPath, [cli, ...args], { cwd: examples, env: { ...base, ...env }, encoding: "utf8" });
};

test("runs a tool from --flags and from JSON", () => {
  const flags = run(["xer_list_activities", "--file", "office-building-update1.xer", "--status", "Completed", "--limit", "2"]);
  assert.equal(flags.status, 0, flags.stderr);
  const r = JSON.parse(flags.stdout);
  assert.equal(r.total, 3);
  assert.equal(r.items.length, 2);

  const json = run(["xer_list_activities", JSON.stringify({ file: "office-building-update1.xer", status: ["Completed", "In Progress"] })]);
  assert.equal(JSON.parse(json.stdout).total, 5);
});

test("validates arguments and gates P6 tools", () => {
  const bad = run(["xer_lookahead", "--file", "office-building-update1.xer", "--days", "abc"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Invalid arguments for xer_lookahead/);

  assert.match(run(["p6_list_projects"]).stderr, /needs a P6 server/);
  assert.match(run(["p6_update_activities", "{}"], { P6_BASE_URL: "http://127.0.0.1:9" }).stderr, /P6_ALLOW_WRITES=1/);

  const list = JSON.parse(run(["list"]).stdout);
  assert.ok(list.tools.every((t: { name: string }) => t.name.startsWith("xer_")));
  assert.ok(list.notAvailable.includes("p6_schedule_project"));
});

