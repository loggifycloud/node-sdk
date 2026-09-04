const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const { Monitor } = require('../dist');

test('captures incoming requests once and supports log severities', async (t) => {
  const posts = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    return { status: 202 };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  Monitor.init({
    apiKey: 'test-key',
    service: 'test-service',
    environment: 'test',
    endpoint: 'http://collector.invalid',
    flushIntervalMs: 60_000,
    captureConsole: false,
  });

  const server = http.createServer((_req, res) => {
    res.statusCode = 201;
    res.setHeader('content-length', '2');
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${address.port}/orders/123?token=hidden`, (res) => {
        res.resume();
        res.once('end', resolve);
      })
      .once('error', reject);
  });
  await new Promise((resolve) => setImmediate(resolve));

  await Monitor.flush();
  const ingest = posts.find((post) => post.url.endsWith('/v1/ingest'));
  assert.ok(ingest);
  const incoming = ingest.body.httpRequests.filter((event) => event.route === '/orders/123');
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].method, 'GET');
  assert.equal(incoming[0].statusCode, 201);
  assert.equal(incoming[0].responseSize, 2);
  assert.equal(typeof incoming[0].durationMs, 'number');
  assert.ok(incoming[0].durationMs >= 0);
  assert.match(incoming[0].traceId ?? '', /^[0-9a-f]{32}$/);

  const httpSpans = (ingest.body.traces ?? []).flatMap((trace) => trace.spans);
  assert.ok(httpSpans.some((span) => span.kind === 'server' && span.name === 'GET /orders/123'));

  await Monitor.withSpan(
    'charge card',
    async (span) => {
      span.setAttribute('payment.provider', 'test');
      assert.deepEqual(Monitor.currentTraceContext(), {
        traceId: span.traceId,
        spanId: span.spanId,
      });
    },
    { kind: 'client' },
  );
  await Monitor.flush();
  const charge = posts
    .filter((post) => post.url.endsWith('/v1/ingest'))
    .flatMap((post) => post.body.traces ?? [])
    .flatMap((trace) => trace.spans ?? [])
    .find((span) => span.name === 'charge card');
  assert.ok(charge);
  assert.equal(charge.kind, 'client');
  assert.equal(charge.attributes['payment.provider'], 'test');

  Monitor.log('legacy info', { compatible: true });
  Monitor.log('WARN', 'explicit warning', { attempt: 2 });
  Monitor.fatal('fatal message');
  await new Promise((resolve) => setImmediate(resolve));

  const logs = posts
    .filter((post) => post.url.endsWith('/v1/logs'))
    .map((post) => post.body.logs[0]);
  assert.deepEqual(
    logs.map(({ level, message }) => ({ level, message })),
    [
      { level: 'INFO', message: 'legacy info' },
      { level: 'WARN', message: 'explicit warning' },
      { level: 'FATAL', message: 'fatal message' },
    ],
  );
  const expectedHost = require('node:os').hostname();
  for (const log of logs) {
    assert.equal(log.attributes.hostname, expectedHost);
  }
  assert.equal(logs[0].attributes.compatible, true);
  assert.equal(charge.attributes.hostname, expectedHost);
});

test('overrides incoming HTTP route and span name from the request context', async (t) => {
  const posts = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    return { status: 202 };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  Monitor.init({
    apiKey: 'test-key',
    service: 'test-service',
    environment: 'test',
    endpoint: 'http://collector.invalid',
    flushIntervalMs: 60_000,
    captureConsole: false,
  });

  const server = http.createServer((_req, res) => {
    Monitor.setHttpRoute('/orders/:id');
    Monitor.setSpanName('GET /orders/:id');
    Monitor.setSpanAttribute('nestjs.controller', 'OrdersController');
    Monitor.log('INFO', 'looking up order');
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${address.port}/orders/42`, (res) => {
        res.resume();
        res.once('end', resolve);
      })
      .once('error', reject);
  });
  await new Promise((resolve) => setImmediate(resolve));

  await Monitor.flush();
  const ingest = posts.find((post) => post.url.endsWith('/v1/ingest'));
  assert.ok(ingest);
  const incoming = ingest.body.httpRequests.filter((event) => event.route === '/orders/:id');
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].method, 'GET');
  const httpSpans = (ingest.body.traces ?? []).flatMap((trace) => trace.spans);
  const serverSpan = httpSpans.find(
    (span) => span.kind === 'server' && span.name === 'GET /orders/:id',
  );
  assert.ok(serverSpan);
  assert.equal(serverSpan.attributes['http.route'], '/orders/:id');
  assert.equal(serverSpan.attributes['nestjs.controller'], 'OrdersController');
  const lookup = posts
    .filter((post) => post.url.endsWith('/v1/logs'))
    .map((post) => post.body.logs[0])
    .find((log) => log.message === 'looking up order');
  assert.ok(lookup);
  assert.equal(lookup.attributes['http.route'], '/orders/:id');
});

