// /api/notify end to end: universe, Yahoo, clock, the push channels and the dedupe store are all stubbed.
const test = require("node:test");
const assert = require("node:assert/strict");
const common = require("../lib/common");

const stamp = (date, mm) => Date.parse(date + "T00:00:00Z") / 1000 + (mm - 330) * 60;
const dateN = (n) => new Date(Date.UTC(2026, 8, 1) + n * 864e5).toISOString().slice(0, 10);
const TODAY = "2026-10-21"; // a Wednesday
let now = stamp(TODAY, 600); // 10:00 IST
let feedMM = 595; // the newest candle time Yahoo reports

function bars(first, rest) {
  const out = [];
  const push = (d, mm, o, hi, lo, cl, vol) => out.push({ t: stamp(d, mm), d, mm, o, hi, lo, cl, vol });
  for (let n = 0; n < 16; n++) {
    push(dateN(n), 555, 101, 102, 100, 101, 1000);
    for (let mm = 560; mm < 930; mm += 5) push(dateN(n), mm, 101, 101, 101, 101, 100);
  }
  push(TODAY, 555, first[0], first[1], first[2], first[3], first[4]);
  for (const [mm, o, hi, lo, cl] of rest) push(TODAY, mm, o, hi, lo, cl, 100);
  return out;
}
const raw = (bs) => ({
  meta: { gmtoffset: 19800, regularMarketPrice: bs[bs.length - 1].cl, regularMarketTime: stamp(TODAY, feedMM) },
  timestamp: bs.map((b) => b.t),
  indicators: { quote: [{ open: bs.map((b) => b.o), high: bs.map((b) => b.hi), low: bs.map((b) => b.lo), close: bs.map((b) => b.cl), volume: bs.map((b) => b.vol) }] },
});
const DATA = {
  AAA: bars([100, 102, 99.5, 101.5, 3000], [[560, 101.5, 101.99, 101, 101.97]]), // long, 3x, 0.03 below the level: building
  BBB: bars([100, 100.5, 98, 98.5, 5000], [[560, 98.4, 98.6, 98.1, 98.2], [565, 98.2, 98.15, 97.7, 97.8]]), // short, 5x, filled
  CCC: bars([100, 102, 99.5, 101.5, 500], [[560, 101.5, 101.9, 101, 101.6]]), // 0.5x: not in play
};
common.getUniverse = async () => ["AAA", "BBB", "CCC"].map((sym) => ({ sym, industry: "X" }));
common.yahooChart = async (sym) => {
  const s = sym.replace(/\.NS$/, "");
  if (!DATA[s]) throw new Error("HTTP 404");
  return raw(DATA[s]);
};
const realNow = Date.now;
Date.now = () => now * 1000;
test.after(() => {
  Date.now = realNow;
});

const handler = require("../api/notify");
const KEY = "k-secret-123";
const ENV = { NOTIFY_KEY: KEY, TELEGRAM_BOT_TOKEN: "tok-SECRET", TELEGRAM_CHAT_ID: "42", NTFY_TOPIC: "my-topic" };

