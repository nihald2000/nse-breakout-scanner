// The project is on Vercel's Hobby plan: at most 12 Serverless Functions per deployment, and every non-underscore file in
// api/ is one. A 13th makes the whole deployment fail at the last build step (exceeded_serverless_functions_per_deployment).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("api/ has at most 12 function files", () => {
  const files = fs.readdirSync(path.join(__dirname, "..", "api")).filter((f) => /\.(js|mjs|cjs|ts)$/.test(f) && !f.startsWith("_"));
  assert.ok(files.length <= 12, `${files.length} function files in api/: ${files.join(", ")}. Put new routes behind an existing one (see api/sip.js ?mode=) or move helpers to lib/.`);
});

test("vercel.json rewrites /api/notify and /api/orbstudy to modes of /api/sip, and the modes dispatch", async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  const dest = Object.fromEntries((cfg.rewrites || []).map((r) => [r.source, r.destination]));
  assert.equal(dest["/api/notify"], "/api/sip?mode=notify");
  assert.equal(dest["/api/orbstudy"], "/api/sip?mode=study");
  delete process.env.NOTIFY_KEY;
  const handler = require("../api/sip");
  const res = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  await handler({ query: { mode: "notify" }, headers: {} }, res);
  assert.equal(res.code, 503, "reached the notify route (not configured)");
  assert.match(res.body.error, /NOTIFY_KEY/);
});
