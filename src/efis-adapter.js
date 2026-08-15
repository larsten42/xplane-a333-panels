// Bridges an XPlaneClient to EFIS-shaped concepts: named buttons (a command
// to press, a dataref reflecting whether they're lit), named readouts (one
// or more datarefs formatted into display text — see readout-formats.js),
// and named toggle switches (several commands sharing one state dataref,
// each position an enum value on it — e.g. the bearing-pointer selector:
// ADF=0/OFF=1/VOR=3 on one dataref, one command per position). All three
// share the same command-resolution machinery.
//
// Much simpler than mcdu-adapter.js — these datarefs are plain scalars
// (no base64/character-grid decoding), and there's no {cdu} template
// substitution to do; the profile just lists full command/dataref names.
//
// Not actually EFIS-specific under the hood (nothing here hardcodes
// anything about the EFIS panel) — reused as-is for the FCU's buttons too
// (see src/fcu-panel.js), which need a few extra button shapes beyond
// plain "one command, boolean dataref":
//   - `litValue`: for buttons that share ONE dataref between several
//     mutually-exclusive states (e.g. AP1/AP2 both read
//     autopilot_12_status, lit when it equals 1 or 2 respectively) rather
//     than each having its own boolean dataref.
//   - `onCommands`/`offCommands`: for buttons where a single logical
//     press actually needs more than one command sent together (e.g.
//     A/THR's a_thr_toggle + autothrottle_arm to engage, a_thr_toggle +
//     autothrottle_hard_off to disengage, confirmed against X-Plane's own
//     stock button behavior 2026-08-08) — same "check current state, then
//     press whichever side applies" shape as the baro encoder's std/qnh
//     pair, just for a plain button instead of a knob.
//   - no `stateDataref` at all: for buttons with no light of their own on
//     the real hardware (e.g. the FCU's HDG-TRK/V-S-FPA mode toggle, which
//     just changes what the display shows, confirmed live — firing
//     sim/autopilot/trkfpa doesn't move any autopilot-status dataref) —
//     still gets a resolved command to press, just no lit-state tracking.

import { READOUT_FORMATS, READOUT_STEP_SIZES } from "./readout-formats.js";

export class EfisAdapter {
  /**
   * @param {import('./xplane-client.js').XPlaneClient} client
   * @param {object} profile parsed profile JSON (config/profiles/efis-*.json)
   */
  constructor(client, profile) {
    this.client = client;
    this.profile = profile;

    /** @type {Map<string, boolean>} button name -> current lit state */
    this.state = new Map();
    /** @type {Map<string, string>} readout name -> current formatted text */
    this.readoutText = new Map();
    /** @type {Map<string, object>} readout name -> its raw {key: value} object, for logic beyond just display text (e.g. "is STD currently engaged?") */
    this.readoutValues = new Map();
    /** @type {Map<string, number>} toggle switch name -> currently active position index, or -1 if the raw value matches none of them */
    this.switchPosition = new Map();
    /** @type {Map<string, object>} readout name -> its profile entry, for adjustReadoutValue() */
    this._readoutByName = new Map();
    /** @type {Map<string, number>} readout name -> resolved dataref id for its encoder.writeDataref, if any */
    this._encoderWriteIds = new Map();
    /** @type {Map<string, number>} readout name -> resolved dataref id for its encoder.unitArc.writeDataref, if any — see setReadoutUnit() */
    this._unitArcWriteIds = new Map();
    /** @type {Map<string, number>} "buttonName" or "readoutName.commandKey" -> command id, only entries that resolved */
    this._commandIds = new Map();
    /** @type {Map<string, {on: number[], off: number[]}>} button name -> resolved command ids for buttons with onCommands/offCommands instead of a single command */
    this._onOffCommandIds = new Map();
    /** @type {Set<string>} same keys as above, present in the profile but unresolved on this sim */
    this.unresolved = new Set();
    /** @type {Set<string>} "readoutName.valueKey" currently under active local drag control — see beginAdjust()/endAdjust() */
    this._heldKeys = new Set();
    /** @type {Map<string, number>} readout name -> net steps still owed (positive = increments, negative = decrements) — see adjustReadoutIndex() */
    this._pendingSteps = new Map();
    /** @type {Set<string>} readout names with an active _drainSteps() timer */
    this._steppingDraining = new Set();

    this.onStateChange = null; // (name) => void, called whenever a button's lit state changes
    this.onReadoutChange = null; // (name) => void, called whenever a readout's text changes
    this.onSwitchChange = null; // (name) => void, called whenever a toggle switch's active position changes
  }

