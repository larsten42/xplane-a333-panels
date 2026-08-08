// Wires the vendored FCU component library (vendor/fcu-instruments.js — see
// vendor/README.md for what it is and how to update it) to the real
// X-Plane adapter. This file owns every bit of X-Plane-specific knowledge;
// the vendored file is never edited, so bringing in an updated bundle is
// just a file copy (unless the component's own API surface changed — see
// vendor/README.md for what to check in that case).
//
// EFIS still uses the older EfisPanel/data-attribute approach — migrating
// it to the same vendored library is a separate, larger piece of work.
//
// The vendored panel builds itself synchronously when <fcu-panel> is
// inserted (see its own INTEGRATION.md), so window.fcuPanel/window.fcu are
// already present by the time this runs from app.js.

const BUTTON_ID_TO_NAME = {
  "spd-mach": "SPD_MACH",
  "hdg-vs": "HDG_TRK",
  "metric-alt": "METRIC_ALT",
  ap1: "AP1",
  ap2: "AP2",
  athr: "A/THR",
  loc: "LOC",
  alt: "ALT",
  appr: "APPR",
};

const KNOB_ID_TO_READOUT = { spd: "SPD", hdg: "HDG", alt: "ALT", vs: "VS" };

// How long to wait after the last onTurn before treating a drag as over —
// the vendored knob API has no onDragStart/onDragEnd the way our own
// RotaryEncoder does, only per-detent onTurn calls, so this reconstructs
// "still dragging" from those. Needed for the same reason baro's knob
// needs beginAdjust()/endAdjust(): while actively dragging, our own
// optimistic writes are ahead of X-Plane's ~10Hz confirmation, and without
// suppressing the subscription during that window a lagging echo can yank
// the displayed value backwards mid-drag.
const DRAG_END_DEBOUNCE_MS = 200;

/**
 * Blanks the FCU display and every button LED, with no adapter involved —
 * for the page-load state before a connection exists. Without this, the
 * panel shows the vendored component's own baked-in demo values (250kt,
 * HDG 270, etc.) from page load until the user actually connects, which
 * reads as real live data. Also reused as the "unpowered" look once
 * connected — see AVIONICS handling in wireFcuPanel().
 */
export function blankFcuPanel() {
  const panel = window.fcuPanel;
  const fcu = window.fcu;
  if (!panel || !fcu) return;
  fcu.clear();
  for (const id of panel.buttons) panel.setLed(id, false);
}

export function wireFcuPanel(adapter) {
  const panel = window.fcuPanel;
  const fcu = window.fcu;
  if (!panel || !fcu) {
    console.error(
      "[fcu-panel] window.fcuPanel/window.fcu not found — is <fcu-panel> in the page, and vendor/fcu-instruments.js loaded before this runs?"
    );
    return;
  }

  wireButtonPresses(panel, adapter);
  wireKnobs(panel, adapter);

  const refreshButtons = () => refreshButtonLeds(panel, adapter, isPowered(adapter));
  const refreshDisplay = () => refreshFcuDisplay(fcu, adapter, isPowered(adapter));
  const refresh = () => {
    refreshButtons();
    refreshDisplay();
  };

  // A single combined refresh on both events, rather than each area
  // guarding its own slice of state: AVIONICS is a readout, so it only
  // ever arrives via onReadoutChange, but it needs to blank the buttons
  // too — simplest to just recompute everything on every change than to
  // track which specific readout changed.
  adapter.onStateChange = refresh;
  adapter.onReadoutChange = refresh;
  refresh();
}

function isPowered(adapter) {
  return Number(adapter.getReadoutValue("AVIONICS", "value")) !== 0;
}

function wireButtonPresses(panel, adapter) {
  for (const id of panel.buttons) {
    const name = BUTTON_ID_TO_NAME[id];
    if (!name) {
      console.warn(`[fcu-panel] button id "${id}" from the vendored panel has no matching profile entry — leaving it unwired`);
      continue;
    }
    if (!adapter.isAvailable(name)) {
      console.warn(`[fcu-panel] "${name}" (button "${id}") did not resolve on this sim — leaving it unwired`);
      continue;
    }
    panel.button(id).onPress(() => adapter.press(name));
  }
}

function refreshButtonLeds(panel, adapter, powered) {
  for (const [id, name] of Object.entries(BUTTON_ID_TO_NAME)) {
    if (adapter.isAvailable(name)) panel.setLed(id, powered && adapter.isLit(name));
  }
}

