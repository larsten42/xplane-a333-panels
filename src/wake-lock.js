// Best-effort "keep the screen on while connected" via the Screen Wake
// Lock API (https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API),
// supported in Chrome/Android — the platform this app targets (see
// ARCHITECTURE.md's "Progressive Web App" section). The spec restricts it
// to a secure context (HTTPS, or the literal localhost origin), which this
// app deliberately doesn't have — a tablet always reaches it over the
// host's LAN IP, never localhost, the same reason full PWA install doesn't
// work here either. acquire() is written defensively so an unsupported/
// refused request just silently no-ops rather than throwing; the device's
// own screen-timeout setting is still the fallback either way.
//
// A wake lock is also automatically released whenever the tab loses
// visibility (switching apps, locking the device), so this re-acquires on
// visibilitychange while still "wanted" rather than only requesting once.

let wakeLock = null;
let wanted = false;

async function acquire() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (err) {
    console.warn("[wake-lock] couldn't acquire a screen wake lock:", err.message);
  }
}

document.addEventListener("visibilitychange", () => {
  if (wanted && document.visibilityState === "visible" && !wakeLock) acquire();
});

/** Call once a connection is established. */
export function startWakeLock() {
  wanted = true;
  acquire();
}

/** Call on disconnect/error — stops re-acquiring and releases the current lock, if any. */
export function stopWakeLock() {
  wanted = false;
  const lock = wakeLock;
  wakeLock = null;
  lock?.release();
}
