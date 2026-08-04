#!/usr/bin/env node
// A small stand-in for X-Plane's Web API, implementing just enough of the
// v2 surface (capabilities, datarefs, commands, both REST and WebSocket) to
// exercise the whole app — client, adapter, screen, keypad —
// without X-Plane running at all. Useful for UI development and as a
// runnable example of the wire protocol described in
// docs/xplane-web-api-notes.md.
//
// It only knows about the CDU-1 text/style lines and the command names in
// config/profiles/default-fms.json. It fakes a scratchpad: typing keys
// appends characters to the bottom line, CLR/DEL backspaces, and any other
// key flashes its name on line 1 so you can see keypresses are reaching
// the "sim".
//
// Usage: node tools/mock-xplane-server/server.js [port]   (default 8086,
// same as real X-Plane, so the app needs zero config changes to point at it)

import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.argv[2]) || 8086;
const LINES = 16;
const COLS = 24;

const STYLE = { LARGE: 1 << 7, REVERSE: 1 << 6, FLASH: 1 << 5, UNDERLINE: 1 << 4 };
const COLOR = { black: 0, cyan: 1, red: 2, yellow: 3, green: 4, magenta: 5, amber: 6, white: 7 };

// ---------------------------------------------------------------- state --

const profile = JSON.parse(
  readFileSync(path.join(ROOT, "config/profiles/default-fms.json"), "utf-8")
);

let nextId = 1;
/** @type {Map<number, {id:number, name:string, value:any}>} */
const datarefsById = new Map();
/** @type {Map<string, number>} */
const datarefIdByName = new Map();
function defineDataref(name, value) {
  const id = nextId++;
  datarefsById.set(id, { id, name, value });
  datarefIdByName.set(name, id);
  return id;
}

/** @type {Map<number, {id:number, name:string}>} */
const commandsById = new Map();
const commandIdByName = new Map();
function defineCommand(name) {
  const id = nextId++;
  commandsById.set(id, { id, name });
  commandIdByName.set(name, id);
  return id;
}

const textLineId = [];
const styleLineId = [];
for (let line = 0; line < LINES; line++) {
  textLineId[line] = defineDataref(`sim/cockpit2/radios/indicators/fms_cdu1_text_line${line}`, "");
  styleLineId[line] = defineDataref(`sim/cockpit2/radios/indicators/fms_cdu1_style_line${line}`, "");
}
// (Also register CDU2/CDU3 as blank/unused datarefs so connecting to those
// positions resolves too — only CDU1's screen is actually driven by the demo.)
for (const cdu of [2, 3]) {
  for (let line = 0; line < LINES; line++) {
    defineDataref(`sim/cockpit2/radios/indicators/fms_cdu${cdu}_text_line${line}`, "");
    defineDataref(`sim/cockpit2/radios/indicators/fms_cdu${cdu}_style_line${line}`, "");
  }
}

// Commands live under a different prefix per CDU (sim/FMS, sim/FMS2,
// sim/CDU3) — register the full name for each, matching what McduAdapter
// composes via profile.commandPrefixByCdu. A few (brightness) instead use
// commandTemplate ({cdu} substituted directly) and are registered separately.
for (const prefix of Object.values(profile.commandPrefixByCdu ?? {})) {
  for (const group of Object.values(profile.keys)) {
    for (const def of Object.values(group)) {
      if (def.commandTemplate) continue;
      const full = `${prefix}/${def.command}`;
      if (!commandIdByName.has(full)) defineCommand(full);
    }
  }
}
for (const cdu of [1, 2, 3]) {
  for (const group of Object.values(profile.keys)) {
    for (const def of Object.values(group)) {
      if (!def.commandTemplate) continue;
      const full = def.commandTemplate.replace("{cdu}", String(cdu));
      if (!commandIdByName.has(full)) defineCommand(full);
    }
  }
}

let scratchpad = "";
let message = "";
let messageTimer = null;

function setLine(line, text, styleByte) {
  const t = text.padEnd(COLS, " ").slice(0, COLS);
  const styleBytes = new Uint8Array(COLS).fill(styleByte);
  datarefsById.get(textLineId[line]).value = Buffer.from(t, "utf-8").toString("base64");
  datarefsById.get(styleLineId[line]).value = Buffer.from(styleBytes).toString("base64");
}

function render() {
  setLine(0, "MCDU MOCK SERVER", STYLE.LARGE | STYLE.REVERSE | COLOR.white);
  setLine(1, message, STYLE.LARGE | COLOR.amber);
  for (let line = 2; line < LINES - 1; line++) setLine(line, "", COLOR.white);
  setLine(LINES - 1, scratchpad, COLOR.white);
}
render();

function flashMessage(text) {
  message = text;
  render();
  broadcastChangedLines([1]);
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    message = "";
    render();
    broadcastChangedLines([1]);
  }, 1200);
}