  /** Resolve all commands/datarefs against the live sim and subscribe to state. */
  async connect() {
    const buttons = this.profile.buttons ?? [];
    const readouts = this.profile.readouts ?? [];
    const toggleSwitches = this.profile.toggleSwitches ?? [];

    const commandNames = [
      ...buttons.map((b) => b.command).filter(Boolean),
      ...buttons.flatMap((b) => [...(b.onCommands ?? []), ...(b.offCommands ?? [])]),
      ...readouts.flatMap((r) => Object.values(r.commands ?? {})),
      ...toggleSwitches.flatMap((s) => s.positions.map((p) => p.command)),
    ];
    const datarefNames = [
      ...buttons.map((b) => b.stateDataref).filter(Boolean),
      ...readouts.flatMap((r) => Object.values(r.datarefs)),
      ...readouts.flatMap((r) => (r.encoder?.writeDataref ? [r.encoder.writeDataref] : [])),
      ...readouts.flatMap((r) => (r.encoder?.unitArc?.writeDataref ? [r.encoder.unitArc.writeDataref] : [])),
      ...toggleSwitches.map((s) => s.stateDataref),
    ];

    const [commandIds, datarefIds] = await Promise.all([
      this.client.resolveCommandIds(commandNames),
      this.client.resolveDatarefIds(datarefNames),
    ]);

    for (const button of buttons) this._connectButton(button, commandIds, datarefIds);
    for (const readout of readouts) this._connectReadout(readout, commandIds, datarefIds);
    for (const toggleSwitch of toggleSwitches) this._connectToggleSwitch(toggleSwitch, commandIds, datarefIds);

    if (this.unresolved.size > 0) {
      console.warn(
        `[efis-adapter] ${this.unresolved.size} command/dataref(s) did not resolve on this sim: ${[...this.unresolved].join(", ")}`
      );
    }
  }

  _connectButton(button, commandIds, datarefIds) {
    // stateDataref is optional — some buttons (e.g. the FCU's HDG-TRK/
    // V-S-FPA mode toggle) have no light of their own to reflect on the
    // real hardware; they still need a resolved command to press, just no
    // lit-state subscription.
    let drId = null;
    if (button.stateDataref) {
      drId = datarefIds.get(button.stateDataref);
      if (drId == null) {
        console.warn(`[efis-adapter] button "${button.name}": missing dataref ${button.stateDataref}. Button will be disabled.`);
        this.unresolved.add(button.name);
        return;
      }
    }

    if (button.onCommands && button.offCommands) {
      const onIds = button.onCommands.map((name) => commandIds.get(name));
      const offIds = button.offCommands.map((name) => commandIds.get(name));
      if (onIds.some((id) => id == null) || offIds.some((id) => id == null)) {
        console.warn(
          `[efis-adapter] button "${button.name}": missing one or more onCommands/offCommands (${button.onCommands.join(", ")} / ${button.offCommands.join(", ")}). Button will be disabled.`
        );
        this.unresolved.add(button.name);
        return;
      }
      this._onOffCommandIds.set(button.name, { on: onIds, off: offIds });
    } else {
      const cmdId = commandIds.get(button.command);
      if (cmdId == null) {
        console.warn(`[efis-adapter] button "${button.name}": missing command ${button.command}. Button will be disabled.`);
        this.unresolved.add(button.name);
        return;
      }
      this._commandIds.set(button.name, cmdId);
    }

    this.state.set(button.name, false);
    if (drId == null) return;
    this.client.subscribeDataref(drId, (raw) => {
      // Some of these datarefs animate smoothly between 0 and 1 (X-Plane's
      // own light-fade transition) rather than flipping instantly — a
      // midpoint threshold, not an exact-zero/nonzero check, is what
      // keeps the previous selection's "off" in sync with the new
      // selection's "on" instead of lagging behind it. litValue is for the
      // different case of several buttons sharing one dataref (e.g.
      // AP1/AP2 on the same autopilot_12_status) — there, "lit" means an
      // exact match, not a threshold.
      const value = Number(raw);
      const lit = button.litValue != null ? Math.round(value) === button.litValue : button.invert ? value < 0.5 : value >= 0.5;
      this.state.set(button.name, lit);
      this.onStateChange?.(button.name);
    });
  }

