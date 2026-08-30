// Wires the vendored vendor/rmp.js component (<rmp-panel>/<acp-panel>) to
// the real X-Plane adapter. Mirrors radio-panel.js's structure: this file
// owns all the RMP/ACP-specific glue, the vendored file is never edited
// except the two small hand-patches noted in vendor/README.md (window.rmpPanel/
// window.acpPanel globals, matching how vendor/radio.js and
// vendor/fcu-instruments.js already expose themselves).
//
// Started as VHF1/VHF2 (COM1/COM2) only; ToLiss's profile has since grown
// to cover every channel the vendored UI already has real buttons for —
// VHF1/VHF2/VHF3, HF1/HF2, and the STBY NAV backup functions VOR/LS/ADF —
// see CHANNEL_TO_BAND/CHANNEL_TO_SEL_BUTTON below and
// rmp-acp-toliss-airbus.json's own _note_on_window_string. "am" and "bfo"
// have real UI buttons and real commands but were confirmed live
// 2026-08-30 to produce no observable effect on any dataref (AM never
// moved RMP1SelFunc at all; BFO is presumably audio-only, matching a real
// ADF beat-frequency-oscillator's actual function) — both are wired
// command-only via PRESS_ONLY_BUTTONS below, same as "nav" (the backup-
// nav master key, which also never moves RMP1SelFunc on its own — VOR/LS/
// ADF work when pressed directly, with no precondition found).
//
// Two things below are read from the profile rather than assumed, since
// the stock A330's RTP profile (config/profiles/rmp-acp-a333.json) and
// the ToLiss Airbus profile (config/profiles/rmp-acp-toliss-airbus.json)
// genuinely differ in what's actually confirmed available on each:
//   - Tuning: the stock A330's standby-frequency datarefs are directly
//     writable (confirmed live), so its readouts declare encoder.write-
//     Dataref and the tune knob writes through it, reusing the generic
//     radio panel's exact coarse/fine gesture and 8.33kHz-grid math (see
//     nextStandbyRaw()). ToLiss's own frequency datarefs aren't confirmed
//     writable (or what write-time validation they'd apply), so that
//     profile omits encoder.writeDataref and instead declares
//     readout.commands.coarseUp/coarseDown/fineUp/fineDown — the tune
//     knob falls back to firing those directly, one press per detent,
//     letting the sim's own stepping/wraparound logic do the work instead
//     of replicating it locally.
//   - Listen toggle: the stock profile's per-channel listen state is a
//     confirmed, live-verified 16-element array dataref; ToLiss's
//     equivalent commands are confirmed by name only, with no confirmed
//     state dataref found at all. See listenToggles' own comment below.
//   - Display: the stock profile's active/standby are plain scaled
//     numbers (readout.displayScale). ToLiss's are pre-formatted display
//     strings (readout.windowString) covering every mode uniformly,
//     including ones a scaled number can't represent at all (ADF's whole-
//     kHz value with no decimal point, VOR/ILS's standby window showing a
//     channel/course indicator instead of a frequency) — see
//     paintWindowString() below.

import { nextStandbyRaw } from "./radio-panel.js";
import { base64ToBytes, bytesToUtf8 } from "./xplane-client.js";

const CHANNEL_TO_BAND = {
  vhf1: "COM1",
  vhf2: "COM2",
  vhf3: "VHF3",
  hf1: "HF1",
  hf2: "HF2",
  vor: "NAV_VOR",
  ls: "NAV_LS",
  adf: "NAV_ADF",
};
const CHANNEL_TO_SEL_BUTTON = {
  vhf1: "SEL_VHF1",
  vhf2: "SEL_VHF2",
  vhf3: "SEL_VHF3",
  hf1: "SEL_HF1",
  hf2: "SEL_HF2",
  vor: "SEL_VOR",
  ls: "SEL_LS",
  adf: "SEL_ADF",
};
// Real commands, real UI buttons, but no confirmed dataref effect at all
// (see this file's own top comment) — wired to fire on press with no lit-
// state tracking and no participation in "which channel is selected"
// detection, unlike CHANNEL_TO_SEL_BUTTON's entries.
const PRESS_ONLY_BUTTONS = { nav: "NAV_PRESS", am: "AM_PRESS", bfo: "BFO_PRESS" };
const CHANNEL_TO_MIC_BUTTON = {
  vhf1: "MIC_VHF1",
  vhf2: "MIC_VHF2",
  vhf3: "MIC_VHF3",
  hf1: "MIC_HF1",
  hf2: "MIC_HF2",
  int: "MIC_INT",
  cab: "MIC_CAB",
  pa: "MIC_PA",
};
// AirbusFBW/ACP1Lights_Raw's own element order. UPDATED 2026-08-30: now uses
// the clean sequential channel-list order (same as ACP1KnobPush and
// ACP1RotaryPositions — see the profile's own _note_on_mic_lights), pa: 15.
// An earlier live test had found PA at index 9 instead — that finding isn't
// re-verified yet, this is a re-attempt on the strength of the other two
// arrays both turning out sequential; revert pa to 9 if live testing shows
// the MIC_PA lamp wrong. vhf3's index is unconfirmed either way
// (ACP1/VHF3Press never moved any index at all, live-tested twice —
// plausibly correct rather than broken, since ToLiss's VHF3 is a datalink/
// ACARS channel with no voice transmission to select) — harmless either way
// since it never lights regardless.
// Every MIC_* button above is deliberately command-only (no stateDataref)
// — see _note_on_mic_lights for why their lit state is read off this
// shared array directly in refresh() instead of through EfisAdapter's own
// per-button stateIndex mechanism.
const MIC_LIGHT_INDEX = { vhf1: 0, vhf2: 1, vhf3: 2, hf1: 3, hf2: 4, int: 5, cab: 6, pa: 15 };
const CHANNEL_TO_VOL_READOUT = { vhf1: "VOL_VHF1", vhf2: "VOL_VHF2" };
// Every channel this app might ever show a listen lamp for, across any
// profile — used only to blank lamps on startup/disconnect below, where
// there's no profile-declared listenToggles list to read yet.
const ALL_LISTEN_CHANNELS = ["vhf1", "vhf2", "vhf3", "hf1", "hf2", "int", "cab", "ls", "mkr", "vor1", "vor2", "adf1", "adf2"];

