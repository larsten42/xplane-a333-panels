// Fits a fixed-size vendored panel element (<fcu-panel>/<efis-panel>) to
// its container. The vendored library's own `scale` attribute (see
// vendor/README.md) is read once when the element is inserted and has no
// live API to change afterward, so this works entirely on our side
// instead: a plain `transform: scale()` on the panel element, recomputed
// against its container's measured size whenever that size changes.
// css/mcdu.css's .scalable-panel is what actually reserves and centers
// that space — this only ever touches the transform.
//
// Two sizing modes, since "fit" means something different depending on
// whether the container holds one panel or several stacked ones:
//   - "fill" (default): fit both dimensions to the container, which grows
//     to claim all available space (flex:1 in CSS) — right for a single
//     panel that's the only thing on screen (EFIS/FCU/Radio).
//   - "content": fit *width* only, then size the container itself to the
//     scaled result (flex:0 0 auto in CSS) instead of letting it claim a
//     fixed share of space — right for panels meant to stack and scroll
//     as a group (RMP+ACP's two halves, see src/rmp-minimap.js), where
//     forcing each into an equal fixed share doesn't correspond to
//     anything real and "fit both dimensions" would just shrink both
//     panels to whatever the *shorter* one needs.

const STORAGE_KEY = "mcdu.autoscale";

/**
 * @param {HTMLElement} container - the .scalable-panel wrapper around panelEl
 * @param {HTMLElement} panelEl - the panel element itself
 * @param {number} nativeWidth - the panel's native/unscaled pixel width
 * @param {number} nativeHeight - the panel's native/unscaled pixel height
 * @param {"fill"|"content"} mode
 * @param {HTMLElement} [widthSource] - "content" mode only: the element to
 *   actually measure available width from (see setupAutoscale's own
 *   widthSource doc). Reading container.clientWidth instead would be
 *   self-referential — this function is the one that *sets* container's
 *   width below, so before that first write a "content" container has no
 *   inline width of its own yet and just shrinks to fit panelEl's native
 *   (unscaled) size, making the very first computed scale ~1 regardless
 *   of the real available space; every call after that would then just be
 *   reading back its own previous output, never correcting to the true
 *   available width. Confirmed live as the cause of RMP+ACP's autoscale
 *   silently not tracking the window at all.
 */
function fitToContainer(container, panelEl, nativeWidth, nativeHeight, mode, widthSource) {
  if (mode === "content") {
    const availableWidth = (widthSource ?? container).clientWidth;
    const scale = Math.max(0.3, availableWidth / nativeWidth);
    panelEl.style.transform = Number.isFinite(scale) ? `scale(${scale})` : "";
    if (Number.isFinite(scale)) {
      container.style.width = `${nativeWidth * scale}px`;
      container.style.height = `${nativeHeight * scale}px`;
    }
    return;
  }
  const scale = Math.max(0.3, Math.min(container.clientWidth / nativeWidth, container.clientHeight / nativeHeight));
  panelEl.style.transform = Number.isFinite(scale) ? `scale(${scale})` : "";
}

/**
 * Wires one shared on/off toggle button to fit-to-container scaling for
 * however many (container, panelEl, nativeWidth, nativeHeight, mode)
 * entries are given — one shared preference across every autoscaled
 * panel, since only one panel is ever visible at a time (see index.html's
 * autoscale-toggle comment).
 * @param {HTMLButtonElement} toggleBtn
 * @param {{container: HTMLElement, panelEl: HTMLElement, nativeWidth: number, nativeHeight: number, mode?: "fill"|"content", widthSource?: HTMLElement}[]} panels
 *   `widthSource`, "content" mode only: the element whose width actually
 *   reflects available space. Once a "content" container gets its own
 *   width set by this file, observing *it* for resize would only ever
 *   catch changes this file caused itself, not the parent shrinking or
 *   growing — widthSource lets the real ancestor (e.g. the scrollable
 *   stack these containers live in) be observed instead. Defaults to
 *   `container`, which is exactly right for "fill" mode.
 * @returns {() => void} refresh - recomputes every panel's fit immediately,
 *   for a size-relevant change this file's own ResizeObserver won't catch
 *   on its own: a "content"-mode container's own hidden/visible toggle
 *   (src/rmp-minimap.js) doesn't change widthSource's size at all, so
 *   nothing here would otherwise notice a previously-hidden panel coming
 *   back needs a fresh scale (its last-known one could be stale, or the
 *   0.3-floor fallback computed from clientWidth:0 while it was hidden).
 */
export function setupAutoscale(toggleBtn, panels) {
  let enabled = localStorage.getItem(STORAGE_KEY) !== "0"; // default on

  const applyAll = () => {
    for (const p of panels) {
      const mode = p.mode ?? "fill";
      if (enabled) {
        fitToContainer(p.container, p.panelEl, p.nativeWidth, p.nativeHeight, mode, p.widthSource);
      } else {
        p.panelEl.style.transform = "";
        if (mode === "content") {
          p.container.style.width = `${p.nativeWidth}px`;
          p.container.style.height = `${p.nativeHeight}px`;
        }
      }
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
  for (const p of panels) observer.observe(p.widthSource ?? p.container);

  applyAll();
  return applyAll;
}
