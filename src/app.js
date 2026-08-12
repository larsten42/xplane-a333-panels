import { XPlaneClient } from "./xplane-client.js";
import { McduAdapter } from "./mcdu-adapter.js";
import { McduScreenView } from "./mcdu-screen.js";
import { McduKeypad } from "./mcdu-keypad.js";
import { EfisAdapter } from "./efis-adapter.js";
import { wireEfisPanel, blankEfisPanel } from "./efis-panel.js";
import { wireFcuPanel, blankFcuPanel } from "./fcu-panel.js";
import { wireRadioPanel, blankRadioPanel } from "./radio-panel.js";
import { setupAutoscale } from "./panel-autoscale.js";
import { startWakeLock, stopWakeLock } from "./wake-lock.js";

// <fcu-panel>/<efis-panel>/<radio-panel>'s native, unscaled pixel size —
// see their own INTEGRATION.md's "Sizing" table. Needed here (not just
// discoverable from the DOM) since panel-autoscale.js computes a scale
// factor against these.
const FCU_NATIVE_SIZE = { width: 1266, height: 442 };
const EFIS_NATIVE_SIZE = { width: 720, height: 370 };
const RADIO_NATIVE_SIZE = { width: 1112, height: 500 };

const STORAGE_KEY = "mcdu.connection";
const THEME_KEY = "mcdu.theme";
const BAR_HIDDEN_KEY = "mcdu.barHidden";
const PANEL_KEY = "mcdu.panel";
const AIRCRAFT_KEY = "mcdu.aircraft";

// Each panel type is independently gated by whether a profile exists for
// the selected aircraft — see ARCHITECTURE.md's "Adding support for
// another aircraft" for why the 737's MCDU profile was a low-effort add
// (X-Plane's default FMS/CDU is one shared program) while EFIS/FCU need a
// real per-aircraft profile (own dataref/command namespace) or, for a
// genuinely different aircraft family (Boeing's MCP instead of an FCU), a
// new panel entirely. A missing entry here just means that panel option
// stays disabled for that aircraft (see applyAircraftAvailability()) —
// none of these three maps need to agree on which aircraft they cover.
const AIRCRAFT_MCDU_PROFILES = {
  a333: "./config/profiles/default-fms.json",
  b738: "./config/profiles/b738-fms.json",
};
const AIRCRAFT_EFIS_PROFILES = {
  a333: "./config/profiles/efis-a333.json",
  "toliss-airbus": "./config/profiles/efis-toliss-airbus.json",
};
const AIRCRAFT_FCU_PROFILES = {
  a333: "./config/profiles/fcu-a333.json",
};

// Unlike EFIS/FCU, the radio panel lives under X-Plane's own generic
// sim/radios / sim/audio_panel / sim/transponder namespaces (see
// config/profiles/radio-panel-generic.json's description) — same reasoning
// as the MCDU profile being aircraft-generic, so it's not gated by aircraft
// selection at all.
const RADIO_PROFILE_PATH = "./config/profiles/radio-panel-generic.json";

