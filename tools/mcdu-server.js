#!/usr/bin/env node
// Serves the app's static files AND proxies /api/* (REST + WebSocket) to
// X-Plane's Web API on localhost. Run this on the same machine as X-Plane.
//
// Zero npm dependencies, deliberately — this is the thing meant to be handed
// to someone off a forum post who has Node installed and nothing else; no
// `npm install` step, no node_modules, just `node tools/mcdu-server.js`. Both
// halves of the websocket relay (accepting the tablet's connection, and
// connecting out to X-Plane) are hand-rolled RFC 6455 below — not just the
// server half. Node 22+ ships a built-in *client* WebSocket that looks like
// the obvious way to do the outbound half with no code at all, but it
// reliably fails (undici throwing inside its own socket-close handling,
// connection closes with code 1006) the moment you send ~20+ messages
// shortly after connecting — exactly the shape of McduAdapter's startup
// burst (14 lines × text+style = 28 subscribe messages). Reproduced with
// Node's WebSocket connecting *directly* to X-Plane, no proxy involved, so
// it's a Node/undici issue, not something in this file. Hand-rolling both
// sides avoids it entirely and means there's exactly one frame
// parser/encoder to trust instead of two different implementations.
//
// This is scoped to exactly what relaying this specific traffic needs, not
// a general-purpose WebSocket implementation — permessage-deflate,
// extension negotiation, and strict UTF-8 validation are all skipped, since
// both peers here are well-behaved and on a local network. Use the `ws`
// package (already a devDependency, for tools/mock-xplane-server/) if you
// need a fuller implementation elsewhere.
//
// Why a proxy instead of the browser talking to X-Plane directly: it means
// the tablet never needs to know X-Plane's address or reach its Web API
// port directly — only this process's. (You still need "Allow incoming
// connections" on in X-Plane's Settings → Network either way — in testing,
// X-Plane's Web API needed it even for this process's own localhost
// connection, not just connections from other devices; the exact reason
// isn't confirmed, see docs/xplane-web-api-notes.md.) This process listens
// on all interfaces (so it's reachable from the tablet) but always reaches
// X-Plane over localhost, forwarding whatever the tablet's browser sends.
// The browser then never needs an X-Plane host/port at all — see
// src/app.js, which just talks to its own page origin.
//
// Usage: node tools/mcdu-server.js [port]   (default 5173; this is the
//        app's own port, i.e. what you open in a browser)
//   env: XPLANE_HOST (default 127.0.0.1), XPLANE_PORT (default 8086) — only
//        needed if X-Plane runs on a different machine than this server;
//        supported, but uncommon.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2]) || 5173;
const XPLANE_HOST = process.env.XPLANE_HOST || "127.0.0.1";
const XPLANE_PORT = Number(process.env.XPLANE_PORT) || 8086;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.join(ROOT, urlPath === "/" ? "/index.html" : urlPath);

  // Prevent escaping the project root via ../
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found: " + urlPath);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

async function proxyRest(req, res) {
  const upstreamUrl = `http://${XPLANE_HOST}:${XPLANE_PORT}${req.url}`;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error_code: "proxy_unreachable",
        error_message: `couldn't reach X-Plane at ${XPLANE_HOST}:${XPLANE_PORT} — is it running with the Web API enabled? (${err.message})`,
      })
    );
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    proxyRest(req, res);
    return;
  }
  serveStatic(req, res);
});

// --------------------------------------------------- minimal RFC 6455 --
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"; // §1.3
function acceptKeyFor(clientKey) {
  return crypto.createHash("sha1").update(clientKey + WS_MAGIC).digest("base64");
}

// §5.2 frame format. `mask` controls the direction: true for frames we send
// as the *client* (our outbound connection to X-Plane — must be masked),
// false for frames we send as the *server* (to the tablet — must not be).
// Handles the 7-bit / 16-bit / 64-bit payload length forms; doesn't handle
// permessage-deflate or the reserved bits, since neither peer uses them.
function encodeFrame(opcode, payload, mask = false) {
  const len = payload.length;
  const maskBit = mask ? 0x80 : 0x00;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, maskBit | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const maskKey = crypto.randomBytes(4);
  const maskedPayload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) maskedPayload[i] = payload[i] ^ maskKey[i % 4];
  return Buffer.concat([header, maskKey, maskedPayload]);
}

/** Incrementally parses a byte stream into frames, calling onFrame for each complete one. */
function makeFrameFeeder(onFrame) {
  let buf = Buffer.alloc(0);
  return function feed(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let payloadLen = buf[1] & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (buf.length < offset + 2) return;
        payloadLen = buf.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (buf.length < offset + 8) return;
        payloadLen = Number(buf.readBigUInt64BE(offset));
        offset += 8;
      }
      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + payloadLen) return; // incomplete frame, wait for more
      let payload = buf.subarray(offset, offset + payloadLen);
      if (masked) {
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
      }
      buf = buf.subarray(offset + payloadLen);
      onFrame(fin, opcode, payload);
    }
  };
}

