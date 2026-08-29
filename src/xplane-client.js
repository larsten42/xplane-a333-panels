// Thin wrapper around X-Plane 12's built-in Web API (REST + WebSocket).
// See docs/xplane-web-api-notes.md for the endpoint/message reference this
// was written against.
//
// Responsibilities of this module, deliberately kept generic (no MCDU
// knowledge here — that lives in mcdu-adapter.js):
//   - resolve dataref/command *names* to the numeric ids the API uses
//   - subscribe to dataref updates over the websocket and hand decoded
//     values to a callback
//   - write datarefs and fire commands
//   - base64 <-> bytes plumbing, since array/string datarefs are
//     base64-encoded on the wire

const API_VERSION = "v2"; // datarefs + commands; this app doesn't need v3 flight endpoints

export class XPlaneClient {
  /**
   * @param {string} host
   * @param {number} port
   */
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.restBase = `http://${host}:${port}/api/${API_VERSION}`;
    this.capabilitiesUrl = `http://${host}:${port}/api/capabilities`;
    this.wsUrl = `ws://${host}:${port}/api/${API_VERSION}`;

    /** @type {WebSocket | null} */
    this.ws = null;
    this._nextReqId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this._pending = new Map();
    /** @type {Map<number, Set<(value: any) => void>>} callback sets keyed by dataref id — a Set, not one slot, because two profile entries can legitimately share a ref (e.g. AP1/AP2 both reading autopilot_12_status via litValue) and a single slot would let the second subscriber silently clobber the first's callback */
    this._datarefListeners = new Map();
    /** @type {Map<number, number[]|undefined>} the `index` each dataref id was originally subscribed with (or undefined for a whole-dataref subscribe) — replayed by _resubscribeAll() after a reconnect, since subscribeDataref() itself only sends the wire request on a dataref's *first* subscriber and every id here already has one. */
    this._datarefIndexById = new Map();
    /** @type {Map<number, Set<(isActive: boolean) => void>>} callback sets keyed by command id, same reasoning as _datarefListeners */
    this._commandListeners = new Map();

    this.onStatusChange = null; // (status: 'connecting'|'open'|'closed'|'error', detail?) => void
    // (level: 'info'|'warn'|'error', message: string) => void — a running
    // narrative of *why*, for the client-side diagnostics panel (app.js).
    // onStatusChange alone only says "closed"; this is where "closed
    // (code 1006, X-Plane's connection reset)" or "reconnecting in 4s
    // (attempt 3)" goes, none of which onStatusChange's terse state enum
    // can carry.
    this.onDiagnostic = null;

