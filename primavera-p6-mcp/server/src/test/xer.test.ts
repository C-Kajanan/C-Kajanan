import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { compareSchedules, criticalPath, dcmaCheck, drivingPath, filterActivities, summary } from "../analysis.js";
import { buildSchedule, findActivity } from "../schedule.js";
import { decodeXer, loadXer, parseXer } from "../xer.js";

const example = (n: number) => fileURLToPath(new URL(`../../../examples/office-building-update${n}.xer`, import.meta.url));
const s1 = () => buildSchedule(loadXer(example(1)));
const s2 = () => buildSchedule(loadXer(example(2)));

test("parses tables, fields and rows", () => {
  const xer = parseXer("ERMHDR\t22.12\t2026-01-01\tProject\tADMIN\r\n%T\tTASK\r\n%F\ttask_id\ttask_code\r\n%R\t1\tA1\r\n%R\t2\tA2\r\n%T\tTASKPRED\r\n%F\ttask_pred_id\r\n%E\r\n");
  assert.equal(xer.version, "22.12");
  assert.deepEqual(xer.tables.get("TASK"), [{ task_id: "1", task_code: "A1" }, { task_id: "2", task_code: "A2" }]);
  assert.deepEqual(xer.tables.get("TASKPRED"), []);
  assert.throws(() => parseXer("not an xer"), /not an XER file/);
});

test("decodes Windows-1252 and UTF-8", () => {
  assert.equal(decodeXer(new Uint8Array([0x43, 0x61, 0x66, 0xe9])), "Café"); // cp1252 é
  assert.equal(decodeXer(new TextEncoder().encode("﻿Café")), "Café");
});

test("builds the schedule model", () => {
  const s = s1();
  assert.equal(s.projectCode, "OFFICE-01");
  assert.equal(s.projectName, "Office Building");
  assert.equal(s.dataDate, "2026-03-02 08:00");
  const a = findActivity(s, "A2010");
  assert.equal(a.status, "In Progress");
  assert.equal(a.originalDurationDays, 15);
  assert.equal(a.remainingDurationDays, 5);
  assert.equal(a.totalFloatDays, -5);
  assert.equal(a.wbsCode, "SUB");
  assert.equal(a.assignments.length, 2);
  assert.deepEqual(a.succs.map((r) => `${r.succ.id} ${r.type} ${r.lagDays}`).sort(), ["A2020 FS 0", "A2030 SS 3"]);
});

test("summary and filters", () => {
  const s = s1();
  const sum = summary(s);
  assert.equal(sum.activities, 13);
  assert.equal(sum.finishActivity?.id, "M9000");
  assert.equal(sum.negativeFloat, 7);
  assert.deepEqual(filterActivities(s, { status: ["Completed"] }).map((a) => a.id), ["M1000", "A1010", "A1020"]);
  assert.deepEqual(filterActivities(s, { minFloat: 10 }).map((a) => a.id).sort(), ["A2030", "A3020"]);
  assert.deepEqual(filterActivities(s, { resource: "crane" }).map((a) => a.id), ["A3010"]);
});

test("critical and driving paths", () => {
  const s = s1();
  const cp = criticalPath(s).activities.map((a) => a.id);
  assert.deepEqual(cp, ["A2010", "A2020", "A3010", "A3030", "A4010", "A4020", "M9000"]);
  const dp = drivingPath(s, findActivity(s, "M9000"));
  assert.deepEqual(dp.path.map((p) => p.id), ["A2010", "A2020", "A3010", "A3030", "A4010", "A4020", "M9000"]);
  assert.ok(dp.path.every((p) => !p.drives || p.drives.gapDays === 0), "Fri→Mon and leads count as no gap");
});

test("DCMA 14-point check finds the planted problems", () => {
  const r = dcmaCheck(s1());
  const c = Object.fromEntries(r.checks.map((x) => [x.id, x]));
  assert.equal(r.checks.length, 14);
  assert.equal(c[2].count, 1); // one lead
  assert.equal(c[3].count, 1); // one lag
  assert.equal(c[4].pass, true); // 90% FS
  assert.deepEqual(c[5].examples, ["A3030 Facade and glazing"]); // Finish On or Before
  assert.deepEqual(c[6].examples, ["A2030 Underground services"]);
  assert.equal(c[7].pass, false);
  assert.deepEqual(c[8].examples, ["A3010 Structural frame"]);
  assert.equal(c[9].pass, true);
  assert.deepEqual(c[11].examples, ["A2010 Bulk excavation"]);
  assert.equal(c[12].pass, true);
  assert.equal(c[13].value, 0.97);
  assert.equal(c[14].value, 0.75);
});

test("compares two updates", () => {
  const r = compareSchedules(s1(), s2());
  assert.equal(r.projectFinishSlipDays, 7);
  assert.equal(r.dataDateMovedDays, 28);
  assert.deepEqual(r.added.map((a) => a.id), ["A4015"]);
  assert.equal(r.counts.newlyCompleted, 2);
  assert.deepEqual(r.logicAdded, ["A3010 -> A4015 FS", "A4015 -> A4020 FS"]);
  assert.deepEqual(r.lagChanged, ["A2010 -> A2030 SS lag 5d (was 3d)"]);
  assert.equal((r.changed[0] as { finishSlipDays: number }).finishSlipDays, 7);
});
