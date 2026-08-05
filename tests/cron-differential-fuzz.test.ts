// `nextCronTime` against an INDEPENDENT constructive reference.
//
// The two implementations disagree about method, not just about code: the
// production one walks forward day by day from `after` and asks "does this day
// match?"; the reference below CONSTRUCTS candidate instants —
// `Date.UTC(y, m, d, h, min)` with a round-trip check that throws out
// non-existent dates like 30 February — and takes the smallest one after
// `after`. A shared bug would have to be a shared misunderstanding of the
// POSIX dom/dow OR rule, which is why that rule is spelled out separately in
// each.
//
// This is the fuzzer that pins the leap-day class: a `29 2 *` pattern can be
// four years out, or eight across a century boundary (2100 is not a leap
// year). The search window used to be 366 days, so those patterns threw, and
// `handleCron` deleted the schedule permanently while blaming the pattern.
//
// Knobs: CRON_FUZZ_CASES (default 3000), CRON_FUZZ_SEED.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type CronFields,
  nextCronTime,
  parseCron,
} from "../src/state/schedule.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

const CASES = fuzzEnvInt("CRON_FUZZ_CASES", 3000, 1);
const SEED = fuzzEnvInt("CRON_FUZZ_SEED", 20260804, 1);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── The independent reference ───────────────────────────────────────

/** Does `y-m-d` exist? Built by round-tripping through Date.UTC, so the
 *  calendar rules (leap years, month lengths, the 1900/2000 century rules)
 *  come from the platform rather than from a table this file wrote. */
function realDate(y: number, m: number, d: number): number | null {
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return (back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 &&
      back.getUTCDate() === d)
    ? t
    : null;
}

/** The smallest instant strictly after `afterMs` (rounded up to the next whole
 *  minute) that the pattern matches, or null within `years`. Constructive:
 *  enumerate the candidate y/m/d/h/min directly instead of stepping time. */
function refNextCron(
  f: CronFields,
  afterMs: number,
  years = 12,
): number | null {
  const from = new Date(afterMs);
  from.setUTCSeconds(0, 0);
  const floor = from.getTime() + 60_000; // "starting from the minute after"
  const startYear = new Date(floor).getUTCFullYear();
  // POSIX: when BOTH day fields are restricted the day matches on EITHER;
  // otherwise both must match. (Stated here from the spec, not shared with the
  // implementation under test.)
  const domRestricted = f.dom.length < 31;
  const dowRestricted = f.dow.length < 7;
  for (let y = startYear; y <= startYear + years; y++) {
    for (const m of f.month) {
      for (let d = 1; d <= 31; d++) {
        const dayStart = realDate(y, m, d);
        if (dayStart === null) continue; // 30 Feb, 31 Apr, …
        const dow = new Date(dayStart).getUTCDay();
        const dayOk = domRestricted && dowRestricted
          ? (f.dom.includes(d) || f.dow.includes(dow))
          : ((!domRestricted || f.dom.includes(d)) &&
            (!dowRestricted || f.dow.includes(dow)));
        if (!dayOk) continue;
        for (const h of f.hour) {
          for (const min of f.minute) {
            const t = dayStart + h * 3_600_000 + min * 60_000;
            if (t >= floor) return t;
          }
        }
      }
    }
  }
  return null;
}

// ── Pattern generation ──────────────────────────────────────────────

const pick = <T>(rnd: () => number, xs: T[]): T =>
  xs[Math.floor(rnd() * xs.length)]!;

function field(
  rnd: () => number,
  min: number,
  max: number,
  endBias: number[],
): string {
  const r = rnd();
  if (r < 0.30) return "*";
  if (r < 0.45) {
    const step = 1 + Math.floor(rnd() * 5);
    return `*/${step}`;
  }
  if (r < 0.60) {
    const a = min + Math.floor(rnd() * (max - min + 1));
    const b = Math.min(max, a + Math.floor(rnd() * 6));
    return `${a}-${b}`;
  }
  if (r < 0.75 && endBias.length > 0) return String(pick(rnd, endBias));
  const n = 1 + Math.floor(rnd() * 3);
  const vals = new Set<number>();
  for (let i = 0; i < n; i++) {
    vals.add(
      // Bias towards the month ends — that is where the calendar is sharp.
      rnd() < 0.5 && endBias.length > 0
        ? pick(rnd, endBias)
        : min + Math.floor(rnd() * (max - min + 1)),
    );
  }
  return [...vals].join(",");
}

