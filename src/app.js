import { XPlaneClient } from "./xplane-client.js";
import { McduAdapter } from "./mcdu-adapter.js";
import { McduScreenView } from "./mcdu-screen.js";
import { McduKeypad } from "./mcdu-keypad.js";

const STORAGE_KEY = "mcdu.connection";
const THEME_KEY = "mcdu.theme";
const BAR_HIDDEN_KEY = "mcdu.barHidden";

const els = {
  cdu: document.getElementById("conn-cdu"),
  connectBtn: document.getElementById("conn-connect"),
  status: document.getElementById("conn-status"),
  screen: document.getElementById("mcdu-screen"),
  lskLeft: document.getElementById("mcdu-lsk-left"),
  lskRight: document.getElementById("mcdu-lsk-right"),
  blockFunction: document.getElementById("mcdu-block-function"),
  blockUtility: document.getElementById("mcdu-block-utility"),
  blockNumeric: document.getElementById("mcdu-block-numeric"),
  blockAlpha: document.getElementById("mcdu-block-alpha"),
  themeSelect: document.getElementById("theme-select"),
  barToggle: document.getElementById("bar-toggle"),
  fullscreenToggle: document.getElementById("fullscreen-toggle"),
};

restoreConnectionForm();
restoreTheme();
restoreBarVisibility();

// Full-screen-friendly: hides the CDU/key-style/connect controls once
// you're actually set up and flying. The toggle button itself is fixed-
// position outside .connection-bar (see css/mcdu.css .bar-toggle) so it's
// still reachable to bring the bar back after hiding it.
els.barToggle.addEventListener("click", () => {
  const hidden = document.body.classList.toggle("bar-hidden");
  els.barToggle.textContent = hidden ? "▼" : "▲";
  els.barToggle.title = hidden ? "Show top bar" : "Hide top bar";
  localStorage.setItem(BAR_HIDDEN_KEY, hidden ? "1" : "0");
});

function restoreBarVisibility() {
  const hidden = localStorage.getItem(BAR_HIDDEN_KEY) === "1";
  document.body.classList.toggle("bar-hidden", hidden);
  els.barToggle.textContent = hidden ? "▼" : "▲";
  els.barToggle.title = hidden ? "Show top bar" : "Hide top bar";
}

// True browser full screen (hides the address bar/tabs too), separate from
// hiding the connection bar — the two are independent states. Not
// restored on load: browsers only allow requestFullscreen() from a direct
// user gesture, so there's nothing to persist. The fullscreenchange
// listener keeps the icon correct even if the user exits via Esc or
// swipe rather than this button.
els.fullscreenToggle.addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen().catch((err) => {
      console.warn("[app] full screen request failed:", err.message);
    });
  }
});
document.addEventListener("fullscreenchange", () => {
  const active = Boolean(document.fullscreenElement);
  els.fullscreenToggle.textContent = active ? "⤢" : "⛶";
  els.fullscreenToggle.title = active ? "Exit full screen" : "Enter full screen";
});

// Purely cosmetic and independent of the connection lifecycle — "bevel"
// and "deboss" (see css/mcdu.css, body[data-theme=...] rules) are both
// additive on top of the default flat look, so this just sets an
// attribute and remembers the choice; nothing about the keypad's actual
// DOM structure changes.
els.themeSelect.addEventListener("change", () => {
  document.body.dataset.theme = els.themeSelect.value;
  localStorage.setItem(THEME_KEY, els.themeSelect.value);
});

function restoreTheme() {
  const theme = localStorage.getItem(THEME_KEY) ?? "flat";
  els.themeSelect.value = theme;
  document.body.dataset.theme = theme;
}

// Reconnecting swaps in a new McduKeypad bound to a new adapter/client;
// without detaching the previous keyboard listener first, presses would
// pile up across every past connection, each firing against a client that
// may no longer even be open.
let detachKeyboardInput = null;

els.connectBtn.addEventListener("click", () => {
  connect().catch((err) => {
    console.error(err);
    setStatus("error", err.message);
  });
});

function restoreConnectionForm() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    els.cdu.value = saved.cdu ?? "1";
  } catch {
    // defaults from the <select> markup are fine
  }
}

function saveConnectionForm() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ cdu: els.cdu.value }));
}

function setStatus(state, detail) {
  els.status.textContent = detail ? `${state}: ${detail}` : state;
  els.status.className = `status status-${state}`;
}

async function connect() {
  const cduIndex = Number(els.cdu.value);
  saveConnectionForm();

  els.connectBtn.disabled = true;
  setStatus("connecting");

  // No X-Plane host/port to ask for: the browser always talks to whatever
  // server it loaded this page from (tools/mcdu-server.js), which proxies
  // /api/* to X-Plane over localhost — see that file for why. That also
  // means this works identically whether you're on the X-Plane machine
  // itself or on a tablet elsewhere on the LAN.
  const client = new XPlaneClient(window.location.hostname, window.location.port || 80);
  client.onStatusChange = (state, detail) => setStatus(state, detail?.message);

  // Fail fast with a clear message if X-Plane isn't reachable through the
  // proxy, before bothering to open the websocket.
  try {
    await client.getCapabilities();
  } catch (err) {
    setStatus(
      "error",
      `couldn't reach X-Plane through this server's proxy — is X-Plane running with the ` +
        `Web API enabled (Settings → Network), and is tools/mcdu-server.js running on the ` +
        `same machine as X-Plane? (${err.message})`
    );
    els.connectBtn.disabled = false;
    return;
  }

  await client.connectSocket();

  const profile = await fetch("./config/profiles/default-fms.json").then((r) => r.json());
  const adapter = new McduAdapter(client, profile, cduIndex);
  await adapter.connect();

  new McduScreenView(els.screen, adapter);

  const keypad = new McduKeypad(adapter);
  keypad.renderLskColumn("line_select_left", els.lskLeft);
  keypad.renderLskColumn("line_select_right", els.lskRight);
  keypad.renderLayoutGrid(profile.keypadLayout.functionBlock, els.blockFunction);
  keypad.renderLayoutGrid(profile.keypadLayout.utilityBlock, els.blockUtility);
  keypad.renderLayoutGrid(profile.keypadLayout.numericBlock, els.blockNumeric);
  keypad.renderLayoutGrid(profile.keypadLayout.alphaBlock, els.blockAlpha);
  keypad.refreshAvailability();

  detachKeyboardInput?.();
  detachKeyboardInput = keypad.attachKeyboardInput();

  if (adapter.unresolvedKeys.size > 0) {
    setStatus(
      "open",
      `connected, but ${adapter.unresolvedKeys.size} key(s) didn't resolve — see console`
    );
  } else {
    setStatus("open", `connected to CDU ${cduIndex}`);
  }

  els.connectBtn.disabled = false;
  els.connectBtn.textContent = "Reconnect";
}
