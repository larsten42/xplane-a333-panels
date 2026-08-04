// Builds keypad DOM from a profile and wires presses to an McduAdapter.
// Two layouts are supported: the line-select rails down each side of the
// screen (renderLskColumn) and an explicit row/column grid for everything
// else (renderLayoutGrid, driven by profile.keypadLayout — see
// config/profiles/default-fms.json), laid out to match a photo of the real
// X-Plane default Airbus MCDU bezel.
//
// Buttons whose command didn't resolve against the live sim (see
// McduAdapter#unresolvedKeys) are rendered disabled with a tooltip, rather
// than silently doing nothing when tapped — a wrong guess in the profile
// should be obvious, not mysterious.
//
// attachKeyboardInput() additionally lets a physical keyboard drive the
// alpha/numeric keys, for testing without a touchscreen.

// A physical line-select key is fixed to a specific pair of screen rows —
// a label row and, directly below it, the data row it selects (e.g. LSK1
// sits beside "CO RTE" / "EFHKEETN01" on the INIT page). A naive "equal
// slices of the rail" mapping drifts from the real positions enough to
// notice, so these two constants — L1/R1's vertical center and the spacing
// between consecutive centers, both as a fraction of the rail's total
// height — are tuned by eye against the running app rather than derived
// exactly. Adjust and reload to retune: FIRST_CENTER shifts the whole rail
// up/down, STEP stretches/compresses the spacing between buttons.
//
// Originally derived against a 16-row screen; rescaled by 16/14 when
// profile.screen.lines dropped to 14 (X-Plane exposes 16 dataref slots but
// the real display only ever uses 14) so the same absolute row positions
// are hit on the now-shorter rail. Retune from scratch if
// profile.screen.lines changes again.
const LSK_FIRST_CENTER_FRACTION = 0.2143;
const LSK_STEP_FRACTION = 0.1378;
// Flat pixel nudge on top of the percentage above — a fixed px shift, not a
// fraction, since it's correcting a small constant offset (bezel padding,
// roughly) that doesn't scale with screen height the way row position does.
const LSK_TOP_OFFSET_PX = -10;

export class McduKeypad {
  /**
   * @param {import('./mcdu-adapter.js').McduAdapter} adapter
   */
  constructor(adapter) {
    this.adapter = adapter;
    /** @type {Map<string, HTMLButtonElement>} */
    this._buttons = new Map();
  }

  /**
   * Render one profile key group ("line_select_left"/"line_select_right")
   * as the vertical rail beside the screen, each button's vertical center
   * computed from its position (L1/R1 first, ...) — see the LSK_* constants
   * above — and placed via absolute positioning (percentage `top`, easier
   * to fine-tune than integer CSS grid lines).
   * @param {string} groupKey key into profile.keys
   * @param {HTMLElement} container
   */
  renderLskColumn(groupKey, container) {
    const group = this.adapter.profile.keys[groupKey];
    if (!group) {
      console.warn(`[mcdu-keypad] unknown key group "${groupKey}"`);
      return;
    }
    container.classList.add("mcdu-lsk-column");
    Object.keys(group).forEach((keyName, i) => {
      const n = i + 1; // 1-indexed line-select position, L1/R1 first
      const btn = this._buildButton(keyName);
      const centerFraction = LSK_FIRST_CENTER_FRACTION + (n - 1) * LSK_STEP_FRACTION;
      btn.style.top = `calc(${centerFraction * 100}% + ${LSK_TOP_OFFSET_PX}px)`;
      container.appendChild(btn);
    });
  }

  /**
   * Render one keypadLayout block (profile.keypadLayout.functionBlock /
   * .utilityBlock / .numericBlock / .alphaBlock — each a clean rectangle,
   * styled and positioned independently in CSS as its own key cluster
   * rather than one grid padded with filler cells to force a shape it
   * isn't): a 2D array of key names, placed by explicit CSS grid
   * row/column. Two non-key values: "" is a real, visible keycap on the
   * bezel that's just unlabeled and inert (e.g. next to AIRPORT); null is
   * genuine empty bezel space within the block, rendered invisible.
   * @param {{ cols: number, rows: (string|null)[][] }} layout
   * @param {HTMLElement} container
   */
  renderLayoutGrid(layout, container) {
    container.classList.add("mcdu-layout-grid");
    container.style.setProperty("--mcdu-grid-cols", String(layout.cols));
    layout.rows.forEach((row, rowIndex) => {
      row.forEach((keyName, colIndex) => {
        let el;
        if (keyName === null) {
          el = document.createElement("div");
          el.className = "mcdu-key-blank";
        } else if (keyName === "") {
          el = document.createElement("div");
          el.className = "mcdu-key-decorative";
        } else {
          el = this._buildButton(keyName);
        }
        el.style.gridRow = String(rowIndex + 1);
        el.style.gridColumn = String(colIndex + 1);
        container.appendChild(el);
      });
    });
  }

