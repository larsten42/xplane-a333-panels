import { XPlaneClient } from "./xplane-client.js";
import { McduAdapter } from "./mcdu-adapter.js";
import { McduScreenView } from "./mcdu-screen.js";
import { McduKeypad } from "./mcdu-keypad.js";
import { EfisAdapter } from "./efis-adapter.js";
import { EfisPanel } from "./efis-panel.js";

const STORAGE_KEY = "mcdu.connection";
const THEME_KEY = "mcdu.theme";
const BAR_HIDDEN_KEY = "mcdu.barHidden";
const PANEL_KEY = "mcdu.panel";

const els = {
  panelSelect: document.getElementById("panel-select"),
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
  panelMcdu: document.getElementById("panel-mcdu"),
  panelEfis: document.getElementById("panel-efis"),
  efisContainer: document.getElementById("efis-panel"),
};

// Reconnecting swaps in new adapters/keypad bound to a new client, and
// switching away from the MCDU panel detaches keyboard input entirely
// (see showPanel()) — without detaching the previous listener first,
// presses would pile up across every past connection, each firing against
// a client that may no longer even be open. Declared before the
// restore*() calls below since restorePanel() calls showPanel(), which
// reads both of these immediately: a `let` referenced before its own
// declaration line throws a ReferenceError even though the declaration is
// hoisted, and that was silently killing the rest of this module's
// top-level code — including every addEventListener() call after it.
let detachKeyboardInput = null;
let mcduKeypad = null;

restoreConnectionForm();
restoreTheme();
restoreBarVisibility();
restorePanel();

// Full-screen-friendly: hides the panel/CDU/key-style/connect controls
// once you're actually set up and flying. The toggle button itself is
// fixed-position outside .connection-bar (see css/mcdu.css .bar-toggle)
// so it's still reachable to bring the bar back after hiding it.
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

// Which panel (MCDU/EFIS) is visible — independent of connection state, so
// switching works before connecting too, it just shows an empty panel
// until connect() populates it. body[data-panel=...] (see mcdu.css) is
// what hides the CDU/Key-style controls when EFIS is showing, since
// they're meaningless there.
els.panelSelect.addEventListener("change", () => {
  showPanel(els.panelSelect.value);
  localStorage.setItem(PANEL_KEY, els.panelSelect.value);
});

function restorePanel() {
  const panel = localStorage.getItem(PANEL_KEY) ?? "mcdu";
  els.panelSelect.value = panel;
  showPanel(panel);
}

function showPanel(panel) {
  document.body.dataset.panel = panel;
  els.panelMcdu.hidden = panel !== "mcdu";
  els.panelEfis.hidden = panel !== "efis";

  // The physical-keyboard bindings only make sense while the MCDU panel is
  // the one actually on screen — otherwise typing while looking at EFIS
  // would silently be driving MCDU keys underneath it.
  detachKeyboardInput?.();
  detachKeyboardInput = panel === "mcdu" ? mcduKeypad?.attachKeyboardInput() ?? null : null;
}

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
  // itself or on a tablet elsewhere on the LAN. One connection serves both
  // panels — MCDU and EFIS just subscribe to different datarefs/commands
  // over it, so switching panels never needs a reconnect.
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

  const [mcduProfile, efisProfile] = await Promise.all([
    fetch("./config/profiles/default-fms.json").then((r) => r.json()),
    fetch("./config/profiles/efis-a333.json").then((r) => r.json()),
  ]);

  const mcduAdapter = new McduAdapter(client, mcduProfile, cduIndex);
  await mcduAdapter.connect();

  new McduScreenView(els.screen, mcduAdapter);

  mcduKeypad = new McduKeypad(mcduAdapter);
  mcduKeypad.renderLskColumn("line_select_left", els.lskLeft);
  mcduKeypad.renderLskColumn("line_select_right", els.lskRight);
  mcduKeypad.renderLayoutGrid(mcduProfile.keypadLayout.functionBlock, els.blockFunction);
  mcduKeypad.renderLayoutGrid(mcduProfile.keypadLayout.utilityBlock, els.blockUtility);
  mcduKeypad.renderLayoutGrid(mcduProfile.keypadLayout.numericBlock, els.blockNumeric);
  mcduKeypad.renderLayoutGrid(mcduProfile.keypadLayout.alphaBlock, els.blockAlpha);
  mcduKeypad.refreshAvailability();

  const efisAdapter = new EfisAdapter(client, efisProfile);
  await efisAdapter.connect();
  new EfisPanel(els.efisContainer, efisAdapter);

  // Re-applies keyboard-input attachment for whichever panel is currently
  // selected, now that mcduKeypad actually exists.
  showPanel(els.panelSelect.value);

  const unresolvedCount = mcduAdapter.unresolvedKeys.size + efisAdapter.unresolved.size;
  if (unresolvedCount > 0) {
    setStatus("open", `connected, but ${unresolvedCount} item(s) didn't resolve — see console`);
  } else {
    setStatus("open", `connected to CDU ${cduIndex}`);
  }

  els.connectBtn.disabled = false;
  els.connectBtn.textContent = "Reconnect";
}
