// /api/calls?options=0 : the NSE option-chain lookups are skipped (the Trade Monitor asks for this on the batches of
// sectors past the hottest ones). Universe, per-stock maths and NSE are stubbed; node --test runs each file in its own process.
const test = require("node:test");
const assert = require("node:assert/strict");
const common = require("../lib/common");
const optionsLib = require("../lib/options");
const sectorstocks = require("../api/sectorstocks");

common.getUniverse = async (idx) => (idx === "NIFTY 500" ? [{ sym: "AAA", industry: "Banks" }, { sym: "BBB", industry: "Banks" }] : [{ sym: "AAA" }, { sym: "BBB" }]);
const row = (sym, side, tier) => ({ sym, industry: "Banks", rvol: 1.2, ltp: 100, read: { trend: { side, tier, agree: 5, total: 6, helpers: 1 } } });
sectorstocks._internals.computeRows = async () => ({ rows: [row("AAA", "up", "strong"), row("BBB", "down", "weak")], failed: 0, newestTs: Math.floor(Date.now() / 1000) });
let chainCalls = 0;
optionsLib.getReferenceExpiries = async () => ({ expiries: [] });
optionsLib.pickExpiry = () => null;
optionsLib.fetchChainForSymbol = async () => {
  chainCalls++;
  return { chain: null };
};
const handler = require("../api/calls");

async function get(query) {
  const res = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  await handler({ query }, res);
  return res;
}

test("options=0 lists every signal without asking NSE for a chain", async () => {
  const r = await get({ sectors: "Banks", options: "0" });
  assert.equal(r.code, 200);
  assert.equal(chainCalls, 0);
  assert.equal(r.body.signals.length, 2, "nothing is dropped");
  assert.ok(r.body.signals.every((s) => s.option === null));
  assert.equal(r.body.meta.option.skipped, true);
  assert.equal(r.body.meta.option.notQuoted, 2);
  assert.equal(r.body.meta.option.loaded, 0);
});

test("by default each listed signal still gets its chain lookup", async () => {
  const r = await get({ sectors: "Banks" });
  assert.equal(r.code, 200);
  assert.equal(chainCalls, 2);
  assert.equal(r.body.meta.option.skipped, false);
  assert.equal(r.body.meta.option.failed, 2);
});
