// Thin localStorage wrapper that degrades gracefully instead of throwing.
//
// Real failure mode, not theoretical: a live user report (a Windows/Chrome
// user, 2026-09-05) traced an "app doesn't do anything" symptom to their
// browser "blocking the cookies" — allowing them made it work again. This
// app has no cookies at all, but it does call raw localStorage.getItem/
// setItem in a dozen places, several of them (restoreTheme(), restorePanel(),
// restoreAircraft(), setupAutoscale(), ...) run unguarded at app.js's own
// module top level, on every page load, before anything else (including
// els.connectBtn's own addEventListener call) runs. A browser that blocks
// site storage — which is what "blocking cookies" means in practice on
// several privacy-focused setups, even though this app was never asking for
// actual cookies — makes those calls throw a SecurityError, which (per
// app.js's own comment on a structurally identical past incident, a
// ReferenceError in the same spot) aborts the rest of that module's
// top-level code entirely: every later addEventListener() call, including
// the Connect button's, silently never happens. That's indistinguishable
// from "the app just doesn't respond" until storage access comes back.
// These two functions turn that into a graceful "preferences don't persist
// this session" instead.
export function storageGet(key, fallback = null) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Best-effort — see this module's own top comment.
  }
}
