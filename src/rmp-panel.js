// Wires the vendored vendor/rmp.js component (<rmp-panel>/<acp-panel>) to
// the real X-Plane adapter. Mirrors radio-panel.js's structure: this file
// owns all the RMP/ACP-specific glue, the vendored file is never edited
// except the two small hand-patches noted in vendor/README.md (window.rmpPanel/
// window.acpPanel globals, matching how vendor/radio.js and
// vendor/fcu-instruments.js already expose themselves).
//
// Scoped to VHF1/VHF2 (COM1/COM2) only for this first pass. Two things
// below are read from the profile rather than assumed, since the stock
// A330's RTP profile (config/profiles/rmp-acp-a333.json) and the ToLiss
// Airbus profile (config/profiles/rmp-acp-toliss-airbus.json) genuinely
// differ in what's actually confirmed available on each:
//   - Tuning: the stock A330's standby-frequency datarefs are directly
//     writable (confirmed live), so its readouts declare encoder.write-
//     Dataref and the tune knob writes through it, reusing the generic
//     radio panel's exact coarse/fine gesture and 8.33kHz-grid math (see
//     nextStandbyRaw()). ToLiss's own RMP1Freq/RMP1StbyFreq datarefs
//     aren't confirmed writable (or what write-time validation they'd
//     apply), so that profile omits encoder.writeDataref and instead
//     declares readout.commands.coarseUp/coarseDown/fineUp/fineDown —
//     the tune knob falls back to firing those directly, one press per
//     detent, letting the sim's own stepping/wraparound logic do the
//     work instead of replicating it locally.
//   - Listen toggle: the stock profile's per-channel listen state is a
//     confirmed, live-verified 16-element array dataref; ToLiss's
//     equivalent commands are confirmed by name only, with no confirmed
//     state dataref found at all. See listenToggles' own comment below.

import { nextStandbyRaw } from "./radio-panel.js";

const CHANNEL_TO_BAND = { vhf1: "COM1", vhf2: "COM2" };
const CHANNEL_TO_SEL_BUTTON = { vhf1: "SEL_VHF1", vhf2: "SEL_VHF2" };
const CHANNEL_TO_MIC_BUTTON = { vhf1: "MIC_VHF1", vhf2: "MIC_VHF2" };
const CHANNEL_TO_VOL_READOUT = { vhf1: "VOL_VHF1", vhf2: "VOL_VHF2" };

/** Blanks the RMP/ACP panels with no adapter involved — see blankRadioPanel() for why. */
export function blankRmpAcpPanel() {
  const rmp = window.rmpPanel;
  const acp = window.acpPanel;
  rmp?.display("active")?.clear();
  rmp?.display("stby")?.clear();
  for (const channel of Object.keys(CHANNEL_TO_MIC_BUTTON)) {
    acp?.key(channel)?.setLed(false);
    acp?.volume(channel)?.setLamp(false);
  }
}

/**
 * Wires the ACP's per-channel reception "listen" toggle (whether you can
 * hear a radio, separate from the transmit-select mic_push/MIC_VHF
 * buttons) from the profile's own `listenToggles` array — a shape EfisAdapter's button
 * model doesn't support (one stateDataref per button, not the mix of
 * shared-array-with-index, per-channel-scalar, or command-only-with-no-
 * confirmed-state that different aircraft's profiles actually need here),
 * so this resolves/subscribes directly against the adapter's own client
 * rather than going through the usual buttons/readouts path.
 *
 * @param {{channel: string, command: string, stateDataref?: string, stateIndex?: number}[]} entries
 *   `stateDataref`/`stateIndex` are both optional — a channel with neither
 *   still gets its command wired (tapping it does something real), just
 *   with no lamp feedback, rather than faking a state nothing confirms.
 *   Entries sharing the same `stateDataref` are subscribed together in
 *   one indexed call (see xplane-client.js's subscribeDataref doc on why
 *   two separate subscriptions to the same id don't both take effect).
 */
