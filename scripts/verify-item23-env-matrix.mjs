// Item 23 — verify resolveSimulationMode against the documented matrix.
// Pure-function test: no session opened. Exhaustive over (platform, QB_SIMULATION, QB_LIVE).

import { resolveSimulationMode } from "../dist/session/manager.js";

const platforms = ["win32", "linux", "darwin"];
const simValues = [undefined, "true", "false", "yes", "1", ""];
const liveValues = [undefined, "1", "0", "true", ""];

const expectedSim = (platform, qbSim, qbLive) => {
  if (qbSim === "true") return true;
  if (qbSim === "false") return false;
  // unset or any non-true/false value
  return platform !== "win32" || qbLive !== "1";
};

let pass = 0;
let fail = 0;
const failures = [];

for (const platform of platforms) {
  for (const qbSim of simValues) {
    for (const qbLive of liveValues) {
      const env = {};
      if (qbSim !== undefined) env.QB_SIMULATION = qbSim;
      if (qbLive !== undefined) env.QB_LIVE = qbLive;
      const got = resolveSimulationMode(env, platform);
      const expected = expectedSim(platform, qbSim, qbLive);
      if (got === expected) {
        pass++;
      } else {
        fail++;
        failures.push(
          `platform=${platform} QB_SIMULATION=${JSON.stringify(qbSim)} QB_LIVE=${JSON.stringify(qbLive)} → got=${got} expected=${expected}`
        );
      }
    }
  }
}

// Spot-check the seven canonical rows from the README matrix.
const canonicalCases = [
  { platform: "win32", QB_SIMULATION: "true", QB_LIVE: "1", expected: true, label: "win + sim=true + live=1 → simulate (forced)" },
  { platform: "win32", QB_SIMULATION: "false", QB_LIVE: "1", expected: false, label: "win + sim=false + live=1 → live" },
  { platform: "win32", QB_SIMULATION: "false", QB_LIVE: undefined, expected: false, label: "win + sim=false + no live → live (was sim before)" },
  { platform: "win32", QB_SIMULATION: undefined, QB_LIVE: "1", expected: false, label: "win + no sim + live=1 → live" },
  { platform: "win32", QB_SIMULATION: undefined, QB_LIVE: undefined, expected: true, label: "win + no sim + no live → sim (default)" },
  { platform: "linux", QB_SIMULATION: "true", QB_LIVE: undefined, expected: true, label: "linux + sim=true → simulate" },
  { platform: "linux", QB_SIMULATION: "false", QB_LIVE: "1", expected: false, label: "linux + sim=false → live (will error at openSession)" },
  { platform: "linux", QB_SIMULATION: undefined, QB_LIVE: "1", expected: true, label: "linux + no sim + live=1 → sim (live needs win32)" },
  { platform: "linux", QB_SIMULATION: undefined, QB_LIVE: undefined, expected: true, label: "linux + no sim + no live → sim (default)" },
];

console.log("\nCanonical cases:");
for (const c of canonicalCases) {
  const env = {};
  if (c.QB_SIMULATION !== undefined) env.QB_SIMULATION = c.QB_SIMULATION;
  if (c.QB_LIVE !== undefined) env.QB_LIVE = c.QB_LIVE;
  const got = resolveSimulationMode(env, c.platform);
  const ok = got === c.expected;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${c.label} → got=${got} expected=${c.expected}`);
  if (!ok) fail++;
  else pass++;
}

console.log(`\n${pass} pass / ${fail} fail (${platforms.length * simValues.length * liveValues.length} matrix + ${canonicalCases.length} canonical)`);
if (failures.length > 0) {
  console.log("\nMatrix failures:");
  for (const f of failures) console.log("  " + f);
}
process.exit(fail === 0 ? 0 : 1);