  _buildButton(keyName) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mcdu-key";
    btn.textContent = keyLabel(keyName);
    btn.dataset.key = keyName;
    // pointerdown, not click: lower latency and one event for mouse+touch+pen alike
    btn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      btn.classList.add("pressed");
      this.adapter.pressKey(keyName);
    });
    const release = () => btn.classList.remove("pressed");
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
    this._buttons.set(keyName, btn);
    return btn;
  }

  /** Call after adapter.connect() resolves to grey out keys with no live command. */
  refreshAvailability() {
    for (const [keyName, btn] of this._buttons) {
      const available = this.adapter.isKeyAvailable(keyName);
      btn.disabled = !available;
      btn.title = available ? "" : "Command not found on this sim — see console, or tools/smoke-test.mjs";
      btn.classList.toggle("unresolved", !available);
    }
  }

  /**
   * Let a physical keyboard drive the alpha (A-Z) and numeric (0-9) keys —
   * handy for testing without reaching for a touchscreen. Ignored while
   * focus is in a form control (typing "192" into the host field shouldn't
   * also press "1", "9", "2") or while a modifier is held (so browser/OS
   * shortcuts still work). Returns a cleanup function; call it before
   * attaching again (e.g. on reconnect) to avoid stacking up listeners
   * bound to a stale adapter.
   * @param {EventTarget} [target]
   * @returns {() => void}
   */
  attachKeyboardInput(target = window) {
    const press = (keyName) => {
      const btn = this._buttons.get(keyName);
      if (!btn || btn.disabled) return null;
      btn.classList.add("pressed");
      this.adapter.pressKey(keyName);
      return btn;
    };

    const onKeyDown = (ev) => {
      if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (isTypingIntoFormControl(ev.target)) return;
      const keyName = physicalKeyToLogicalKey(ev.key);
      if (!keyName) return;
      if (press(keyName)) ev.preventDefault();
    };
    const onKeyUp = (ev) => {
      const keyName = physicalKeyToLogicalKey(ev.key);
      if (!keyName) return;
      this._buttons.get(keyName)?.classList.remove("pressed");
    };

    target.addEventListener("keydown", onKeyDown);
    target.addEventListener("keyup", onKeyUp);
    return () => {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
    };
  }
}

function physicalKeyToLogicalKey(key) {
  if (/^[0-9]$/.test(key)) return key; // matches numericBlock's "0".."9"
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase(); // matches alphaBlock's "A".."Z"
  if (key === ".") return "PERIOD";
  if (key === "/") return "SLASH";
  if (key === "-") return "MINUS"; // the +/- sign toggle, not a literal minus sign
  if (key === "Backspace") return "CLR";
  return null;
}

function isTypingIntoFormControl(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(target?.isContentEditable);
}

function keyLabel(keyName) {
  // A few logical names get friendlier button text than their raw key id —
  // mostly matching the real keycap text, which doesn't always match the
  // underlying command name (e.g. INIT's command is "index").
  const overrides = {
    SP: "SP",
    PERIOD: ".",
    MINUS: "+/-",
    SLASH: "/",
    OVERFLY: "OVFY\nΔ",
    CLR: "CLR",
    AIRPORT: "AIR\nPORT",
    DIR_INTC: "DIR",
    INDEX: "INIT",
    DEP_ARR: "DEP\nARR",
    ATC_COMM: "ATC\nCOMM",
    FUEL_PRED: "FUEL\nPRED",
    SEC_FPLN: "SEC\nF-PLN",
    FPLN: "F-PLN",
    NAVRAD: "NAV\nRAD",
    MENU: "MCDU\nMENU",
    CDU_POPUP: "POP UP",
    CDU_POPOUT: "POP OUT",
    PREV: "◀",
    NEXT: "▶",
    UP: "▲",
    DOWN: "▼",
    // Real line-select keys aren't printed "L1"/"R1" — position along the
    // bezel already says which line they select — just an unlabeled dash.
    // Left empty and drawn as a CSS bar (see .mcdu-lsk-column .mcdu-key::before
    // in mcdu.css) rather than a dash character: a font glyph can't reliably
    // hit an exact percentage of the button's width.
    L1: "", L2: "", L3: "", L4: "", L5: "", L6: "",
    R1: "", R2: "", R3: "", R4: "", R5: "", R6: "",
  };
  return overrides[keyName] ?? keyName;
}
