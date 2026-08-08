// Fits a fixed-size vendored panel element (<fcu-panel>/<efis-panel>) to
// its container. The vendored library's own `scale` attribute (see
// vendor/README.md) is read once when the element is inserted and has no
// live API to change afterward, so this works entirely on our side
// instead: a plain `transform: scale()` on the panel element, recomputed
// against its container's measured size whenever that size changes.
// css/mcdu.css's .scalable-panel is what actually reserves and centers
// that space — this only ever touches the transform.

const STORAGE_KEY = "mcdu.autoscale";

/**
 * @param {HTMLElement} container - the .scalable-panel wrapper around panelEl
 * @param {HTMLElement} panelEl - the <fcu-panel>/<efis-panel> element itself
 * @param {number} nativeWidth - the panel's native/unscaled pixel width
 * @param {number} nativeHeight - the panel's native/unscaled pixel height
 */
function fitToContainer(container, panelEl, nativeWidth, nativeHeight) {
  const scale = Math.max(0.3, Math.min(container.clientWidth / nativeWidth, container.clientHeight / nativeHeight));
  panelEl.style.transform = Number.isFinite(scale) ? `scale(${scale})` : "";
}

/**
 * Wires one shared on/off toggle button to fit-to-container scaling for
 * however many (container, panelEl, nativeWidth, nativeHeight) entries are
 * given — one shared preference for both FCU and EFIS, since only one of
 * the two is ever visible at a time (see index.html's autoscale-toggle
 * comment).
 * @param {HTMLButtonElement} toggleBtn
 * @param {{container: HTMLElement, panelEl: HTMLElement, nativeWidth: number, nativeHeight: number}[]} panels
 */
export function setupAutoscale(toggleBtn, panels) {
  let enabled = localStorage.getItem(STORAGE_KEY) !== "0"; // default on

  const applyAll = () => {
    for (const p of panels) {
      if (enabled) fitToContainer(p.container, p.panelEl, p.nativeWidth, p.nativeHeight);
      else p.panelEl.style.transform = "";
    }
    toggleBtn.classList.toggle("active", enabled);
    toggleBtn.title = enabled ? "Auto-scale: on (click to show native size)" : "Auto-scale: fit to window";
  };

  toggleBtn.addEventListener("click", () => {
    enabled = !enabled;
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
    applyAll();
  });

  // One observer per container rather than window's own resize event —
  // catches container-size changes that aren't window resizes too (the
  // top connection bar being hidden/shown via bar-toggle, a panel
  // switching visible, ...), and ResizeObserver already only fires when
  // the observed box's size has actually changed.
  const observer = new ResizeObserver(applyAll);
  for (const p of panels) observer.observe(p.container);

  applyAll();
}
