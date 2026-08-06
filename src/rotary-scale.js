// The printed scale around a detent-selector knob: an arc spanning from
// the first to the last position, with a tick mark and label at each one.
// SVG rather than positioned <div>s — an arbitrary partial-circle arc
// isn't something plain CSS draws cleanly, and having the arc, ticks, and
// labels all governed by the same trig in one place keeps them honest
// with each other.

import { angleForIndex, pointAt as pointAtOrigin } from "./detent-angles.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export class RotaryScale {
  /**
   * @param {HTMLElement} container
   * @param {string[]} labels position labels, in index order
   * @param {number} [size] SVG canvas size in px (square)
   */
  constructor(container, labels, size = 180) {
    // size needs real headroom beyond labelRadius, not just outer CSS
    // spacing around the SVG — the SVG clips its own content at its own
    // width/height regardless of how much room the surrounding page gives
    // it. 140 wasn't enough: "PLAN"/"160" (the labels nearest due east,
    // where text-anchor="middle" pushes half the text past labelRadius)
    // were getting cut to "PLA"/"16" by the SVG's own edge.
    const cx = size / 2;
    const cy = size / 2;
    const arcRadius = 40; // sits closer to the 32px-radius knob than before
    const tickInner = arcRadius; // ticks start right at the arc and extend outward only, not straddling it
    const tickOuter = 49;
    const labelRadius = 63;

    const pointAt = (radius, angleDeg) => pointAtOrigin(cx, cy, radius, angleDeg);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "rotary-scale");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);

    const startAngle = angleForIndex(0);
    const endAngle = angleForIndex(labels.length - 1);
    const [sx, sy] = pointAt(arcRadius, startAngle);
    const [ex, ey] = pointAt(arcRadius, endAngle);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;

    const arc = document.createElementNS(SVG_NS, "path");
    arc.setAttribute("d", `M ${sx} ${sy} A ${arcRadius} ${arcRadius} 0 ${largeArc} 1 ${ex} ${ey}`);
    arc.setAttribute("class", "rotary-scale-arc");
    svg.appendChild(arc);

    labels.forEach((label, index) => {
      const angle = angleForIndex(index);

      const [tx1, ty1] = pointAt(tickInner, angle);
      const [tx2, ty2] = pointAt(tickOuter, angle);
      const tick = document.createElementNS(SVG_NS, "line");
      tick.setAttribute("x1", String(tx1));
      tick.setAttribute("y1", String(ty1));
      tick.setAttribute("x2", String(tx2));
      tick.setAttribute("y2", String(ty2));
      tick.setAttribute("class", "rotary-scale-tick");
      svg.appendChild(tick);

      const [lx, ly] = pointAt(labelRadius, angle);
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(lx));
      text.setAttribute("y", String(ly));
      text.setAttribute("class", "rotary-scale-label");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "middle");
      text.textContent = label;
      svg.appendChild(text);
    });

    container.appendChild(svg);
  }
}
