// lib/indicators.js - EMA, RSI and ADX/DI (Wilder). Zero dependencies, pure functions.
// Every value at index i uses bars 0..i only (no look-ahead). Not a route: it lives outside api/.

function ema(values, p) {
  const k = 2 / (p + 1);
  let e = null;
  return values.map((v) => (e = e == null ? v : v * k + e * (1 - k)));
}

// Wilder RSI. The first value is at index p (needs p changes); earlier entries are null.
function rsi(closes, p = 9) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= p) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  g /= p;
  l /= p;
  const val = () => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[p] = val();
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = val();
  }
  return out;
}

// Wilder ADX with +DI / -DI. bars need hi, lo, cl. ADX first appears at index 2p-1; DI at index p.
function adx(bars, p = 14) {
  const n = bars.length;
  const adxA = new Array(n).fill(null);
  const pdi = new Array(n).fill(null);
  const mdi = new Array(n).fill(null);
  if (n < 2 * p) return { adx: adxA, pdi, mdi };
  const tr = [0];
  const pdm = [0];
  const mdm = [0];
  for (let i = 1; i < n; i++) {
    const up = bars[i].hi - bars[i - 1].hi;
    const dn = bars[i - 1].lo - bars[i].lo;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(bars[i].hi - bars[i].lo, Math.abs(bars[i].hi - bars[i - 1].cl), Math.abs(bars[i].lo - bars[i - 1].cl)));
  }
  let sTR = 0;
  let sP = 0;
  let sM = 0;
  for (let i = 1; i <= p; i++) {
    sTR += tr[i];
    sP += pdm[i];
    sM += mdm[i];
  }
  const dx = [];
  const setDI = (i) => {
    pdi[i] = sTR > 0 ? (100 * sP) / sTR : 0;
    mdi[i] = sTR > 0 ? (100 * sM) / sTR : 0;
    const s = pdi[i] + mdi[i];
    return s > 0 ? (100 * Math.abs(pdi[i] - mdi[i])) / s : 0;
  };
  dx.push(setDI(p));
  for (let i = p + 1; i < n; i++) {
    sTR = sTR - sTR / p + tr[i];
    sP = sP - sP / p + pdm[i];
    sM = sM - sM / p + mdm[i];
    dx.push(setDI(i));
    if (dx.length === p) adxA[i] = dx.reduce((a, b) => a + b, 0) / p;
    else if (dx.length > p) adxA[i] = (adxA[i - 1] * (p - 1) + dx[dx.length - 1]) / p;
  }
  return { adx: adxA, pdi, mdi };
}

module.exports = { ema, rsi, adx };
