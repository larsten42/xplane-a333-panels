#!/usr/bin/env node
// Connects to a *live* X-Plane 12 Web API, pulls the current CDU1 (and
// CDU2) screen text + style, prints it decoded and annotated, and scans
// the full command/dataref lists for anything MCDU/CDU/FMS-related.
//
// This exists because the exact keypad command names differ per aircraft
// (the stock default FMS uses sim/FMS/*, but the stock Airbus A330 has its
// own MCDU implementation with its own namespace) — this script is how you
// find out what a specific loaded aircraft actually exposes, to update
// config/profiles/*.json accordingly.
//
// Usage: node tools/smoke-test.mjs [host] [port]
//   defaults: host=localhost port=8086

import { XPlaneClient, base64ToBytes, bytesToUtf8 } from "../src/xplane-client.js";

const host = process.argv[2] ?? "localhost";
const port = Number(process.argv[3]) || 8086;

const STYLE_COLORS = ["black", "cyan", "red", "yellow", "green", "magenta", "amber", "white"];
const ANSI = {
  black: 30, cyan: 36, red: 31, yellow: 33, green: 32, magenta: 35, amber: 33, white: 37,
};
function paint(char, color, reverse) {
  const code = ANSI[color] ?? 37;
  return reverse ? `\x1b[${code + 10};30m${char}\x1b[0m` : `\x1b[${code}m${char}\x1b[0m`;
}

function decodeLine(textB64, styleB64, cols) {
  const text = bytesToUtf8(base64ToBytes(textB64 ?? ""));
  const styleBytes = base64ToBytes(styleB64 ?? "");
  const chars = Array.from(text);
  const out = [];
  for (let i = 0; i < cols; i++) {
    const ch = chars[i] ?? " ";
    const s = styleBytes[i] ?? 0;
    out.push({
      char: ch,
      large: Boolean(s & (1 << 7)),
      reverse: Boolean(s & (1 << 6)),
      flash: Boolean(s & (1 << 5)),
      underline: Boolean(s & (1 << 4)),
      color: STYLE_COLORS[s & 0x0f] ?? "white",
    });
  }
  return out;
}

async function main() {
  console.log(`Connecting to X-Plane Web API at ${host}:${port} ...`);
  const client = new XPlaneClient(host, port);
  client.onStatusChange = (s, d) => {
    if (s === "error") console.error("[socket]", s, d?.message ?? d);
  };

  const caps = await client.getCapabilities();
  console.log("capabilities:", JSON.stringify(caps));

  await client.connectSocket();
  console.log("websocket open\n");

  const LINES = 16;
  const COLS = 24;

  for (const cdu of [1, 2]) {
    const textNames = Array.from({ length: LINES }, (_, l) => `sim/cockpit2/radios/indicators/fms_cdu${cdu}_text_line${l}`);
    const styleNames = Array.from({ length: LINES }, (_, l) => `sim/cockpit2/radios/indicators/fms_cdu${cdu}_style_line${l}`);
    const textIds = await client.resolveDatarefIds(textNames);
    const styleIds = await client.resolveDatarefIds(styleNames);

    if (textIds.size === 0) {
      console.log(`--- CDU ${cdu}: no fms_cdu${cdu}_text_line* datarefs found on this sim ---\n`);
      continue;
    }

    const raw = { text: new Array(LINES).fill(""), style: new Array(LINES).fill("") };
    let pending = 0;
    for (let l = 0; l < LINES; l++) {
      const tId = textIds.get(textNames[l]);
      const sId = styleIds.get(styleNames[l]);
      if (tId != null) {
        pending++;
        client.subscribeDataref(tId, (v) => { raw.text[l] = v; pending--; });
      }
      if (sId != null) {
        pending++;
        client.subscribeDataref(sId, (v) => { raw.style[l] = v; pending--; });
      }
    }

    await new Promise((r) => setTimeout(r, 400)); // let the 10Hz push loop deliver values

    console.log(`=== CDU ${cdu} screen (${LINES}x${COLS}) ===`);
    for (let l = 0; l < LINES; l++) {
      const cells = decodeLine(raw.text[l], raw.style[l], COLS);
      const rendered = cells.map((c) => paint(c.char, c.color, c.reverse)).join("");
      const flags = cells
        .map((c, i) => (c.large || c.flash || c.underline ? `${i}:${c.large ? "L" : ""}${c.flash ? "F" : ""}${c.underline ? "U" : ""}` : null))
        .filter(Boolean)
        .join(" ");
      console.log(`${String(l).padStart(2, "0")} |${rendered}|${flags ? "  " + flags : ""}`);
    }
    console.log();
  }

  console.log("Scanning full command list for MCDU/CDU/FMS-related names (this fetches everything once)...");
  const allCommands = await client.listAll("commands");
  const keywords = ["cdu", "mcdu", "fms"];
  const matches = allCommands.filter((c) => keywords.some((k) => c.name.toLowerCase().includes(k)));
  console.log(`${allCommands.length} commands total, ${matches.length} match [${keywords.join(", ")}]:\n`);
  for (const m of matches.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  #${m.id}\t${m.name}${m.description ? "  — " + m.description : ""}`);
  }

  console.log("\nScanning full dataref list for the same keywords (may take a moment)...");
  const allDatarefs = await client.listAll("datarefs");
  const drMatches = allDatarefs.filter((d) => keywords.some((k) => d.name.toLowerCase().includes(k)));
  console.log(`${allDatarefs.length} datarefs total, ${drMatches.length} match [${keywords.join(", ")}]:\n`);
  for (const m of drMatches.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  #${m.id}\t${m.name}`);
  }

  client.closeSocket();
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