function handleKeyCommand(name) {
  let changed = false;
  const numMatch = name.match(/^sim\/FMS\/key_(\d)$/);
  const alphaMatch = name.match(/^sim\/FMS\/key_([A-Z])$/);
  if (numMatch) {
    scratchpad = (scratchpad + numMatch[1]).slice(0, COLS);
    changed = true;
  } else if (alphaMatch) {
    scratchpad = (scratchpad + alphaMatch[1]).slice(0, COLS);
    changed = true;
  } else if (name === "sim/FMS/key_period") {
    scratchpad = (scratchpad + ".").slice(0, COLS);
    changed = true;
  } else if (name === "sim/FMS/key_space") {
    scratchpad = (scratchpad + " ").slice(0, COLS);
    changed = true;
  } else if (name === "sim/FMS/key_slash") {
    scratchpad = (scratchpad + "/").slice(0, COLS);
    changed = true;
  } else if (name === "sim/FMS/key_minus") {
    scratchpad = (scratchpad + "-").slice(0, COLS);
    changed = true;
  } else if (name === "sim/FMS/key_clear" || name === "sim/FMS/key_delete") {
    scratchpad = scratchpad.slice(0, -1);
    changed = true;
  } else {
    // CDU2/CDU3 key names (and any CDU1 page/function key) just flash their
    // name — only CDU1 typing is simulated in this demo.
    flashMessage(`>> ${name.replace(/^sim\/(FMS2?|CDU3)\//, "")} <<`);
    return;
  }
  if (changed) {
    render();
    broadcastChangedLines([LINES - 1]);
  }
}

// -------------------------------------------------------------- HTTP api --

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

function filterByExactNames(all, url) {
  const names = url.searchParams.getAll("filter[name]");
  if (names.length === 0) return all;
  const wanted = new Set(names);
  return all.filter((e) => wanted.has(e.name));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/capabilities") {
    return sendJson(res, 200, {
      data: { versions: ["v1", "v2"], "x-plane": { version: "120410 (mock)" } },
    });
  }

  if (url.pathname === "/api/v2/datarefs") {
    const all = [...datarefsById.values()].map(({ id, name }) => ({ id, name, value_type: "data" }));
    return sendJson(res, 200, { data: filterByExactNames(all, url) });
  }
  if (url.pathname === "/api/v2/commands") {
    const all = [...commandsById.values()];
    return sendJson(res, 200, { data: filterByExactNames(all, url) });
  }
  const drValueMatch = url.pathname.match(/^\/api\/v2\/datarefs\/(\d+)\/value$/);
  if (drValueMatch) {
    const entry = datarefsById.get(Number(drValueMatch[1]));
    if (!entry) return sendJson(res, 404, { error_code: "not_found", error_message: "no such dataref" });
    return sendJson(res, 200, { data: entry.value });
  }

  sendJson(res, 404, { error_code: "not_found", error_message: `no mock handler for ${url.pathname}` });
});

// --------------------------------------------------------------- socket --

const wss = new WebSocketServer({ server, path: "/api/v2" });

wss.on("connection", (ws) => {
  const subscribedDatarefs = new Set();
  const subscribedCommands = new Set();

  ws._push = (ids) => {
    const data = {};
    for (const id of ids) {
      if (subscribedDatarefs.has(id)) data[id] = datarefsById.get(id).value;
    }
    if (Object.keys(data).length > 0) {
      ws.send(JSON.stringify({ type: "dataref_update_values", data }));
    }
  };

  const tick = setInterval(() => {
    if (subscribedDatarefs.size === 0) return;
    ws._push([...subscribedDatarefs]);
  }, 100); // ~10Hz, matching the real API

  ws.on("close", () => clearInterval(tick));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const ok = () => ws.send(JSON.stringify({ req_id: msg.req_id, type: "result", success: true }));

    switch (msg.type) {
      case "dataref_subscribe_values":
        for (const d of msg.params.datarefs) subscribedDatarefs.add(d.id);
        ok();
        ws._push([...subscribedDatarefs]); // immediate first push, don't wait for the tick
        break;
      case "dataref_unsubscribe_values":
        if (msg.params.datarefs === "all") subscribedDatarefs.clear();
        else for (const d of msg.params.datarefs) subscribedDatarefs.delete(d.id);
        ok();
        break;
      case "command_subscribe_is_active":
        for (const c of msg.params.commands) subscribedCommands.add(c.id);
        ok();
        break;
      case "command_unsubscribe_is_active":
        if (msg.params.commands === "all") subscribedCommands.clear();
        else for (const c of msg.params.commands) subscribedCommands.delete(c.id);
        ok();
        break;
      case "command_set_is_active":
        for (const c of msg.params.commands) {
          const entry = commandsById.get(c.id);
          if (entry && c.is_active) handleKeyCommand(entry.name);
          if (entry && subscribedCommands.has(c.id)) {
            ws.send(
              JSON.stringify({ type: "command_update_is_active", data: { [c.id]: Boolean(c.is_active) } })
            );
            if (c.is_active) {
              setTimeout(() => {
                ws.send(
                  JSON.stringify({ type: "command_update_is_active", data: { [c.id]: false } })
                );
              }, (c.duration ?? 0.15) * 1000);
            }
          }
        }
        ok();
        break;
      case "dataref_set_values":
        for (const d of msg.params.datarefs) {
          const entry = datarefsById.get(d.id);
          if (entry) entry.value = d.value;
        }
        ok();
        break;
      default:
        ws.send(
          JSON.stringify({ req_id: msg.req_id, type: "result", success: false, error_code: "unhandled", error_message: `mock server doesn't implement ${msg.type}` })
        );
    }
  });
});

function broadcastChangedLines() {
  const ids = [...textLineId, ...styleLineId];
  for (const client of wss.clients) client._push?.(ids);
}

server.listen(PORT, () => {
  console.log(`Mock X-Plane Web API listening on http://localhost:${PORT} (REST + WS, api/v2)`);
  console.log("Point the app at host=localhost, port=" + PORT + " to try it without X-Plane.");
});