test('attaches hostname to logs and spans and allows override', async (t) => {
  const posts = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    return { status: 202 };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  Monitor.init({
    apiKey: 'test-key',
    service: 'test-service',
    environment: 'test',
    endpoint: 'http://collector.invalid',
    flushIntervalMs: 60_000,
    captureConsole: false,
    hostname: 'orders-api-7d9f8c-xk2p1',
  });

  Monitor.info('from replica');
  await Monitor.withSpan('work', async () => {});
  await new Promise((resolve) => setImmediate(resolve));
  await Monitor.flush();

  const log = posts
    .filter((post) => post.url.endsWith('/v1/logs'))
    .map((post) => post.body.logs[0])
    .find((row) => row.message === 'from replica');
  assert.ok(log);
  assert.equal(log.attributes.hostname, 'orders-api-7d9f8c-xk2p1');

  const work = posts
    .filter((post) => post.url.endsWith('/v1/ingest'))
    .flatMap((post) => post.body.traces ?? [])
    .flatMap((trace) => trace.spans ?? [])
    .find((span) => span.name === 'work');
  assert.ok(work);
  assert.equal(work.attributes.hostname, 'orders-api-7d9f8c-xk2p1');

  Monitor.info('manual host', { hostname: 'custom-host' });
  await new Promise((resolve) => setImmediate(resolve));
  const manual = posts
    .filter((post) => post.url.endsWith('/v1/logs'))
    .map((post) => post.body.logs[0])
    .find((row) => row.message === 'manual host');
  assert.ok(manual);
  assert.equal(manual.attributes.hostname, 'custom-host');
});

