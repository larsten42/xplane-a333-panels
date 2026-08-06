// A short arc with a tick + label at each end, drawn around a knob for a
// 2-way direct-set toggle (e.g. baro's in Hg / hPa unit selector) — same
// visual language as RotaryScale (arc + tick + label per position), just a
// 2-position stub instead of a wide multi-detent sweep, plus a small
// pointer that swings between the two ends to show which one is currently
// active (standing in for the real hardware's small coaxial ring/knob).
//
// Each label is its own click target that *sets* its side's value rather
// than flipping whatever the current state is — clicking "in Hg" always
// selects in Hg — so onSelect(side) fires with which side was clicked.

import { pointAt as pointAtOrigin } from "./detent-angles.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export class ArcToggle {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {string} opts.startLabel text at the start of the arc (west side)
   * @param {string} opts.endLabel text at the end of the arc (east side)
   * @param {number} [opts.startAngle] degrees, 0 = north, clockwise positive (default -30, i.e. "330")
   * @param {number} [opts.endAngle] degrees (default 30)
   * @param {(side: "start" | "end") => void} [opts.onSelect]
   * @param {number} [opts.size] SVG canvas size in px (square)
   */
  constructor(container, { startAngle = -30, endAngle = 30, startLabel, endLabel, onSelect, size = 160 } = {}) {
    const cx = size / 2;
    const cy = size / 2;
    const arcRadius = 44;
    const tickInner = arcRadius;
    const tickOuter = 54;
    const labelRadius = 68;
    const pointerRadius = 34; // between the knob's own edge and the arc

    const pointAt = (radius, angleDeg) => pointAtOrigin(cx, cy, radius, angleDeg);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "arc-toggle");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);

    const [sx, sy] = pointAt(arcRadius, startAngle);
    const [ex, ey] = pointAt(arcRadius, endAngle);
    const arc = document.createElementNS(SVG_NS, "path");
    arc.setAttribute("d", `M ${sx} ${sy} A ${arcRadius} ${arcRadius} 0 0 1 ${ex} ${ey}`);
    arc.setAttribute("class", "arc-toggle-arc");
    svg.appendChild(arc);

    for (const angle of [startAngle, endAngle]) {
      const [tx1, ty1] = pointAt(tickInner, angle);
      const [tx2, ty2] = pointAt(tickOuter, angle);
      const tick = document.createElementNS(SVG_NS, "line");
      tick.setAttribute("x1", String(tx1));
      tick.setAttribute("y1", String(ty1));
      tick.setAttribute("x2", String(tx2));
      tick.setAttribute("y2", String(ty2));
      tick.setAttribute("class", "arc-toggle-tick");
      svg.appendChild(tick);
    }

    this.startLabelEl = null;
    this.endLabelEl = null;
    for (const [angle, label, side] of [
      [startAngle, startLabel, "start"],
      [endAngle, endLabel, "end"],
    ]) {
      const [lx, ly] = pointAt(labelRadius, angle);
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(lx));
      text.setAttribute("y", String(ly));
      text.setAttribute("class", "arc-toggle-label");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "middle");
      text.textContent = label;
      if (onSelect) {
        text.classList.add("arc-toggle-label-clickable");
        text.addEventListener("click", () => onSelect(side));
      }
      svg.appendChild(text);
      if (side === "start") this.startLabelEl = text;
      else this.endLabelEl = text;
    }

    // Small arrowhead, pointing outward at rest (straight up/north), swung
    // left or right by rotating the whole shape around the center — same
    // rotate-around-center convention pointAt() itself uses, so -30/30 here
    // land exactly on the two ticks above.
    this._pointerEl = document.createElementNS(SVG_NS, "polygon");
    this._pointerEl.setAttribute(
      "points",
      `${cx},${cy - pointerRadius - 5} ${cx - 4},${cy - pointerRadius + 5} ${cx + 4},${cy - pointerRadius + 5}`
    );
    this._pointerEl.setAttribute("class", "arc-toggle-pointer");
    svg.appendChild(this._pointerEl);

    this._cx = cx;
    this._cy = cy;
    this._startAngle = startAngle;
    this._endAngle = endAngle;

    container.appendChild(svg);
  }

  /** Swings the pointer to whichever side is currently the active unit. */
  setActive(side) {
    const angle = side === "start" ? this._startAngle : this._endAngle;
    this._pointerEl.setAttribute("transform", `rotate(${angle} ${this._cx} ${this._cy})`);
  }
}