function wireKnobs(panel, adapter) {
  const dragEndTimers = new Map();

  const onTurn = (name, dir) => {
    if (!dragEndTimers.has(name)) adapter.beginAdjust(name);
    else clearTimeout(dragEndTimers.get(name));
    dragEndTimers.set(
      name,
      setTimeout(() => {
        dragEndTimers.delete(name);
        adapter.endAdjust(name);
      }, DRAG_END_DEBOUNCE_MS)
    );

    adapter.adjustReadoutValue(name, dir);
  };

  for (const id of panel.knobs) {
    const name = KNOB_ID_TO_READOUT[id];
    if (!name) continue;
    const knob = panel.knob(id);
    knob.onTurn((dir) => onTurn(name, dir));

    if (name === "HDG") {
      // Heading's push/pull each also fire a second, independent command
      // (gpss on push, heading_sync on pull) — two unconditional presses
      // per gesture, not EfisAdapter's onCommands/offCommands pairing
      // (that's for a toggle chosen by current state).
      knob.onPull(() => {
        adapter.press("HDG_PULL");
        adapter.press("HDG_SYNC");
      });
      knob.onPush(() => {
        adapter.press("HDG_PUSH");
        adapter.press("HDG_GPSS");
      });
    } else if (name === "ALT") {
      // Pull is the same regardless of mode; push branches on whether ALT
      // is currently managed (fms_vnav-driven, same "managed" key the
      // display's ALTDOT reads) or selected — confirmed live 2026-08-08.
      knob.onPull(() => {
        adapter.press("ALT_KNOB_PULL");
        adapter.press("ALT_SPEED_HOLD");
        adapter.press("ALT_LEVEL_CHANGE");
      });
      knob.onPush(() => {
        adapter.press("ALT_KNOB_PUSH");
        const managed = Number(adapter.getReadoutValue("ALT", "managed")) !== 0;
        adapter.press(managed ? "ALT_INTV" : "ALT_FMS");
      });
    } else {
      knob.onPull(() => adapter.press(`${name}.pull`));
      knob.onPush(() => adapter.press(`${name}.push`));
    }
  }

  // ALT's concentric ring picks the knob's step size (100ft/1000ft) —
  // unlike a plain toggle, the vendored knob's onRing(i) hands back the
  // *target* index the user actually selected, which happens to line up
  // exactly with alt_step_left (index 0, 100ft) / alt_step_right (index 1,
  // 1000ft) — confirmed live 2026-08-08: those two commands set the ring
  // to an absolute position rather than nudging altitude, and
  // alt_step_knob_pos is the same 0/1 dataref both read from and reflect.
  // Not gated by AVIONICS — it's a physical selector position, not a lit
  // indication, so it stays wherever it physically is regardless of power,
  // same as a toggle switch would.
  const altKnob = panel.knob("alt");
  altKnob.onRing((i) => adapter.press(i === 0 ? "ALT_STEP_LEFT" : "ALT_STEP_RIGHT"));
  const syncAltRing = () => altKnob.setRing(Number(adapter.getReadoutValue("ALT", "ring")) !== 0 ? 1 : 0);
  const prevOnReadoutChangeForRing = adapter.onReadoutChange;
  adapter.onReadoutChange = (name) => {
    prevOnReadoutChangeForRing?.(name);
    if (name === "ALT") syncAltRing();
  };
  syncAltRing();
}

// SPD/HDG/ALT/V-S display — see readout-formats.js's fcuSpeed/fcuHeading/
// fcuAltitude/fcuVerticalSpeed for the *values*; those formatters still run
// (EfisAdapter requires a valid one to resolve a readout's commands/
// datarefs at all) but their combined "123•"-style text output isn't used
// here — the vendored display wants the plain number and the managed dot
// as two separate calls, not one string, so this reads the raw values via
// getReadoutValue() instead of getReadoutText().
function refreshFcuDisplay(fcu, adapter, powered) {
  if (!powered) {
    fcu.clear();
    return;
  }

  const spdSelected = Number(adapter.getReadoutValue("SPD", "selected")) !== 0;
  const spdIsMach = Number(adapter.getReadoutValue("SPD", "mach")) !== 0;
  if (!spdSelected) {
    // Managed: the FMS is computing the target, so there's no pilot-picked
    // number to show — dashes instead (confirmed live 2026-08-08). The
    // knots/Mach unit annunciator still reflects the current mode
    // regardless of managed/selected, which is an orthogonal setting (the
    // SPD/MACH button, not the knob push/pull).
    fcu.setField("spd", "---");
    fcu.setDecimal("spd", 1, false);
    fcu.setLabel("MACH", spdIsMach);
    fcu.setLabel("SPD", !spdIsMach);
  } else if (spdIsMach) {
    // showMach() wants the same string shape as its own documented
    // example (".78", not "0.78" or a bare number) — it strips any "."
    // itself and just pads/positions from there, so this only needs to
    // match that shape, not reproduce its internal digit layout.
    const mach = Number(adapter.getReadoutValue("SPD", "value")) || 0;
    fcu.showMach(`.${String(Math.round(mach * 100)).padStart(2, "0")}`);
  } else {
    fcu.setField("spd", String(Math.round(Number(adapter.getReadoutValue("SPD", "value")) || 0)));
    fcu.setDecimal("spd", 1, false); // clear a decimal point left lit by showMach()
    fcu.setLabel("MACH", false);
    fcu.setLabel("SPD", true);
  }
  fcu.setLabel("SPDDOT", !spdSelected);

  const hdgSelected = Number(adapter.getReadoutValue("HDG", "selected")) !== 0;
  fcu.setField("hdg", String(Math.round(Number(adapter.getReadoutValue("HDG", "value")) || 0)));
  fcu.setLabel("HDGDOT", !hdgSelected);

  fcu.setField("alt", String(Math.round(Number(adapter.getReadoutValue("ALT", "value")) || 0)));
  const altManaged = Number(adapter.getReadoutValue("ALT", "managed")) !== 0;
  fcu.setLabel("ALTDOT", altManaged);
  // LVLCH has no backing dataref yet (still being tracked down) — explicit
  // off every cycle rather than leaving the vendored component's own
  // demo-init default (lit) looking like real, working state.
  fcu.setLabel("LVLCH", false);

  const vsShown = Number(adapter.getReadoutValue("VS", "shown")) !== 0;
  if (vsShown) {
    fcu.setField("vs", String(Math.round(Number(adapter.getReadoutValue("VS", "value")) || 0)));
  } else {
    // Not "-----" — the display's own _setField() reads a *leading* "-" as
    // a minus sign (it can't tell "negative value" from "dashed/blank"
    // apart, both start with the same character), which would incorrectly
    // light the sign lamp. setSign(null) after is what actually clears it
    // back off.
    fcu.setField("vs", "----");
    fcu.setSign(null);
  }

  const trkFpa = Number(adapter.getReadoutValue("TRK_FPA_MODE", "value")) !== 0;
  fcu.setMode(trkFpa ? "TRK-FPA" : "HDG-VS");
}