async function call(query, headers, deps) {
  const res = {
    code: null,
    body: null,
    setHeader() {},
    status(c) {
      this.code = c;
      return this;
    },
    json(o) {
      this.body = o;
      return this;
    },
  };
  await handler({ query: query || {}, headers: headers || { "x-notify-key": KEY } }, res, deps);
  return res;
}
function fakeFetch(opts = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    if (opts.fail) throw new Error("connect failed " + url);
    return { ok: true, status: 200, json: async () => ({ result: "OK" }) };
  };
  f.calls = calls;
  return f;
}
function fakeKv() {
  const seen = new Set();
  return {
    seen,
    async claim(id) {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    async release(id) {
      seen.delete(id);
    },
  };
}

test("not configured and bad key", async () => {
  assert.equal((await call({}, {}, { env: {}, fetch: fakeFetch() })).code, 503);
  assert.equal((await call({}, { "x-notify-key": "nope" }, { env: ENV, fetch: fakeFetch() })).code, 401);
  assert.equal((await call({}, {}, { env: ENV, fetch: fakeFetch() })).code, 401);
  assert.equal((await call({ key: KEY }, {}, { env: ENV, fetch: fakeFetch(), kv: null, ...{} })).code, 200, "?key= also works");
});

test("dry run lists the events and sends nothing", async () => {
  const f = fakeFetch();
  const r = await call({ dry: "1" }, null, { env: ENV, fetch: f, kv: null });
  assert.equal(r.code, 200);
  assert.equal(r.body.dry, true);
  const kinds = r.body.events.map((e) => e.kind + ":" + (e.id.split(":")[1] || ""));
  assert.ok(r.body.events.some((e) => e.kind === "shortlist"));
  assert.ok(r.body.events.some((e) => e.kind === "building" && e.id.includes("AAA")));
  assert.ok(r.body.events.some((e) => e.kind === "triggered" && e.id.includes("BBB")));
  assert.ok(!kinds.join().includes("CCC"), "a 0.5x name is not in play");
  assert.equal(f.calls.length, 0);
  assert.equal(r.body.evaluated, 3);
});

test("a real run sends each event to every channel, once, with a store", async () => {
  const f = fakeFetch();
  const kv = fakeKv();
  const r1 = await call({}, null, { env: ENV, fetch: f, kv });
  assert.equal(r1.code, 200);
  assert.equal(r1.body.dedupe, "store");
  assert.equal(r1.body.sent.length, 4, "shortlist, AAA building, BBB triggered, BBB at +1R");
  assert.equal(f.calls.length, 8, "4 events x telegram + ntfy");
  assert.ok(f.calls.some((c) => c.url === "https://api.telegram.org/bottok-SECRET/sendMessage"));
  assert.ok(f.calls.some((c) => c.url === "https://ntfy.sh/my-topic"));
  const tg = JSON.parse(f.calls.find((c) => c.url.includes("telegram")).init.body);
  assert.equal(tg.chat_id, "42");
  const ntfy = f.calls.find((c) => c.url.includes("ntfy")).init.headers;
  assert.match(ntfy.Title, /^[\x20-\x7e]+$/, "ntfy title is plain ASCII");
  // the same minute again: nothing new
  const r2 = await call({}, null, { env: ENV, fetch: f, kv });
  assert.equal(r2.body.sent.length, 0);
  assert.equal(r2.body.skipped.filter((s) => s.why === "already sent").length, 4);
  assert.equal(f.calls.length, 8);
});

test("a failed send releases the claim so the next run retries, and errors never contain the token", async () => {
  const kv = fakeKv();
  const bad = fakeFetch({ fail: true });
  const r1 = await call({}, null, { env: ENV, fetch: bad, kv });
  assert.equal(r1.body.sent.length, 0);
  assert.ok(r1.body.errors.length > 0);
  assert.ok(!JSON.stringify(r1.body).includes("tok-SECRET"), "token must not leak into the reply");
  assert.equal(kv.seen.size, 0, "claims were released");
  const r2 = await call({}, null, { env: ENV, fetch: fakeFetch(), kv });
  assert.equal(r2.body.sent.length, 4);
});

test("without a store only recent events are sent", async () => {
  now = stamp(TODAY, 572); // 09:32, the candles at 09:20-09:30 have just closed
  feedMM = 570;
  const f = fakeFetch();
  const r = await call({}, null, { env: { ...ENV, NTFY_TOPIC: "" }, fetch: f, kv: null });
  assert.equal(r.body.dedupe, "window");
  assert.deepEqual(r.body.channels, ["telegram"]);
  assert.equal(r.body.sent.length, 4);
  now = stamp(TODAY, 640); // 40 minutes later: the old events are outside the window (the feed moves with the clock)
  feedMM = 635;
  const later = await call({}, null, { env: ENV, fetch: fakeFetch(), kv: null });
  assert.equal(later.body.sent.length, 0, "everything is older than the window");
  assert.ok(later.body.skipped.length > 0 && later.body.skipped.every((s) => s.why === "older than the window"));
  now = stamp(TODAY, 600);
  feedMM = 595;
});

test("no channel configured is reported, not silently ignored", async () => {
  const r = await call({}, null, { env: { NOTIFY_KEY: KEY }, fetch: fakeFetch(), kv: null });
  assert.equal(r.code, 503);
  assert.match(r.body.error, /channel/);
});

test("weekends, off hours and a stale feed do nothing", async () => {
  now = stamp("2026-10-25", 600); // Sunday
  assert.equal((await call({}, null, { env: ENV, fetch: fakeFetch(), kv: null })).body.skipped, "outside market hours");
  now = stamp(TODAY, 480); // 08:00
  assert.equal((await call({}, null, { env: ENV, fetch: fakeFetch(), kv: null })).body.skipped, "outside market hours");
  now = stamp(TODAY, 600);
  feedMM = 540; // newest candle is 60 minutes old
  const f = fakeFetch();
  const stale = await call({}, null, { env: ENV, fetch: f, kv: null });
  assert.equal(stale.body.skipped, "market not live or data stale");
  assert.equal(f.calls.length, 0);
  feedMM = 595;
});
