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
      ]
        .filter(Boolean)
        .join(" ");
    }
  }
}
