import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const {
  basePosition, bucketIndexForDay, buildTimeScale, chooseGranularity, fisheye, magnificationFor, nearestActiveBucket, stepActiveBucket,
} = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "time-scale.mjs")));

const now = new Date(2026, 10, 8);

test("granularity is the finest one whose buckets fit the rail", () => {
  assert.equal(chooseGranularity(30, 600), "day");
  assert.equal(chooseGranularity(400, 600), "day");
  assert.equal(chooseGranularity(1_000, 600), "week");
  assert.equal(chooseGranularity(4_000, 600), "month");
  assert.equal(chooseGranularity(40_000, 600), "year");
});

test("day buckets run newest first, keep gaps as empty buckets and jump to their own day", () => {
  const { granularity, buckets } = buildTimeScale([
    { day: "2026-11-08", count: 3 }, { day: "2026-11-05", count: 1 }, { day: "2026-11-05", count: 2 }, { day: "bad", count: 9 },
  ], 600, now);
  assert.equal(granularity, "day");
  assert.deepEqual(buckets.map(bucket => [bucket.startDay, bucket.count]),
    [["2026-11-08", 3], ["2026-11-07", 0], ["2026-11-06", 0], ["2026-11-05", 3]]);
  assert.equal(buckets[0].label, "11 月 8 日 周日");
  assert.equal(buckets[3].jumpDay, "2026-11-05");
});

test("week buckets start on Monday and never jump past the newest commit day", () => {
  const days = [];
  for (let ordinal = Date.UTC(2023, 0, 2); ordinal <= Date.UTC(2026, 10, 4); ordinal += 86_400_000 * 3) {
    days.push({ day: new Date(ordinal).toISOString().slice(0, 10), count: 1 });
  }
  const { granularity, buckets } = buildTimeScale(days, 600, now);
  assert.equal(granularity, "week");
  for (const bucket of buckets) assert.equal(new Date(`${bucket.startDay}T00:00:00Z`).getUTCDay(), 1, `${bucket.startDay} is a Monday`);
  assert.equal(buckets[0].jumpDay, days.at(-1).day, "the newest week jumps to the newest commit day, not to Sunday");
  assert.equal(buckets[1].jumpDay, buckets[1].endDay);
  assert.match(buckets.find(bucket => bucket.startDay.startsWith("2025")).label, /^2025 年 /, "earlier years are named");
  const yearStarts = buckets.filter(bucket => bucket.yearStart).map(bucket => bucket.startDay.slice(0, 4));
  assert.deepEqual(yearStarts, ["2025", "2024", "2023", "2022"].filter(year => buckets.some(bucket => bucket.startDay.startsWith(year))).slice(0, yearStarts.length));
});

test("month buckets cover whole months with Chinese labels", () => {
  const { granularity, buckets } = buildTimeScale([{ day: "2026-02-10" }, { day: "2010-03-01" }], 300, now);
  assert.equal(granularity, "month");
  assert.equal(buckets[0].startDay, "2026-02-01");
  assert.equal(buckets[0].endDay, "2026-02-28");
  assert.equal(buckets[0].label, "2026 年 2 月");
  assert.equal(buckets[0].jumpDay, "2026-02-10");
  assert.equal(buckets.at(-1).startDay, "2010-03-01");
});

test("the fisheye keeps the focus and both ends in place and never reorders buckets", () => {
  for (const focus of [0, 0.2, 0.5, 0.93, 1]) {
    assert.equal(fisheye(focus, focus, 8), focus);
    assert.equal(fisheye(0, focus, 8), 0);
    assert.equal(fisheye(1, focus, 8), 1);
    let previous = -1;
    for (let index = 0; index < 200; index += 1) {
      const position = fisheye(basePosition(index, 200), focus, 8);
      assert.ok(position > previous, `monotonic at ${index} for focus ${focus}`);
      previous = position;
    }
  }
  const near = fisheye(basePosition(101, 200), 0.5, 8) - fisheye(basePosition(100, 200), 0.5, 8);
  assert.ok(near > 5 / 200, `neighbours of the focus spread out: ${near * 200}x`);
  assert.equal(fisheye(0.3, 0.5, 0), 0.3);
});

test("magnification targets about 20px between buckets at the focus, and none when already spaced", () => {
  assert.equal(magnificationFor(600, 10), 0);
  assert.ok(Math.abs(magnificationFor(600, 400) - (20 / 1.5 - 1)) < 1e-9);
  assert.equal(magnificationFor(600, 4000), 14);
});

test("hover and keys only land on buckets with commits", () => {
  const { buckets } = buildTimeScale([{ day: "2026-11-08" }, { day: "2026-11-04" }, { day: "2026-11-01" }], 600, now);
  const positions = buckets.map((_, index) => basePosition(index, buckets.length));
  assert.equal(buckets[nearestActiveBucket(buckets, positions, positions[3])].startDay, "2026-11-04", "a gap snaps to the nearest bucket with commits");
  assert.equal(stepActiveBucket(buckets, 0, 1), 4);
  assert.equal(stepActiveBucket(buckets, 4, 1), 7);
  assert.equal(stepActiveBucket(buckets, 7, 1), 7, "stays at the oldest");
  assert.equal(stepActiveBucket(buckets, 2, -1), 0, "from a gap, one step newer is the next newer bucket");
  assert.equal(stepActiveBucket(buckets, 2, 1), 4, "from a gap, one step older is the next older bucket");
  assert.equal(stepActiveBucket(buckets, 4, -buckets.length), 0, "Home lands on the newest bucket");
  assert.equal(bucketIndexForDay(buckets, "2026-11-04"), 4);
  assert.equal(bucketIndexForDay(buckets, "2020-01-01"), -1);
  assert.equal(nearestActiveBucket([], [], 0.5), -1);
});
