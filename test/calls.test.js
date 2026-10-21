const test = require("node:test");
const assert = require("node:assert/strict");
const calls = require("../api/calls");

function summary(overrides = {}) {
  return {
    expiry: "27-Oct-2026",
    dte: 6.3,
    asOfTs: Date.UTC(2026, 9, 21, 4, 0, 0),
    spot: 100,
    atm: {
      strike: 100,
      iv: 0.25,
      call: {
        px: 2.1,
        bid: 2,
        ask: 2.2,
        spreadPct: 0.0952,
        iv: 0.25,
        delta: 0.5,
        oi: 10,
        oiChg: 1,
        vol: 3,
      },
      put: {
        px: 1.9,
        bid: 1.8,
        ask: 2,
        spreadPct: 0.1053,
        iv: 0.25,
        delta: -0.5,
        oi: 12,
        oiChg: -1,
        vol: 4,
      },
    },
    rawSkew: 0.01,
    normSkew: 0.04,
    flags: [],
    ...overrides,
  };
}

test("Live Calls labels an up read CE and a down read PE", () => {
  const up = calls._internals.optionForSummary(summary(), "up");
  assert.equal(up.type, "CE");
  assert.equal(up.premium, 2.1);
  assert.equal(up.delta, 0.5);

  const down = calls._internals.optionForSummary(summary(), "down");
  assert.equal(down.type, "PE");
  assert.equal(down.premium, 1.9);
  assert.equal(down.delta, -0.5);
});

test("Live Calls does not invent an option when the ATM quote is absent", () => {
  const missingCall = summary({ atm: { ...summary().atm, call: null } });
  assert.equal(calls._internals.optionForSummary(missingCall, "up"), null);
  assert.ok(calls._internals.optionForSummary(missingCall, "down"));
  assert.equal(calls._internals.optionForSummary(summary({ atm: null }), "up"), null);
  assert.equal(calls._internals.optionForSummary(summary({ atm: { ...summary().atm, iv: null } }), "up"), null);
});
