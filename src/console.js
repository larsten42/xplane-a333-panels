// Operator console — polls tools/mcdu-server.js's own /console/status.json
// (not X-Plane's Web API) and renders it. No adapters, no dataref/command
// concepts here at all; this is host-machine status, not cockpit state.

const REFRESH_MS = 3000;

async function refresh() {
  let data;
  try {
    const res = await fetch("/console/status.json", { cache: "no-store" });
    data = await res.json();
  } catch (err) {
    console.error("[console] status fetch failed:", err);
    return;
  }
  render(data);
}

function render(data) {
  document.getElementById("server-version").textContent = data.server.version ?? "—";
  document.getElementById("server-uptime").textContent = formatDuration(data.server.uptimeSeconds);
  document.getElementById("server-port").textContent = String(data.server.port);

  const xplaneStatus = document.getElementById("xplane-status");
  xplaneStatus.textContent = data.xplane.reachable ? "Connected" : "Not reachable";
  xplaneStatus.className = data.xplane.reachable ? "status-ok" : "status-bad";
  document.getElementById("xplane-address").textContent =
    `${data.xplane.host}:${data.xplane.port}` + (data.xplane.isDefault ? "" : " (non-default)");
  document.getElementById("xplane-version").textContent = data.xplane.version ?? "—";

  renderInterfaces(data.interfaces);
  renderClients(data.clients);

  document.getElementById("last-updated").textContent = "Updated " + new Date().toLocaleTimeString();
}

function renderInterfaces(interfaces) {
  const container = document.getElementById("interfaces");
  container.textContent = "";
  for (const iface of interfaces) {
    const card = document.createElement("div");
    card.className = "interface-card";

    const qrWrap = document.createElement("div");
    qrWrap.className = "qr-wrap";
    // Not useful for "this machine" itself — nothing to scan a code with
    // that's already looking at the screen it's on.
    if (!iface.internal) renderQr(qrWrap, iface.url);

    const label = document.createElement("div");
    label.className = "interface-label";
    const link = document.createElement("a");
    link.href = iface.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = iface.url;
    const name = document.createElement("span");
    name.className = "interface-name";
    name.textContent = iface.name + (iface.internal ? " · this machine" : "");
    label.append(link, name);

    card.append(qrWrap, label);
    container.appendChild(card);
  }
}

function renderQr(container, text) {
  const qr = window.qrcode(0, "M"); // typeNumber 0 = smallest size that fits the data
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!qr.isDark(row, col)) continue;
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(col));
      rect.setAttribute("y", String(row));
      rect.setAttribute("width", "1");
      rect.setAttribute("height", "1");
      rect.setAttribute("fill", "#000");
      svg.appendChild(rect);
    }
  }
  container.appendChild(svg);
}

function renderClients(clients) {
  document.getElementById("client-count").textContent = String(clients.length);
  document.getElementById("no-clients").hidden = clients.length > 0;

  const body = document.getElementById("clients-body");
  body.textContent = "";
  for (const c of clients) {
    const tr = document.createElement("tr");
    const tdIp = document.createElement("td");
    tdIp.textContent = c.ip;
    const tdPanel = document.createElement("td");
    tdPanel.textContent = c.panel;
    const tdTime = document.createElement("td");
    tdTime.textContent = formatDuration(c.connectedSeconds);
    tr.append(tdIp, tdPanel, tdTime);
    body.appendChild(tr);
  }
}

function formatDuration(seconds) {
  if (seconds == null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

refresh();
setInterval(refresh, REFRESH_MS);
