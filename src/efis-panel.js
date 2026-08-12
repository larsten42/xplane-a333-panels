// Wires the vendored EFIS component library (vendor/fcu-instruments.js —
// see vendor/README.md for what it is and how to update it) to the real
// X-Plane adapter. Mirrors src/fcu-panel.js's structure closely — see that
// file for the reasoning behind the shared patterns (single combined
// refresh, avionics-gated blanking of lit indications only, debounced drag
// begin/end for knobs with no native drag-start/end event). This file owns
// all the EFIS-specific glue; the vendored file is never edited.

import { INHG_PER_HPA } from "./readout-formats.js";

const BUTTON_ID_TO_NAME = {
  cstr: "CSTR",
  wpt: "WPT",
  vord: "VOR.D",
  ndb: "NDB",
  arpt: "ARPT",
  fd: "FD",
  ls: "LS",
};

const LEVER_ID_TO_SWITCH = { bearing1: "BRG1", bearing2: "BRG2" };
// Index -> lever position; matches the ADF/OFF/VOR order both profile
// switches already list their positions in.
const LEVER_POSITIONS = ["left", "center", "right"];

// How long to wait after the last onTurn before treating a drag as over —
// see fcu-panel.js's own DRAG_END_DEBOUNCE_MS for why this exists (the
// vendored knob API has no onDragStart/onDragEnd, only per-detent onTurn).
const DRAG_END_DEBOUNCE_MS = 200;

/** Blanks the EFIS panel with no adapter involved — see blankFcuPanel(). */
export function blankEfisPanel() {
  const efis = window.efis;
  if (!efis) return;
  for (const id of efis.buttons) efis.setLed(id, false);
  efis.qnh()?.clear();
}

export function wireEfisPanel(adapter) {
  const efis = window.efis;
  if (!efis) {
    console.error(
      "[efis-panel] window.efis not found — is <efis-panel> in the page, and vendor/fcu-instruments.js loaded before this runs?"
    );
    return;
  }

  wireButtonPresses(efis, adapter);
  wireBaroKnob(efis, adapter);
  wireDetentKnob(efis, adapter, "nd-mode", "MODE", false);
  wireDetentKnob(efis, adapter, "nd-range", "RANGE", true);
  wireLevers(efis, adapter);

  const refresh = () => {
    const powered = isPowered(adapter);
    refreshButtonLeds(efis, adapter, powered);
    refreshQnh(efis, adapter, powered);
    refreshBaroRing(efis, adapter);
    refreshDetentKnob(efis, adapter, "nd-mode", "MODE");
    refreshDetentKnob(efis, adapter, "nd-range", "RANGE");
    refreshLevers(efis, adapter);
  };

  // Single combined refresh on every kind of change this adapter reports,
  // rather than each area guarding its own slice — AVIONICS is a readout,
  // so it only ever arrives via onReadoutChange, but it needs to blank the
  // buttons and QNH too; simplest to just recompute everything.
  adapter.onStateChange = refresh;
  adapter.onReadoutChange = refresh;
  adapter.onSwitchChange = refresh;
  refresh();
}

function isPowered(adapter) {
  return Number(adapter.getReadoutValue("AVIONICS", "value")) !== 0;
}

function wireButtonPresses(efis, adapter) {
  for (const id of efis.buttons) {
    const name = BUTTON_ID_TO_NAME[id];
    if (!name) {
      console.warn(`[efis-panel] button id "${id}" from the vendored panel has no matching profile entry — leaving it unwired`);
      continue;
    }
    if (!adapter.isAvailable(name)) {
      console.warn(`[efis-panel] "${name}" (button "${id}") did not resolve on this sim — leaving it unwired`);
      continue;
    }
    efis.button(id).onPress(() => adapter.press(name));
  }
}

function refreshButtonLeds(efis, adapter, powered) {
  for (const [id, name] of Object.entries(BUTTON_ID_TO_NAME)) {
    if (adapter.isAvailable(name)) efis.setLed(id, powered && adapter.isLit(name));
  }
}

