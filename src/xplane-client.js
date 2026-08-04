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
    /** @type {Map<number, (value: any) => void>} callbacks keyed by dataref id */
    this._datarefListeners = new Map();
    /** @type {Map<number, (isActive: boolean) => void>} callbacks keyed by command id */
    this._commandListeners = new Map();

    this.onStatusChange = null; // (status: 'connecting'|'open'|'closed'|'error', detail?) => void
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

  async _resolveIds(kind, names) {
    const map = new Map();
    if (names.length === 0) return map;
    // Batch to keep query strings sane; X-Plane doesn't document a limit,
    // but a few hundred names per request is a reasonable ceiling.
    const BATCH = 200;
    for (let i = 0; i < names.length; i += BATCH) {
      const batch = names.slice(i, i + BATCH);
      const qs = batch.map((n) => `filter[name]=${encodeURIComponent(n)}`).join("&");
      const res = await fetch(`${this.restBase}/${kind}?${qs}`);
      if (!res.ok) throw new Error(`${kind} lookup: HTTP ${res.status}`);
      const body = await res.json();
      for (const entry of body.data ?? []) {
        map.set(entry.name, entry.id);
      }
    }
    return map;
  }

  /** Fetch the *entire* dataref or command list. Large; cache the result. */
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

  connectSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      this._setStatus("connecting");

      ws.addEventListener("open", () => {
        this._setStatus("open");
        resolve();
      });
      ws.addEventListener("error", (ev) => {
        this._setStatus("error", ev);
        reject(new Error("WebSocket error"));
      });
      ws.addEventListener("close", () => {
        this._setStatus("closed");
      });
      ws.addEventListener("message", (ev) => this._handleMessage(ev));
    });
  }

  closeSocket() {
    this.ws?.close();
    this.ws = null;
  }

  _setStatus(status, detail) {
    this.onStatusChange?.(status, detail);
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
        const listener = this._datarefListeners.get(id);
        if (listener) listener(rawValue);
      }
      return;
    }

    if (msg.type === "command_update_is_active" && msg.data) {
      for (const [idStr, isActive] of Object.entries(msg.data)) {
        const id = Number(idStr);
        const listener = this._commandListeners.get(id);
        if (listener) listener(Boolean(isActive));
      }
      return;
    }

    // "result" acks for our own requests aren't currently awaited
    // individually; surface failures to the console so mapping mistakes
    // (e.g. a bad dataref id) aren't silently swallowed.
    if (msg.type === "result" && msg.success === false) {
      console.warn("[xplane-client] request failed", msg);
    }
  }

  /**
   * Subscribe to a dataref's value stream (pushed ~10Hz by X-Plane).
   * @param {number} id
   * @param {(value: any) => void} onValue
   */
  subscribeDataref(id, onValue) {
    this._datarefListeners.set(id, onValue);
    this._send("dataref_subscribe_values", { datarefs: [{ id }] });
  }

  unsubscribeDataref(id) {
    this._datarefListeners.delete(id);
    this._send("dataref_unsubscribe_values", { datarefs: [{ id }] });
  }

  subscribeCommand(id, onIsActive) {
    this._commandListeners.set(id, onIsActive);
    this._send("command_subscribe_is_active", { commands: [{ id }] });
  }

  unsubscribeCommand(id) {
    this._commandListeners.delete(id);
    this._send("command_unsubscribe_is_active", { commands: [{ id }] });
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
