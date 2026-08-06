// Renders an EfisAdapter's buttons and readouts into simple DOM elements and
// keeps them in sync. Deliberately plain — this is a first pass to prove
// the command/dataref mapping end-to-end, not a bezel-accurate rendering
// (see css/mcdu.css's keypad for what that level of polish looks like, if
// this panel gets there later).

import { RotaryEncoder } from "./rotary-encoder.js";
import { CompassScale } from "./compass-scale.js";
import { ArcToggle } from "./arc-toggle.js";
import { angleForIndex } from "./detent-angles.js";

// The bearing-pointer selector (ADF/OFF/VOR) is a 3-position left/middle/
// right throw, not the 6-position sweep mode/range use — its own angle
// step, fed into the same shared angleForIndex() (see detent-angles.js).
const BEARING_ANGLE_OPTS = { upIndex: 1, degPerPosition: 90 };

export class EfisPanel {
  /**
   * @param {HTMLElement} container
   * @param {import('./efis-adapter.js').EfisAdapter} adapter
   */
  constructor(container, adapter) {
    this.container = container;
    this.adapter = adapter;
    this._buttonEls = new Map();
    this._readoutEls = new Map();
    this._switchEls = new Map();
    this._encoderEls = new Map();
    this._unitArcs = new Map();

    this._render();
    adapter.onStateChange = (name) => this._updateButton(name);
    adapter.onReadoutChange = (name) => this._updateReadout(name);
    adapter.onSwitchChange = (name) => this._updateSwitch(name);
  }

  /** Looks up a named layout slot (see the data-group elements in efis.html) — falls back to the root container if a profile entry has no group or the slot doesn't exist, so ungrouped items still render rather than silently vanishing. */
  _groupContainer(name) {
    if (!name) return this.container;
    return this.container.querySelector(`[data-group="${name}"]`) ?? this.container;
  }

