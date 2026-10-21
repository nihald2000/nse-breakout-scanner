// Local preview only: serves public/ and proxies /api to the current deployment.
// Not shipped. Used to exercise the chart integration without touching production.
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "public");
const ORIGIN = "https://nse-breakout-scanner-tau.vercel.app";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json"
};

function proxy(req, res) {
  const target = ORIGIN + req.url;
  const headers = { ...req.headers, host: new URL(ORIGIN).host, accept: "application/json", "accept-encoding": "identity" };
  const up = https.get(target, { headers }, (r) => {
    res.writeHead(r.statusCode || 502, {
      "content-type": r.headers["content-type"] || "application/json",
      "cache-control": "no-store"
    });
    r.pipe(res);
  });
  up.on("error", (e) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "preview proxy failed", detail: e.message }));
  });
  up.setTimeout(30000, () => up.destroy(new Error("proxy timeout")));
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return proxy(req, res);
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.resolve(ROOT, "." + p);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(buf);
  });
});

server.listen(4173, "127.0.0.1", () => {
  console.log("preview http://127.0.0.1:4173");
});
