"use strict";
// run_all.js - the one command: download (unless --skip-fetch), parity check, backtest, 1-minute timing study.
//   node research/backtest-2026-10-20/run_all.js [--skip-fetch] [--data <dir>] [--out <dir>] [--mode live|extended] [--cost 0.05]
// Outputs land in --out (default: this folder): report.md, results.json, grid.csv, signals.csv.gz, configs.json,
// parity.json, timing_1m.md/json, missing_symbols.json, run_command.txt. Nothing outside --out is written except
// the data cache in --data. No git commands are run.

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const data = path.resolve(get("--data", path.join(__dirname, "data")));
const out = path.resolve(get("--out", __dirname));
const cost = get("--cost", "0.05");
const mode = get("--mode", "live");
const cmds = [];
function step(title, script, a, fatal = true) {
  console.log(`\n=== ${title}`);
  const full = ["node", path.relative(process.cwd(), path.join(__dirname, script)), ...a];
  cmds.push(full.join(" "));
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...a], { stdio: "inherit" });
  if (r.status !== 0) {
    console.log(`step "${title}" exited with ${r.status}`);
    if (fatal) process.exit(r.status || 1);
  }
  return r.status;
}
fs.mkdirSync(out, { recursive: true });
if (!args.includes("--skip-fetch")) step("download data (resumable)", "fetch_data.js", ["--out", data]);
step("parity against the real computeRows()", "parity.js", ["--data", data, "--out", out, "--n", "200"], false);
step("walk-forward backtest", "run_backtest.js", ["--data", data, "--out", out, "--mode", mode, "--cost", cost]);
step("1-minute entry-timing study", "timing_1m.js", ["--data", data, "--out", out, "--cost", cost], false);
fs.writeFileSync(path.join(out, "run_command.txt"), cmds.join("\n") + "\n");
console.log(`\nDone. Read ${path.join(out, "report.md")}`);
