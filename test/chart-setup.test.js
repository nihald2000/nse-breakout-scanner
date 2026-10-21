const test = require("node:test");
const assert = require("node:assert/strict");
const { computeChartSetup } = require("../lib/chart_setup");

const bar = (mm, o, hi, lo, cl) => ({ mm, o, hi, lo, cl });
const orb = { hi: 23000, lo: 22900 };
const setupBars = [
  bar(570, 23020, 23030, 23000, 23020), // upside break
  bar(575, 23020, 23020, 23005, 23010), // first retest
  bar(580, 23010, 23010, 22940, 22950), // failed back inside
  bar(600, 22900, 22905, 22875, 22880), // downside break, touches OR low
  bar(605, 22880, 22890, 22865, 22870), // confirmation close below the retest low
  bar(610, 22870, 22872, 22820, 22830), // T1
  bar(615, 22830, 22832, 22790, 22800)  // T2
];

test("a failed upside break does not disable the later downside retest", () => {
  const s = computeChartSetup(setupBars, { orb });
  assert.equal(s.side, "short");
  assert.equal(s.entry, 22870);
  assert.equal(s.sl, 22905);
  assert.equal(s.t1, 22835);
  assert.equal(s.t2, 22800);
  assert.equal(s.riskPct, (35 / 22870) * 100);
  assert.equal(s.outcome, "T2");
  assert.equal(s.r, 2);
  assert.equal(s.action, "NO NEW ENTRY");
  assert.equal(s.state, "TRIGGERED");
  assert.equal(s.fresh, false);
});

test("the same setup is fresh when evaluated at the trigger close", () => {
  const s = computeChartSetup(setupBars.slice(0, 5), { orb });
  assert.equal(s.side, "short");
  assert.equal(s.action, "BUY PE");
  assert.equal(s.state, "LIVE SETUP");
  assert.equal(s.outcome, "OPEN");
  assert.equal(s.fresh, true);
  assert.equal(s.rr, "1:2");
  assert.equal(s.entryMM, 610);
  assert.equal(s.retestMM, 605);
  assert.equal(s.breakMM, 605);
});

test("a setup whose T1 already traded is not fresh", () => {
  const s = computeChartSetup(setupBars.slice(0, 6), { orb });
  assert.equal(s.fresh, false);
  assert.equal(s.action, "NO NEW ENTRY");
  assert.equal(s.state, "TRIGGERED, T1 ALREADY HIT");
  assert.equal(s.outcome, "OPEN");
  assert.equal(s.r, null);
});

test("a completed historical session is never marked fresh", () => {
  const s = computeChartSetup(setupBars.slice(0, 5), { orb, live: false });
  assert.equal(s.fresh, false);
  assert.equal(s.action, "NO NEW ENTRY");
  assert.equal(s.state, "TRIGGERED");
});

test("later bars cannot change the entry or levels, only the outcome", () => {
  const atTrigger = computeChartSetup(setupBars.slice(0, 5), { orb });
  const full = computeChartSetup(setupBars, { orb });
  for (const key of ["side", "entry", "sl", "t1", "t2", "riskPct", "entryMM", "retestMM"]) {
    assert.equal(full[key], atTrigger[key], key);
  }
  assert.equal(atTrigger.outcome, "OPEN");
  assert.equal(full.outcome, "T2");
});

test("the India VIX filter is a warning, not a hidden block", () => {
  const s = computeChartSetup(setupBars.slice(0, 5), {
    orb,
    vix: { ok: true, elevated: true, value: 22.5, p60: 15.1 }
  });
  assert.equal(s.action, "BUY PE");
  assert.equal(s.vixWarning, true);
  assert.ok(s.checks.some((c) => /India VIX 22.50/.test(c.text)));
});

test("inside the range there is no trade and no invented level", () => {
  const bars = [bar(570, 22950, 22960, 22940, 22950), bar(575, 22950, 22970, 22940, 22960), bar(580, 22960, 22980, 22950, 22970), bar(585, 22970, 22980, 22960, 22970)];
  const s = computeChartSetup(bars, { orb });
  assert.equal(s.action, "WAIT");
  assert.equal(s.state, "INSIDE RANGE");
  assert.equal(s.side, null);
  assert.equal(s.entry, null);
  assert.equal(s.sl, null);
  assert.ok(s.note.includes("No 5-minute close beyond"));
});

test("a stop is checked before a target inside the same candle", () => {
  const bars = setupBars.slice(0, 5).concat([
    bar(610, 22870, 22910, 22820, 22895) // touches both stop 22905 and T1 22835
  ]);
  const s = computeChartSetup(bars, { orb });
  assert.equal(s.outcome, "SL");
  assert.equal(s.r, -1);
  assert.equal(s.exitMM, 615);
});

test("T1 then a stop is not turned into a made-up 1R", () => {
  const bars = setupBars.slice(0, 5).concat([
    bar(610, 22870, 22872, 22830, 22835), // T1 touched, not a full exit
    bar(615, 22835, 22910, 22835, 22900)  // later stop at 22905
  ]);
  const s = computeChartSetup(bars, { orb });
  assert.equal(s.outcome, "T1 then stop");
  assert.equal(s.r, null);
  assert.ok(s.checks.some((c) => /R is n\/a/.test(c.text)));
});