  _render() {
    this.container.querySelectorAll("[data-group]").forEach((el) => (el.innerHTML = ""));

    for (const readout of this.adapter.profile.readouts ?? []) {
      const group = this._groupContainer(readout.group);

      // Detent selectors (mode, range) show their position on the knob
      // itself (pointer + scale) — a separate text readout would just be
      // redundant, and the real hardware doesn't have one either.
      if (readout.display !== false) {
        const wrap = document.createElement("div");
        wrap.className = "efis-readout";

        const label = document.createElement("span");
        label.className = "efis-readout-label";
        // Display text can differ from the internal name (e.g. "QNH" shown
        // for the readout that's still keyed "BARO" everywhere else, so
        // adjustReadoutValue()/"BARO.std" etc. don't need to change too).
        label.textContent = readout.label ?? readout.name;

        const value = document.createElement("span");
        value.className = "efis-readout-value";
        value.textContent = this.adapter.getReadoutText(readout.name) || "—";

        wrap.append(label, value);
        group.appendChild(wrap);
        this._readoutEls.set(readout.name, value);
      }

      if (readout.encoder) {
        const hasPushPull = readout.commands?.std && readout.commands?.qnh;
        const isDetent = Boolean(readout.encoder.positions);
        const encoder = new RotaryEncoder(group, {
          label: readout.encoder.label,
          scaleLabels: isDetent ? readout.encoder.positions : undefined,
          // A detent selector's pointer should show a real (or at least
          // known-correct) position, not spin proportionally to raw drag
          // pixels — see setAngle() below, driven from _updateReadout().
          trackDragVisually: !isDetent,
          stepPx: readout.encoder.stepPx,
          onDragStart: () => this.adapter.beginAdjust(readout.name),
          onDragEnd: () => this.adapter.endAdjust(readout.name),
          onStep: (direction) => {
            // Three ways a step can land, depending what the profile gave
            // us: write the value directly (no command pacing to fight, so
            // this is preferred whenever available); step a clamped detent
            // selector via commands; or a plain unclamped step command.
            if (readout.encoder.writeDataref) {
              this.adapter.adjustReadoutValue(readout.name, direction);
            } else if (readout.encoder.positions) {
              this.adapter.adjustReadoutIndex(readout.name, direction);
            } else {
              this.adapter.queuePress(`${readout.name}.${direction > 0 ? "increment" : "decrement"}`);
            }
          },
          // A tap (not a drag) mirrors a physical push/pull knob: engage
          // STD if it isn't already, otherwise revert to the last QNH
          // value. Only wired for readouts that actually have that pair of
          // commands (baro) — most detent selectors (mode, range) have no
          // center action at all.
          onPress: hasPushPull
            ? () => {
                const isStd = this.adapter.getReadoutValue(readout.name, "std") !== 0;
                this.adapter.press(`${readout.name}.${isStd ? "qnh" : "std"}`);
              }
            : undefined,
        });
        this._encoderEls.set(readout.name, encoder);
        if (isDetent) this._updateEncoderAngle(readout, encoder);

        if (readout.encoder.unitArc) {
          const arcCfg = readout.encoder.unitArc;
          encoder.el.classList.add("rotary-encoder-has-unit-arc");
          const arc = new ArcToggle(encoder.el, {
            startLabel: arcCfg.startLabel,
            endLabel: arcCfg.endLabel,
            onSelect: (side) => {
              const key = side === "start" ? arcCfg.startCommand : arcCfg.endCommand;
              this.adapter.press(`${readout.name}.${key}`);
            },
          });
          this._unitArcs.set(readout.name, { arc, unitKey: arcCfg.unitKey ?? "unit" });
          this._updateUnitArc(readout.name);
        }
      }
    }

    for (const button of this.adapter.profile.buttons ?? []) {
      const el = document.createElement("button");
      el.type = "button";

      if (button.style === "legend") {
        // Real Airbus "legend switch" look: a separate on/off indicator
        // segment above the label, rather than the label itself changing
        // color — see .efis-legend-button in efis.css.
        el.className = "efis-legend-button";
        const indicator = document.createElement("span");
        indicator.className = "efis-legend-indicator";
        const label = document.createElement("span");
        label.className = "efis-legend-label";
        label.textContent = button.name;
        el.append(indicator, label);
      } else {
        el.className = "efis-button";
        el.textContent = button.name;
      }

      if (!this.adapter.isAvailable(button.name)) {
        el.disabled = true;
        el.title = "Command/dataref did not resolve on this sim";
      } else {
        el.addEventListener("click", () => this.adapter.press(button.name));
      }

      this._groupContainer(button.group).appendChild(el);
      this._buttonEls.set(button.name, el);
    }

    for (const toggleSwitch of this.adapter.profile.toggleSwitches ?? []) {
      const wrap = document.createElement("div");
      wrap.className = "compass-switch";

      new CompassScale(wrap, { idLabel: toggleSwitch.idLabel ?? "" });

      // Absolute-select commands (not relative step), unlike mode/range —
      // each position has its own dedicated command, so a drag just needs
      // to track which of the 3 positions it's currently aiming at and
      // (re-)select that one directly. Repeating an already-selected
      // position is harmless, so no pending-queue bookkeeping is needed
      // here the way adjustReadoutIndex() needs it for paced step commands.
      let index = this.adapter.getSwitchPosition(toggleSwitch.name);
      if (index < 0) index = 1; // unknown yet — default to the OFF slot visually
      const encoder = new RotaryEncoder(wrap, {
        pointer: true,
        pointerStyle: "toggle",
        trackDragVisually: false,
        stepPx: 40,
        onStep: (direction) => {
          const next = Math.min(toggleSwitch.positions.length - 1, Math.max(0, index + direction));
          if (next === index) return;
          index = next;
          this.adapter.pressSwitchPosition(toggleSwitch.name, index);
        },
      });
      encoder.setAngle(angleForIndex(index, BEARING_ANGLE_OPTS));

      this._groupContainer(toggleSwitch.group).appendChild(wrap);
      this._switchEls.set(toggleSwitch.name, encoder);
    }
  }

  _updateButton(name) {
    const el = this._buttonEls.get(name);
    if (!el) return;
    el.classList.toggle("lit", this.adapter.isLit(name));
  }

  _updateReadout(name) {
    const el = this._readoutEls.get(name);
    if (el) el.textContent = this.adapter.getReadoutText(name);

    const readout = this.adapter.profile.readouts?.find((r) => r.name === name);
    if (readout?.encoder?.positions) this._updateEncoderAngle(readout, this._encoderEls.get(name));
    this._updateUnitArc(name);
  }

  _updateUnitArc(name) {
    const entry = this._unitArcs.get(name);
    if (!entry) return;
    const raw = Number(this.adapter.getReadoutValue(name, entry.unitKey) ?? 0);
    entry.arc.setActive(raw >= 0.5 ? "end" : "start");
  }

  _updateEncoderAngle(readout, encoder) {
    if (!encoder) return;
    const valueKey = readout.encoder.valueKey ?? "value";
    const index = Math.round(Number(this.adapter.getReadoutValue(readout.name, valueKey) ?? 0));
    encoder.setAngle(angleForIndex(index));
  }

  _updateSwitch(name) {
    const encoder = this._switchEls.get(name);
    const index = this.adapter.getSwitchPosition(name);
    if (!encoder || index < 0) return;
    encoder.setAngle(angleForIndex(index, BEARING_ANGLE_OPTS));
  }
}
