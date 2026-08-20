// Floating "map" of RMP+ACP's two stacked halves (<rmp-panel> on top,
// <acp-panel> below, inside the scrollable #panel-rmp — see
// panel-autoscale.js's "content" mode and css/mcdu.css's
// .scalable-panel--stack for how the stack itself works). Exists for a
// narrow/tall viewport — a phone in portrait — where both halves at a
// readable scale don't comfortably fit on screen together: tapping a
// section shows/hides that half (at least one always stays visible, so
// there's never nothing to look at), and dragging anywhere on the map
// scrolls the stack, mapping the drag position directly to a scroll
// position the way clicking a spot on a minimap jumps a camera there,
// rather than a relative drag-to-pan gesture.
//
// Deliberately not wired through EfisAdapter or any X-Plane concept —
// this is pure layout/visibility UI, same category as panel-autoscale.js.

const STORAGE_KEY = "mcdu.rmpVisibility";
const CLICK_THRESHOLD_PX = 6; // below this, a pointerdown+up counts as a tap, not a drag

/**
 * @param {HTMLElement} mapEl - the .rmp-minimap root
 * @param {HTMLElement} scrollEl - the scrollable ancestor (#panel-rmp)
 * @param {{key: string, wrapper: HTMLElement, sectionEl: HTMLElement}[]} sections
 *   one entry per stacked half, top-to-bottom: `wrapper` is the
 *   .scalable-panel--stack div to show/hide, `sectionEl` is this half's
 *   own clickable rectangle inside the map.
 * @param {() => void} [refreshAutoscale] - panel-autoscale.js's own
 *   returned refresh function. A wrapper coming back from hidden doesn't
 *   change widthSource's size at all, so panel-autoscale's ResizeObserver
 *   has no way to notice it on its own — this is called right after
 *   un-hiding one so it gets a fresh scale immediately, not a stale one
 *   from whenever it was last actually visible.
 */
export function setupRmpMinimap(mapEl, scrollEl, sections, refreshAutoscale) {
  const viewportEl = mapEl.querySelector("[data-map-viewport]");
  const visible = loadVisibility();

  function loadVisibility() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    } catch {
      // fall through to the all-visible default below
    }
    const state = {};
    for (const s of sections) state[s.key] = saved?.[s.key] ?? true;
    // Never restore/apply a state with nothing visible — could happen if
    // localStorage was hand-edited, or a future version adds/removes a
    // section and the saved keys no longer line up.
    if (Object.values(state).every((v) => !v)) for (const s of sections) state[s.key] = true;
    return state;
  }

  function saveVisibility() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visible));
  }

  function applyVisibility() {
    for (const s of sections) {
      const isVisible = visible[s.key];
      s.wrapper.hidden = !isVisible;
      s.sectionEl.classList.toggle("visible", isVisible);
      s.sectionEl.classList.toggle("hidden", !isVisible);
    }
  }

  function toggleSection(key) {
    const wouldHide = visible[key]; // true means this tap is trying to hide an already-visible section
    if (wouldHide && Object.values(visible).filter(Boolean).length <= 1) {
      // Only one section left visible and it's this one — refuse, with a
      // quick pulse so the tap still reads as "acknowledged" rather than
      // silently doing nothing.
      const el = sections.find((s) => s.key === key)?.sectionEl;
      el?.classList.remove("locked-pulse");
      el?.offsetWidth; // restart the CSS animation if it's already mid-pulse
      el?.classList.add("locked-pulse");
      return;
    }
    visible[key] = !visible[key];
    saveVisibility();
    applyVisibility();
    refreshAutoscale?.();
    updateViewportIndicator();
  }

  function updateViewportIndicator() {
    const max = scrollEl.scrollHeight - scrollEl.clientHeight;
    const mapHeight = mapEl.clientHeight;
    if (max <= 0) {
      viewportEl.style.top = "0";
      viewportEl.style.height = "100%";
      return;
    }
    const topRatio = scrollEl.scrollTop / scrollEl.scrollHeight;
    const heightRatio = scrollEl.clientHeight / scrollEl.scrollHeight;
    viewportEl.style.top = `${topRatio * mapHeight}px`;
    viewportEl.style.height = `${Math.max(6, heightRatio * mapHeight)}px`;
  }

  function scrollToPointer(clientY) {
    const rect = mapEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const max = scrollEl.scrollHeight - scrollEl.clientHeight;
    if (max > 0) scrollEl.scrollTop = ratio * max;
  }

  let dragging = false;
  let dragMoved = false;
  let startY = 0;
  let startSection = null;

  mapEl.addEventListener("pointerdown", (e) => {
    dragging = true;
    dragMoved = false;
    startY = e.clientY;
    // Captured here, not read from the pointerup event below: once
    // setPointerCapture() is in effect, every subsequent event for this
    // pointer reports mapEl itself as e.target (not whatever's visually
    // underneath), regardless of where the finger actually is — reading
    // e.target.closest("[data-map-section]") on pointerup would always
    // resolve against mapEl's own ancestors, which never includes a
    // section, silently breaking every tap. e.target is still accurate
    // right here, before capture takes hold.
    startSection = e.target.closest("[data-map-section]");
    mapEl.setPointerCapture(e.pointerId);
  });
  mapEl.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    if (!dragMoved && Math.abs(e.clientY - startY) > CLICK_THRESHOLD_PX) dragMoved = true;
    if (dragMoved) scrollToPointer(e.clientY);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    if (mapEl.hasPointerCapture(e.pointerId)) mapEl.releasePointerCapture(e.pointerId);
    if (!dragMoved && startSection) toggleSection(startSection.dataset.mapSection);
  };
  mapEl.addEventListener("pointerup", endDrag);
  mapEl.addEventListener("pointercancel", endDrag);

  scrollEl.addEventListener("scroll", updateViewportIndicator, { passive: true });
  // Three things can change how much there is to scroll: the viewport
  // itself resizing (window resize, the connection bar hiding/showing),
  // and either wrapper's own scaled size changing (autoscale recomputing
  // on resize, or the FIT/native-size toggle) — the wrappers' sizes are
  // explicitly set by panel-autoscale.js's "content" mode, so observing
  // them (rather than #panel-rmp, whose own box doesn't change just
  // because its scrollable content did) catches that reliably. Visibility
  // toggles are handled directly in toggleSection() instead — hiding a
  // wrapper doesn't resize the one still showing, so there's nothing here
  // that would otherwise notice.
  const observer = new ResizeObserver(updateViewportIndicator);
  observer.observe(scrollEl);
  for (const s of sections) observer.observe(s.wrapper);

  applyVisibility();
  updateViewportIndicator();
}