test('captures console output as logs when Monitor APIs are not used', () => {
  const sdkPath = path.resolve(__dirname, '../dist');
  const script = `
    const posts = [];
    global.fetch = async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return { status: 202 };
    };
    const { Monitor } = require(${JSON.stringify(sdkPath)});
    Monitor.init({
      apiKey: 'test-key',
      service: 'test-service',
      environment: 'test',
      endpoint: 'http://collector.invalid',
      flushIntervalMs: 60_000,
    });
    console.info('order accepted', { orderId: 'ord_123' });
    console.warn('queue delayed', { lagMs: 420 });
    console.error('payment failed', { provider: 'stripe' });
    console.log('retry scheduled', { attempt: 2 });
    setImmediate(() => {
      const logs = posts
        .filter((post) => String(post.url).endsWith('/v1/logs'))
        .map((post) => post.body.logs[0]);
      process.stdout.write('__RESULT__' + JSON.stringify(logs.map((log) => ({
        level: log.level,
        message: log.message,
        source: log.attributes.source,
        orderId: log.attributes.orderId,
        lagMs: log.attributes.lagMs,
        provider: log.attributes.provider,
        attempt: log.attributes.attempt,
      }))));
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const marker = '__RESULT__';
  const idx = child.stdout.lastIndexOf(marker);
  assert.ok(idx >= 0, child.stdout);
  const logs = JSON.parse(child.stdout.slice(idx + marker.length));
  assert.deepEqual(logs, [
    { level: 'INFO', message: 'order accepted', source: 'console', orderId: 'ord_123' },
    { level: 'WARN', message: 'queue delayed', source: 'console', lagMs: 420 },
    { level: 'ERROR', message: 'payment failed', source: 'console', provider: 'stripe' },
    { level: 'INFO', message: 'retry scheduled', source: 'console', attempt: 2 },
  ]);
});

test('captures winston, pino, bunyan, loglevel, and npmlog without duplicating console', () => {
  const sdkPath = path.resolve(__dirname, '../dist');
  const modulesPath = path.resolve(__dirname, 'fixtures/modules');
  const script = `
    const posts = [];
    global.fetch = async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return { status: 202 };
    };
    const { Monitor } = require(${JSON.stringify(sdkPath)});
    Monitor.init({
      apiKey: 'test-key',
      service: 'test-service',
      environment: 'test',
      endpoint: 'http://collector.invalid',
      flushIntervalMs: 60_000,
    });
    const winston = require('winston');
    winston.createLogger().info('order accepted', { orderId: 'ord_123' });
    winston.createLogger().warn('queue delayed', { lagMs: 420 });
    winston.createLogger().error('payment failed', { provider: 'stripe' });

    const pino = require('pino');
    const pinoLog = pino();
    pinoLog.info({ orderId: 'ord_123' }, 'order accepted');
    pinoLog.warn({ lagMs: 420 }, 'queue delayed');
    pinoLog.error({ provider: 'stripe' }, 'payment failed');

    const bunyan = require('bunyan');
    const bunyanLog = bunyan.createLogger({ name: 'api' });
    bunyanLog.info({ orderId: 'ord_123' }, 'order accepted');
    bunyanLog.warn({ lagMs: 420 }, 'queue delayed');
    bunyanLog.error({ provider: 'stripe' }, 'payment failed');

    const loglevel = require('loglevel');
    loglevel.info('order accepted', { orderId: 'ord_123' });
    loglevel.warn('queue delayed', { lagMs: 420 });
    loglevel.error('payment failed', { provider: 'stripe' });

    const npmlog = require('npmlog');
    npmlog.info('orders', 'order accepted', { orderId: 'ord_123' });
    npmlog.warn('queue', 'queue delayed', { lagMs: 420 });
    npmlog.error('pay', 'payment failed', { provider: 'stripe' });

    setImmediate(() => {
      const logs = posts
        .filter((post) => String(post.url).endsWith('/v1/logs'))
        .map((post) => post.body.logs[0])
        .map((log) => {
          const row = { level: log.level, message: log.message, source: log.attributes.source };
          for (const key of ['orderId', 'lagMs', 'provider', 'prefix']) {
            if (log.attributes[key] !== undefined) row[key] = log.attributes[key];
          }
          return row;
        });
      process.stdout.write('__RESULT__' + JSON.stringify(logs));
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: modulesPath },
  });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  const marker = '__RESULT__';
  const idx = child.stdout.lastIndexOf(marker);
  assert.ok(idx >= 0, child.stdout);
  const logs = JSON.parse(child.stdout.slice(idx + marker.length));
  assert.deepEqual(
    logs.filter((log) => log.source === 'winston'),
    [
      { level: 'INFO', message: 'order accepted', source: 'winston', orderId: 'ord_123' },
      { level: 'WARN', message: 'queue delayed', source: 'winston', lagMs: 420 },
      { level: 'ERROR', message: 'payment failed', source: 'winston', provider: 'stripe' },
    ],
  );
  assert.deepEqual(
    logs.filter((log) => log.source === 'pino'),
    [
      { level: 'INFO', message: 'order accepted', source: 'pino', orderId: 'ord_123' },
      { level: 'WARN', message: 'queue delayed', source: 'pino', lagMs: 420 },
      { level: 'ERROR', message: 'payment failed', source: 'pino', provider: 'stripe' },
    ],
  );
  assert.deepEqual(
    logs.filter((log) => log.source === 'bunyan'),
    [
      { level: 'INFO', message: 'order accepted', source: 'bunyan', orderId: 'ord_123' },
      { level: 'WARN', message: 'queue delayed', source: 'bunyan', lagMs: 420 },
      { level: 'ERROR', message: 'payment failed', source: 'bunyan', provider: 'stripe' },
    ],
  );
  assert.deepEqual(
    logs.filter((log) => log.source === 'loglevel'),
    [
      { level: 'INFO', message: 'order accepted', source: 'loglevel', orderId: 'ord_123' },
      { level: 'WARN', message: 'queue delayed', source: 'loglevel', lagMs: 420 },
      { level: 'ERROR', message: 'payment failed', source: 'loglevel', provider: 'stripe' },
    ],
  );
  assert.deepEqual(
    logs.filter((log) => log.source === 'npmlog'),
    [
      {
        level: 'INFO',
        message: 'order accepted',
        source: 'npmlog',
        orderId: 'ord_123',
        prefix: 'orders',
      },
      { level: 'WARN', message: 'queue delayed', source: 'npmlog', lagMs: 420, prefix: 'queue' },
      {
        level: 'ERROR',
        message: 'payment failed',
        source: 'npmlog',
        provider: 'stripe',
        prefix: 'pay',
      },
    ],
  );
  assert.equal(logs.filter((log) => log.source === 'console').length, 0);
});

