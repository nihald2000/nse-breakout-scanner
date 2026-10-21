"use strict";
// research_strategies.js - pre-registered, data-compatible hypotheses from the literature review.
// These are ADAPTATIONS, not replications: the papers use different markets, bar sizes, holding
// periods and universes. Each rule below is fixed before the run and is not tuned on validation.

const RVOL_MIN = 1.5; // the scanner's already-fixed "in play" threshold, not a new tuned value
const MR_MOVE_PCT = 1.0; // 45-minute move that counts as an extreme for the mean-reversion control
const SECTOR_TOP = 3; // top/bottom three sectors by prior-session momentum

function sideFromOrb(d, hi, lo, dir) {
  if (!dir || hi == null || lo == null || d.px == null) return 0;
  if (dir > 0 && d.px > hi) return 1;
  if (dir < 0 && d.px < lo) return -1;
  return 0;
}

function buildResearchStrategies() {
  const sm = (d) => (d.tier >= 2 ? d.side : 0);
  const L = [];
  const add = (id, group, label, side) => L.push({ id, group, label, side });

  add("SM_REF", "board-component", "Strong + moderate, every stock (the board's raw input)", sm);
  add("ORB5", "orb", "5m opening-range breakout, first-bar direction, close beyond the range", (d) => sideFromOrb(d, d.or5Hi, d.or5Lo, d.or5Dir));
  add("ORB5_RVOL", "orb", `5m ORB AND first traded-5m RVOL >= ${RVOL_MIN} (adapted "stock in play")`, (d) => (d.openRvol != null && d.openRvol >= RVOL_MIN ? sideFromOrb(d, d.or5Hi, d.or5Lo, d.or5Dir) : 0));
  add("ORB15", "orb", "15m opening-range breakout, first-bar direction, close beyond the range", (d) => sideFromOrb(d, d.or15Hi, d.or15Lo, d.or15Dir));
  add("ORB15_RVOL", "orb", `15m ORB AND first traded-5m RVOL >= ${RVOL_MIN}`, (d) => (d.openRvol != null && d.openRvol >= RVOL_MIN ? sideFromOrb(d, d.or15Hi, d.or15Lo, d.or15Dir) : 0));
  add("VWAP_TREND", "vwap", "Price and VWAP slope on the same side (VWAP trend adaptation)", (d) => {
    const pos = d.slot && d.slot[0];
    const slope = d.slot && d.slot[1];
    return pos && slope && pos === slope ? pos : 0;
  });
  add("SM_SECTOR_1D", "sector", `Strong+moderate in a top/bottom ${SECTOR_TOP} sector by prior-day return`, (d) => {
    const s = sm(d);
    if (!s) return 0;
    if (s > 0 && d.secRank1Up != null && d.secRank1Up <= SECTOR_TOP) return 1;
    if (s < 0 && d.secRank1Down != null && d.secRank1Down <= SECTOR_TOP) return -1;
    return 0;
  });
  add("SM_SECTOR_5D", "sector", `Strong+moderate in a top/bottom ${SECTOR_TOP} sector by prior 5-session return`, (d) => {
    const s = sm(d);
    if (!s) return 0;
    if (s > 0 && d.secRank5Up != null && d.secRank5Up <= SECTOR_TOP) return 1;
    if (s < 0 && d.secRank5Down != null && d.secRank5Down <= SECTOR_TOP) return -1;
    return 0;
  });
  add("MEANREV_45M", "control", `Fade a ${MR_MOVE_PCT}% 45-minute move (mean-reversion control)`, (d) => {
    if (d.ret3 == null) return 0;
    if (d.ret3 >= MR_MOVE_PCT) return -1;
    if (d.ret3 <= -MR_MOVE_PCT) return 1;
    return 0;
  });
  return L;
}

module.exports = { buildResearchStrategies, RVOL_MIN, MR_MOVE_PCT, SECTOR_TOP };