  _connectReadout(readout, commandIds, datarefIds) {
    const format = READOUT_FORMATS[readout.format];
    if (!format) {
      console.warn(`[efis-adapter] readout "${readout.name}": unknown format "${readout.format}"`);
      return;
    }

    const values = {};
    let allResolved = true;
    for (const [key, name] of Object.entries(readout.datarefs)) {
      const id = datarefIds.get(name);
      if (id == null) {
        console.warn(`[efis-adapter] readout "${readout.name}": missing dataref ${key}=${name}`);
        allResolved = false;
        continue;
      }
      values[key] = 0;
      this.client.subscribeDataref(id, (raw) => {
        // While this key is under active drag control (see beginAdjust()),
        // our own optimistic value is ahead of what X-Plane's ~10Hz push
        // has caught up to confirming — accepting a push here would be
        // accepting a stale echo of an earlier write and yank the display
        // backwards mid-drag. Skip it; endAdjust() lets the next push
        // resync once the drag actually stops.
        if (this._heldKeys.has(`${readout.name}.${key}`)) return;
        values[key] = raw;
        this.readoutText.set(readout.name, format(values, readout));
        this.onReadoutChange?.(readout.name);
      });
    }
    if (!allResolved) {
      this.unresolved.add(readout.name);
      return;
    }
    this.readoutValues.set(readout.name, values);
    this.readoutText.set(readout.name, format(values, readout));
    this._readoutByName.set(readout.name, readout);

    if (readout.encoder?.writeDataref) {
      const writeId = datarefIds.get(readout.encoder.writeDataref);
      if (writeId == null) {
        console.warn(
          `[efis-adapter] readout "${readout.name}": encoder.writeDataref "${readout.encoder.writeDataref}" did not resolve`
        );
      } else {
        this._encoderWriteIds.set(readout.name, writeId);
      }
    }

    // Same idea as encoder.writeDataref above, but for a ring/arc's own
    // two-position unit toggle (e.g. baro's inHg/hPa) on aircraft where
    // that's a plain writable dataref rather than a command pair — see
    // setReadoutUnit(). Kept as a separate field (not reusing
    // encoder.writeDataref) since the two can legitimately be different
    // datarefs, same as unitArc.startCommand/endCommand already being
    // separate from commands.pull/push.
    if (readout.encoder?.unitArc?.writeDataref) {
      const writeId = datarefIds.get(readout.encoder.unitArc.writeDataref);
      if (writeId == null) {
        console.warn(
          `[efis-adapter] readout "${readout.name}": encoder.unitArc.writeDataref "${readout.encoder.unitArc.writeDataref}" did not resolve`
        );
      } else {
        this._unitArcWriteIds.set(readout.name, writeId);
      }
    }

    for (const [key, name] of Object.entries(readout.commands ?? {})) {
      const id = commandIds.get(name);
      const fullKey = `${readout.name}.${key}`;
      if (id == null) {
        console.warn(`[efis-adapter] readout "${readout.name}": missing command ${key}=${name}`);
        this.unresolved.add(fullKey);
        continue;
      }
      this._commandIds.set(fullKey, id);
    }
  }