async function wireListenToggles(adapter, acp, entries) {
  if (!entries || entries.length === 0) return;

  const [commandIds, datarefIds] = await Promise.all([
    adapter.client.resolveCommandIds(entries.map((e) => e.command)),
    adapter.client.resolveDatarefIds([...new Set(entries.filter((e) => e.stateDataref).map((e) => e.stateDataref))]),
  ]);

  const byDataref = new Map();
  for (const entry of entries) {
    if (!entry.stateDataref) continue;
    if (!byDataref.has(entry.stateDataref)) byDataref.set(entry.stateDataref, []);
    byDataref.get(entry.stateDataref).push(entry);
  }
  for (const [datarefName, group] of byDataref) {
    const id = datarefIds.get(datarefName);
    if (id == null) {
      console.warn(`[rmp-panel] missing dataref ${datarefName} — listen state for ${group.map((e) => e.channel).join(", ")} will show no feedback`);
      continue;
    }
    if (group.every((e) => e.stateIndex != null)) {
      const indices = group.map((e) => e.stateIndex);
      adapter.client.subscribeDataref(id, (raw) => group.forEach((e, i) => acp.volume(e.channel)?.setLamp(Number(raw?.[i]) >= 0.5)), indices);
    } else {
      // Scalar dataref (no stateIndex) — expected to be one channel per
      // dataref name in this case, not grouped.
      adapter.client.subscribeDataref(id, (raw) => acp.volume(group[0].channel)?.setLamp(Number(raw) >= 0.5));
    }
  }

  for (const entry of entries) {
    const cmdId = commandIds.get(entry.command);
    if (cmdId == null) {
      console.warn(`[rmp-panel] missing command ${entry.command} — ${entry.channel} listen toggle will be disabled`);
      continue;
    }
    acp.volume(entry.channel)?.onTap(() => adapter.client.activateCommand(cmdId));
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
  // MHz value instead (e.g. ToLiss's RMP1Freq/RMP1StbyFreq, going by name
  // alone — unconfirmed) declares readout.displayScale: 1000 to get the
  // same 6-digit shape; defaults to 1 (no scaling) for a dataref that's
  // already in that form.
  const displayScaleByBand = Object.fromEntries((adapter.profile.readouts ?? []).map((r) => [r.name, r.displayScale ?? 1]));

  const syncDisplay = () => {
    const band = CHANNEL_TO_BAND[rmp.channel()];
    if (!band || adapter.unresolved.has(band)) return;
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
      adapter.press(`${band}.${key}`);
      return;
    }

    const current = Math.round(Number(adapter.getReadoutValue(band, "standby")) || 0);
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

  for (const channel of Object.keys(CHANNEL_TO_MIC_BUTTON)) {
    acp.key(channel)?.onPress(() => {
      const name = CHANNEL_TO_MIC_BUTTON[channel];
      if (adapter.isAvailable(name)) adapter.press(name);
    });
  }

  for (const channel of Object.keys(CHANNEL_TO_VOL_READOUT)) {
    const band = CHANNEL_TO_VOL_READOUT[channel];
    // Profiles that don't declare this readout at all (e.g. the ToLiss
    // profile, which has no confirmed volume mechanism to write through —
    // see its own _gap_acp_volume) never resolve it, so readoutValues
    // never gets an entry for it either — skip wiring the knob entirely
    // rather than firing a "no writable encoder" warning on every drag.
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
    // vhf_1_status/vhf_2_status are independent booleans (see profile's
    // _note_on_channel_select) — VHF2 wins only if it's actually reported
    // lit, VHF1 is the fallback/default otherwise.
    const channel = adapter.isAvailable("SEL_VHF2") && adapter.isLit("SEL_VHF2") ? "vhf2" : "vhf1";
    if (rmp.channel() !== channel) rmp.selectChannel(channel);
    syncDisplay();

    for (const [ch, name] of Object.entries(CHANNEL_TO_MIC_BUTTON)) {
      if (adapter.isAvailable(name)) acp.key(ch)?.setLed(adapter.isLit(name));
    }

    if (adapter.isAvailable("RTP_POWER")) {
      const wantPos = adapter.isLit("RTP_POWER") ? "right" : "left";
      if (rmp.power()?.get() !== wantPos) rmp.power()?.set(wantPos);
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