test('does not capture third-party loggers when captureLoggers is false', () => {
  const sdkPath = path.resolve(__dirname, '../dist');
  const modulesPath = path.resolve(__dirname, 'fixtures/modules');
  const script = `
    const posts = [];
    global.fetch = async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return { status: 202 };
    };
    const { Monitor } = require(${JSON.stringify(sdkPath)});
    Monitor.init({
      apiKey: 'test-key',
      service: 'test-service',
      environment: 'test',
      endpoint: 'http://collector.invalid',
      flushIntervalMs: 60_000,
      captureConsole: false,
      captureLoggers: false,
    });
    require('winston').createLogger().info('order accepted', { orderId: 'ord_123' });
    require('pino')().info({ orderId: 'ord_123' }, 'order accepted');
    require('bunyan').createLogger({ name: 'api' }).info({ orderId: 'ord_123' }, 'order accepted');
    require('loglevel').info('order accepted', { orderId: 'ord_123' });
    require('npmlog').info('orders', 'order accepted', { orderId: 'ord_123' });
    setImmediate(() => {
      const logs = posts.filter((post) => String(post.url).endsWith('/v1/logs'));
      process.stdout.write('__RESULT__' + JSON.stringify(logs.length));
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: modulesPath },
  });
  assert.equal(child.status, 0, child.stderr);
  const marker = '__RESULT__';
  const idx = child.stdout.lastIndexOf(marker);
  assert.ok(idx >= 0, child.stdout);
  assert.equal(JSON.parse(child.stdout.slice(idx + marker.length)), 0);
});

test('does not prevent the process from crashing on an uncaught exception', () => {
  const sdkPath = path.resolve(__dirname, '../dist');
  const script = `
    const { Monitor } = require(${JSON.stringify(sdkPath)});
    Monitor.init({
      apiKey: 'test-key',
      service: 'test-service',
      environment: 'test',
      endpoint: 'http://collector.invalid'
    });
    throw new Error('expected crash');
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /expected crash/);
});

