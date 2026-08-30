// Renders an McduAdapter's screen model (grid of styled characters) into DOM.
// One <span class="ch"> per cell, styled via CSS classes — see css/mcdu.css
// for the color/size/reverse/flash/underline rules.

export class McduScreenView {
  /**
   * @param {HTMLElement} rootEl container to render the grid into
   * @param {import('./mcdu-adapter.js').McduAdapter} adapter
   */
  constructor(rootEl, adapter) {
    this.root = rootEl;
    this.adapter = adapter;
    /** @type {HTMLElement[][]} */
    this._cellEls = [];
    this._build();

    adapter.onScreenUpdate = (line) => this._renderLine(line);
    adapter.onVertSlewChange = (up, down) => this._renderVertSlew(up, down);
  }

  _build() {
    this.root.innerHTML = "";
    this.root.classList.add("mcdu-screen");
    for (let line = 0; line < this.adapter.lines; line++) {
      const rowEl = document.createElement("div");
      rowEl.className = "mcdu-row";
      const cells = [];
      for (let col = 0; col < this.adapter.cols; col++) {
        const cellEl = document.createElement("span");
        cellEl.className = "ch color-white";
        cellEl.textContent = " ";
        rowEl.appendChild(cellEl);
        cells.push(cellEl);
      }
      this.root.appendChild(rowEl);
      this._cellEls.push(cells);
    }

    // Floating overlay for the up/down scroll-availability indicator (see
    // McduAdapter's onVertSlewChange) — a separate element positioned in
    // the screen's bottom-right corner rather than a grid cell, so it can
    // never collide with real row content (confirmed live 2026-08-30 that
    // it can: ToLiss's own last content row shows real right-aligned text
    // there too, e.g. "INSERT*"). Built once here rather than per-row
    // since it isn't tied to any particular row at all.
    const vertSlew = document.createElement("div");
    vertSlew.className = "mcdu-vert-slew";
    vertSlew.innerHTML = '<span class="mcdu-vert-slew-up"></span><span class="mcdu-vert-slew-down"></span>';
    this.root.appendChild(vertSlew);
    this._vertSlewEl = vertSlew;
    this._vertSlewUpEl = vertSlew.querySelector(".mcdu-vert-slew-up");
    this._vertSlewDownEl = vertSlew.querySelector(".mcdu-vert-slew-down");
  }

  _renderVertSlew(up, down) {
    this._vertSlewUpEl.textContent = up;
    this._vertSlewDownEl.textContent = down;
    // Hidden outright rather than left as an always-visible empty pill
    // when there's nothing to scroll — see .mcdu-vert-slew--none's own
    // comment in css/mcdu.css.
    this._vertSlewEl.classList.toggle("mcdu-vert-slew--none", up.trim() === "" && down.trim() === "");
  }

  renderAll() {
    for (let line = 0; line < this.adapter.lines; line++) this._renderLine(line);
  }

  _renderLine(line) {
    const cells = this.adapter.screen[line];
    const els = this._cellEls[line];
    if (!cells || !els) return;
    for (let col = 0; col < cells.length; col++) {
      const cell = cells[col];
      const el = els[col];
      el.textContent = cell.char;
      el.className = [
        "ch",
        `color-${cell.color}`,
        cell.large ? "large" : "small",
        cell.reverse ? "reverse" : "",
        cell.flash ? "flash" : "",
        cell.underline ? "underline" : "",
        cell.align ? `align-${cell.align}` : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
  }
}
