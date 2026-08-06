// A generic drag-to-turn encoder input: horizontal drag distance converts
// to discrete step callbacks, a tap-without-drag fires a separate press
// callback (for push/pull-style center actions like baro's STD). Nothing
// baro-specific here — this is meant for any encoder-style control (FCU's
// speed/heading/altitude/V-S knobs included), so it only knows about
// pixels and steps, not what a step *means*.
//
// Builds its own DOM (knob + optional label printed on the knob face, e.g.
// "PULL STD", or a pointer/needle shape for detent selectors — see
// opts.pointer) rather than being handed an existing element, so a caller
// just does `new RotaryEncoder(container, { ... })` and gets a fully wired
// widget back — consistent with how EfisPanel treats buttons/readouts.
//
// Uses Pointer Events (not mouse/touch separately) so mouse and touch/
// tablet drag work identically, and setPointerCapture so a fast drag that
// leaves the knob's bounds doesn't drop the gesture.

import { RotaryScale } from "./rotary-scale.js";

const DRAG_THRESHOLD_PX = 4; // movement below this still counts as a tap, not a drag
const DEG_PER_STEP = 15; // purely visual — how far the knob rotates per step, when trackDragVisually is on
const TOGGLE_SHAFT_LENGTH_PX = 20; // must match .rotary-encoder-pointer-toggle-shaft's width in efis.css

export class RotaryEncoder {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {string} [opts.label] text printed on the knob face (e.g. "PULL STD")
   * @param {boolean} [opts.pointer] draws a pointer on the knob face instead of a label
   * @param {"pen" | "toggle"} [opts.pointerStyle] "pen" (default) is the flat tapered wedge used by
   *   mode/range; "toggle" is a thin metal shaft with a rounded bulb at the tip, for switches that are
   *   physically small industrial toggles rather than a knob you turn (e.g. the bearing-pointer selector)
   * @param {string[]} [opts.scaleLabels] if set, draws a RotaryScale (arc + tick + label per position)
   *   around the knob — implies pointer, since a scale without a pointer to read it against is pointless
   * @param {number} [opts.stepPx] pixels of horizontal drag per step (default 12)
   * @param {boolean} [opts.trackDragVisually] if true (default), the knob spins as you drag, purely for
   *   turning feel — right for a free-running encoder like baro. Detent selectors with a real, known
   *   position (mode, range) should pass false and drive rotation via setAngle() instead, since a
   *   value that's paced/optimistic shouldn't have the pointer visually promise more than is true yet.
   * @param {(direction: 1 | -1) => void} [opts.onStep]
   * @param {() => void} [opts.onPress] fired on a tap/click that wasn't a drag
   * @param {() => void} [opts.onDragStart] fired on pointerdown, before any steps
   * @param {() => void} [opts.onDragEnd] fired on release, always (tap or drag)
   */
  constructor(
    container,
    {
      label,
      pointer,
      pointerStyle = "pen",
      scaleLabels,
      stepPx = 12,
      trackDragVisually = true,
      onStep,
      onPress,
      onDragStart,
      onDragEnd,
    } = {}
  ) {
    this.stepPx = stepPx;
    this.trackDragVisually = trackDragVisually;
    this.pointerStyle = pointerStyle;
    this.onStep = onStep;
    this.onPress = onPress;
    this.onDragStart = onDragStart;
    this.onDragEnd = onDragEnd;
    this._rotationDeg = 0;
    this.pointerEl = null;
    this.pointerShaftEl = null;
    this.pointerBulbEl = null;

    this.el = document.createElement("div");
    this.el.className = "rotary-encoder";

    if (scaleLabels) {
      this.el.classList.add("rotary-encoder-has-scale");
      const scaleEl = document.createElement("div");
      scaleEl.className = "rotary-scale-wrap";
      new RotaryScale(scaleEl, scaleLabels);
      this.el.appendChild(scaleEl);
    }

    this.knobEl = document.createElement("div");
    this.knobEl.className = "rotary-encoder-knob";
    this.knobEl.setAttribute("role", "button");
    if (pointerStyle === "toggle" && (pointer || scaleLabels)) {
      // Two independently-transformed pieces, not one rotated/skewed
      // shape: a shaft that scales from zero (so centered = "just a
      // circle", matching a real toggle pointing straight at the viewer)
      // and a bulb that only ever translates, so it never distorts into
      // an ellipse the way scaling or skewing a circle would.
      //
      // rotary-encoder-knob-toggle-base is a separate class purely for
      // sizing the round grey base smaller than the pen-style knobs (see
      // efis.css) — the lever's own shaft/bulb are fixed-px sized and
      // absolutely positioned, so shrinking this base doesn't touch them.
      this.knobEl.classList.add("rotary-encoder-knob-pointer", "rotary-encoder-knob-toggle-base");
      this.pointerShaftEl = document.createElement("span");
      this.pointerShaftEl.className = "rotary-encoder-pointer-toggle-shaft";
      this.pointerBulbEl = document.createElement("span");
      this.pointerBulbEl.className = "rotary-encoder-pointer-toggle-bulb";
      this.knobEl.append(this.pointerShaftEl, this.pointerBulbEl);
    } else if (pointer || scaleLabels) {
      this.knobEl.classList.add("rotary-encoder-knob-pointer");
      this.pointerEl = document.createElement("span");
      this.pointerEl.className = "rotary-encoder-pointer";
      this.knobEl.appendChild(this.pointerEl);
    } else if (label) {
      const labelEl = document.createElement("span");
      labelEl.className = "rotary-encoder-label";
      labelEl.textContent = label;
      this.knobEl.appendChild(labelEl);
    }

    this.el.appendChild(this.knobEl);
    container.appendChild(this.el);

    this._attachPointerHandlers();
  }

