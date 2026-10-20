// TEMPORARY deployment probe. Delete before merging.
// Tests whether Vercel's network can reach NSE's v3 option-chain endpoint directly.
// No production page calls this route.

const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/option-chain",
};

async function get(url, ms = 15000) {
  const t0 = Date.now();
  const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(ms) });
  const text = await r.text();
  return { status: r.status, bytes: text.length, ms: Date.now() - t0, text };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const out = { at: new Date().toISOString(), direct: {}, jina: {} };
  try {
    const c = await get("https://www.nseindia.com/api/option-chain-contract-info?symbol=NBCC");
    out.direct.contract = { status: c.status, bytes: c.bytes, ms: c.ms, head: c.text.slice(0, 160) };
    let expiry = null;
    try {
      const j = JSON.parse(c.text);
      expiry = j.expiryDates && j.expiryDates[0];
    } catch (e) {
      out.direct.contract.parseError = String(e.message || e);
    }
    if (expiry) {
      const u = `https://www.nseindia.com/api/option-chain-v3?type=Equity&symbol=NBCC&expiry=${encodeURIComponent(expiry)}`;
      const v = await get(u);
      out.direct.chain = { status: v.status, bytes: v.bytes, ms: v.ms, head: v.text.slice(0, 120) };
      try {
        const j = JSON.parse(v.text);
        const rows = (j.records && j.records.data) || [];
        out.direct.chain.rows = rows.length;
        out.direct.chain.timestamp = (j.records && j.records.timestamp) || null;
        out.direct.chain.spot = (j.records && j.records.underlyingValue) || null;
      } catch (e) {
        out.direct.chain.parseError = String(e.message || e);
      }
    }
  } catch (e) {
    out.direct.error = String((e && e.message) || e);
    out.direct.name = e && e.name;
  }
  try {
    const u = "https://r.jina.ai/https://www.nseindia.com/api/option-chain-v3?type=Equity&symbol=NBCC&expiry=27-Oct-2026";
    const v = await get(u, 25000);
    out.jina = { status: v.status, bytes: v.bytes, ms: v.ms, head: v.text.slice(0, 160) };
  } catch (e) {
    out.jina.error = String((e && e.message) || e);
  }
  return res.status(200).json(out);
};