    // Auto-reconnect state. A dropped connection is the normal case here
    // (see tools/mcdu-server.js's proxy — the tablet's WS, the proxy's own
    // upstream WS to X-Plane, and the WiFi link in between are all things
    // that can blip independently), and until this there was no recovery
    // but the user noticing and clicking the "Reconnect" button — see
    // app.js's own comment on that button being relabeled, never an
    // automatic retry. closeSocket() is the only thing that suppresses
    // this (sets _explicitClose so a deliberate close doesn't trigger a
    // retry loop) — and closeSocket() is not currently called anywhere in
    // this app, so in practice every close reconnects.
    this._explicitClose = false;
    this._lastPanelHint = undefined;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
  }

  // ---------------------------------------------------------------- REST --

  async getCapabilities() {
    const res = await fetch(this.capabilitiesUrl);
    if (!res.ok) throw new Error(`capabilities: HTTP ${res.status}`);
    const body = await res.json();
    return body.data ?? body;
  }

  /**
   * Resolve exact dataref names to ids. Uses filter[name] (exact match,
   * repeatable) so this only works for names you already know precisely.
   * @param {string[]} names
   * @returns {Promise<Map<string, number>>} name -> id, missing names simply absent
   */
  async resolveDatarefIds(names) {
    return this._resolveIds("datarefs", names);
  }

  /** @param {string[]} names @returns {Promise<Map<string, number>>} */
  async resolveCommandIds(names) {
    return this._resolveIds("commands", names);
  }

  /**
   * Resolves by fetching the full list once (cached per XPlaneClient
   * instance) and filtering client-side, rather than a batched
   * `filter[name]` REST query — X-Plane 404s the *entire* request if even
   * one name in a multi-filter query doesn't match (confirmed live
   * 2026-08-06: one valid + one invalid name together → 404, not partial
   * results), which would otherwise take down every other name in the
   * same batch too. A profile with one wrong/outdated name is exactly the
   * case this needs to degrade gracefully from — see README "Known
   * limitations" on unresolved keys being disabled, not fatal.
   */
  async _resolveIds(kind, names) {
    const map = new Map();
    if (names.length === 0) return map;
    const wanted = new Set(names);
    this._allCache ??= {};
    this._allCache[kind] ??= await this.listAll(kind);
    for (const entry of this._allCache[kind]) {
      if (wanted.has(entry.name)) map.set(entry.name, entry.id);
    }

    // Names the bulk list didn't have: X-Plane sometimes accepts a
    // single-name filter query for a name that never appears in the bulk
    // list under that exact string — confirmed live 2026-08-08,
    // sim/autopilot/speed_hold resolves this way to the same id as
    // sim/autopilot/level_change (an apparent legacy alias for the same
    // underlying command, invisible in the bulk listing but real to the
    // single-name lookup — a proper 404 on an actually-invalid name, 200
    // on this). Tried one at a time rather than batched, since a
    // multi-name filter 404s entirely if even one name in it is invalid
    // (see this method's own doc above) — single-name queries don't have
    // that failure mode.
    for (const name of names) {
      if (map.has(name)) continue;
      const res = await fetch(`${this.restBase}/${kind}?filter[name]=${encodeURIComponent(name)}`);
      if (!res.ok) continue;
      const body = await res.json();
      const id = body.data?.[0]?.id;
      if (id != null) map.set(name, id);
    }
    return map;
  }

  /** Fetch the *entire* dataref or command list. Large; not cached itself (see _resolveIds for the cached path used by name resolution). */
  async listAll(kind) {
    const res = await fetch(`${this.restBase}/${kind}`);
    if (!res.ok) throw new Error(`list ${kind}: HTTP ${res.status}`);
    const body = await res.json();
    return body.data ?? [];
  }

  async getDatarefValueOnce(id) {
    const res = await fetch(`${this.restBase}/datarefs/${id}/value`);
    if (!res.ok) throw new Error(`get dataref ${id}: HTTP ${res.status}`);
    const body = await res.json();
    return body.data;
  }

  // ------------------------------------------------------------ Socket ----

  /**
   * @param {string} [panelHint] - which panel was selected when connecting
   *   (mcdu/efis/fcu), purely for the operator console's client list (see
   *   tools/mcdu-server.js) — not meaningful to X-Plane itself, and since
   *   all panels share this one connection, it reflects the panel active
   *   at connect time, not live switches afterward.
   */
  connectSocket(panelHint) {
    this._lastPanelHint = panelHint;
    this._explicitClose = false;
    this._clearReconnectTimer();
    return new Promise((resolve, reject) => {
      const url = panelHint ? `${this.wsUrl}?panel=${encodeURIComponent(panelHint)}` : this.wsUrl;
      const ws = new WebSocket(url);
      this.ws = ws;
      this._setStatus("connecting");

      ws.addEventListener("open", () => {
        const wasReconnect = this._reconnectAttempt > 0;
        this._reconnectAttempt = 0;
        this._setStatus("open");
        // Every dataref/command listener registered before the drop is
        // still sitting in _datarefListeners/_commandListeners (nothing
        // clears those on close) — X-Plane just doesn't know about them
        // anymore on this brand-new socket, so replay the subscribe
        // requests before anything else notices values have gone stale.
        if (wasReconnect) {
          this._diag("info", "reconnected — resubscribing to everything this session had open");
          this._resubscribeAll();
        }
        resolve();
      });
      ws.addEventListener("error", (ev) => {
        this._diag("error", "websocket error (see browser console for detail, if any — the WebSocket API doesn't expose a reason here)");
        this._setStatus("error", ev);
        reject(new Error("WebSocket error"));
      });
      ws.addEventListener("close", (ev) => {
        this._diag(
          this._explicitClose ? "info" : "warn",
          `websocket closed (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`
        );
        this._setStatus("closed");
        if (!this._explicitClose) this._scheduleReconnect();
      });
      ws.addEventListener("message", (ev) => this._handleMessage(ev));
    });
  }

  /** Not currently called anywhere in this app (see the constructor's own note) — kept for API completeness and so a future "Disconnect" button has something to call that won't immediately trigger auto-reconnect. */
  closeSocket() {
    this._explicitClose = true;
    this._clearReconnectTimer();
    this.ws?.close();
    this.ws = null;
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // Exponential backoff (1s, 2s, 4s, ... capped at 30s) rather than
  // retrying at full speed — a genuinely-down X-Plane (not just a brief
  // WiFi blip) shouldn't get hammered with reconnect attempts forever.
  _scheduleReconnect() {
    this._clearReconnectTimer();
    const attempt = ++this._reconnectAttempt;
    const delayMs = Math.min(1000 * 2 ** (attempt - 1), 30000);
    this._diag("info", `reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${attempt})`);
    this._reconnectTimer = setTimeout(() => {
      // Failures here are already logged by the 'error'/'close' listeners
      // in connectSocket() above, which is also what schedules the *next*
      // attempt — this .catch() exists purely to keep a failed retry from
      // surfacing as an unhandled promise rejection.
      this.connectSocket(this._lastPanelHint).catch(() => {});
    }, delayMs);
  }

  /** Replays every currently-registered dataref/command subscription onto the (new) socket after a reconnect. Cheap to call even with nothing subscribed yet (first-ever connect) — both maps are just empty then. */
  _resubscribeAll() {
    for (const [id, index] of this._datarefIndexById) {
      this._send("dataref_subscribe_values", { datarefs: [index ? { id, index } : { id }] });
    }
    for (const id of this._commandListeners.keys()) {
      this._send("command_subscribe_is_active", { commands: [{ id }] });
    }
  }

  _setStatus(status, detail) {
    this.onStatusChange?.(status, detail);
  }

  _diag(level, message) {
    this.onDiagnostic?.({ level, message });
  }

  _send(type, params) {
    const req_id = this._nextReqId++;
    const msg = { req_id, type, params };
    this.ws.send(JSON.stringify(msg));
    return req_id;
  }

  _handleMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === "dataref_update_values" && msg.data) {
      for (const [idStr, rawValue] of Object.entries(msg.data)) {
        const id = Number(idStr);
        for (const listener of this._datarefListeners.get(id) ?? []) listener(rawValue);
      }
      return;
    }

    if (msg.type === "command_update_is_active" && msg.data) {
      for (const [idStr, isActive] of Object.entries(msg.data)) {
        const id = Number(idStr);
        for (const listener of this._commandListeners.get(id) ?? []) listener(Boolean(isActive));
      }
      return;
    }

    // "result" acks for our own requests aren't currently awaited
    // individually; surface failures to the console — and the
    // diagnostics panel, which is what someone like Jerry can actually
    // see on a tablet — so mapping mistakes (e.g. a bad dataref id)
    // aren't silently swallowed.
    if (msg.type === "result" && msg.success === false) {
      console.warn("[xplane-client] request failed", msg);
      this._diag("warn", `request failed: ${msg.error_message ?? JSON.stringify(msg)}`);
    }
  }

  /**
   * Subscribe to a dataref's value stream (pushed ~10Hz by X-Plane).
   * @param {number} id
   * @param {(value: any) => void} onValue
   * @param {number[]} [index] - for array datarefs, the element indices to
   *   track (e.g. [0, 1]); the callback then receives an array of just
   *   those elements, in that order, instead of the whole dataref. Plain
   *   numeric arrays come back as ordinary JSON arrays on the wire, not
   *   base64 (base64 is only for "data"/byte-string typed datarefs — see
   *   docs/xplane-web-api-notes.md), so no decoding is needed here.
   *   Note: the subscribe request is only sent once per id (on the first
   *   subscriber), so every caller sharing an id must agree on the same
   *   `index` — this doesn't support two callers each wanting a different
   *   slice of the same array dataref; whichever calls this first for a
   *   given id wins the index for every later caller, silently. This is a
   *   real trap, not just theoretical — confirmed live 2026-08-30 when
   *   rmp-acp-toliss-airbus.json's AM_PRESS/BFO_PRESS buttons each
   *   declared their own `stateIndex` against the *same*
   *   AirbusFBW/RMP1Lights id a third caller also wanted as a whole
   *   array: the whole-array reader silently got back a one-element
   *   array instead (see ARCHITECTURE.md's RMP+ACP section). If several
   *   things need different slices (or the whole array) of one dataref,
   *   subscribe once — to the whole array, no `index` — and have every
   *   caller index into that single shared value themselves, the way
   *   src/rmp-panel.js's RMP1_LIGHTS readout does now.
   */
  subscribeDataref(id, onValue, index) {
    const isFirst = !this._datarefListeners.has(id);
    if (isFirst) {
      this._datarefListeners.set(id, new Set());
      this._datarefIndexById.set(id, index); // remembered for _resubscribeAll() after a reconnect
    }
    this._datarefListeners.get(id).add(onValue);
    if (isFirst) this._send("dataref_subscribe_values", { datarefs: [index ? { id, index } : { id }] });
  }

  unsubscribeDataref(id, onValue) {
    const listeners = this._datarefListeners.get(id);
    listeners?.delete(onValue);
    if (listeners && listeners.size === 0) {
      this._datarefListeners.delete(id);
      this._datarefIndexById.delete(id);
      this._send("dataref_unsubscribe_values", { datarefs: [{ id }] });
    }
  }

  subscribeCommand(id, onIsActive) {
    const isFirst = !this._commandListeners.has(id);
    if (isFirst) this._commandListeners.set(id, new Set());
    this._commandListeners.get(id).add(onIsActive);
    if (isFirst) this._send("command_subscribe_is_active", { commands: [{ id }] });
  }

  unsubscribeCommand(id, onIsActive) {
    const listeners = this._commandListeners.get(id);
    listeners?.delete(onIsActive);
    if (listeners && listeners.size === 0) {
      this._commandListeners.delete(id);
      this._send("command_unsubscribe_is_active", { commands: [{ id }] });
    }
  }

  setDatarefValue(id, value) {
    this._send("dataref_set_values", { datarefs: [{ id, value }] });
  }

  /**
   * Fire a command as a brief press-and-release. Uses the websocket
   * command_set_is_active form (fully documented) rather than the REST
   * /command/{id}/activate endpoint (body shape unconfirmed) — see
   * docs/xplane-web-api-notes.md.
   * @param {number} id
   * @param {number} durationSeconds
   */
  activateCommand(id, durationSeconds = 0.15) {
    this._send("command_set_is_active", {
      commands: [{ id, is_active: true, duration: durationSeconds }],
    });
  }
}

// ----------------------------------------------------------- base64 utils --

/** @param {string} b64 @returns {Uint8Array} */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** @param {Uint8Array} bytes @returns {string} */
export function bytesToBase64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** @param {Uint8Array} bytes @returns {string} */
export function bytesToUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}