// Mirrors vendor/rmp.js's own AMBER/GLOW/SILK literals (used for its caret
// and cap() silkscreen colors) — duplicated here rather than exported from
// the vendored file, since this is the one small piece of its visual
// language this app's own backlight-dimming glue needs to match, not a
// functional dependency on vendor internals.
const CAP_AMBER = "#ffb15a";
const CAP_GLOW = "0 0 7px rgba(255,150,40,.55), 0 0 14px rgba(255,130,20,.28), 0 1px 1px rgba(0,0,0,.8)";
const CAP_SILK = "rgba(232,220,184,.92)";
const CAP_DIM_SHADOW = "0 1px 1px rgba(0,0,0,.85)";

// Dims/lights a whole RMP or ACP panel's static silkscreen legends —
// vendor/rmp.js's own setBacklight() (see below) only ever re-paints the
// per-channel select carets; it has no panel-wide equivalent of
// fcu-instruments.js's own applyBacklight()/panel-level setBacklight(),
// even though its cap()-drawn captions use the exact same `data-cap="1"`
// marker fcu-instruments.js's version looks for (confirmed by reading both
// — plausibly the same author's convention, just never wired up for RMP/
// ACP). Reimplemented here at the app level instead of hand-patching the
// vendored file a third time (see vendor/README.md's existing two patches):
// this only ever reaches into DOM already reachable through each panel's
// own public root/button()/knob() accessors, so it doesn't need vendor
// changes to work. Covers the "ACTIVE"/"STBY/CRS"/"ON"/"OFF" captions and
// the channel-name/CALL-MECH-ATT legends (via each <fcu-led-button>'s own
// setBacklight(), same mechanism fcu-instruments.js's applyBacklight() uses
// internally) and the tune knob's bezel glow (fcu-knob's setGlow()).
// ACP's reception-volume <acp-knob>s have no equivalent lit/dim state of
// their own (real hardware's volume pots aren't backlit either), so
// they're intentionally left alone.
function applyPanelGlow(root, on) {
  if (!root) return;
  root.querySelectorAll('[data-cap="1"]').forEach((el) => {
    el.style.color = on ? CAP_AMBER : CAP_SILK;
    el.style.textShadow = on ? CAP_GLOW : CAP_DIM_SHADOW;
  });
  root.querySelectorAll("[data-btn]").forEach((el) => el.button?.setBacklight?.(on));
  root.querySelectorAll("[data-knob]").forEach((el) => el.knob?.setGlow?.(on));
}

/** Blanks the RMP/ACP panels with no adapter involved — see blankRadioPanel() for why. */
export function blankRmpAcpPanel() {
  const rmp = window.rmpPanel;
  const acp = window.acpPanel;
  rmp?.display("active")?.clear();
  rmp?.display("stby")?.clear();
  for (const channel of Object.keys(CHANNEL_TO_MIC_BUTTON)) acp?.key(channel)?.setLed(false);
  for (const channel of ALL_LISTEN_CHANNELS) acp?.volume(channel)?.setLamp(false);
}

