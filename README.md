# @loggifycloud/node

Documentation: [https://loggify.cloud/docs](https://loggify.cloud/docs)

```ts
import { Monitor } from '@loggifycloud/node';

Monitor.init({
  apiKey: process.env.MONITOR_API_KEY!,
  service: 'payment-api',
  environment: 'production',
});
```

Call `Monitor.init` **before** requiring `pg`, `mysql`, `mysql2`, `ioredis`,
`redis`, or `mongodb` - or at least before your first query. The SDK patches
those clients automatically, like a New Relic / Datadog agent. You do not wrap
queries in `Monitor.withSpan`.

After init, incoming HTTP requests become a server span, and datastore calls
show up as child spans on the trace waterfall:

```text
GET /users/42
 ├── redis GET
 └── postgresql SELECT
```

No extra middleware is required. `pg`, `mysql` / `mysql2`, `ioredis` / `redis`,
and `mongodb` are patched when the package is loaded. Knex and Sequelize are
covered because they call `pg` / `mysql2` underneath. Prisma is patched when
`@prisma/client` is required after `Monitor.init` - query events become
`db.statement` spans. Call `Monitor.setUser`, `Monitor.addBreadcrumb`, and
`Monitor.setRelease` to attach identity and release to captured errors.

Call `Monitor.init` before creating or starting your HTTP servers. The SDK
automatically instruments Node's `http` and `https` servers, including servers
used by frameworks such as Express, Fastify, and NestJS. It records the request method,
URL path (query strings are excluded), response status, duration, and
content-length values when available. Outgoing `http`/`https` and `fetch` calls
are recorded as client spans (collector/ingest URLs are skipped) and receive a
W3C `traceparent` header from the **client** span. Incoming requests continue a
trace when they include `traceparent`. For custom clients:

```ts
const parent = Monitor.extractTraceparent(req.headers.traceparent);
const span = Monitor.startSpan('HTTP GET /pay', { kind: 'client', parent });
headers.traceparent = Monitor.injectTraceparent(span);
```

For NestJS route templates (`GET /orders/:id`), exception filters, and
`LoggifyModule`, use [`@loggifycloud/nestjs`](../nestjs-sdk).

Runnable demo: `../test-app` (`Monitor.init`, then shim `pg` / `ioredis`).

## Node HTTP

```ts
import http from 'node:http';
import { Monitor } from '@loggifycloud/node';

Monitor.init({
  apiKey: process.env.MONITOR_API_KEY!,
  service: 'orders-api',
  environment: process.env.NODE_ENV ?? 'development',
});

http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  })
  .listen(3000);
```

## Express

No Loggify middleware is required. Initialize the SDK before Express creates
its underlying HTTP server:

```ts
import express from 'express';
import { Monitor } from '@loggifycloud/node';

Monitor.init({
  apiKey: process.env.MONITOR_API_KEY!,
  service: 'orders-api',
  environment: 'production',
});

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(3000);
```

## NestJS

Use `@loggifycloud/nestjs` so spans use controller routes (`/orders/:id`) and 5xx
exceptions are captured:

```ts
import { Monitor } from '@loggifycloud/nestjs';

Monitor.init({
  apiKey: process.env.LOGGIFY_KEY!,
  service: 'orders-api',
  environment: 'production',
});
```

Then import `LoggifyModule.forRoot()` in `AppModule`. See `../nestjs-sdk/README.md`.

## Logs

The existing `Monitor.log(message, attributes?)` API remains an `INFO` log.
Pass a level first for explicit severity, or use a convenience method:

```ts
Monitor.log('checkout started', { cartId: 'cart_123' }); // INFO
Monitor.log('WARN', 'payment retry', { attempt: 2 });

Monitor.debug('cache miss');
Monitor.info('order accepted');
Monitor.warn('queue delayed');
Monitor.error('payment failed');
Monitor.fatal('database unavailable');
```

Supported levels are `DEBUG`, `INFO`, `WARN`, `ERROR`, and `FATAL`.

After `Monitor.init`, existing `console.log` / `info` / `debug` / `warn` / `error`
calls are captured as logs too - the original console output is still printed.
Pass `captureConsole: false` to disable this.

```ts
console.info('order accepted', { orderId: 'ord_123' });
console.warn('queue delayed', { lagMs: 420 });
console.error('payment failed', { provider: 'stripe' });
```

Winston, Pino, Bunyan, loglevel, and npmlog are captured the same way after init.
Existing logger calls keep working; Loggify records them as structured logs.
Pass `captureLoggers: false` to disable this.

```ts
const winston = require('winston');
winston.createLogger().info('order accepted', { orderId: 'ord_123' });

const pino = require('pino');
pino().info({ orderId: 'ord_123' }, 'order accepted');

const bunyan = require('bunyan');
bunyan.createLogger({ name: 'api' }).info({ orderId: 'ord_123' }, 'order accepted');

const log = require('loglevel');
log.info('order accepted', { orderId: 'ord_123' });

const npmlog = require('npmlog');
npmlog.info('orders', 'order accepted', { orderId: 'ord_123' });
```

Call `Monitor.init` before creating those loggers, or at least before the first
log line. Already-loaded Winston / Pino / Bunyan / loglevel / npmlog instances
are patched as well.

Uncaught exceptions are observed through Node's `uncaughtExceptionMonitor`
event. Loggify does not install an `uncaughtException` handler, so it does not
prevent Node's normal crash behavior. Applications remain responsible for any
explicit shutdown and final-flush policy.