const els = {
  aircraftSelect: document.getElementById("aircraft-select"),
  panelSelect: document.getElementById("panel-select"),
  cdu: document.getElementById("conn-cdu"),
  connectBtn: document.getElementById("conn-connect"),
  status: document.getElementById("conn-status"),
  connLed: document.getElementById("conn-led"),
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
  autoscaleToggle: document.getElementById("autoscale-toggle"),
  panelMcdu: document.getElementById("panel-mcdu"),
  panelEfis: document.getElementById("panel-efis"),
  panelFcu: document.getElementById("panel-fcu"),
  panelRadio: document.getElementById("panel-radio"),
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
// After restorePanel(), not before — it needs the *persisted* panel choice
// already loaded so it can correct a stale one (e.g. EFIS selected from a
// previous Airbus session, now invalid because the restored aircraft is
// the 737) rather than checking against the <select>'s unloaded default.
restoreAircraft();

// Otherwise <fcu-panel>/<efis-panel>/<radio-panel> show the vendored
// components' own baked-in demo values from page load until connect()
// actually wires them up — indistinguishable from real live data at a
// glance.
blankFcuPanel();
blankEfisPanel();
blankRadioPanel();

setupAutoscale(els.autoscaleToggle, [
  {
    container: els.panelFcu.querySelector(".scalable-panel"),
    panelEl: els.panelFcu.querySelector("fcu-panel"),
    nativeWidth: FCU_NATIVE_SIZE.width,
    nativeHeight: FCU_NATIVE_SIZE.height,
  },
  {
    container: els.panelEfis.querySelector(".scalable-panel"),
    panelEl: els.panelEfis.querySelector("efis-panel"),
    nativeWidth: EFIS_NATIVE_SIZE.width,
    nativeHeight: EFIS_NATIVE_SIZE.height,
  },
  {
    container: els.panelRadio.querySelector(".scalable-panel"),
    panelEl: els.panelRadio.querySelector("radio-panel"),
    nativeWidth: RADIO_NATIVE_SIZE.width,
    nativeHeight: RADIO_NATIVE_SIZE.height,
  },
]);

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

// "generic" (see AIRCRAFT_MCDU_PROFILES above) has no MCDU/EFIS/FCU
// profile at all — it exists purely so the radio panel can be tested
// against a non-Airbus/non-737 default aircraft (e.g. a GA type) without
// also trying to connect profiles that were never going to work on that
// aircraft anyway, piling up unresolved-command noise. Options are greyed
// out rather than left clickable into a panel that would just show
// unresolved/disabled everything.
els.aircraftSelect.addEventListener("change", () => {
  localStorage.setItem(AIRCRAFT_KEY, els.aircraftSelect.value);
  applyAircraftAvailability();
});

function restoreAircraft() {
  els.aircraftSelect.value = localStorage.getItem(AIRCRAFT_KEY) ?? "a333";
  applyAircraftAvailability();
}

function applyAircraftAvailability() {
  const aircraft = els.aircraftSelect.value;
  const hasMcdu = Boolean(AIRCRAFT_MCDU_PROFILES[aircraft]);
  const hasEfis = Boolean(AIRCRAFT_EFIS_PROFILES[aircraft]);
  const hasFcu = Boolean(AIRCRAFT_FCU_PROFILES[aircraft]);
  for (const opt of els.panelSelect.options) {
    if (opt.value === "mcdu") opt.disabled = !hasMcdu;
    if (opt.value === "efis") opt.disabled = !hasEfis;
    if (opt.value === "fcu") opt.disabled = !hasFcu;
  }
  // The radio panel (never disabled) is always a safe fallback once the
  // currently selected panel option becomes unavailable for this aircraft.
  if (els.panelSelect.selectedOptions[0]?.disabled) {
    els.panelSelect.value = "radio";
    localStorage.setItem(PANEL_KEY, "radio");
    showPanel("radio");
  }
}

function showPanel(panel) {
  document.body.dataset.panel = panel;
  els.panelMcdu.hidden = panel !== "mcdu";
  els.panelEfis.hidden = panel !== "efis";
  els.panelFcu.hidden = panel !== "fcu";
  els.panelRadio.hidden = panel !== "radio";

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
  els.connLed.className = `conn-led status-${state}`;
  // Keep the screen on for as long as there's a live connection to fly
  // with — see wake-lock.js's own top comment for the HTTPS caveat.
  if (state === "open") startWakeLock();
  else stopWakeLock();
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

  await client.connectSocket(els.panelSelect.value);

  const aircraft = els.aircraftSelect.value;
  const mcduProfilePath = AIRCRAFT_MCDU_PROFILES[aircraft];
  const efisProfilePath = AIRCRAFT_EFIS_PROFILES[aircraft];
  const fcuProfilePath = AIRCRAFT_FCU_PROFILES[aircraft];
  const [mcduProfile, efisProfile, fcuProfile, radioProfile] = await Promise.all([
    mcduProfilePath ? fetch(mcduProfilePath).then((r) => r.json()) : null,
    efisProfilePath ? fetch(efisProfilePath).then((r) => r.json()) : null,
    fcuProfilePath ? fetch(fcuProfilePath).then((r) => r.json()) : null,
    fetch(RADIO_PROFILE_PATH).then((r) => r.json()),
  ]);

  // No MCDU profile for "generic" — see AIRCRAFT_MCDU_PROFILES above. The
  // mcdu panel option is already disabled in that case
  // (applyAircraftAvailability()), so mcduKeypad staying null just means
  // there's nothing to attach keyboard input to.
  let mcduAdapter = null;
  if (mcduProfile) {
    mcduAdapter = new McduAdapter(client, mcduProfile, cduIndex);
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
  } else {
    mcduKeypad = null;
  }

  // No EFIS/FCU profile for every aircraft yet — see the AIRCRAFT_*_PROFILES
  // maps above. Those panel options are already disabled in that case
  // (applyAircraftAvailability()), and blankFcuPanel()/blankEfisPanel()
  // from startup already leave both panels blank rather than stale demo
  // data. EFIS and FCU are independently gated (unlike before, when one
  // "isAirbus" flag controlled both) since a new aircraft can have one
  // without the other — e.g. efis-toliss-airbus.json exists with no FCU
  // counterpart yet.
  let efisAdapter = null;
  if (efisProfile) {
    efisAdapter = new EfisAdapter(client, efisProfile);
    await efisAdapter.connect();
    wireEfisPanel(efisAdapter);
  }

  let fcuAdapter = null;
  if (fcuProfile) {
    fcuAdapter = new EfisAdapter(client, fcuProfile);
    await fcuAdapter.connect();
    wireFcuPanel(fcuAdapter);
  }

  const radioAdapter = new EfisAdapter(client, radioProfile);
  await radioAdapter.connect();
  wireRadioPanel(radioAdapter);

  // Re-applies keyboard-input attachment for whichever panel is currently
  // selected, now that mcduKeypad actually exists.
  showPanel(els.panelSelect.value);

  const unresolvedCount =
    (mcduAdapter?.unresolvedKeys.size ?? 0) +
    (efisAdapter?.unresolved.size ?? 0) +
    (fcuAdapter?.unresolved.size ?? 0) +
    radioAdapter.unresolved.size;
  if (unresolvedCount > 0) {
    setStatus("open", `connected, but ${unresolvedCount} item(s) didn't resolve — see console`);
  } else {
    setStatus("open", mcduAdapter ? `connected to CDU ${cduIndex}` : "connected");
  }

  els.connectBtn.disabled = false;
  els.connectBtn.textContent = "Reconnect";
}