test('auto-instruments pg and redis queries under the request span', () => {
  const sdkPath = path.resolve(__dirname, '../dist');
  const modulesPath = path.resolve(__dirname, 'fixtures/modules');
  const script = `
    const http = require('node:http');
    const posts = [];
    const realFetch = global.fetch;
    global.fetch = async (url, init) => {
      if (String(url).startsWith('http://collector.invalid')) {
        posts.push({ url: String(url), body: JSON.parse(init.body) });
        return { status: 202 };
      }
      return realFetch(url, init);
    };
    const { Client } = require('pg');
    const Redis = require('ioredis');
    const { Monitor } = require(${JSON.stringify(sdkPath)});
    Monitor.init({
      apiKey: 'test-key',
      service: 'test-service',
      environment: 'test',
      endpoint: 'http://collector.invalid',
      flushIntervalMs: 60_000,
      captureConsole: false,
    });
    const db = new Client();
    const redis = new Redis();
    const server = http.createServer(async (_req, res) => {
      await redis.get('user:1');
      await db.query('SELECT * FROM users WHERE id = $1', [1]);
      res.statusCode = 200;
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      http.get('http://127.0.0.1:' + port + '/users/1', (res) => {
        res.resume();
        res.once('end', async () => {
          await new Promise((resolve) => setImmediate(resolve));
          await Monitor.flush();
          const traces = posts
            .filter((post) => String(post.url).endsWith('/v1/ingest'))
            .flatMap((post) => post.body.traces ?? []);
          process.stdout.write('__RESULT__' + JSON.stringify(traces));
          server.close();
          process.exit(0);
        });
      }).once('error', (err) => {
        console.error(err);
        process.exit(1);
      });
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: modulesPath },
  });
  assert.equal(child.status, 0, child.stderr);
  const marker = '__RESULT__';
  const idx = child.stdout.lastIndexOf(marker);
  assert.ok(idx >= 0, child.stdout);
  const traces = JSON.parse(child.stdout.slice(idx + marker.length));
  const spans = traces.flatMap((trace) =>
    (trace.spans ?? []).map((span) => ({ ...span, traceId: trace.traceId })),
  );
  const serverSpan = spans.find((span) => span.kind === 'server' && span.name === 'GET /users/1');
  const pgSpan = spans.find((span) => span.name === 'postgresql SELECT');
  const redisSpan = spans.find((span) => span.name === 'redis GET');
  assert.ok(serverSpan, 'missing server span');
  assert.ok(pgSpan, 'missing postgres span');
  assert.ok(redisSpan, 'missing redis span');
  assert.equal(pgSpan.attributes['db.system'], 'postgresql');
  assert.match(pgSpan.attributes['db.statement'], /SELECT \* FROM users/);
  assert.equal(redisSpan.attributes['db.system'], 'redis');
  assert.equal(pgSpan.traceId, serverSpan.traceId);
  assert.equal(redisSpan.traceId, serverSpan.traceId);
  assert.equal(pgSpan.parentSpanId, serverSpan.spanId);
  assert.equal(redisSpan.parentSpanId, serverSpan.spanId);
});

test('extracts and injects W3C traceparent across HTTP hops', async (t) => {
  const posts = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    return { status: 202 };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  Monitor.init({
    apiKey: 'test-key',
    service: 'orders-api',
    environment: 'test',
    endpoint: 'http://collector.invalid',
    flushIntervalMs: 60_000,
    captureConsole: false,
  });

  const parentTraceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const parentSpanId = 'bbbbbbbbbbbbbbbb';
  assert.deepEqual(Monitor.extractTraceparent(`00-${parentTraceId}-${parentSpanId}-01`), {
    traceId: parentTraceId,
    spanId: parentSpanId,
  });
  assert.equal(Monitor.extractTraceparent('not-a-trace'), undefined);
  await Monitor.withSpan('work', async (span) => {
    assert.equal(Monitor.injectTraceparent(), `00-${span.traceId}-${span.spanId}-01`);
    assert.equal(
      Monitor.injectTraceparent({ traceId: parentTraceId, spanId: parentSpanId }),
      `00-${parentTraceId}-${parentSpanId}-01`,
    );
  });

  const captured = [];
  const downstream = http.createServer((req, res) => {
    captured.push(req.headers.traceparent);
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolve) => downstream.listen(0, '127.0.0.1', resolve));
  t.after(() => downstream.close());
  const downstreamPort = downstream.address().port;

  const server = http.createServer((_req, res) => {
    http
      .get(`http://127.0.0.1:${downstreamPort}/pay`, (up) => {
        up.resume();
        up.once('end', () => {
          res.statusCode = 200;
          res.end('ok');
        });
      })
      .once('error', () => {
        res.statusCode = 502;
        res.end('bad');
      });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  await new Promise((resolve, reject) => {
    http
      .get(
        {
          hostname: '127.0.0.1',
          port,
          path: '/orders/1',
          headers: { traceparent: `00-${parentTraceId}-${parentSpanId}-01` },
        },
        (res) => {
          res.resume();
          res.once('end', resolve);
        },
      )
      .once('error', reject);
  });
  await new Promise((resolve) => setImmediate(resolve));
  await Monitor.flush();

  const ingest = posts.filter((post) => String(post.url).endsWith('/v1/ingest'));
  const traces = ingest.flatMap((post) => post.body.traces ?? []);
  const spans = traces.flatMap((trace) =>
    (trace.spans ?? []).map((span) => ({ ...span, traceId: trace.traceId })),
  );
  const serverSpan = spans.find((span) => span.kind === 'server' && span.name === 'GET /orders/1');
  const clientSpan = spans.find((span) => span.kind === 'client');
  assert.ok(serverSpan, 'missing inbound server span');
  assert.ok(clientSpan, 'missing outbound client span');
  assert.equal(serverSpan.traceId, parentTraceId);
  assert.equal(serverSpan.parentSpanId, parentSpanId);
  assert.equal(clientSpan.traceId, parentTraceId);
  assert.equal(clientSpan.parentSpanId, serverSpan.spanId);
  assert.equal(captured.length, 1);
  assert.equal(captured[0], `00-${clientSpan.traceId}-${clientSpan.spanId}-01`);
});

