"use strict";

// Live GUI for the suspicious transactions.
// The dashboard service pushes data with Server-Sent Events (GET /events):
//   snapshot    -> the latest transactions it has in memory (sent on every (re)connect)
//   transaction -> one new suspicious transaction from the RabbitMQ queue
//   status      -> the service's connection to RabbitMQ went up/down
// The charts are plain SVG drawn by hand, so the page has no external dependencies.

const WINDOW_MINUTES = 30; // time window of the two time charts
const MAX_TRANSACTIONS = 500; // same as HISTORY_SIZE on the server
const FEED_ROWS = 50;
const TOP_CURRENCIES = 8;
const MINUTE = 60 * 1000;

const state = {
  transactions: [], // oldest first
  total: 0,
  startedAt: null,
  version: 0, // bumped on every data change
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const minuteFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium" });
const intFmt = new Intl.NumberFormat("en-US");
const amountFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const byId = (id) => document.getElementById(id);

function fmtDateTime(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? dateTimeFmt.format(ms) : "–";
}

function fmtSeconds(seconds) {
  if (seconds == null) return "–";
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${intFmt.format(Math.round(seconds))} s`;
}

function fmtTick(value) {
  return Number.isInteger(value) ? intFmt.format(value) : String(value);
}

// Precompute what the charts need once per transaction
function normalize(tx) {
  const flaggedMs = Date.parse(tx.flaggedAt);
  const sentMs = Date.parse(tx.timestamp);
  return {
    ...tx,
    _flaggedMs: flaggedMs,
    // Seconds from the bank creating the transaction to fraud-detection flagging it
    _delay: Number.isFinite(sentMs) && Number.isFinite(flaggedMs) ? Math.max(0, (flaggedMs - sentMs) / 1000) : null,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function textEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text; // data from the queue is never inserted as HTML
  return node;
}

// ---------------------------------------------------------------------------
// Live connection (Server-Sent Events)
// ---------------------------------------------------------------------------

function setPill(id, pillState, label) {
  const pill = byId(id);
  pill.dataset.state = pillState;
  pill.querySelector(".pill-label").textContent = label;
}

function setRabbit(connected) {
  setPill(
    "rabbit-status",
    connected ? "connected" : "disconnected",
    connected ? "RabbitMQ connected" : "RabbitMQ disconnected"
  );
}

function connect() {
  setPill("stream-status", "connecting", "Connecting…");
  const source = new EventSource("events"); // relative, so it also works behind a path prefix

  source.addEventListener("open", () => setPill("stream-status", "live", "Live"));

  source.addEventListener("error", () => {
    setPill("stream-status", "reconnecting", "Reconnecting…");
    setPill("rabbit-status", "unknown", "RabbitMQ");
    if (source.readyState === EventSource.CLOSED) {
      // The browser gave up (e.g. the server answered with an error) - retry ourselves
      source.close();
      setTimeout(connect, 5000);
    }
  });

  source.addEventListener("snapshot", (event) => {
    const snapshot = JSON.parse(event.data);
    state.transactions = snapshot.transactions.map(normalize);
    state.total = snapshot.total;
    state.startedAt = Date.parse(snapshot.startedAt);
    state.version++;
    byId("queue-name").textContent = snapshot.queue;
    setRabbit(snapshot.rabbitConnected);
    rebuildFeed();
    scheduleRender();
  });

  source.addEventListener("transaction", (event) => {
    const { total, transaction } = JSON.parse(event.data);
    const tx = normalize(transaction);
    state.total = total;
    state.transactions.push(tx);
    if (state.transactions.length > MAX_TRANSACTIONS) state.transactions.shift();
    state.version++;
    prependFeedRow(tx);
    scheduleRender();
  });

  source.addEventListener("status", (event) => setRabbit(JSON.parse(event.data).rabbitConnected));
}

// ---------------------------------------------------------------------------
// Rendering loop
// ---------------------------------------------------------------------------

let renderQueued = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const now = Date.now();
    renderKpis(now);
    for (const chart of charts) chart.render(now);
  });
}

// ---------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------

function setValue(id, value, unit) {
  const node = byId(id);
  node.textContent = value;
  if (unit) node.append(textEl("span", "unit", unit));
}

function renderKpis(now) {
  const txs = state.transactions;

  setValue("kpi-total", intFmt.format(state.total));
  byId("kpi-total-note").textContent = state.startedAt
    ? `since the dashboard started at ${minuteFmt.format(state.startedAt)}`
    : " ";

  const recent = txs.filter((tx) => tx._flaggedMs >= now - 5 * MINUTE).length;
  setValue("kpi-recent", intFmt.format(recent));
  byId("kpi-recent-note").textContent = `≈ ${(recent / 5).toFixed(1)} per minute`;

  const delays = txs
    .slice(-20)
    .map((tx) => tx._delay)
    .filter((d) => d != null);
  if (delays.length) {
    const m = median(delays);
    setValue("kpi-delay", m < 10 ? m.toFixed(1) : intFmt.format(Math.round(m)), "s");
    byId("kpi-delay-note").textContent = `median of the last ${delays.length}, bank → flagged`;
  } else {
    setValue("kpi-delay", "–");
  }

  const largest = txs.reduce((best, tx) => (!best || tx.amount > best.amount ? tx : best), null);
  if (largest) {
    setValue("kpi-largest", amountFmt.format(largest.amount), largest.currency);
    byId("kpi-largest-note").textContent = `account ${largest.accountId.slice(0, 8)} at ${timeFmt.format(largest._flaggedMs)}`;
  } else {
    setValue("kpi-largest", "–");
  }
}

// ---------------------------------------------------------------------------
// Feed of the latest transactions
// ---------------------------------------------------------------------------

function feedRow(tx, fresh) {
  const details = document.createElement("details");
  details.className = fresh ? "tx is-fresh" : "tx";

  const summary = document.createElement("summary");
  const amount = textEl("span", "tx-amount num", amountFmt.format(tx.amount));
  amount.append(textEl("span", "currency", tx.currency));
  summary.append(
    textEl("span", "tx-time", Number.isFinite(tx._flaggedMs) ? timeFmt.format(tx._flaggedMs) : "–"),
    textEl("span", "tx-account", tx.accountId),
    amount,
    textEl("span", "tx-delay num", fmtSeconds(tx._delay))
  );

  const list = document.createElement("dl");
  list.className = "tx-details";
  const rows = [
    ["Account", tx.accountId],
    ["Amount", `${amountFmt.format(tx.amount)} ${tx.currency}`],
    ["Sent by bank", fmtDateTime(tx.timestamp)],
    ["Flagged", fmtDateTime(tx.flaggedAt)],
    ["Received here", fmtDateTime(tx.receivedAt)],
    ["Delay", fmtSeconds(tx._delay)],
    ["Reason", tx.reason || "–"],
  ];
  for (const [label, value] of rows) {
    list.append(textEl("dt", "", label), textEl("dd", label === "Reason" ? "reason" : "", value));
  }

  details.append(summary, list);
  return details;
}

function updateFeedEmpty() {
  byId("feed-empty").hidden = byId("feed").childElementCount > 0;
}

function rebuildFeed() {
  const latest = state.transactions.slice(-FEED_ROWS).reverse();
  byId("feed").replaceChildren(...latest.map((tx) => feedRow(tx, false)));
  updateFeedEmpty();
}

function prependFeedRow(tx) {
  const feed = byId("feed");
  feed.prepend(feedRow(tx, true));
  while (feed.childElementCount > FEED_ROWS) feed.lastElementChild.remove();
  updateFeedEmpty();
}

// ---------------------------------------------------------------------------
// Tooltip (one for the whole page; values first, labels after)
// ---------------------------------------------------------------------------

const tooltip = { el: byId("tooltip"), owner: null };

function showTooltip(owner, clientX, clientY, lines) {
  const tip = tooltip.el;
  tooltip.owner = owner;
  tip.replaceChildren(textEl("strong", "", lines[0]), ...lines.slice(1).map((line) => textEl("span", "", line)));
  tip.hidden = false;

  let left = clientX + 14;
  let top = clientY - tip.offsetHeight - 10;
  if (left + tip.offsetWidth > window.innerWidth - 8) left = clientX - tip.offsetWidth - 14;
  if (top < 8) top = clientY + 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}

function hideTooltip(owner) {
  if (tooltip.owner !== owner) return;
  tooltip.owner = null;
  tooltip.el.hidden = true;
}

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
const HEIGHT = 220; // includes the x-axis labels
const MARGIN = { top: 12, right: 20, bottom: 28, left: 44 };

function svgEl(name, attrs, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (parent) parent.appendChild(node);
  return node;
}

// Clean y-axis steps (1, 2, 2.5, 5 x 10^n) from 0 up to at least `max`
function niceTicks(max, count, integer) {
  if (!(max > 0)) max = integer ? 4 : 10;
  const rough = max / count;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const multipliers = integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  let step = multipliers.map((m) => m * pow).find((s) => s >= rough);
  if (integer) step = Math.max(1, Math.round(step));
  const ticks = [];
  for (let v = 0; v < max + step - 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

// Column with 4px rounded top corners and a square base
function columnPath(x, yTop, w, h) {
  const r = Math.min(4, w / 2, h);
  return (
    `M${x},${yTop + h}V${yTop + r}A${r},${r} 0 0 1 ${x + r},${yTop}` +
    `H${x + w - r}A${r},${r} 0 0 1 ${x + w},${yTop + r}V${yTop + h}Z`
  );
}

// Frame shared by the two time charts: gridlines, y labels and the baseline
function drawFrame(svg, width, ticks, yScale, unit) {
  const top = ticks[ticks.length - 1];
  for (const v of ticks) {
    const y = Math.round(yScale(v)) + 0.5;
    if (v !== 0) svgEl("line", { class: "gridline", x1: MARGIN.left, x2: width - MARGIN.right, y1: y, y2: y }, svg);
    const label = svgEl("text", { x: MARGIN.left - 8, y: y + 4, "text-anchor": "end" }, svg);
    label.textContent = v === top && unit ? `${fmtTick(v)} ${unit}` : fmtTick(v);
  }
}

function drawBaseline(svg, width, y) {
  const yy = Math.round(y) + 0.5;
  svgEl("line", { class: "baseline", x1: MARGIN.left, x2: width - MARGIN.right, y1: yy, y2: yy }, svg);
}

function emptyMessage(text) {
  return textEl("p", "empty", text);
}

// ---------------------------------------------------------------------------
// Chart: flagged per minute (columns)
// ---------------------------------------------------------------------------

function minuteBuckets(now) {
  const currentMinute = Math.floor(now / MINUTE) * MINUTE;
  const first = currentMinute - (WINDOW_MINUTES - 1) * MINUTE;
  const buckets = Array.from({ length: WINDOW_MINUTES }, (_, i) => ({ start: first + i * MINUTE, count: 0 }));
  for (const tx of state.transactions) {
    const index = Math.floor((tx._flaggedMs - first) / MINUTE);
    if (index >= 0 && index < WINDOW_MINUTES) buckets[index].count++;
  }
  return buckets;
}

function minuteLabel(bucket, isLast) {
  return `${minuteFmt.format(bucket.start)}–${minuteFmt.format(bucket.start + MINUTE)}${isLast ? " (so far)" : ""}`;
}

function drawRate(host, width, now) {
  const buckets = minuteBuckets(now);
  const ticks = niceTicks(Math.max(...buckets.map((b) => b.count)), 4, true);
  const top = ticks[ticks.length - 1];
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = plotW / buckets.length;
  const colW = Math.max(2, Math.min(24, band * 0.7, band - 2)); // thin columns, >= 2px air between
  const y = (v) => MARGIN.top + plotH - (v / top) * plotH;

  const svg = svgEl("svg", { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, "aria-hidden": "true" });
  svgEl("rect", { class: "hover-band", x: 0, y: MARGIN.top, width: 0, height: plotH, visibility: "hidden" }, svg);
  drawFrame(svg, width, ticks, y);

  const points = buckets.map((bucket, i) => {
    const cx = MARGIN.left + band * i + band / 2;
    const isLast = i === buckets.length - 1;
    let el = null;
    if (bucket.count > 0) {
      el = svgEl("path", { class: "col", d: columnPath(cx - colW / 2, y(bucket.count), colW, y(0) - y(bucket.count)) }, svg);
    }
    if (new Date(bucket.start).getMinutes() % 5 === 0) {
      const label = svgEl("text", { x: cx, y: HEIGHT - 8, "text-anchor": "middle" }, svg);
      label.textContent = minuteFmt.format(bucket.start);
    }
    return {
      key: bucket.start,
      x: cx,
      y: y(bucket.count),
      el,
      band: { x: MARGIN.left + band * i, width: band },
      hitRadius: band / 2,
      lines: [`${intFmt.format(bucket.count)} flagged`, minuteLabel(bucket, isLast)],
    };
  });
  drawBaseline(svg, width, y(0));

  host.replaceChildren(svg);
  if (!state.transactions.length) host.append(emptyMessage("Waiting for the first flagged transaction…"));
  return points;
}

function rateTable(now) {
  const buckets = minuteBuckets(now);
  return {
    columns: [{ label: "Minute" }, { label: "Flagged", num: true }],
    rows: buckets.map((b, i) => [minuteLabel(b, i === buckets.length - 1), intFmt.format(b.count)]).reverse(),
  };
}

// ---------------------------------------------------------------------------
// Chart: detection delay (one dot per transaction)
// ---------------------------------------------------------------------------

function delayTransactions(now) {
  const start = now - WINDOW_MINUTES * MINUTE;
  return state.transactions.filter((tx) => tx._flaggedMs >= start && tx._flaggedMs <= now + MINUTE && tx._delay != null);
}

function drawDelay(host, width, now) {
  const start = now - WINDOW_MINUTES * MINUTE;
  const txs = delayTransactions(now);
  const ticks = niceTicks(Math.max(0, ...txs.map((tx) => tx._delay)), 4, false);
  const top = ticks[ticks.length - 1];
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = (t) => MARGIN.left + Math.min(1, (t - start) / (now - start)) * plotW;
  const y = (v) => MARGIN.top + plotH - (v / top) * plotH;

  const svg = svgEl("svg", { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, "aria-hidden": "true" });
  drawFrame(svg, width, ticks, y, "s");
  drawBaseline(svg, width, y(0));

  // Time labels every 5 minutes on the clock
  for (let t = Math.ceil(start / (5 * MINUTE)) * 5 * MINUTE; t <= now; t += 5 * MINUTE) {
    const label = svgEl("text", { x: x(t), y: HEIGHT - 8, "text-anchor": "middle" }, svg);
    label.textContent = minuteFmt.format(t);
  }

  // Oldest first, so the newest dots are drawn on top
  const points = txs.map((tx) => {
    const cx = x(tx._flaggedMs);
    const cy = y(tx._delay);
    return {
      key: tx.id,
      x: cx,
      y: cy,
      el: svgEl("circle", { class: "dot", cx, cy, r: 4 }, svg),
      hitRadius: 20,
      lines: [
        `${fmtSeconds(tx._delay)} delay`,
        `flagged at ${timeFmt.format(tx._flaggedMs)}`,
        `${amountFmt.format(tx.amount)} ${tx.currency}`,
      ],
    };
  });

  host.replaceChildren(svg);
  if (!txs.length) {
    host.append(
      emptyMessage(
        state.transactions.length ? "No flagged transactions in the last 30 minutes" : "Waiting for the first flagged transaction…"
      )
    );
  }
  return points;
}

function delayTable(now) {
  return {
    columns: [{ label: "Flagged" }, { label: "Delay", num: true }, { label: "Amount", num: true }],
    rows: delayTransactions(now)
      .reverse()
      .map((tx) => [timeFmt.format(tx._flaggedMs), fmtSeconds(tx._delay), `${amountFmt.format(tx.amount)} ${tx.currency}`]),
  };
}

// ---------------------------------------------------------------------------
// Chart: top currencies (ranked horizontal bars, plain HTML)
// ---------------------------------------------------------------------------

function currencyCounts() {
  const counts = new Map();
  for (const tx of state.transactions) counts.set(tx.currency, (counts.get(tx.currency) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function drawCurrencies(host) {
  const counts = currencyCounts();
  const total = state.transactions.length;
  byId("currencies-subtitle").textContent = total
    ? `Among the latest ${intFmt.format(total)} flagged transactions`
    : "Among the latest flagged transactions";

  if (!counts.length) {
    host.replaceChildren(emptyMessage("Waiting for the first flagged transaction…"));
    return;
  }

  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.currency : null;
  const top = counts.slice(0, TOP_CURRENCIES);
  const max = top[0][1];
  const list = document.createElement("div");
  list.className = "bars";

  for (const [currency, count] of top) {
    const share = Math.round((count / total) * 100);
    const lines = [`${intFmt.format(count)} flagged`, `${currency}, ${share}% of ${intFmt.format(total)}`];

    const row = document.createElement("div");
    row.className = "bar-row";
    row.tabIndex = 0;
    row.dataset.currency = currency;
    row.setAttribute("aria-label", `${currency}: ${count} flagged, ${share}%`);

    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.width = `calc((100% - 40px) * ${count / max})`;
    const track = document.createElement("div");
    track.className = "bar-track";
    track.append(bar, textEl("span", "bar-value", intFmt.format(count)));
    row.append(textEl("span", "bar-label", currency), track);

    const show = () => {
      const r = bar.getBoundingClientRect();
      showTooltip(row, r.right, r.top + r.height / 2, lines);
    };
    row.addEventListener("pointerenter", show);
    row.addEventListener("focus", show);
    row.addEventListener("pointerleave", () => hideTooltip(row));
    row.addEventListener("blur", () => hideTooltip(row));
    list.append(row);
  }

  const nodes = [list];
  const rest = counts.slice(TOP_CURRENCIES);
  if (rest.length) {
    const restCount = rest.reduce((sum, [, count]) => sum + count, 0);
    nodes.push(
      textEl(
        "p",
        "bars-note",
        `+ ${rest.length} more ${rest.length === 1 ? "currency" : "currencies"} (${intFmt.format(restCount)} transactions)`
      )
    );
  }
  if (tooltip.owner && host.contains(tooltip.owner)) hideTooltip(tooltip.owner);
  host.replaceChildren(...nodes);
  if (focused) host.querySelector(`[data-currency="${CSS.escape(focused)}"]`)?.focus();
}

function currencyTable() {
  const total = state.transactions.length;
  return {
    columns: [{ label: "Currency" }, { label: "Flagged", num: true }, { label: "Share", num: true }],
    rows: currencyCounts().map(([currency, count]) => [
      currency,
      intFmt.format(count),
      `${Math.round((count / total) * 100)}%`,
    ]),
  };
}

// ---------------------------------------------------------------------------
// Chart cards: chart/table toggle, hover and keyboard
// ---------------------------------------------------------------------------

function renderTable(host, { columns, rows }) {
  if (!rows.length) {
    host.replaceChildren(emptyMessage("No data yet"));
    return;
  }
  const table = document.createElement("table");
  const headRow = table.createTHead().insertRow();
  for (const col of columns) {
    const th = textEl("th", col.num ? "num" : "", col.label);
    th.scope = "col";
    headRow.append(th);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    row.forEach((value, i) => tr.append(textEl("td", columns[i].num ? "num" : "", value)));
  }
  host.replaceChildren(table);
}

function setActive(chart, key) {
  chart.activeKey = key;
  const point = key == null ? null : chart.points.find((p) => p.key === key);
  for (const p of chart.points) p.el?.classList.toggle("is-active", p === point);

  const band = chart.host.querySelector(".hover-band");
  if (band) {
    band.setAttribute("visibility", point?.band ? "visible" : "hidden");
    if (point?.band) {
      band.setAttribute("x", point.band.x);
      band.setAttribute("width", point.band.width);
    }
  }

  if (point) {
    const r = chart.host.getBoundingClientRect();
    showTooltip(chart, r.left + point.x, r.top + point.y, point.lines);
  } else {
    hideTooltip(chart);
  }
}

// Nearest mark to the pointer: by x for columns, by distance for dots
function pointAt(chart, px, py) {
  let best = null;
  let bestDistance = Infinity;
  for (const p of chart.points) {
    const d = chart.mode === "x" ? Math.abs(p.x - px) : Math.hypot(p.x - px, p.y - py);
    if (d <= p.hitRadius && d < bestDistance) {
      best = p;
      bestDistance = d;
    }
  }
  return best;
}

function bindHover(chart) {
  const host = chart.host;
  host.addEventListener("pointermove", (event) => {
    const r = host.getBoundingClientRect();
    chart.pointer = { x: event.clientX - r.left, y: event.clientY - r.top };
    setActive(chart, pointAt(chart, chart.pointer.x, chart.pointer.y)?.key ?? null);
  });
  host.addEventListener("pointerleave", () => {
    chart.pointer = null;
    setActive(chart, null);
  });
  host.addEventListener("focus", () => {
    if (chart.activeKey == null && chart.points.length) setActive(chart, chart.points[chart.points.length - 1].key);
  });
  host.addEventListener("blur", () => setActive(chart, null));
  host.addEventListener("keydown", (event) => {
    const n = chart.points.length;
    if (!n) return;
    let i = chart.points.findIndex((p) => p.key === chart.activeKey);
    if (event.key === "ArrowRight") i = i < 0 ? 0 : Math.min(i + 1, n - 1);
    else if (event.key === "ArrowLeft") i = i < 0 ? n - 1 : Math.max(i - 1, 0);
    else if (event.key === "Home") i = 0;
    else if (event.key === "End") i = n - 1;
    else if (event.key === "Escape") return setActive(chart, null);
    else return;
    event.preventDefault();
    setActive(chart, chart.points[i].key);
  });
}

function createChart(name, spec) {
  const card = document.querySelector(`[data-chart="${name}"]`);
  const chart = {
    host: card.querySelector(".chart"),
    tableHost: card.querySelector(".table-view"),
    mode: spec.mode,
    points: [],
    activeKey: null,
    pointer: null,
    showTable: false,
    width: 0,
    renderedVersion: -1,
  };

  const toggle = card.querySelector(".view-toggle");
  toggle.addEventListener("click", () => {
    chart.showTable = !chart.showTable;
    toggle.setAttribute("aria-pressed", String(chart.showTable));
    toggle.textContent = chart.showTable ? "Chart" : "Table";
    chart.host.hidden = chart.showTable;
    chart.tableHost.hidden = !chart.showTable;
    chart.renderedVersion = -1;
    hideTooltip(chart);
    scheduleRender();
  });

  chart.render = (now) => {
    if (chart.showTable) {
      renderTable(chart.tableHost, spec.table(now));
      return;
    }
    const width = chart.host.clientWidth;
    if (!width) return;
    // Time charts redraw every tick (the window moves); the currency bars only when data changes
    if (!spec.timeBased && chart.renderedVersion === state.version && chart.width === width) return;
    chart.width = width;
    chart.renderedVersion = state.version;
    chart.points = spec.draw(chart.host, width, now) || [];

    // Keep the hover/keyboard readout on the same mark after a redraw
    if (chart.pointer) setActive(chart, pointAt(chart, chart.pointer.x, chart.pointer.y)?.key ?? null);
    else if (chart.activeKey != null) setActive(chart, chart.activeKey);
  };

  if (spec.mode) bindHover(chart);
  new ResizeObserver(() => {
    if (chart.host.clientWidth !== chart.width) scheduleRender();
  }).observe(chart.host);
  return chart;
}

const charts = [
  createChart("rate", { draw: drawRate, table: rateTable, mode: "x", timeBased: true }),
  createChart("delay", { draw: drawDelay, table: delayTable, mode: "xy", timeBased: true }),
  createChart("currencies", { draw: drawCurrencies, table: currencyTable }),
];

// Move the time window along even when nothing new arrives
setInterval(scheduleRender, 5000);

connect();
scheduleRender();
