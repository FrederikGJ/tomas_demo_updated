# Suspicious dashboard microservice

Consumes the `suspiciousTransactions` queue (filled by fraud-detection) and shows the flagged
transactions live in a browser GUI made with plain HTML, CSS and JS (`public/`).

```
fraud-detection --> RabbitMQ (suspiciousTransactions) --> suspicious-dashboard --SSE--> browser
```

Needs .env file:
```
PORT = 3004
RABBITMQ_URL = amqp://localhost
SUSPICIOUS_QUEUE_NAME = suspiciousTransactions
HISTORY_SIZE = 500 # how many of the latest transactions are kept in memory
```

Endpoints:

| Endpoint              | What it does                                                                          |
| --------------------- | ------------------------------------------------------------------------------------- |
| `GET /`               | The GUI                                                                               |
| `GET /events`         | Server-Sent Events: `snapshot` on connect, then `transaction` per message, `status` when RabbitMQ goes up/down |
| `GET /api/suspicious` | The latest transactions as JSON                                                       |
| `GET /health`         | Status, incl. the RabbitMQ connection                                                 |

Run it on its own (with RabbitMQ from `docker-compose-rabbitmq.yaml`):

```bash
npm install
npm start
# open http://localhost:3004
```

Run it as one replica only: RabbitMQ gives each message to one consumer, so more replicas would
split the messages between them, and each browser would only see part of them.