test('defaults to the cloud ingest URL when endpoint and LOGGIFY_ENDPOINT are omitted', async (t) => {
  const posts = [];
  const originalFetch = global.fetch;
  const previous = process.env.LOGGIFY_ENDPOINT;
  delete process.env.LOGGIFY_ENDPOINT;
  global.fetch = async (url) => {
    posts.push(String(url));
    return { status: 202 };
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (previous === undefined) delete process.env.LOGGIFY_ENDPOINT;
    else process.env.LOGGIFY_ENDPOINT = previous;
  });

  Monitor.init({
    apiKey: 'test-key',
    service: 'test-service',
    environment: 'test',
    endpoint: process.env.LOGGIFY_ENDPOINT,
    flushIntervalMs: 60_000,
    captureConsole: false,
    captureLoggers: false,
  });
  await Monitor.flush();
  assert.ok(posts.some((url) => url === 'https://ingest.loggify.cloud/v1/ingest'));
});

test('LOGGIFY_ENDPOINT overrides the default when init omits endpoint', async (t) => {
  const posts = [];
  const originalFetch = global.fetch;
  const previous = process.env.LOGGIFY_ENDPOINT;
  process.env.LOGGIFY_ENDPOINT = 'http://localhost:3001/';
  global.fetch = async (url) => {
    posts.push(String(url));
    return { status: 202 };
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (previous === undefined) delete process.env.LOGGIFY_ENDPOINT;
    else process.env.LOGGIFY_ENDPOINT = previous;
  });

  Monitor.init({
    apiKey: 'test-key',
    service: 'test-service',
    environment: 'test',
    flushIntervalMs: 60_000,
    captureConsole: false,
    captureLoggers: false,
  });
  await Monitor.flush();
  assert.ok(posts.some((url) => url === 'http://localhost:3001/v1/ingest'));
});