/**
 * Wires the ACP's per-channel reception "listen" toggle (whether you can
 * hear a radio, separate from the transmit-select mic_push/MIC_VHF
 * buttons) from the profile's own `listenToggles` array — a shape
 * EfisAdapter's button model doesn't support (one stateDataref per button,
 * not a read-modify-write against one index of a dataref several channels
 * share), so this resolves/subscribes directly against the adapter's own
 * client rather than going through the usual buttons/readouts path.
 *
 * CORRECTED 2026-08-30: previously went through per-channel Listen{X}
 * commands, with only ListenVHF1/2/3 confirmed to exist at all (see
 * _note_on_listen_state's exhaustive live command-list search) and every
 * other channel left permanently read-only. A live report questioned that
 * — the earlier "single-index writes are rejected" finding only ruled out
 * a *partial* write, never a full-array read-modify-write, exactly the
 * shape already proven for AirbusFBW/ACP1RotaryPositions (see
 * wireAcpVolumeKnobs). Live-tested directly: flipped one index in a full
 * 16-element copy of ACP1KnobPush and wrote it back — it stuck (re-read
 * moments later still showed the flipped value), same mechanism as volume,
 * just a 0/1 int instead of a 0-1 float. This function now bypasses
 * commands entirely and drives every channel — including vhf1/vhf2/vhf3,
 * which used to have real working commands — through the array directly,
 * mirroring wireAcpVolumeKnobs almost exactly (whole-array subscription
 * and local cache, not grouped-index, since every entry now needs to
 * read-modify-write rather than just read).
 *
 * @param {{channel: string, stateDataref: string, stateIndex: number}[]} entries
 */
async function wireListenToggles(adapter, acp, entries) {
  if (!entries || entries.length === 0) return;

  const datarefNames = [...new Set(entries.map((e) => e.stateDataref))];
  const datarefIds = await adapter.client.resolveDatarefIds(datarefNames);

  const byDataref = new Map();
  for (const entry of entries) {
    if (!byDataref.has(entry.stateDataref)) byDataref.set(entry.stateDataref, []);
    byDataref.get(entry.stateDataref).push(entry);
  }

  for (const [datarefName, group] of byDataref) {
    const id = datarefIds.get(datarefName);
    if (id == null) {
      console.warn(`[rmp-panel] missing dataref ${datarefName} — listen state for ${group.map((e) => e.channel).join(", ")} will not work`);
      continue;
    }

    let cache = null;
    adapter.client.subscribeDataref(id, (raw) => {
      if (!Array.isArray(raw)) return;
      cache = raw.slice();
      for (const entry of group) acp.volume(entry.channel)?.setLamp(Number(cache[entry.stateIndex]) >= 0.5);
    });

    for (const entry of group) {
      // onTap() is registered for every entry (see the module-level note on
      // vendor/rmp.js's AcpKnob falling back to an unbacked local lamp flip
      // when no onTap is registered at all) — every entry here has a real
      // write behind it now, so there's no command-less no-op case left.
      acp.volume(entry.channel)?.onTap(() => {
        if (!cache) return;
        cache = cache.slice();
        cache[entry.stateIndex] = cache[entry.stateIndex] ? 0 : 1;
        adapter.client.setDatarefValue(id, cache);
      });
    }
  }
}

/**
 * Wires the ACP's per-channel reception volume knobs from the profile's own
 * `volumeKnobs` array — a shared 16-element AirbusFBW/ACP1RotaryPositions
 * float_array, one index per channel (see rmp-acp-toliss-airbus.json's own
 * _note_on_acp_volume for the confirmed index order and how it was
 * verified live). Bypasses EfisAdapter's readout/encoder model entirely,
 * same as wireListenToggles() above and for the same reason: that model
 * only supports a scalar write to its own dedicated dataref, not a
 * read-modify-write against one index of a dataref several channels share.
 *
 * X-Plane's Web API rejects a single-index write to this array outright
 * (`incompatible_data`, confirmed live — same limitation as ACP1KnobPush,
 * see wireListenToggles' own doc comment) — every write below sends the
 * *whole* 16-element array back, with only the dragged channel's index
 * changed, computed from a locally-cached copy of the last known array.
 * The cache comes from subscribing to the dataref as a whole array (no
 * `index`, unlike wireListenToggles' grouped-index subscriptions — those
 * only need booleans back and never write, this needs the full array to
 * safely read-modify-write) and is also updated optimistically on every
 * local write, so a rapid drag doesn't have to wait for its own write to
 * echo back before computing the next one.
 *
 * Channels with no matching <acp-panel> volume knob (e.g. ToLiss's sat1/
 * sat2, which have no UI slot at all) simply no-op via `?.` — they're
 * still listed in the profile for completeness.
 *
 * @param {{channel: string, stateDataref: string, stateIndex: number}[]} entries
 */
