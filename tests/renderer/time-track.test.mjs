import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const {
  dayStartSeconds,
  followProgressFor,
  localDay,
  relativeDay,
  timeTrackBounds,
  viewportReadingSeconds,
  windowSpanFor,
} = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "time-track.mjs")));

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

test("timeTrackBounds pins top and oldest to exact commit timestamps without future midnight padding", () => {
  const DAY = 86_400;
  const oldestDay = dayStartSeconds("2026-08-01");
  const newestDay = dayStartSeconds("2026-11-17");
  const newestSeconds = newestDay + 1 * 3600 + 6 * 60;
  const oldestSeconds = oldestDay + 22 * 3600 + 15 * 60;
  const observedLater = dayStartSeconds("2026-11-18") + 14 * 3600 + 23 * 60;
  const days = [
    { start: oldestDay, count: 4 },
    { start: newestDay, count: 8 },
  ];

  const exact = timeTrackBounds(days, { newestSeconds, oldestSeconds, nowSeconds: observedLater });
  assert.deepEqual(exact, { oldest: oldestSeconds, top: newestSeconds });

  // When a narrower subset is passed while full activity stats still record an older/newer active day, keep the full span.
  const subset = timeTrackBounds(
    [
      { start: oldestDay - 5 * DAY, count: 2 },
      ...days,
      { start: newestDay + DAY, count: 3 },
    ],
    { newestSeconds, oldestSeconds, nowSeconds: observedLater },
  );
  assert.deepEqual(subset, { oldest: oldestDay - 5 * DAY, top: newestDay + 2 * DAY });

  assert.deepEqual(timeTrackBounds([], { newestSeconds, oldestSeconds }), { oldest: oldestSeconds, top: newestSeconds });
  assert.equal(timeTrackBounds([]), null);
});

test("followProgressFor tracks cumulative commit share monotonically from 0 at top to 1 at bottom", () => {
  const DAY = 86_400;
  const oldestDay = dayStartSeconds("2026-11-10");
  const newestDay = dayStartSeconds("2026-11-17");
  const top = newestDay + 1 * 3600 + 6 * 60;
  const oldest = oldestDay + 12 * 3600;
  const days = [
    { start: oldestDay, count: 10 },
    { start: dayStartSeconds("2026-11-13"), count: 20 },
    { start: newestDay, count: 10 },
  ];
  const bounds = { oldest, top };

  assert.equal(followProgressFor(days, bounds, top), 0);
  assert.equal(followProgressFor(days, bounds, oldest), 1);
  assert.equal(followProgressFor(days, bounds, oldest, { atTop: true }), 0);
  assert.equal(followProgressFor(days, bounds, top, { atBottom: true }), 1);
  assert.equal(followProgressFor(days, bounds, top, { fullWindowScrollRatio: 0.42 }), 0.42);

  const probes = [
    top,
    newestDay,
    dayStartSeconds("2026-11-13") + 18 * 3600,
    dayStartSeconds("2026-11-13") + 6 * 3600,
    oldestDay + 18 * 3600,
    oldest,
  ];
  const values = probes.map(moment => followProgressFor(days, bounds, moment));
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(values[index] >= values[index - 1], `progress increases monotonically (${values[index - 1]} -> ${values[index]})`);
  }
  assert.ok(values[2] > 0.25 && values[2] < 0.75);
});

test("viewportReadingSeconds interpolates rows, handles topo inversions at edges, and reaches oldest at bottom", () => {
  const base = 1_794_900_000;
  // Simulate --topo-order where samples[0] is slightly older than samples[1] (branch commit),
  // and samples[9] is slightly newer than samples[8].
  const samples = Array.from({ length: 10 }, (_, index) => ({
    top: 34 + index * 60,
    bottom: 34 + (index + 1) * 60,
    seconds: index === 0 ? base - 300 : index === 9 ? base - 750 : base - index * 100,
  }));
  const newestSeconds = base - 100;
  const oldestSeconds = base - 800;
  const scrollHeight = 34 + 10 * 60 + 24;
  const clientHeight = 300;
  const maxScroll = scrollHeight - clientHeight;

  // At scrollTop = 0 when newest is loaded, reading equals newestSeconds despite topo inversion.
  assert.equal(viewportReadingSeconds(samples, {
    scrollTop: 0,
    clientHeight,
    scrollHeight,
    readingOffsetPx: 34,
    atNewest: true,
    atOldest: true,
    newestSeconds,
    oldestSeconds,
  }), newestSeconds);

  // Smoothly ramps away from top instead of jumping backward instantly.
  const nearTop = viewportReadingSeconds(samples, {
    scrollTop: 30,
    clientHeight,
    scrollHeight,
    readingOffsetPx: 34,
    atNewest: true,
    atOldest: true,
    newestSeconds,
    oldestSeconds,
  });
  assert.ok(nearTop !== null && nearTop <= newestSeconds && nearTop > samples[0].seconds);

  // Smooth interpolation between adjacent monotonic rows (samples[3] at top 214 -> base-300, samples[4] at top 274 -> base-400).
  const mid = viewportReadingSeconds(samples, {
    scrollTop: 210,
    clientHeight,
    scrollHeight,
    readingOffsetPx: 34,
    atNewest: true,
    atOldest: false,
    newestSeconds,
    oldestSeconds: null,
  });
  assert.ok(mid !== null && Math.abs(mid - (base - 350)) < 0.01, `expected midpoint around ${base - 350}, got ${mid}`);

  // Near bottom sweeps across remaining rows down to oldestSeconds at maxScroll.
  const nearBottom = viewportReadingSeconds(samples, {
    scrollTop: maxScroll - 40,
    clientHeight,
    scrollHeight,
    readingOffsetPx: 34,
    atNewest: true,
    atOldest: true,
    newestSeconds,
    oldestSeconds,
  });
  assert.ok(nearBottom !== null && nearBottom < base - 500 && nearBottom > oldestSeconds);

  assert.equal(viewportReadingSeconds(samples, {
    scrollTop: maxScroll,
    clientHeight,
    scrollHeight,
    readingOffsetPx: 34,
    atNewest: true,
    atOldest: true,
    newestSeconds,
    oldestSeconds,
  }), oldestSeconds);
});
