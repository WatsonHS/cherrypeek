import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { dayStartSeconds, localDay, relativeDay, windowSpanFor } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "time-track.mjs")));

test("local days and their midnights round-trip", () => {
  const midnight = dayStartSeconds("2026-11-03");
  assert.equal(localDay(midnight), "2026-11-03");
  assert.equal(localDay(midnight + 86_399), "2026-11-03");
  assert.equal(localDay(midnight - 1), "2026-11-02");
  assert.equal(new Date(midnight * 1000).getHours(), 0);
});

test("relative days read naturally", () => {
  assert.equal(relativeDay("2026-11-08", "2026-11-08"), "今天");
  assert.equal(relativeDay("2026-11-07", "2026-11-08"), "昨天");
  assert.equal(relativeDay("2026-10-29", "2026-11-08"), "10 天前");
  assert.equal(relativeDay("2026-05-08", "2026-11-08"), "约 6 个月前");
  assert.equal(relativeDay("2023-11-08", "2026-11-08"), "约 3 年前");
});

test("the time window holds about the target number of commits and rounds to fixed lengths", () => {
  const DAY = 86_400;
  const start = dayStartSeconds("2026-08-01");
  const dailyDays = (perDay, count = 100) => Array.from({ length: count }, (_, index) => ({ start: start + index * DAY, count: perDay }));
  const anchor = start + 60 * DAY + 12 * 3600;
  assert.equal(windowSpanFor(dailyDays(300), anchor, 2700), 10 * DAY, "300 commits a day: 9 days rounds up to 10");
  assert.equal(windowSpanFor(dailyDays(20, 300), anchor, 2700), 180 * DAY, "20 commits a day: 135 days rounds up to 180");
  assert.equal(windowSpanFor(dailyDays(20), anchor, 2700), 120 * DAY, "fewer commits than the target: the whole 100 days, rounded up");
  assert.equal(windowSpanFor(dailyDays(10_000), anchor, 2700), 0.5 * DAY, "one very busy day: about a quarter day rounds up to half a day");
  assert.equal(windowSpanFor(dailyDays(1, 30), start + 15 * DAY, 2700), 30 * DAY, "a short history fits whole");
  assert.equal(windowSpanFor([], anchor, 2700), DAY);
  const bursty = [...dailyDays(5, 50), { start: start + 50 * DAY, count: 3000 }];
  assert.equal(windowSpanFor(bursty, start + 50 * DAY + 3600, 2700), DAY, "a burst right at the anchor keeps the window to a day");
});