async function wireAcpVolumeKnobs(adapter, acp, entries) {
  if (!entries || entries.length === 0) return;

  const datarefNames = [...new Set(entries.map((e) => e.stateDataref))];
  const datarefIds = await adapter.client.resolveDatarefIds(datarefNames);

  const byDataref = new Map();
  for (const entry of entries) {
    if (!byDataref.has(entry.stateDataref)) byDataref.set(entry.stateDataref, []);
    byDataref.get(entry.stateDataref).push(entry);
  }

  for (const [datarefName, group] of byDataref) {
    const id = datarefIds.get(datarefName);
    if (id == null) {
      console.warn(`[rmp-panel] missing dataref ${datarefName} — volume for ${group.map((e) => e.channel).join(", ")} will not work`);
      continue;
    }

    let cache = null;
    adapter.client.subscribeDataref(id, (raw) => {
      if (!Array.isArray(raw)) return;
      cache = raw.slice();
      for (const entry of group) acp.volume(entry.channel)?.set(Number(cache[entry.stateIndex]) * 100);
    });

    for (const entry of group) {
      acp.volume(entry.channel)?.onChange((value) => {
        if (!cache) return;
        const target = value / 100;
        if (Math.abs(Number(cache[entry.stateIndex]) - target) < 1e-6) return;
        cache = cache.slice();
        cache[entry.stateIndex] = target;
        adapter.client.setDatarefValue(id, cache);
      });
    }
  }
}