  /**
   * Sets the knob's position directly, bypassing the drag-step
   * accumulator — for detent selectors whose pointer should reflect a
   * real (or optimistic-but-known) position rather than free spin.
   *
   * "toggle" style: the shaft's own transform-origin is its left edge
   * (the knob's center), so scaleX(t) for t in [-1, 1] does exactly what
   * a toggle pointing at the viewer does — collapses to zero length at
   * t=0 (root, "OFF" — nothing to see but the bulb, right where the
   * shaft would start), and extends left or right as it leans away from
   * center. The bulb is a *separate* element that only ever translates by
   * the same fraction of the shaft's fixed length, never scaled itself,
   * so it stays a circle instead of being squashed by the shaft's own
   * scaleX (a transform on a parent affects everything painted inside
   * it, pseudo-elements included — that's why this needs two elements,
   * not one shape plus a ::after).
   */
  setAngle(deg) {
    this._rotationDeg = deg;
    if (this.pointerStyle === "toggle" && this.pointerShaftEl) {
      // Vertical centering is baked into each element's static CSS margin
      // (see efis.css), so these transforms only need to express the
      // left/right motion itself.
      const t = Math.max(-1, Math.min(1, deg / 90));
      this.pointerShaftEl.style.transform = `scaleX(${t})`;
      this.pointerBulbEl.style.transform = `translateX(${TOGGLE_SHAFT_LENGTH_PX * t}px)`;
    } else {
      this.knobEl.style.transform = `rotate(${deg}deg)`;
    }
  }

  _attachPointerHandlers() {
    let lastX = 0;
    let dragged = false;
    let accumulated = 0;

    this.knobEl.addEventListener("pointerdown", (ev) => {
      lastX = ev.clientX;
      accumulated = 0;
      dragged = false;
      this.knobEl.setPointerCapture(ev.pointerId);
      this.knobEl.classList.add("active");
      this.onDragStart?.();
    });

    this.knobEl.addEventListener("pointermove", (ev) => {
      if (!this.knobEl.hasPointerCapture(ev.pointerId)) return;
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      accumulated += dx;
      if (Math.abs(accumulated) > DRAG_THRESHOLD_PX) dragged = true;

      while (accumulated >= this.stepPx) {
        accumulated -= this.stepPx;
        this._step(1);
      }
      while (accumulated <= -this.stepPx) {
        accumulated += this.stepPx;
        this._step(-1);
      }
    });

    const endDrag = (ev) => {
      if (!this.knobEl.hasPointerCapture(ev.pointerId)) return;
      this.knobEl.releasePointerCapture(ev.pointerId);
      this.knobEl.classList.remove("active");
      if (!dragged) this.onPress?.();
      this.onDragEnd?.();
    };
    this.knobEl.addEventListener("pointerup", endDrag);
    this.knobEl.addEventListener("pointercancel", endDrag);
  }

  _step(direction) {
    if (this.trackDragVisually) {
      this._rotationDeg += direction * DEG_PER_STEP;
      this.knobEl.style.transform = `rotate(${this._rotationDeg}deg)`;
    }
    this.onStep?.(direction);
  }
}
