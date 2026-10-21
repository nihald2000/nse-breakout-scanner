"use strict";
// stats.js - small, dependency-free statistics for the walk-forward backtest.
// Everything here is checked against scipy in harness_check.js.

function lgamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a, b, x) {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}

// Regularised incomplete beta I_x(a, b).
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// Student-t CDF.
function tCdf(t, df) {
  if (!(df > 0) || !Number.isFinite(t)) return NaN;
  const p = 0.5 * ibeta(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - p : p;
}

// Standard normal CDF (Abramowitz-Stegun 7.1.26 on erf is too coarse; use the t CDF with a huge df).
const normCdf = (z) => tCdf(z, 1e6);

// Quantile of the t distribution by bisection (used for confidence intervals).
function tQuant(p, df) {
  let lo = -50;
  let hi = 50;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Wilson 95% interval for k successes of n. NAIVE: assumes the n trials are independent.
function wilson(k, n, z = 1.959964) {
  if (!(n > 0)) return { lo: null, hi: null };
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const ctr = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { lo: Math.max(0, ctr - half), hi: Math.min(1, ctr + half) };
}

// Ratio estimator sum(s)/sum(n) with DAY-CLUSTERED standard error (stocks traded on the same day share
// the market's move, so they are not independent). perDay = [{ s, n }] one entry per cluster.
// Returns { mean, se, t, df, p1 (one-sided P(mean<=0)... of the t stat), ci: [lo, hi] }.
function clusterRatio(perDay) {
  const cl = perDay.filter((x) => x.n > 0);
  const G = cl.length;
  let S = 0;
  let N = 0;
  for (const x of cl) {
    S += x.s;
    N += x.n;
  }
  if (!(N > 0) || G < 2) return { mean: N > 0 ? S / N : null, se: null, t: null, df: G - 1, p1: null, ci: [null, null], G };
  const mean = S / N;
  let ss = 0;
  for (const x of cl) ss += (x.s - mean * x.n) ** 2;
  const se = Math.sqrt((G / (G - 1)) * ss) / N;
  const df = G - 1;
  if (!(se > 0)) return { mean, se: 0, t: null, df, p1: null, ci: [mean, mean], G };
  const t = mean / se;
  const q = tQuant(0.975, df);
  return { mean, se, t, df, p1: 1 - tCdf(t, df), ci: [mean - q * se, mean + q * se], G };
}

// Day-block bootstrap percentile interval for a ratio sum(s)/sum(n). Deterministic (seeded).
function bootstrapRatio(perDay, B = 1000, seed = 12345) {
  const cl = perDay.filter((x) => x.n > 0);
  const G = cl.length;
  if (G < 2) return [null, null];
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const vals = [];
  for (let b = 0; b < B; b++) {
    let S = 0;
    let N = 0;
    for (let g = 0; g < G; g++) {
      const x = cl[Math.floor(rnd() * G)];
      S += x.s;
      N += x.n;
    }
    if (N > 0) vals.push(S / N);
  }
  vals.sort((x, y) => x - y);
  if (vals.length < 20) return [null, null];
  return [vals[Math.floor(0.025 * vals.length)], vals[Math.min(vals.length - 1, Math.floor(0.975 * vals.length))]];
}

// Benjamini-Hochberg: returns, for each p (null allowed), the adjusted q value.
function bhAdjust(ps) {
  const idx = ps.map((p, i) => [p, i]).filter((x) => x[0] != null && Number.isFinite(x[0])).sort((a, b) => a[0] - b[0]);
  const m = idx.length;
  const q = new Array(ps.length).fill(null);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    const v = Math.min(prev, (idx[k][0] * m) / (k + 1));
    q[idx[k][1]] = v;
    prev = v;
  }
  return q;
}

module.exports = { lgamma, ibeta, tCdf, normCdf, tQuant, wilson, clusterRatio, bootstrapRatio, bhAdjust };