export async function wireRmpAcpPanel(adapter) {
  const rmp = window.rmpPanel;
  const acp = window.acpPanel;
  if (!rmp || !acp) {
    console.error(
      "[rmp-panel] window.rmpPanel/window.acpPanel not found — is <rmp-panel>/<acp-panel> in the page, and vendor/rmp.js loaded before this runs?"
    );
    return;
  }

  // onTap() is a hand-patch on vendor/rmp.js's AcpKnob (see
  // vendor/README.md) — without it, a tap would just flip the knob's own
  // local lamp state with nothing behind it; wiring it here means the
  // lamp only ever reflects a confirmed sim state (when the profile has
  // one), never an unconfirmed local guess.
  await wireListenToggles(adapter, acp, adapter.profile.listenToggles);
  await wireAcpVolumeKnobs(adapter, acp, adapter.profile.volumeKnobs);

  // Same ghost-toggle problem wireListenToggles' own onTap fix addresses
  // (vendor/rmp.js's AcpKnob falls back to flipping its own unbacked local
  // lamp on a tap when no onTap was ever registered at all), but for
  // volumeKnobs-only channels — currently just "pa" (a real knob exists,
  // but PA is deliberately excluded from listenToggles: it's a transmit/
  // announce function, not a listen toggle, see rmp-acp-toliss-airbus.json's
  // own _note_on_listen_state). Skips any channel listenToggles already
  // covered, so this can never clobber a real command's onTap — onTap is
  // last-write-wins on the shared knob element (see AcpKnob.api.onTap).
  const listenChannels = new Set((adapter.profile.listenToggles ?? []).map((e) => e.channel));
  for (const entry of adapter.profile.volumeKnobs ?? []) {
    if (listenChannels.has(entry.channel)) continue;
    acp.volume(entry.channel)?.onTap(() => {});
  }

  // Same drag-end debounce pattern as radio-panel.js/fcu-panel.js's own
  // knobs — one timer per control that can be dragged, so beginAdjust()/
  // endAdjust() bracket the whole gesture instead of every single step.
  const DRAG_END_DEBOUNCE_MS = 200;
  let tuneDragEndTimer = null;
  const volDragEndTimers = { vhf1: null, vhf2: null };

  // <rmp-panel>'s seven-seg display expects every value pre-scaled to
  // "freq*1000 as a 6-digit integer" (the stock A330's own _833 datarefs
  // already come out that way — see radio-panel.js's own comment on this
  // same convention). A profile whose frequency dataref is a plain float
  // MHz value instead declares readout.displayScale: 1000 to get the same
  // 6-digit shape; defaults to 1 (no scaling) for a dataref that's already
  // in that form. This whole path is unused by ToLiss now (see
  // windowStringByBand below) but stays generic/reusable for whatever the
  // next aircraft's shape turns out to be — the stock A330 still uses it.
  const displayScaleByBand = Object.fromEntries((adapter.profile.readouts ?? []).map((r) => [r.name, r.displayScale ?? 1]));
  // A profile whose active/standby are pre-formatted display strings
  // rather than scaled numbers declares readout.windowString: true — see
  // paintWindowString() below and rmp-acp-toliss-airbus.json's own
  // _note_on_window_string for why ToLiss needs this (backup-nav modes
  // whose display shape a scaled number can't represent at all).
  const windowStringByBand = Object.fromEntries((adapter.profile.readouts ?? []).map((r) => [r.name, r.windowString === true]));
  // Which readouts.datarefs key actually holds the plain numeric value
  // adjustReadoutValue()/nextStandbyRaw() need for their own math —
  // "standby" itself for the stock A330 (a plain scaled number there),
  // but a *different* key for ToLiss's windowString readouts, whose own
  // "standby" holds display text instead (see COM1's own
  // _note_on_standby_raw). Falls back to "standby" for any profile that
  // doesn't declare an encoder at all, matching the stock shape.
  const standbyValueKeyByBand = Object.fromEntries((adapter.profile.readouts ?? []).map((r) => [r.name, r.encoder?.valueKey ?? "standby"]));

  function decodeWindowString(raw) {
    if (typeof raw !== "string") return ""; // the readout's pre-subscription placeholder value is the number 0, not a string
    return bytesToUtf8(base64ToBytes(raw)).replace(/\0+$/, "");
  }

  // Paints a pre-formatted display string (e.g. "118.630", "   210", or
  // " C/000") onto a <seven-seg>'s own segdisplay object directly — not
  // through rmp.setFreq(), which hardcodes a "6-digit MHz.MHz with the
  // decimal always after digit 3" shape that only some of these strings
  // actually have (see this file's own top comment). The decimal
  // point's position is read from the string itself (or omitted entirely
  // when there isn't one, e.g. ADF's whole-kHz value) rather than assumed.
  // Characters with no seven-segment glyph at all (e.g. VOR/ILS's standby
  // "/" course separator) render as a blank digit instead of crashing —
  // see fcu-instruments.js's own glyph() fallback — an acceptable
  // approximation of hardware this app's display primitive can't fully
  // reproduce.
  function paintWindowString(segdisplay, text) {
    if (!segdisplay) return;
    const dotIndex = text.indexOf(".");
    const digits = dotIndex === -1 ? text : text.slice(0, dotIndex) + text.slice(dotIndex + 1);
    segdisplay.set(digits);
    for (let i = 0; i < digits.length; i++) segdisplay.setDecimal(i, i === dotIndex);
  }

  // vendor/rmp.js's own transfer key (the XFER button between the two
  // windows) does its own optimistic local swap-and-repaint on click,
  // straight from its internal freq[] array (see its _transfer()) —
  // useful for the numeric setFreq() path below, where freq[] is always
  // kept current, but freq[] is never written to at all on the
  // windowString path (painting goes straight through paintWindowString()
  // instead), so it stays frozen at its construction-time default
  // (121825/126375) forever. Confirmed live 2026-08-30: that's the
  // "strange frequency" a reported flash on every swap press turned out
  // to be — vendor's own _transfer() briefly painting that frozen default
  // before this file's own syncDisplay() (triggered once the sim's real
  // swap lands) corrects it a moment later. Feeding a numeric
  // approximation into setFreq() alongside the real paintWindowString()
  // call keeps freq[] close enough that _transfer()'s optimistic repaint
  // shows something reasonable instead — its own numeric _paint() runs
  // and gets immediately overwritten by paintWindowString() right after,
  // in the same tick, so this never causes a flash on a *normal* refresh,
  // only fixes what a physical XFER click sees before this file's own
  // update arrives. Not a perfect substitute (vendor's numeric _paint()
  // always shows a decimal point, which isn't correct for e.g. ADF's
  // whole-kHz value) — but a stray decimal point for one transient frame
  // is a far smaller gap than an unrelated stale frequency.
  function windowStringToApproxNumber(text) {
    const digitsOnly = text.replace(/[^0-9]/g, "");
    return digitsOnly === "" ? 0 : parseInt(digitsOnly, 10);
  }

  const syncDisplay = () => {
    const band = CHANNEL_TO_BAND[rmp.channel()];
    if (!band || adapter.unresolved.has(band)) return;
    if (windowStringByBand[band]) {
      const activeText = decodeWindowString(adapter.getReadoutValue(band, "active"));
      const standbyText = decodeWindowString(adapter.getReadoutValue(band, "standby"));
      rmp.setFreq(windowStringToApproxNumber(activeText), windowStringToApproxNumber(standbyText));
      paintWindowString(rmp.display("active"), activeText);
      paintWindowString(rmp.display("stby"), standbyText);
      return;
    }
    const scale = displayScaleByBand[band] ?? 1;
    const active = Math.round((Number(adapter.getReadoutValue(band, "active")) || 0) * scale);
    const standby = Math.round((Number(adapter.getReadoutValue(band, "standby")) || 0) * scale);
    rmp.setFreq(active, standby);
  };

  for (const channel of Object.keys(CHANNEL_TO_SEL_BUTTON)) {
    rmp.button(channel)?.onPress(() => {
      const name = CHANNEL_TO_SEL_BUTTON[channel];
      if (adapter.isAvailable(name)) adapter.press(name);
    });
  }
  for (const channel of Object.keys(PRESS_ONLY_BUTTONS)) {
    rmp.button(channel)?.onPress(() => {
      const name = PRESS_ONLY_BUTTONS[channel];
      if (adapter.isAvailable(name)) adapter.press(name);
    });
  }

  // Coarse/fine ring-pick gesture, ported directly from vendor/radio.js's
  // own _wireKnobs()/_tune() — this delivery's rmp-tune <fcu-knob> has no
  // ring/bezel split of its own (same as radio.js's own tune knobs: both
  // are plain ring="false" <fcu-knob>s), so radio.js implements "grab near
  // the edge for MHz, near the center for kHz" itself on top of the plain
  // knob rather than relying on any vendor-level ring support. Reusing
  // that same gesture (rather than a fine-only knob, which is what this
  // panel shipped with initially) keeps the RMP's tune knob feeling like
  // the same real 2-ring radio as the Radio panel's tune knobs, right down
  // to the identical nextStandbyRaw() wraparound math — COM's real
  // 8.33kHz-within-25kHz channel grid, the fine ring never touching the
  // MHz digit, and the coarse ring wrapping at the band edges instead of
  // hard-stopping (see radio-panel.js's own extensive comments on all of
  // that; not reproduced a second time here since it's the same function).
  let tuneMode = "fine";
  let tuneFineAngle = 0;
  let tuneBezelAngle = 0;
  const tuneKnob = rmp.knob();
  const tuneKnobEl = tuneKnob?.root;
  const pickRing = (e) => {
    if (!tuneKnobEl) return;
    const b = tuneKnobEl.getBoundingClientRect();
    const d = Math.hypot(e.clientX - (b.left + b.width / 2), e.clientY - (b.top + b.height / 2));
    tuneMode = d > b.width * 0.3 ? "coarse" : "fine";
  };
  tuneKnobEl?.addEventListener("pointerdown", pickRing, true);
  tuneKnobEl?.addEventListener("wheel", pickRing, true);

  tuneKnob.onTurn((dir) => {
    const band = CHANNEL_TO_BAND[rmp.channel()];
    if (!band || adapter.unresolved.has(band)) return;

    // Same visual decoupling as radio.js: in coarse mode, undo the cap
    // rotation the knob primitive's own onTurn handler already applied
    // (it always spins the cap) and spin the bezel ring instead, so only
    // the ring that's conceptually "in use" appears to move.
    if (tuneMode === "coarse") {
      tuneKnob.setAngle(tuneFineAngle);
      tuneBezelAngle += dir * 12;
      tuneKnob.setBezelAngle(tuneBezelAngle);
    } else {
      tuneFineAngle = tuneKnob.getAngle();
    }

    if (!adapter.hasWritableEncoder(band)) {
      // No confirmed-writable standby dataref for this profile (e.g. the
      // ToLiss profile — see this file's own top comment) — fall back to
      // firing the readout's own named step command directly, one press
      // per detent. No local value/wraparound computation here: the sim
      // owns that entirely on this path, unlike the direct-write path
      // below which has to reproduce it exactly (nextStandbyRaw()) since
      // it's writing the raw value itself.
      const key = tuneMode === "coarse" ? (dir > 0 ? "coarseUp" : "coarseDown") : dir > 0 ? "fineUp" : "fineDown";
      // A short explicit duration, not EfisAdapter.press()'s own 0.15s
      // default — confirmed live 2026-08-30 that the default creates a
      // real ~6.5/sec ceiling on X-Plane's websocket command_set_is_active
      // path specifically (the REST /activate endpoint doesn't share this
      // limit, which is why earlier speed testing against that endpoint
      // gave a falsely optimistic picture). This is a discrete step
      // command, not a hold-to-repeat one, so it doesn't need to stay
      // "active" anywhere near 150ms — 25ms tested clean at a real 25/sec
      // press rate (see rate-drag's own rate-max-hz on this knob, tuned to
      // match).
      adapter.press(`${band}.${key}`, 0.025);
      return;
    }

    const current = Math.round(Number(adapter.getReadoutValue(band, standbyValueKeyByBand[band])) || 0);
    const next = nextStandbyRaw(band, current, tuneMode, dir);
    const delta = next - current;
    if (delta === 0) return;

    if (!tuneDragEndTimer) adapter.beginAdjust(band);
    else clearTimeout(tuneDragEndTimer);
    tuneDragEndTimer = setTimeout(() => {
      tuneDragEndTimer = null;
      adapter.endAdjust(band);
    }, DRAG_END_DEBOUNCE_MS);

    adapter.adjustReadoutValue(band, delta);
  });

  rmp.onTransfer(() => {
    if (adapter.isAvailable("RTP_XFER")) adapter.press("RTP_XFER");
  });

  rmp.power()?.onChange((pos) => {
    if (!adapter.isAvailable("RTP_POWER")) return;
    const wantOn = pos === "right";
    if (adapter.isLit("RTP_POWER") !== wantOn) adapter.press("RTP_POWER");
  });

  // "right" (up, toward the INT legend) = lit = INT, "left" (down, toward
  // RAD) = unlit = RAD — see the profile's own INT_RAD note.
  acp.intRad()?.onChange((pos) => {
    if (!adapter.isAvailable("INT_RAD")) return;
    const wantOn = pos === "right";
    if (adapter.isLit("INT_RAD") !== wantOn) adapter.press("INT_RAD");
  });

  for (const channel of Object.keys(CHANNEL_TO_MIC_BUTTON)) {
    acp.key(channel)?.onPress(() => {
      const name = CHANNEL_TO_MIC_BUTTON[channel];
      if (adapter.isAvailable(name)) adapter.press(name);
    });
  }

  for (const channel of Object.keys(CHANNEL_TO_VOL_READOUT)) {
    const band = CHANNEL_TO_VOL_READOUT[channel];
    // Profiles that don't declare this readout at all (e.g. the ToLiss
    // profile, which dropped VOL_VHF1/VOL_VHF2 once its volume knobs moved
    // to the shared-array approach — see wireAcpVolumeKnobs() and
    // rmp-acp-toliss-airbus.json's own _note_on_acp_volume) never resolve
    // it, so readoutValues never gets an entry for it either — skip wiring
    // the knob entirely rather than firing a "no writable encoder" warning
    // on every drag.
    if (!adapter.readoutValues.has(band)) continue;
    const knob = acp.volume(channel);
    knob?.onChange((value) => {
      if (adapter.unresolved.has(band)) return;
      const target = value / 100;
      const current = Number(adapter.getReadoutValue(band, "value")) || 0;
      const delta = target - current;
      if (delta === 0) return;

      if (!volDragEndTimers[channel]) adapter.beginAdjust(band);
      else clearTimeout(volDragEndTimers[channel]);
      volDragEndTimers[channel] = setTimeout(() => {
        volDragEndTimers[channel] = null;
        adapter.endAdjust(band);
      }, DRAG_END_DEBOUNCE_MS);

      adapter.adjustReadoutValue(band, delta);
    });
  }

  const refresh = () => {
    // Whichever CHANNEL_TO_SEL_BUTTON entry reports lit wins — works the
    // same way regardless of whether the profile's underlying mechanism
    // is several independent boolean datarefs (the stock A330's
    // vhf_1_status/vhf_2_status, see rmp-acp-a333.json's own
    // _note_on_channel_select) or one shared enum with a litValue per
    // button (ToLiss's RMP1SelFunc) — EfisAdapter's isLit() already
    // normalizes both to a plain boolean. "vhf1" is the fallback when
    // nothing reports lit yet (e.g. still connecting).
    const foundChannel = Object.keys(CHANNEL_TO_SEL_BUTTON).find(
      (ch) => adapter.isAvailable(CHANNEL_TO_SEL_BUTTON[ch]) && adapter.isLit(CHANNEL_TO_SEL_BUTTON[ch])
    );
    // RMP1SelFunc freezes at whatever channel was last selected when the
    // RMP is powered off (confirmed live 2026-08-30, same finding behind
    // the SEL-indicator and NAV-caret fixes above) — so foundChannel stays
    // e.g. "vhf1" with the unit off, and without this check the green
    // "selected channel" caret stayed lit with the real display blank.
    // "__off__" is a sentinel that matches no real vendor/rmp.js caret id,
    // so selectChannel() below falls through its own else branch for
    // every caret (CARET.off, since backlighting is never turned on here)
    // — blanking all of them rather than leaving one stuck green.
    const rtpPowered = !adapter.isAvailable("RTP_POWER") || adapter.isLit("RTP_POWER");
    const channel = rtpPowered ? foundChannel ?? "vhf1" : "__off__";
    if (rmp.channel() !== channel) rmp.selectChannel(channel);
    // Panel backlight — see applyPanelGlow()'s own comment for why this
    // needs to be driven from here rather than something vendor/rmp.js
    // already does on its own. rmp.setBacklight() was already present and
    // correct (it's what makes selectChannel() above show non-selected
    // carets amber-lit instead of dim white whenever the panel has power)
    // but was never actually being called anywhere until now — every caret
    // but the selected channel's own was rendering as if permanently
    // unpowered. CSS on rmp-panel/acp-panel's own [data-cap]/[data-caret]/
    // [data-label] elements (css/mcdu.css) supplies the "quickly fade"
    // transition; this just flips the end state.
    if (rmp._glowOn !== rtpPowered) {
      rmp._glowOn = rtpPowered;
      rmp.setBacklight(rtpPowered);
      applyPanelGlow(rmp.root, rtpPowered);
      applyPanelGlow(acp.root, rtpPowered);
    }
    // AM/BFO's own lamps (below) share one AirbusFBW/RMP1Lights array via
    // the RMP1_LIGHTS readout — deliberately NOT via a stateDataref/
    // stateIndex on each button, even though EfisAdapter supports that
    // (see NAV_PRESS, which does use it against a *different*, single-
    // purpose dataref). subscribeDataref() only sends one actual
    // subscribe request per dataref id — the first caller's `index` wins
    // for every other subscriber sharing that same id (see its own doc
    // comment). AM_PRESS and BFO_PRESS originally each declared their own
    // stateIndex against this same RMP1Lights id, which silently broke
    // each other and the RMP1_LIGHTS readout below — confirmed live
    // 2026-08-30 when RMP1_LIGHTS came back as a one-element array
    // instead of the full 16. Reading everything off one shared
    // whole-array subscription avoids that entirely.
    const lights = adapter.getReadoutValue("RMP1_LIGHTS", "value");
    const lightAt = (i) => Number(lights?.[i]) >= 0.5;
    // The round "SEL" indicator between HF1/HF2 (vendor/rmp.js's setSel())
    // — fourth attempt, not yet confirmed live; see the profile's own
    // _note_on_sel_indicator for the full history of what's already been
    // tried and ruled out (don't repeat any of them). Current theory:
    // AirbusFBW/RMP1Lights_Raw, a *different* dataref from RMP1Lights
    // above (both exist, both 16-element float_arrays with different
    // values) — index 12, "4th from Right" per the user (indices
    // 15/14/13/12 counted as 1st/2nd/3rd/4th from the right).
    const lightsRaw = adapter.getReadoutValue("RMP1_LIGHTS_RAW", "value");
    rmp.setSel(Number(lightsRaw?.[12]) >= 0.5);
    // The STBY NAV row's "NAV" master key has its own caret, separate from
    // whichever VOR/LS/ADF submode caret selectChannel() above marks
    // 'sel' — on a real RMP both light simultaneously (NAV confirming
    // backup-nav mode is engaged at all, the submode caret showing which
    // one), not a single mutually-exclusive selection the way the main
    // channel row works. selectChannel() can only ever mark one caret
    // 'sel' at a time, so NAV's is driven directly via setCaret() instead
    // — previously not wired at all (NAV_PRESS had no stateDataref), see
    // the profile's own _note_on_nav_backup_mode.
    if (adapter.isAvailable("NAV_PRESS")) {
      rmp.setCaret("nav", adapter.isLit("NAV_PRESS") ? "sel" : "off");
    }
    // BFO's own caret, index 11 — confirmed live 2026-08-30 (a user-
    // provided before/after pair of the full 16-element array differed at
    // exactly that one index, everything else identical). Not part of
    // CHANNEL_TO_SEL_BUTTON's mutually-exclusive selection (BFO can be on
    // or off independently of whichever VOR/LS/ADF submode is active), so
    // driven directly here too. See the profile's own _note_on_bfo.
    if (adapter.isAvailable("BFO_PRESS")) {
      rmp.setCaret("bfo", lightAt(11) ? "sel" : "off");
    }
    // AM isn't its own channel (confirmed live: it never moves
    // RMP1SelFunc) but a mode on top of whichever HF channel is currently
    // selected — index 6, confirmed the same way as BFO. Its caret sits
    // in the main channel row (not the backup-nav row), but still isn't
    // part of CHANNEL_TO_SEL_BUTTON's mutually-exclusive selection, so
    // it's driven directly here too — see the profile's own _note_on_am.
    if (adapter.isAvailable("AM_PRESS")) {
      rmp.setCaret("am", lightAt(6) ? "sel" : "off");
    }
    // RMP1/ActiveWindowString/StandbyWindowString freeze at their last
    // value when the unit loses power (same freeze-on-power-off pattern as
    // RMP1SelFunc/RMP1Lights_Raw above), and syncDisplay() itself has no
    // reason to know that — it just quietly no-ops when rmp.channel() is
    // the "__off__" sentinel (CHANNEL_TO_BAND has no entry for it), which
    // left the seven-segs showing whatever frequency was last tuned.
    // Blanking here explicitly, rather than inside syncDisplay(), keeps
    // that function's early-return meaning "still connecting, nothing to
    // paint yet" (blankRmpAcpPanel() already owns that case) separate from
    // "connected, but genuinely unpowered".
    if (rtpPowered) syncDisplay();
    else {
      rmp.display("active")?.clear();
      rmp.display("stby")?.clear();
    }

    // MIC_* buttons are command-only (see MIC_LIGHT_INDEX's own comment) —
    // their lit state comes from this one shared readout, indexed per
    // channel, not from adapter.isLit(name).
    const acpLights = adapter.getReadoutValue("ACP1_LIGHTS_RAW", "value");
    for (const [ch, name] of Object.entries(CHANNEL_TO_MIC_BUTTON)) {
      if (adapter.isAvailable(name)) acp.key(ch)?.setLed(Number(acpLights?.[MIC_LIGHT_INDEX[ch]]) >= 0.5);
    }

    if (adapter.isAvailable("RTP_POWER")) {
      const wantPos = adapter.isLit("RTP_POWER") ? "right" : "left";
      if (rmp.power()?.get() !== wantPos) rmp.power()?.set(wantPos);
    }

    if (adapter.isAvailable("INT_RAD")) {
      const wantPos = adapter.isLit("INT_RAD") ? "right" : "left";
      if (acp.intRad()?.get() !== wantPos) acp.intRad()?.set(wantPos);
    }

    for (const [ch, band] of Object.entries(CHANNEL_TO_VOL_READOUT)) {
      if (!adapter.readoutValues.has(band) || adapter.unresolved.has(band)) continue;
      const raw = Number(adapter.getReadoutValue(band, "value")) || 0;
      acp.volume(ch)?.set(raw * 100);
    }
  };

  adapter.onReadoutChange = refresh;
  adapter.onStateChange = refresh;
  refresh();
}