function randomPattern(rnd: () => number): string {
  // 1 in 8: a deliberately SPARSE pattern (a single month-end day in one or two
  // months). This is the shape whose next fire can be years away — the class
  // the old 366-day search window silently deleted — and random fields hit it
  // far too rarely to rely on.
  if (rnd() < 0.125) {
    const dom = pick(rnd, [29, 30, 31]);
    const months = rnd() < 0.6
      ? "2"
      : [2, 1 + Math.floor(rnd() * 12)].join(",");
    return `${Math.floor(rnd() * 60)} ${
      Math.floor(rnd() * 24)
    } ${dom} ${months} *`;
  }
  return [
    field(rnd, 0, 59, [0, 59]),
    field(rnd, 0, 23, [0, 23]),
    field(rnd, 1, 31, [1, 28, 29, 30, 31]), // dom: month-end biased
    field(rnd, 1, 12, [1, 2, 12]), // month: February biased
    field(rnd, 0, 6, [0, 6]),
  ].join(" ");
}

/** Hand-picked calendar edges — the cases a random generator hits rarely. */
const CORPUS = [
  "0 0 29 2 *", // leap day: up to 8 years out
  "0 0 29 2 0", // leap day OR Sunday (OR rule ⇒ weekly)
  "59 23 31 12 *", // last minute of the year
  "0 0 31 1,3,5,7,8,10,12 *", // every 31-day month
  "0 0 30 4,6,9,11 *", // every 30-day month
  "0 0 1 1 *", // new year
  "*/7 */5 */3 */2 *", // steps that do not divide their range
  "0 0 * * 0", // Sundays
  "0 0 29,30,31 2,4 *", // partly impossible, partly fine
  "30 12 28-31 2 *",
];

const EPOCHS = [
  Date.UTC(2026, 0, 1),
  Date.UTC(2026, 1, 28, 23, 59), // the minute before a missed leap day
  Date.UTC(2028, 1, 29, 12, 0), // ON a leap day
  Date.UTC(2096, 2, 1), // next Feb 29 is 2104 — the century gap
  Date.UTC(2099, 11, 31, 23, 58),
  Date.UTC(2026, 6, 4, 17, 3),
];

Deno.test("fuzz: nextCronTime matches an independent constructive reference", () => {
  const rnd = mulberry32(SEED);
  let checked = 0, impossible = 0, farOut = 0;
  const cases: { pattern: string; at: number }[] = [];
  for (const p of CORPUS) {
    for (const at of EPOCHS) cases.push({ pattern: p, at });
  }
  for (let i = cases.length; i < CASES; i++) {
    cases.push({
      pattern: randomPattern(rnd),
      at: rnd() < 0.5
        ? pick(rnd, EPOCHS)
        : Date.UTC(2026 + Math.floor(rnd() * 80), Math.floor(rnd() * 12), 1) +
          Math.floor(rnd() * 366 * 86_400_000),
    });
  }

  for (const { pattern, at } of cases) {
    let fields: CronFields;
    try {
      fields = parseCron(pattern);
    } catch {
      continue; // generator produced an invalid pattern — parsing owns that
    }
    const expected = refNextCron(fields, at);
    if (expected === null) {
      impossible++;
      assertThrows(
        () => nextCronTime(fields, new Date(at)),
        Error,
        undefined,
        `"${pattern}" matches nothing in 12 years but nextCronTime returned a time`,
      );
      continue;
    }
    const got = nextCronTime(fields, new Date(at)).getTime();
    assertEquals(
      got,
      expected,
      `"${pattern}" from ${new Date(at).toISOString()}: got ${
        new Date(got).toISOString()
      }, reference ${new Date(expected).toISOString()}`,
    );
    if (expected - at > 366 * 86_400_000) farOut++;
    checked++;
  }

  // The leap-day class has to be REACHED, not just handled — a fuzzer that
  // never generates the case it exists for is a green that means nothing.
  assert(
    farOut > 0,
    `no pattern was more than a year out — the leap-day class went untested`,
  );
  console.log(
    `[cron-fuzz] seed=${SEED} checked=${checked} beyond-1-year=${farOut} never-matching=${impossible}`,
  );
});

Deno.test("fuzz: the search window covers the widest real leap gap (2096→2104)", () => {
  // 2100 is not a leap year, so this is the longest gap the Gregorian calendar
  // produces — and the one that decides how wide CRON_SEARCH_DAYS must be.
  const f = parseCron("0 0 29 2 *");
  const next = nextCronTime(f, new Date(Date.UTC(2096, 2, 1)));
  assertEquals(next.toISOString(), "2104-02-29T00:00:00.000Z");
});
