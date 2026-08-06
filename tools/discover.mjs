#!/usr/bin/env node
// Searches a live X-Plane Web API's full command/dataref lists for names
// containing a keyword. Generic — not tied to any one panel/profile — for
// finding the real names to put in a new config/profiles/*.json before
// writing one by hand. REST only, no websocket needed.
//
// Usage: node tools/discover.mjs <keyword> [host] [port]
//   defaults: host=localhost port=8086

import { XPlaneClient } from "../src/xplane-client.js";

const keyword = process.argv[2];
if (!keyword) {
  console.error("Usage: node tools/discover.mjs <keyword> [host] [port]");
  process.exit(1);
}
const host = process.argv[3] ?? "localhost";
const port = Number(process.argv[4]) || 8086;

async function main() {
  const client = new XPlaneClient(host, port);
  const needle = keyword.toLowerCase();

  console.log(`Connecting to X-Plane Web API at ${host}:${port} ...`);
  await client.getCapabilities();

  console.log(`Scanning commands for "${keyword}" ...`);
  const allCommands = await client.listAll("commands");
  const cmdMatches = allCommands.filter((c) => c.name.toLowerCase().includes(needle));
  console.log(`${allCommands.length} commands total, ${cmdMatches.length} match:\n`);
  for (const m of cmdMatches.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  #${m.id}\t${m.name}${m.description ? "  — " + m.description : ""}`);
  }

  console.log(`\nScanning datarefs for "${keyword}" ...`);
  const allDatarefs = await client.listAll("datarefs");
  const drMatches = allDatarefs.filter((d) => d.name.toLowerCase().includes(needle));
  console.log(`${allDatarefs.length} datarefs total, ${drMatches.length} match:\n`);
  for (const m of drMatches.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  #${m.id}\t${m.name}`);
  }
}

main().catch((err) => {
  console.error("discover failed:", err);
  process.exit(1);
});