  _connectToggleSwitch(toggleSwitch, commandIds, datarefIds) {
    const drId = datarefIds.get(toggleSwitch.stateDataref);
    if (drId == null) {
      console.warn(
        `[efis-adapter] switch "${toggleSwitch.name}": missing stateDataref "${toggleSwitch.stateDataref}"`
      );
      this.unresolved.add(toggleSwitch.name);
      return;
    }

    let anyResolved = false;
    toggleSwitch.positions.forEach((position, index) => {
      const cmdId = commandIds.get(position.command);
      const fullKey = `${toggleSwitch.name}.${index}`;
      if (cmdId == null) {
        console.warn(
          `[efis-adapter] switch "${toggleSwitch.name}" position "${position.label}": missing command "${position.command}"`
        );
        this.unresolved.add(fullKey);
        return;
      }
      anyResolved = true;
      this._commandIds.set(fullKey, cmdId);
    });
    if (!anyResolved) {
      this.unresolved.add(toggleSwitch.name);
      return;
    }

    this.switchPosition.set(toggleSwitch.name, -1);
    this.client.subscribeDataref(drId, (raw) => {
      const rounded = Math.round(Number(raw));
      const index = toggleSwitch.positions.findIndex((p) => p.value === rounded);
      this.switchPosition.set(toggleSwitch.name, index);
      this.onSwitchChange?.(toggleSwitch.name);
    });
  }

  /** Selects a toggle switch's position by index (see profile's toggleSwitches[].positions). */
  pressSwitchPosition(switchName, positionIndex) {
    return this.press(`${switchName}.${positionIndex}`);
  }

  getSwitchPosition(switchName) {
    return this.switchPosition.get(switchName) ?? -1;
  }

  press(name) {
    const onOff = this._onOffCommandIds.get(name);
    if (onOff) {
      const ids = this.isLit(name) ? onOff.off : onOff.on;
      for (const id of ids) this.client.activateCommand(id);
      return true;
    }
    const id = this._commandIds.get(name);
    if (id == null) {
      console.warn(`[efis-adapter] "${name}" has no resolved command; ignoring press`);
      return false;
    }
    this.client.activateCommand(id);
    return true;
  }

  /**
   * Marks a readout's encoder value as under active local control — call
   * on drag start, paired with endAdjust() on drag end. While held, this
   * readout's value-key subscription pushes are ignored (see
   * subscribeDataref callback in _connectReadout) so a fast drag's own
   * optimistic updates aren't fought by stale server echoes; endAdjust()
   * lets the next real push resync once the drag actually stops, which
   * also naturally corrects for anything the sim clamped (e.g. min/max).
   *
   * Only meaningful for the writable-dataref case (adjustReadoutValue) —
   * there, our own write really is more current than a lagging push, so
   * trusting local state over the echo is correct. Command-paced detent
   * selectors (adjustReadoutIndex) have no such "our own write" to
   * protect: the subscription is the *only* source of truth, so holding
   * it would just make the display go stale for the whole drag instead of
   * tracking however fast the paced commands actually land.
   */
  beginAdjust(name) {
    const readout = this._readoutByName.get(name);
    if (!readout?.encoder.writeDataref) return;
    this._heldKeys.add(`${name}.${readout.encoder.valueKey ?? "value"}`);
  }

  endAdjust(name) {
    const readout = this._readoutByName.get(name);
    if (readout?.encoder.writeDataref) {
      this._heldKeys.delete(`${name}.${readout.encoder.valueKey ?? "value"}`);
    }
    // Deliberately does NOT touch _pendingSteps: those are real outstanding
    // commands still owed to reach where the drag asked to go, and should
    // keep draining in the background after release, not be forgotten.
  }

