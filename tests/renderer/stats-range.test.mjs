import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A zone with daylight saving: 2026-03-08 has 23 hours, 2026-11-01 has 25.
process.env.TZ = "America/New_York";
const range = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "stats-range.mjs")));
const utc = (...parts) => Date.UTC(...parts) / 1_000;

test("day presets start and end at local midnight, across a DST change", () => {
  const now = new Date(2026, 2, 10, 12, 30);
  const seven = range.presetRange("7d", now);
  assert.equal(seven.startUnix, utc(2026, 2, 4, 5)); // Mar 4 00:00 EST
  assert.equal(seven.endUnix, utc(2026, 2, 11, 4)); // Mar 11 00:00 EDT
  assert.equal(seven.endUnix - seven.startUnix, 7 * 86_400 - 3_600);
  const today = range.presetRange("today", new Date(2026, 2, 8, 23, 59));
  assert.equal(today.endUnix - today.startUnix, 23 * 3_600);
  const fall = range.presetRange("today", new Date(2026, 10, 1, 9));
  assert.equal(fall.endUnix - fall.startUnix, 25 * 3_600);
});

test("hour presets end at the next whole minute", () => {
  const now = new Date(2026, 5, 1, 10, 15, 20);
  const hour = range.presetRange("1h", now);
  assert.equal(hour.endUnix, Math.floor(new Date(2026, 5, 1, 10, 16).getTime() / 1_000));
  assert.equal(hour.endUnix - hour.startUnix, 3_600);
  assert.equal(range.presetRange("6h", now).endUnix - range.presetRange("6h", now).startUnix, 21_600);
});

test("a custom range includes both days and rejects invalid input", () => {
  const one = range.presetRange("custom", new Date(), { from: "2026-03-08", to: "2026-03-08" });
  assert.equal(one.startUnix, utc(2026, 2, 8, 5));
  assert.equal(one.endUnix, utc(2026, 2, 9, 4));
  assert.equal(range.presetRange("custom", new Date(), { from: "2026-03-09", to: "2026-03-08" }), null);
  assert.equal(range.presetRange("custom", new Date(), { from: "", to: "2026-03-08" }), null);
  assert.equal(range.presetRange("custom", new Date(), { from: "2026-02-30", to: "2026-03-08" }), null);
  assert.equal(range.presetRange("custom", new Date(), { from: "2010-01-01", to: "2026-03-08" }), null, "longer than 3660 days");
});

test("auto bucket follows the range length", () => {
  const now = new Date(2026, 5, 15, 12);
  const bucket = preset => range.autoBucket(range.presetRange(preset, now));
  assert.equal(bucket("1h"), "tenMinutes");
  assert.equal(bucket("6h"), "tenMinutes");
  assert.equal(bucket("today"), "hour");
  assert.equal(bucket("7d"), "day");
  assert.equal(bucket("90d"), "day");
  const custom = (from, to) => range.autoBucket(range.presetRange("custom", now, { from, to }));
  assert.equal(custom("2026-01-01", "2026-02-01"), "day");
  assert.equal(custom("2025-06-01", "2026-06-01"), "week");
  assert.equal(custom("2020-01-01", "2026-06-01"), "month");
  assert.equal(custom("2026-06-01", "2026-06-02"), "hour", "two days");
});

test("manual buckets too coarse or too fine for the range are disabled", () => {
  const now = new Date(2026, 5, 15, 12);
  const week = range.presetRange("7d", now);
  assert.equal(range.bucketDisabledReason("week", week), null, "7 days across DST still allows weeks");
  assert.equal(range.bucketDisabledReason("month", week), "tooShort");
  assert.equal(range.bucketDisabledReason("week", range.presetRange("today", now)), "tooShort");
  assert.equal(range.bucketDisabledReason("tenMinutes", range.presetRange("90d", now)), "tooLong");
  assert.equal(range.bucketDisabledReason("hour", range.presetRange("30d", now)), null);
  assert.equal(range.resolveBucket("month", week), "day", "an unusable choice falls back to auto");
  assert.equal(range.resolveBucket("hour", week), "hour");
});

test("bucket ends use local calendar boundaries", () => {
  const marchEighth = utc(2026, 2, 8, 5);
  assert.equal(range.bucketEnd(marchEighth, "day"), utc(2026, 2, 9, 4));
  assert.equal(range.bucketEnd(utc(2026, 2, 2, 5), "week"), utc(2026, 2, 9, 4));
  assert.equal(range.bucketEnd(utc(2026, 1, 1, 5), "month"), utc(2026, 2, 1, 5));
  assert.equal(range.bucketEnd(100, "tenMinutes"), 700);
  assert.equal(range.bucketEnd(100, "hour"), 3_700);
  const clipped = range.clipToRange(10, 100, { startUnix: 20, endUnix: 50 });
  assert.deepEqual(clipped, { startUnix: 20, endUnix: 50 });
});

test("comparison wording names the previous period", () => {
  const sevenDays = { startUnix: 0, endUnix: 7 * 86_400 };
  assert.equal(range.compareText(15, 3, sevenDays), "比上一个 7 天多 12");
  assert.equal(range.compareText(3, 15, sevenDays), "比上一个 7 天少 12");
  assert.equal(range.compareText(4, 4, sevenDays), "与上一个 7 天持平");
  assert.equal(range.compareText(5, 1, { startUnix: 0, endUnix: 6 * 3_600 }), "比上一个 6 小时多 4");
  assert.equal(range.compareText(5, 1, { startUnix: 0, endUnix: 86_400 - 3_600 }), "比昨天多 4");
  assert.equal(range.previousPeriodName({ startUnix: 0, endUnix: 7 * 86_400 - 3_600 }), "上一个 7 天");
});

test("bucket chart titles reflect the bucket", () => {
  assert.equal(range.bucketChartTitle("day"), "每日提交");
  assert.equal(range.bucketChartTitle("hour"), "每小时提交");
  assert.equal(range.bucketChartTitle("tenMinutes"), "提交数 · 每 10 分钟");
});

test("typed paths become UTF-8 hex without surrounding slashes", () => {
  assert.equal(range.pathToHex(""), "");
  assert.equal(range.pathToHex("/src/"), Buffer.from("src").toString("hex"));
  assert.equal(range.pathToHex("文档/a.md"), Buffer.from("文档/a.md").toString("hex"));
});