/** Reassembles fragmented frames into whole messages and dispatches control frames. */
function makeMessageAssembler({ onText, onBinary, onClose, onPing }) {
  let fragments = [];
  let fragmentedOpcode = null;
  return function onFrame(fin, opcode, payload) {
    if (opcode === 0x8) return onClose();
    if (opcode === 0x9) return onPing(payload);
    if (opcode === 0xa) return; // pong: nothing to do, we don't send pings

    const isContinuation = opcode === 0x0;
    if (!isContinuation) fragmentedOpcode = opcode;
    fragments.push(payload);
    if (!fin) return;

    const full = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
    fragments = [];
    if (fragmentedOpcode === 0x1) onText(full.toString("utf8"));
    else if (fragmentedOpcode === 0x2) onBinary(full);
  };
}

/**
 * Hand-rolled WS client: opens `path` on host:port via http.request's
 * upgrade mechanism (which handles request-line/header formatting for us —
 * we just have to supply the right websocket headers and take over the
 * socket once it hands back a 101), then relays frames through the same
 * feeder/assembler/encoder used for the server side above.
 * @returns {{ send(data: string|Buffer): void, close(): void }}
 */
function connectUpstream(host, port, path, { onOpen, onText, onBinary, onClose, onError }) {
  const key = crypto.randomBytes(16).toString("base64");
  const req = http.request({
    host,
    port,
    path,
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Version": "13",
    },
  });
  req.end();

  let socket = null;
  req.on("upgrade", (res, sock, head) => {
    socket = sock;
    const feed = makeFrameFeeder(makeMessageAssembler({ onText, onBinary, onClose, onPing: () => {} }));
    if (head?.length) feed(head);
    socket.on("data", feed);
    socket.on("close", onClose);
    socket.on("error", onError);
    onOpen();
  });
  req.on("response", (res) => {
    onError(new Error(`X-Plane rejected the websocket handshake: HTTP ${res.statusCode}`));
  });
  req.on("error", onError);

  return {
    send(data) {
      if (!socket) return;
      const opcode = typeof data === "string" ? 0x1 : 0x2;
      const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      socket.write(encodeFrame(opcode, payload, true)); // masked: we're the client here
    },
    close() {
      socket?.end();
    },
  };
}

// Accept the tablet's connection, open a second (hand-rolled) websocket to
// X-Plane over localhost, and relay messages both ways at the message level
// (not raw frames) — always knowing whether a message was text or binary
// from which callback fired, rather than needing to track a flag through
// the relay. See docs/xplane-web-api-notes.md for the silent-corruption bug
// that came from getting that distinction wrong.
server.on("upgrade", (req, socket, head) => {
  const isWs = (req.headers.upgrade || "").toLowerCase() === "websocket";
  const clientKey = req.headers["sec-websocket-key"];
  if (!req.url.startsWith("/api/") || !isWs || !clientKey) {
    socket.destroy();
    return;
  }

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKeyFor(clientKey)}\r\n\r\n`
  );

  let upstreamOpen = false;
  const pendingToUpstream = [];
  const upstream = connectUpstream(XPLANE_HOST, XPLANE_PORT, req.url, {
    onOpen: () => {
      upstreamOpen = true;
      for (const data of pendingToUpstream.splice(0)) upstream.send(data);
    },
    onText: (text) => socket.write(encodeFrame(0x1, Buffer.from(text, "utf8"))),
    onBinary: (buf) => socket.write(encodeFrame(0x2, buf)),
    onClose: () => socket.end(),
    onError: (err) => {
      console.error("[proxy] upstream connection error:", err.message);
      socket.end();
    },
  });
  const sendUpstream = (data) => {
    if (upstreamOpen) upstream.send(data);
    else pendingToUpstream.push(data);
  };

  const feed = makeFrameFeeder(
    makeMessageAssembler({
      onText: sendUpstream,
      onBinary: sendUpstream,
      onClose: () => {
        socket.end();
        upstream.close();
      },
      onPing: (payload) => socket.write(encodeFrame(0xa, payload)), // reply with pong
    })
  );
  if (head?.length) feed(head);
  socket.on("data", (chunk) => {
    try {
      feed(chunk);
    } catch (err) {
      console.error("[proxy] frame feed error:", err.message);
    }
  });
  socket.on("close", () => upstream.close());
  socket.on("error", () => upstream.close());
});

server.listen(PORT, () => {
  console.log(`MCDU server: http://localhost:${PORT}  (and on your LAN IP, for tablets)`);
  console.log(`Proxying /api/* to X-Plane at ${XPLANE_HOST}:${XPLANE_PORT}`);
  console.log("Serving static files from", ROOT);
});
