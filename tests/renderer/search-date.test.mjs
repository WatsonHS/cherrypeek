import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const {
  formatSearchTimeRange,
  hasSubDayTime,
  inputDateRange,
  inputDateTimeRange,
  localDateInput,
  localDateTimeInput,
  presetDateRange,
  presetRelativeHours,
} = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "search-date.mjs")));

test("Los Angeles inclusive local days use the next midnight across both DST transitions", () => {
  const oldTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const springDay = inputDateRange("2026-03-08", "2026-03-08");
    assert.ok(springDay);
    assert.equal(springDay.toTimestamp - springDay.fromTimestamp, 23 * 60 * 60);
    assert.equal(localDateInput(new Date(springDay.toTimestamp * 1_000)), "2026-03-09");

    const fallDay = inputDateRange("2026-11-01", "2026-11-01");
    assert.ok(fallDay);
    assert.equal(fallDay.toTimestamp - fallDay.fromTimestamp, 25 * 60 * 60);
    assert.equal(localDateInput(new Date(fallDay.toTimestamp * 1_000)), "2026-11-02");

    const inclusiveTwoDayRange = inputDateRange("2026-03-07", "2026-03-08");
    assert.ok(inclusiveTwoDayRange);
    assert.equal(localDateInput(new Date(inclusiveTwoDayRange.toTimestamp * 1_000)), "2026-03-09");
    assert.equal(inclusiveTwoDayRange.toTimestamp - inclusiveTwoDayRange.fromTimestamp, 47 * 60 * 60);
  } finally {
    if (oldTz === undefined) delete process.env.TZ;
    else process.env.TZ = oldTz;
  }
});

test("the seven day preset counts local calendar days across a DST boundary", () => {
  const oldTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const range = presetDateRange("7days", new Date(2026, 2, 10, 15, 30));
    assert.equal(localDateInput(new Date(range.fromTimestamp * 1_000)), "2026-03-04");
    assert.equal(localDateInput(new Date(range.toTimestamp * 1_000)), "2026-03-11");
    assert.equal(range.toTimestamp - range.fromTimestamp, 167 * 60 * 60);
  } finally {
    if (oldTz === undefined) delete process.env.TZ;
    else process.env.TZ = oldTz;
  }
});

test("invalid or reversed dates produce no date filter", () => {
  assert.equal(inputDateRange("2026-02-30", "2026-03-01"), null);
  assert.equal(inputDateRange("2026-03-02", "2026-03-01"), null);
  assert.equal(inputDateRange("2026/03/01", "2026-03-02"), null);
});

test("relative hour presets and minute-precise datetime inputs work cleanly", () => {
  const now = new Date(2026, 10, 18, 16, 30, 12);
  const rel = presetRelativeHours(3, now);
  assert.equal(rel.toTimestamp - rel.fromTimestamp, 3 * 3_600);
  assert.equal(localDateTimeInput(new Date(rel.toTimestamp * 1_000)), "2026-11-18T16:31");
  assert.equal(hasSubDayTime(rel.fromTimestamp, rel.toTimestamp), true);
  assert.equal(formatSearchTimeRange(rel.fromTimestamp, rel.toTimestamp), "2026-11-18 13:31 至 2026-11-18 16:30");

  const custom = inputDateTimeRange("2026-11-18T10:15", "2026-11-18T10:15");
  assert.ok(custom);
  assert.equal(custom.toTimestamp - custom.fromTimestamp, 60);
  assert.equal(inputDateTimeRange("2026-11-18T12:00", "2026-11-18T11:59"), null);

  const day = inputDateRange("2026-11-18", "2026-11-18");
  assert.ok(day);
  assert.equal(hasSubDayTime(day.fromTimestamp, day.toTimestamp), false);
  assert.equal(formatSearchTimeRange(day.fromTimestamp, day.toTimestamp), "2026-11-18");
});