  /**
   * Adjusts a readout's underlying value directly by writing its
   * encoder.writeDataref, rather than firing step commands — no
   * command_set_is_active pacing/coalescing to worry about, so this is
   * what a fast encoder drag should use whenever a writable dataref is
   * available (see readout.encoder.writeDataref in the profile).
   * Updates local state optimistically so the display tracks the drag
   * instantly instead of waiting on the next subscription push.
   *
   * If encoder.positions is set, this is a detent selector rather than a
   * free value: the step size is always exactly 1 index, clamped to
   * [0, positions.length - 1] rather than left to wrap/overflow — X-Plane
   * itself has no min/max concept for an arbitrary written dataref value,
   * so nothing else would stop it going out of range.
   */
  adjustReadoutValue(name, deltaSteps) {
    const readout = this._readoutByName.get(name);
    const writeId = this._encoderWriteIds.get(name);
    if (!readout || writeId == null) {
      console.warn(`[efis-adapter] readout "${name}" has no writable encoder dataref; ignoring adjust`);
      return false;
    }
    const values = this.readoutValues.get(name);
    const valueKey = readout.encoder.valueKey ?? "value";
    const positions = readout.encoder.positions;

    let next;
    if (positions) {
      const current = Math.round(Number(values[valueKey] ?? 0));
      next = Math.min(positions.length - 1, Math.max(0, current + deltaSteps));
      if (next === current) return true; // already at an end stop
    } else {
      // Prefer a format-specific step size (e.g. baro's differs by
      // displayed unit) over the profile's flat fallback, for formats that
      // don't need that nuance.
      const stepFn = READOUT_STEP_SIZES[readout.format];
      const stepSize = stepFn ? stepFn(values) : readout.encoder.stepValue;
      next = Number(values[valueKey] ?? 0) + deltaSteps * stepSize;
    }

    values[valueKey] = next;
    this.readoutText.set(name, READOUT_FORMATS[readout.format](values, readout));
    this.onReadoutChange?.(name);
    this.client.setDatarefValue(writeId, next);
    return true;
  }

  /**
   * Sets a readout's encoder.unitArc-driven two-position unit toggle (e.g.
   * baro's inHg/hPa ring) by writing encoder.unitArc.writeDataref directly
   * — the writable-dataref counterpart to firing unitArc.startCommand/
   * endCommand via press(), for aircraft that expose this as a plain
   * dataref instead of a command pair. index 0 -> unitArc.startValue
   * (default 0), index 1 -> unitArc.endValue (default 1).
   */
  setReadoutUnit(name, index) {
    const readout = this._readoutByName.get(name);
    const writeId = this._unitArcWriteIds.get(name);
    const unitArc = readout?.encoder?.unitArc;
    if (!readout || writeId == null || !unitArc) {
      console.warn(`[efis-adapter] readout "${name}" has no encoder.unitArc.writeDataref; ignoring setReadoutUnit`);
      return false;
    }
    const value = index === 0 ? unitArc.startValue ?? 0 : unitArc.endValue ?? 1;
    const unitKey = unitArc.unitKey ?? "unit";
    const values = this.readoutValues.get(name);

    values[unitKey] = value;
    this.readoutText.set(name, READOUT_FORMATS[readout.format](values, readout));
    this.onReadoutChange?.(name);
    this.client.setDatarefValue(writeId, value);
    return true;
  }

