// Suspicious transactions dashboard
//
// Consumes the `suspiciousTransactions` queue (filled by fraud-detection) and pushes every
// flagged transaction live to the browser with Server-Sent Events (SSE). The GUI itself is
// plain HTML/CSS/JS in ./public, served by this same Express app.
//
//   RabbitMQ (suspiciousTransactions) --> this service --SSE /events--> browser (public/app.js)

import express, { Response } from "express";
import amqplib from "amqplib";
import path from "path";
import createLogger from "@microservices-demo/logger-library";
import "dotenv/config";

const { logMessage } = createLogger("suspicious-dashboard");

const app = express();

const PORT = process.env.PORT || 3004;
const RABBITMQ_URL = process.env.RABBITMQ_URL as string;
const SUSPICIOUS_QUEUE_NAME = process.env.SUSPICIOUS_QUEUE_NAME as string;
// How many of the latest suspicious transactions are kept in memory and sent to new browsers
const HISTORY_SIZE = parseInt(process.env.HISTORY_SIZE || "500");
const RECONNECT_DELAY_MS = 5000;
const KEEP_ALIVE_MS = 15000;

// The message from fraud-detection is the original transaction + `flaggedAt` and `reason`.
// We add an id and the time the dashboard received it.
type SuspiciousTransaction = {
  id: number; // assigned by this service, counts up per received message
  accountId: string;
  amount: number;
  currency: string;
  timestamp: string | null; // when the bank created the transaction
  flaggedAt: string; // when fraud-detection flagged it
  receivedAt: string; // when this dashboard consumed it
  reason: string;
};

// In-memory state - it is lost when the pod restarts, which is fine for a live dashboard.
const startedAt = new Date().toISOString();
const history: SuspiciousTransaction[] = [];
let totalReceived = 0;
let rabbitConnected = false;

// Every open browser tab is an SSE response we can keep writing to
const clients = new Set<Response>();

function sendEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown) {
  for (const client of clients) sendEvent(client, event, data);
}

function snapshot() {
  return {
    queue: SUSPICIOUS_QUEUE_NAME,
    startedAt,
    total: totalReceived,
    rabbitConnected,
    transactions: history,
  };
}

function setRabbitConnected(connected: boolean) {
  if (rabbitConnected === connected) return;
  rabbitConnected = connected;
  broadcast("status", { rabbitConnected });
}

function toSuspiciousTransaction(raw: any): SuspiciousTransaction {
  const now = new Date().toISOString();
  return {
    id: ++totalReceived,
    accountId: String(raw.accountId ?? "unknown"),
    amount: parseFloat(raw.amount) || 0, // the bank sends the amount as a string, e.g. "123.45"
    currency: String(raw.currency ?? "???"),
    timestamp: raw.timestamp ?? null,
    flaggedAt: raw.flaggedAt ?? now,
    receivedAt: now,
    reason: String(raw.reason ?? ""),
  };
}

// ---------------------------------------------------------------------------------------
// RabbitMQ consumer - reconnects by itself if RabbitMQ is not ready yet or restarts
// ---------------------------------------------------------------------------------------

let reconnectTimer: NodeJS.Timeout | undefined;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectAndConsume();
  }, RECONNECT_DELAY_MS);
}

async function connectAndConsume() {
  let connection: Awaited<ReturnType<typeof amqplib.connect>> | undefined;
  try {
    connection = await amqplib.connect(RABBITMQ_URL);
    connection.on("error", (error) => {
      logMessage(`RabbitMQ connection error: ${(error as Error).message}`, {
        level: "error",
      });
    });
    connection.on("close", () => {
      setRabbitConnected(false);
      logMessage("RabbitMQ connection closed - reconnecting...", {
        level: "warn",
      });
      scheduleReconnect();
    });

    const channel = await connection.createChannel();
    await channel.assertQueue(SUSPICIOUS_QUEUE_NAME);
    channel.prefetch(50);

    await channel.consume(
      SUSPICIOUS_QUEUE_NAME,
      (msg) => {
        if (!msg) {
          // RabbitMQ cancelled the consumer (e.g. the queue was deleted) - start over
          connection?.close().catch(() => undefined);
          return;
        }

        let data: unknown;
        try {
          data = JSON.parse(msg.content.toString());
        } catch (error) {
          logMessage("Discarding message that is not valid JSON", {
            level: "error",
            meta: { content: msg.content.toString() },
          });
          channel.nack(msg, false, false); // don't requeue - it would fail again
          return;
        }

        const transaction = toSuspiciousTransaction(data);
        history.push(transaction);
        if (history.length > HISTORY_SIZE) history.shift();

        broadcast("transaction", { total: totalReceived, transaction });
        logMessage("Received suspicious transaction", {
          level: "info",
          meta: { transaction, browsers: clients.size },
        });

        // Acknowledge when the transaction is stored and pushed to the browsers
        channel.ack(msg);
      },
      { noAck: false }
    );

    setRabbitConnected(true);
    logMessage(`Connected to RabbitMQ - consuming ${SUSPICIOUS_QUEUE_NAME}`, {
      level: "info",
    });
  } catch (error) {
    logMessage(`RabbitMQ error: ${(error as Error).message} - retrying in ${RECONNECT_DELAY_MS / 1000}s`, {
      level: "error",
    });
    setRabbitConnected(false);
    connection?.close().catch(() => undefined);
    scheduleReconnect();
  }
}

// ---------------------------------------------------------------------------------------
// HTTP: static GUI, Server-Sent Events stream and a small JSON API
// ---------------------------------------------------------------------------------------

// The GUI (index.html, styles.css, app.js). process.cwd() is /app both with ts-node and with dist/
app.use(express.static(path.join(process.cwd(), "public")));

// Live stream for the browser. On connect it gets a snapshot of the latest transactions,
// then one `transaction` event per new message. EventSource in the browser reconnects
// automatically and gets a fresh snapshot.
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n"); // browser reconnect delay

  sendEvent(res, "snapshot", snapshot());
  clients.add(res);
  logMessage(`Browser connected (${clients.size} open)`, { level: "info" });

  req.on("close", () => {
    clients.delete(res);
    logMessage(`Browser disconnected (${clients.size} open)`, { level: "info" });
  });
});

// Comment lines keep idle connections open through proxies / port-forwards
setInterval(() => {
  for (const client of clients) client.write(": keep-alive\n\n");
}, KEEP_ALIVE_MS);

app.get("/api/suspicious", (_req, res) => {
  res.json(snapshot());
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    rabbitmq: rabbitConnected ? "connected" : "disconnected",
    browsers: clients.size,
    total: totalReceived,
  });
});

connectAndConsume();

app.listen(PORT, () => {
  logMessage(`Suspicious dashboard listening on port ${PORT}`, {
    level: "info",
  });
});
