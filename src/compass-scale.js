// The printed ring around the bearing-pointer selector (a left/middle/
// right 3-position switch: ADF, OFF, VOR): a full circle (unlike
// RotaryScale's partial arc — the 4th quadrant is used too) with a tick +
// label at each of the 3 real positions plus the switch's identifying
// number.
//
// Matches the real panel's print layout: ADF/ID/VOR read left-to-right
// along the top (west/north/east), with OFF printed below (south) —
// confirmed live 2026-08-06, not just "whichever quadrant was left over".

import { pointAt as pointAtOrigin } from "./detent-angles.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export class CompassScale {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {string} opts.idLabel shown at the south position, opposite OFF (e.g. "1" or "2")
   * @param {number} [opts.size] SVG canvas size in px (square)
   */
  constructor(container, { idLabel, size = 120 } = {}) {
    const cx = size / 2;
    const cy = size / 2;
    const ringRadius = 20; // half of the original 40
    const tickInner = ringRadius;
    const tickOuter = 27;
    const legendRadius = 38;

    const pointAt = (radius, angleDeg) => pointAtOrigin(cx, cy, radius, angleDeg);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "compass-scale");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);

    const ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("cx", String(cx));
    ring.setAttribute("cy", String(cy));
    ring.setAttribute("r", String(ringRadius));
    ring.setAttribute("class", "compass-scale-ring");
    svg.appendChild(ring);

    const legend = [
      { angle: -90, label: "ADF" },
      { angle: 0, label: idLabel },
      { angle: 90, label: "VOR" },
      { angle: 180, label: "OFF" },
    ];
    for (const { angle, label } of legend) {
      const [tx1, ty1] = pointAt(tickInner, angle);
      const [tx2, ty2] = pointAt(tickOuter, angle);
      const tick = document.createElementNS(SVG_NS, "line");
      tick.setAttribute("x1", String(tx1));
      tick.setAttribute("y1", String(ty1));
      tick.setAttribute("x2", String(tx2));
      tick.setAttribute("y2", String(ty2));
      tick.setAttribute("class", "compass-scale-tick");
      svg.appendChild(tick);

      const [lx, ly] = pointAt(legendRadius, angle);
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(lx));
      text.setAttribute("y", String(ly));
      text.setAttribute("class", "compass-scale-legend-label");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "middle");
      text.textContent = label;
      svg.appendChild(text);
    }

    container.appendChild(svg);
  }
}