  /**
   * Like adjustReadoutValue(), but for detent selectors whose only way to
   * move is step commands (e.g. the ND mode knob) rather than a writable
   * dataref. Deliberately does *not* touch the displayed value — that
   * stays driven purely by real subscription pushes, since command
   * activations are paced ~160ms apart (see _drainSteps()) and there's no
   * way to know the real position faster than X-Plane confirms it. A fast
   * drag will feel a little behind the finger because of that pacing, but
   * it will never show something that turns out to be wrong.
   *
   * Queues into a single signed _pendingSteps counter per readout rather
   * than firing commands immediately or using two independent per-
   * direction queues — a fast, slightly imprecise drag can generate a few
   * steps in the "wrong" direction
   * along with the intended ones, and X-Plane coalesces overlapping
   * command_set_is_active activations, so an increment and a decrement
   * both in flight at once can silently cancel each other out. A single
   * counter with one drain loop guarantees only one direction is ever
   * actually in flight.
   */
  adjustReadoutIndex(name, deltaSteps) {
    const readout = this._readoutByName.get(name);
    const valueKey = readout?.encoder?.valueKey ?? "value";
    const confirmed = Math.round(Number(this.readoutValues.get(name)?.[valueKey] ?? 0));
    const pending = this._pendingSteps.get(name) ?? 0;
    return this.setReadoutIndex(name, confirmed + pending + deltaSteps);
  }

  /**
   * Like adjustReadoutIndex(), but takes the *absolute* target index a
   * caller already knows (e.g. a detent selector's onChange, which hands
   * back the absolute index the user dragged/scrolled to) instead of a
   * relative delta. Use this whenever the caller has an absolute target —
   * computing "delta = target - currentDisplayedValue" on the caller's
   * side goes stale and double-counts across a burst of quick calls
   * (mouse wheel, a fast drag), since the displayed value is deliberately
   * never updated optimistically here (see the class-level reasoning
   * above): confirmed live 2026-08-15 as the cause of the ND mode knob
   * overshooting and visibly snapping back during a burst (RANGE doesn't
   * hit this — its writeDataref path in adjustReadoutValue() already
   * updates the tracked value optimistically, so its own delta computation
   * in efis-panel.js's wireDetentKnob() stays accurate across a burst).
   * Deriving
   * the queued delta from the adapter's own tracked confirmed+pending
   * state instead keeps every call in a burst correctly additive.
   */
  setReadoutIndex(name, targetIndex) {
    const readout = this._readoutByName.get(name);
    const positions = readout?.encoder?.positions;
    if (!readout || !positions) {
      console.warn(`[efis-adapter] readout "${name}" has no encoder.positions; ignoring setReadoutIndex`);
      return false;
    }
    const valueKey = readout.encoder.valueKey ?? "value";
    const confirmed = Math.round(Number(this.readoutValues.get(name)?.[valueKey] ?? 0));
    const pending = this._pendingSteps.get(name) ?? 0;
    const predicted = confirmed + pending; // real state, plus whatever's still queued/in flight
    const next = Math.min(positions.length - 1, Math.max(0, targetIndex));
    if (next === predicted) return true; // already at (or already queued to) this target

    this._pendingSteps.set(name, pending + (next - predicted));
    this._drainSteps(name);
    return true;
  }

  /** Single drain loop per readout, pacing ~160ms apart, always resolving _pendingSteps' current sign so increment/decrement can never both be in flight at once. */
  _drainSteps(name) {
    if (this._steppingDraining.has(name)) return;
    this._steppingDraining.add(name);
    const step = () => {
      const pending = this._pendingSteps.get(name) ?? 0;
      if (pending === 0) {
        this._steppingDraining.delete(name);
        return;
      }
      const direction = pending > 0 ? 1 : -1;
      this._pendingSteps.set(name, pending - direction);
      this.press(`${name}.${direction > 0 ? "increment" : "decrement"}`);
      setTimeout(step, 160);
    };
    step();
  }

  isLit(name) {
    return this.state.get(name) ?? false;
  }

  getReadoutText(name) {
    return this.readoutText.get(name) ?? "";
  }

  getReadoutValue(name, key) {
    return this.readoutValues.get(name)?.[key];
  }

  isAvailable(name) {
    return this._commandIds.has(name) || this._onOffCommandIds.has(name);
  }
}