// BARO: a writable dataref (same shape as FCU's SPD/HDG/VS/ALT) with a
// dynamic step size — READOUT_STEP_SIZES.baro already picks inHg vs hPa
// resolution, reused as-is via adjustReadoutValue(). Push/pull engage STD
// / revert to the selected QNH; the concentric ring picks the displayed
// unit, mapped to the same setInHg/setHpa commands the old ArcToggle-based
// UI used on the stock A330 — some aircraft (confirmed: ToLiss Airbus's
// AirbusFBW/BaroUnitCapt) expose that as a plain writable dataref instead
// of a command pair, hence the isAvailable() branch below: prefer the
// commands when the profile has them, fall back to a direct write via
// setReadoutUnit() (encoder.unitArc.writeDataref) otherwise.
function wireBaroKnob(efis, adapter) {
  const knob = efis.knob("baro");
  const dragEndTimers = new Map();
  knob.onTurn((dir) => {
    if (!dragEndTimers.has("BARO")) adapter.beginAdjust("BARO");
    else clearTimeout(dragEndTimers.get("BARO"));
    dragEndTimers.set(
      "BARO",
      setTimeout(() => {
        dragEndTimers.delete("BARO");
        adapter.endAdjust("BARO");
      }, DRAG_END_DEBOUNCE_MS)
    );
    adapter.adjustReadoutValue("BARO", dir);
  });
  knob.onPull(() => adapter.press("BARO.std"));
  knob.onPush(() => adapter.press("BARO.qnh"));
  const unitByCommand = adapter.isAvailable("BARO.setInHg") || adapter.isAvailable("BARO.setHpa");
  knob.onRing((i) => {
    if (unitByCommand) adapter.press(i === 0 ? "BARO.setInHg" : "BARO.setHpa");
    else adapter.setReadoutUnit("BARO", i);
  });
}

function refreshQnh(efis, adapter, powered) {
  const qnh = efis.qnh();
  if (!qnh) return;
  if (!powered) {
    qnh.clear();
    return;
  }

  const isStd = Number(adapter.getReadoutValue("BARO", "std")) !== 0;
  if (isStd) {
    // Case-sensitive glyph table (see vendor/fcu-instruments.js's GLYPHS)
    // — only lowercase 't'/'d' render as letters, uppercase T/D come back
    // blank. "Std" is the one casing that actually reads as S-T-D.
    qnh.set("Std");
    qnh.setDecimal(2, false);
  } else {
    const inHg = Number(adapter.getReadoutValue("BARO", "value")) || 0;
    const isHpa = Number(adapter.getReadoutValue("BARO", "unit")) !== 0;
    if (isHpa) {
      qnh.set(String(Math.round(inHg / INHG_PER_HPA)).padStart(4, "0"));
      qnh.setDecimal(2, false);
    } else {
      // The seven-seg's decimal dot renders *before* digit i (confirmed
      // against showMach()'s own use of index 1 for a 3-digit field), so
      // index 2 of 4 digits lands it between the 2nd and 3rd — "29.92".
      qnh.set(String(Math.round(inHg * 100)).padStart(4, "0"));
      qnh.setDecimal(2, true);
    }
  }
}

// Not gated by power — it's a physical selector ring position, not a lit
// indication, so (like the FCU ALT knob's ring) it stays wherever it
// physically is regardless of avionics state.
function refreshBaroRing(efis, adapter) {
  const ring = Number(adapter.getReadoutValue("BARO", "unit")) !== 0 ? 1 : 0;
  efis.knob("baro").setRing(ring);
}

// MODE has no writable dataref (paced increment/decrement commands only),
// RANGE does — same distinction ALT/SPD/HDG/VS already draw on the FCU
// side; see efis-adapter.js's adjustReadoutValue vs adjustReadoutIndex.
// Both selector knobs report the *absolute* target index the user dragged
// or clicked to (not a per-detent direction the way onTurn's dir is), so
// this converts that into the relative delta each adjust method wants.
// Also not power-gated, for the same reason as the baro ring.
function wireDetentKnob(efis, adapter, knobId, readoutName, hasWriteDataref) {
  const knob = efis.knob(knobId);
  knob.onChange((targetIndex) => {
    const current = Math.round(Number(adapter.getReadoutValue(readoutName, "value")) || 0);
    const delta = targetIndex - current;
    if (delta === 0) return;
    if (hasWriteDataref) adapter.adjustReadoutValue(readoutName, delta);
    else adapter.adjustReadoutIndex(readoutName, delta);
  });
}

function refreshDetentKnob(efis, adapter, knobId, readoutName) {
  const index = Math.round(Number(adapter.getReadoutValue(readoutName, "value")) || 0);
  efis.knob(knobId).setIndex(index);
}

function wireLevers(efis, adapter) {
  for (const [leverId, switchName] of Object.entries(LEVER_ID_TO_SWITCH)) {
    efis.lever(leverId).onChange((pos) => {
      const index = LEVER_POSITIONS.indexOf(pos);
      if (index >= 0) adapter.pressSwitchPosition(switchName, index);
    });
  }
}

// Also not power-gated — a bearing-pointer lever is a physical 3-position
// switch, same reasoning as the baro ring and detent knobs above.
function refreshLevers(efis, adapter) {
  for (const [leverId, switchName] of Object.entries(LEVER_ID_TO_SWITCH)) {
    const index = adapter.getSwitchPosition(switchName);
    if (index < 0) continue; // unknown yet
    efis.lever(leverId).set(LEVER_POSITIONS[index]);
  }
}
