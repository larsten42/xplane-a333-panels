// Wires the vendored vendor/rmp.js component (<rmp-panel>/<acp-panel>) to
// the real X-Plane adapter. Mirrors radio-panel.js's structure: this file
// owns all the RMP/ACP-specific glue, the vendored file is never edited
// except the two small hand-patches noted in vendor/README.md (window.rmpPanel/
// window.acpPanel globals, matching how vendor/radio.js and
// vendor/fcu-instruments.js already expose themselves).
//
// Scoped to VHF1/VHF2 (COM1/COM2) only for this first pass — see
// config/profiles/rmp-acp-a333.json's own description/_note_on_* fields for
// why the RTP's tune knob reuses the generic radio panel's direct-write
// standby tuning (and, below, its exact coarse/fine gesture + wraparound
// math via nextStandbyRaw()) instead of the RTP's own step commands.

import { nextStandbyRaw } from "./radio-panel.js";

const CHANNEL_TO_BAND = { vhf1: "COM1", vhf2: "COM2" };
const CHANNEL_TO_SEL_BUTTON = { vhf1: "SEL_VHF1", vhf2: "SEL_VHF2" };
const CHANNEL_TO_MIC_BUTTON = { vhf1: "MIC_VHF1", vhf2: "MIC_VHF2" };
const CHANNEL_TO_VOL_READOUT = { vhf1: "VOL_VHF1", vhf2: "VOL_VHF2" };

// The ACP's per-channel reception "listen" toggle (whether you can hear a
// radio, separate from mic_push*/MIC_VHF*'s transmit-select) lives on a
// 16-element array dataref, not a shape EfisAdapter's button model
// supports (one stateDataref per button, not one shared array with a
// per-button index) — so this is resolved/subscribed directly against the
// adapter's own client rather than going through config/profiles/rmp-acp-a333.json.
// Confirmed live 2026-08-16: index 0 = VHF1, index 1 = VHF2, plain 0/1
// values, and listen_press00/01 toggle exactly those two indices
// one-to-one (press00 -> index 0, press01 -> index 1).
const LISTEN_STATUS_DATAREF = "laminar/A333/audio/capt/listen_status";
const CHANNEL_TO_LISTEN_INDEX = { vhf1: 0, vhf2: 1 };
const CHANNEL_TO_LISTEN_COMMAND = {
  vhf1: "laminar/A333/audio/capt/listen_press00",
  vhf2: "laminar/A333/audio/capt/listen_press01",
};

/** Blanks the RMP/ACP panels with no adapter involved — see blankRadioPanel() for why. */
export function blankRmpAcpPanel() {
  const rmp = window.rmpPanel;
  const acp = window.acpPanel;
  rmp?.display("active")?.clear();
  rmp?.display("stby")?.clear();
  for (const channel of Object.keys(CHANNEL_TO_MIC_BUTTON)) acp?.key(channel)?.setLed(false);
  for (const channel of Object.keys(CHANNEL_TO_LISTEN_INDEX)) acp?.volume(channel)?.setLamp(false);
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

  // See CHANNEL_TO_LISTEN_INDEX's own comment for why this is resolved
  // here instead of through the profile. onTap() is a hand-patch on
  // vendor/rmp.js's AcpKnob (see vendor/README.md) — without it, a tap
  // would just flip the knob's own local lamp state with nothing behind
  // it; wiring it here means the lamp only ever reflects the sim's
  // confirmed listen_status, never an unconfirmed local guess.
  const [listenDatarefIds, listenCommandIds] = await Promise.all([
    adapter.client.resolveDatarefIds([LISTEN_STATUS_DATAREF]),
    adapter.client.resolveCommandIds(Object.values(CHANNEL_TO_LISTEN_COMMAND)),
  ]);
  const listenStatusId = listenDatarefIds.get(LISTEN_STATUS_DATAREF);
  if (listenStatusId == null) {
    console.warn(`[rmp-panel] missing dataref ${LISTEN_STATUS_DATAREF} — listen toggle will be disabled`);
  } else {
    const listenChannels = Object.keys(CHANNEL_TO_LISTEN_INDEX); // ["vhf1", "vhf2"]
    const listenIndices = listenChannels.map((ch) => CHANNEL_TO_LISTEN_INDEX[ch]); // [0, 1], same order
    adapter.client.subscribeDataref(
      listenStatusId,
      (raw) => listenChannels.forEach((channel, i) => acp.volume(channel)?.setLamp(Number(raw?.[i]) >= 0.5)),
      listenIndices
    );
  }
  for (const [channel, commandName] of Object.entries(CHANNEL_TO_LISTEN_COMMAND)) {
    const cmdId = listenCommandIds.get(commandName);
    if (cmdId == null) {
      console.warn(`[rmp-panel] missing command ${commandName} — ${channel} listen toggle will be disabled`);
      continue;
    }
    acp.volume(channel)?.onTap(() => adapter.client.activateCommand(cmdId));
  }

  // Same drag-end debounce pattern as radio-panel.js/fcu-panel.js's own
  // knobs — one timer per control that can be dragged, so beginAdjust()/
  // endAdjust() bracket the whole gesture instead of every single step.
  const DRAG_END_DEBOUNCE_MS = 200;
  let tuneDragEndTimer = null;
  const volDragEndTimers = { vhf1: null, vhf2: null };

  const syncDisplay = () => {
    const band = CHANNEL_TO_BAND[rmp.channel()];
    if (!band || adapter.unresolved.has(band)) return;
    const active = Math.round(Number(adapter.getReadoutValue(band, "active")) || 0);
    const standby = Math.round(Number(adapter.getReadoutValue(band, "standby")) || 0);
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
      if (adapter.unresolved.has(band)) continue;
      const raw = Number(adapter.getReadoutValue(band, "value")) || 0;
      acp.volume(ch)?.set(raw * 100);
    }
  };

  adapter.onReadoutChange = refresh;
  adapter.onStateChange = refresh;
  refresh();
}
