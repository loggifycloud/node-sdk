import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import { format } from 'node:util';
import { installDatastoreInstrumentation } from './instrumentation';
import { installLoggerInstrumentation, isCapturingFromLogger } from './loggers';

export interface MonitorOptions {
  apiKey: string;
  service: string;
  environment: string;
  endpoint?: string;
  sampleRate?: number;
  flushIntervalMs?: number;
  maxBuffer?: number;
  timeoutMs?: number;
  /** Release / git SHA attached to errors and deployments. */
  release?: string;
  /**
   * Hostname attached to logs and spans. Defaults to `os.hostname()`
   * (the pod name in Kubernetes) or `HOSTNAME`.
   */
  hostname?: string;
  /** Capture `console.log` / `info` / `debug` / `warn` / `error` as logs. Default true. */
  captureConsole?: boolean;
  /** Capture Winston, Pino, Bunyan, loglevel, and npmlog. Default true. */
  captureLoggers?: boolean;
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanOptions {
  kind?: SpanKind;
  parent?: { traceId: string; spanId: string };
  timestamp?: string;
  durationMs?: number;
  attributes?: Record<string, unknown>;
}

export interface SpanContext {
  traceId: string;
  spanId: string;
}

export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  setName(name: string): this;
  setAttribute(key: string, value: unknown): this;
  setStatus(status: SpanStatus): this;
  end(status?: SpanStatus): void;
}

type HttpEvent = {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  requestSize?: number;
  responseSize?: number;
  timestamp?: string;
  serviceName?: string;
  environment?: string;
  traceId?: string;
};

type ErrorEvent = {
  message: string;
  exceptionType: string;
  stackTrace?: string;
  endpoint?: string;
  method?: string;
  statusCode?: number;
  traceId?: string;
  release?: string;
  userId?: string;
  user?: Record<string, string>;
  breadcrumbs?: Array<{ timestamp: string; category: string; message: string; level?: string; data?: Record<string, string> }>;
};

type MetricEvent = {
  metricName: string;
  value: number;
  tags?: Record<string, string>;
  serviceName?: string;
  environment?: string;
};

type SpanEvent = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  timestamp: string;
  durationMs: number;
  attributes?: Record<string, unknown>;
  serviceName: string;
  environment: string;
};

type ActiveSpanStore = SpanContext & {
  httpRoute?: string;
  span?: SpanHandle;
};

class BufferQueue<T> {
  items: T[] = [];
  constructor(private readonly max: number) {}
  push(item: T) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push(item);
  }
  drain(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function resolveHostname(override?: string): string {
  const trimmed = typeof override === 'string' ? override.trim() : '';
  if (trimmed) return trimmed.slice(0, 255);
  try {
    const host = osHostname();
    if (typeof host === 'string' && host.trim()) return host.trim().slice(0, 255);
  } catch {
    /* ignore */
  }
  const env = typeof process.env.HOSTNAME === 'string' ? process.env.HOSTNAME.trim() : '';
  return (env || 'localhost').slice(0, 255);
}

class MonitorImpl {
  private opts!: MonitorOptions;
  private httpBuf!: BufferQueue<HttpEvent>;
  private errorBuf!: BufferQueue<ErrorEvent>;
  private metricBuf!: BufferQueue<MetricEvent>;
  private spanBuf!: BufferQueue<SpanEvent>;
  private readonly traceContext = new AsyncLocalStorage<ActiveSpanStore>();
  private timer?: NodeJS.Timeout;
  private runtimeTimer?: NodeJS.Timeout;
  private instrumented = false;
  private fetchInstrumented = false;
  private datastoresInstrumented = false;
  private errorsInstrumented = false;
  private consoleInstrumented = false;
  private loggersInstrumented = false;
  private capturingConsole = false;
  private currentUser: Record<string, string> = {};
  private breadcrumbs: Array<{
    timestamp: string;
    category: string;
    message: string;
    level?: string;
    data?: Record<string, string>;
  }> = [];
  private release = '';
  private hostname = '';

  init(options: MonitorOptions) {
    this.opts = {
      endpoint: 'https://ingest.loggify.cloud',
      sampleRate: 1,
      flushIntervalMs: 2000,
      maxBuffer: 500,
      timeoutMs: 1500,
      captureConsole: true,
      captureLoggers: true,
      ...options,
    };
    this.release = options.release ?? this.release;
    this.hostname = resolveHostname(options.hostname);
    this.httpBuf = new BufferQueue(this.opts.maxBuffer!);
    this.errorBuf = new BufferQueue(this.opts.maxBuffer!);
    this.metricBuf = new BufferQueue(this.opts.maxBuffer!);
    this.spanBuf = new BufferQueue(this.opts.maxBuffer!);
    this.instrumentHttp();
    this.instrumentFetch();
    this.instrumentDatastores();
    this.instrumentErrors();
    this.instrumentConsole();
    this.instrumentLoggers();
    this.instrumentRuntime();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
    this.timer.unref?.();
  }

  captureException(err: unknown, extra?: Partial<ErrorEvent>) {
    try {
      const error = err instanceof Error ? err : new Error(String(err));
      const payload = {
        message: error.message,
        exceptionType: error.name,
        stackTrace: error.stack,
        traceId: this.traceContext.getStore()?.traceId,
        release: this.release || undefined,
        userId: this.currentUser.id || this.currentUser.userId || undefined,
        user: Object.keys(this.currentUser).length ? { ...this.currentUser } : undefined,
        breadcrumbs: this.breadcrumbs.slice(-50),
        ...extra,
      };
      this.errorBuf.push(payload);
      const logAttributes: Record<string, unknown> = {
        exceptionType: error.name,
        stackTrace: error.stack,
      };
      if (extra?.endpoint) logAttributes.endpoint = extra.endpoint;
      if (extra?.method) logAttributes.method = extra.method;
      if (extra?.statusCode) logAttributes.statusCode = extra.statusCode;
      this.log('ERROR', `${error.name}: ${error.message}`, logAttributes);
    } catch {
      /* never throw into host app */
    }
  }

  startSpan(name: string, options: SpanOptions = {}): SpanHandle {
    const active = options.parent ?? this.traceContext.getStore();
    const traceId = active?.traceId ?? randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    const parentSpanId = active?.spanId;
    const startedAt = options.timestamp ?? new Date().toISOString();
    const started = process.hrtime.bigint();
    const attributes = { ...(options.attributes ?? {}) };
    this.attachHostname(attributes);
    let spanName = String(name).slice(0, 512);
    let status: SpanStatus = 'unset';
    let ended = false;
    const handle: SpanHandle = {
      traceId,
      spanId,
      parentSpanId,
      setName(value) {
        if (!ended) spanName = String(value).slice(0, 512);
        return this;
      },
      setAttribute(key, value) {
        if (!ended) attributes[key] = value;
        return this;
      },
      setStatus(value) {
        status = value;
        return this;
      },
      end: (finalStatus) => {
        if (ended) return;
        ended = true;
        if (Math.random() > (this.opts.sampleRate ?? 1)) return;
        this.spanBuf.push({
          traceId,
          spanId,
          parentSpanId,
          name: spanName,
          kind: options.kind ?? 'internal',
          status: finalStatus ?? status,
          timestamp: startedAt,
          durationMs:
            options.durationMs ?? Number(process.hrtime.bigint() - started) / 1_000_000,
          attributes,
          serviceName: this.opts.service,
          environment: this.opts.environment,
        });
      },
    };
    return handle;
  }

  async withSpan<T>(
    name: string,
    operation: (span: SpanHandle) => T | Promise<T>,
    options: SpanOptions = {},
  ): Promise<T> {
    const span = this.startSpan(name, options);
    return this.traceContext.run({ traceId: span.traceId, spanId: span.spanId, span }, async () => {
      try {
        const result = await operation(span);
        span.end();
        return result;
      } catch (error) {
        span.end('error');
        throw error;
      }
    });
  }

  currentTraceContext(): Readonly<SpanContext> | undefined {
    const context = this.traceContext.getStore();
    return context ? { traceId: context.traceId, spanId: context.spanId } : undefined;
  }

  setUser(user: Record<string, string> | null) {
    this.currentUser = user ? { ...user } : {};
    return this;
  }

  addBreadcrumb(crumb: { category?: string; message: string; level?: string; data?: Record<string, string> }) {
    this.breadcrumbs.push({
      timestamp: new Date().toISOString(),
      category: crumb.category ?? 'manual',
      message: String(crumb.message).slice(0, 512),
      level: crumb.level,
      data: crumb.data,
    });
    if (this.breadcrumbs.length > 50) this.breadcrumbs.shift();
    return this;
  }

  setRelease(release: string) {
    this.release = release;
    if (this.opts) this.opts.release = release;
    return this;
  }

  captureDeployment(data: { release?: string; gitSha?: string }) {
    const release = data.release ?? this.release;
    if (!release || !this.opts) return;
    void this.post('/v1/deployments', {
      deployments: [
        {
          release,
          gitSha: data.gitSha,
          environment: this.opts.environment,
          serviceName: this.opts.service,
        },
      ],
    });
  }

  extractTraceparent(value?: string | string[] | null): SpanContext | undefined {
    const header = Array.isArray(value) ? value[0] : value;
    if (typeof header !== 'string') return undefined;
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/i.exec(header.trim());
    if (!match) return undefined;
    return { traceId: match[1].toLowerCase(), spanId: match[2].toLowerCase() };
  }

  injectTraceparent(context?: SpanContext): string | undefined {
    const active = context ?? this.traceContext.getStore();
    if (!active?.traceId || !active?.spanId) return undefined;
    return `00-${active.traceId}-${active.spanId}-01`;
  }

  isCollectorUrl(url: string): boolean {
    const endpoint = this.opts?.endpoint;
    return typeof endpoint === 'string' && endpoint.length > 0 && String(url).startsWith(endpoint);
  }

  setHttpRoute(route: string) {
    try {
      const store = this.traceContext.getStore();
      if (!store) return;
      store.httpRoute = String(route).slice(0, 512);
    } catch {
      /* never throw into host app */
    }
  }

  setSpanName(name: string) {
    try {
      this.traceContext.getStore()?.span?.setName(name);
    } catch {
      /* never throw into host app */
    }
  }

  setSpanAttribute(key: string, value: unknown) {
    try {
      this.traceContext.getStore()?.span?.setAttribute(key, value);
    } catch {
      /* never throw into host app */
    }
  }

  log(message: string, attributes?: Record<string, unknown>): void;
  log(level: LogLevel, message: string, attributes?: Record<string, unknown>): void;
  log(
    levelOrMessage: LogLevel | string,
    messageOrAttributes?: string | Record<string, unknown>,
    attributes?: Record<string, unknown>,
  ) {
    try {
      const hasExplicitLevel = typeof messageOrAttributes === 'string';
      const level = hasExplicitLevel ? this.normalizeLogLevel(levelOrMessage) : 'INFO';
      const message = hasExplicitLevel ? messageOrAttributes : levelOrMessage;
      const givenAttributes = hasExplicitLevel
        ? attributes
        : (messageOrAttributes as Record<string, unknown> | undefined);
      const context = this.traceContext.getStore();
      const logAttributes: Record<string, unknown> = { ...(givenAttributes ?? {}) };
      if (context) {
        logAttributes.traceId = context.traceId;
        logAttributes.spanId = context.spanId;
        if (context.httpRoute && logAttributes['http.route'] == null) {
          logAttributes['http.route'] = context.httpRoute;
        }
      }
      this.attachHostname(logAttributes);

      void this.post('/v1/logs', {
        logs: [
          {
            level,
            message,
            attributes: Object.keys(logAttributes).length ? logAttributes : givenAttributes,
            serviceName: this.opts.service,
            environment: this.opts.environment,
            timestamp: new Date().toISOString(),
          },
        ],
      });
    } catch {
      /* never throw into host app */
    }
  }

  debug(message: string, attributes?: Record<string, unknown>) {
    this.log('DEBUG', message, attributes);
  }

  info(message: string, attributes?: Record<string, unknown>) {
    this.log('INFO', message, attributes);
  }

  warn(message: string, attributes?: Record<string, unknown>) {
    this.log('WARN', message, attributes);
  }

  error(message: string, attributes?: Record<string, unknown>) {
    this.log('ERROR', message, attributes);
  }

  fatal(message: string, attributes?: Record<string, unknown>) {
    this.log('FATAL', message, attributes);
  }

  private attachHostname(attributes: Record<string, unknown>) {
    if (!this.hostname || attributes.hostname != null) return;
    attributes.hostname = this.hostname;
  }

  private normalizeLogLevel(value: string): LogLevel {
    const level = value.toUpperCase();
    if (
      level === 'DEBUG' ||
      level === 'INFO' ||
      level === 'WARN' ||
      level === 'ERROR' ||
      level === 'FATAL'
    ) {
      return level;
    }
    return 'INFO';
  }

  private instrumentHttp() {
    if (this.instrumented) return;
    this.instrumented = true;
    try {
      const http = require('http');
      const https = require('https');
      this.patchOutgoing(http);
      this.patchOutgoing(https);
      this.patchIncoming(http);
      this.patchIncoming(https);
    } catch {
      /* ignore */
    }
  }

  private instrumentFetch() {
    if (this.fetchInstrumented) return;
    if (typeof globalThis.fetch !== 'function') return;
    this.fetchInstrumented = true;

    const original = globalThis.fetch;
    const patchMarker = Symbol.for('loggify.node.fetch-patched');
    if ((original as unknown as Record<symbol, boolean>)[patchMarker]) return;

    const self = this;
    const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const url = self.fetchUrl(input);
      if (self.isCollectorUrl(url) || self.fetchHasTraceparent(input, init)) {
        return original.call(this, input, init);
      }

      const method = (
        init?.method ??
        (typeof input === 'object' && 'method' in input ? input.method : 'GET') ??
        'GET'
      )
        .toString()
        .toUpperCase();
      const path = self.requestPath(url);
      const span = self.startSpan(`HTTP ${method} ${path}`, {
        kind: 'client',
        attributes: {
          'http.method': method,
          'http.url': url.slice(0, 512),
          'http.route': path,
        },
      });

      return self.traceContext.run({ traceId: span.traceId, spanId: span.spanId, span }, () => {
        const headers = self.headersWithTraceparent(init?.headers, input);
        const nextInit = { ...init, headers };
        return Promise.resolve(original.call(this, input, nextInit)).then(
          (res) => {
            span.setAttribute('http.status_code', res.status);
            span.end(res.status >= 500 ? 'error' : 'ok');
            return res;
          },
          (error) => {
            span.end('error');
            throw error;
          },
        );
      });
    };
    Object.defineProperty(wrapped, patchMarker, { value: true });
    globalThis.fetch = wrapped as typeof fetch;
  }

  private instrumentDatastores() {
    if (this.datastoresInstrumented) return;
    this.datastoresInstrumented = true;
    try {
      installDatastoreInstrumentation({
        startSpan: (name, options) => this.startSpan(name, options),
        runInContext: (context, fn) => this.traceContext.run(context, fn),
      });
    } catch {
      /* never throw into host app */
    }
  }

  private patchOutgoing(mod: any) {
    const original = mod.request;
    const patchMarker = Symbol.for('loggify.node.outgoing-http-patched');
    if (original?.[patchMarker]) return;

    const self = this;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const start = Date.now();
      const url = self.outgoingUrl(args);
      if (self.isCollectorUrl(url) || self.outgoingHasTraceparent(args)) {
        return original.apply(this, args);
      }

      const method = self.outgoingMethod(args);
      const parent = self.traceContext.getStore();
      const path = self.requestPath(url);
      const span = self.startSpan(`HTTP ${method} ${path}`, {
        kind: 'client',
        attributes: {
          'http.method': method,
          'http.url': url.slice(0, 512),
          'http.route': path,
        },
      });

      return self.traceContext.run({ traceId: span.traceId, spanId: span.spanId, span }, () => {
        const context = self.traceContext.getStore();
        const req = original.apply(this, args);
        const header = self.injectTraceparent();
        if (header && typeof req.setHeader === 'function') {
          req.setHeader('traceparent', header);
        }
        let ended = false;
        const finish = (status?: SpanStatus, statusCode?: number) => {
          if (ended) return;
          ended = true;
          if (statusCode !== undefined) span.setAttribute('http.status_code', statusCode);
          span.end(status);
        };
        req.on('response', (res: { statusCode?: number }) => {
          try {
            const statusCode = res.statusCode ?? 0;
            finish(statusCode >= 500 ? 'error' : 'ok', statusCode);
            if (Math.random() > (self.opts.sampleRate ?? 1)) return;
            self.httpBuf.push({
              method: (req as { method?: string }).method ?? method,
              route: url,
              statusCode,
              durationMs: Date.now() - start,
              serviceName: self.opts.service,
              environment: self.opts.environment,
              timestamp: new Date().toISOString(),
              traceId: context?.traceId ?? parent?.traceId,
            });
          } catch {
            /* ignore */
          }
        });
        req.on('error', () => finish('error'));
        return req;
      });
    };
    Object.defineProperty(wrapped, patchMarker, { value: true });
    mod.request = wrapped;
    if (typeof mod.get === 'function' && !mod.get[patchMarker]) {
      const wrappedGet = function (this: unknown, ...args: unknown[]) {
        const req = wrapped.apply(this, args);
        if (req && typeof req.end === 'function') req.end();
        return req;
      };
      Object.defineProperty(wrappedGet, patchMarker, { value: true });
      mod.get = wrappedGet;
    }
  }

  // Patching Server.emit instruments plain Node, Express, Fastify, and other
  // frameworks without changing listener order or consuming request streams.
  private patchIncoming(mod: any) {
    const prototype = mod.Server?.prototype;
    if (!prototype) return;

    const patchMarker = Symbol.for('loggify.node.incoming-http-patched');
    if (prototype[patchMarker]) return;

    const originalEmit = prototype.emit;
    const self = this;
    prototype.emit = function (event: string | symbol, ...args: unknown[]) {
      if (event === 'request') {
        return self.traceIncomingRequest(this, originalEmit, args);
      }
      return originalEmit.call(this, event, ...args);
    };
    Object.defineProperty(prototype, patchMarker, { value: true });
  }

  private traceIncomingRequest(
    server: unknown,
    originalEmit: (...args: unknown[]) => unknown,
    args: unknown[],
  ) {
    try {
      const request = args[0] as {
        method?: string;
        url?: string;
        headers?: Record<string, string | string[] | undefined>;
      };
      const path = this.requestPath(request?.url);
      const method = request?.method ?? 'GET';
      const span = this.startSpan(`${method} ${path}`, {
        kind: 'server',
        parent: this.extractTraceparent(request?.headers?.traceparent),
        attributes: {
          'http.method': method,
          'http.route': path,
        },
      });
      return this.traceContext.run(
        { traceId: span.traceId, spanId: span.spanId, span, httpRoute: path },
        () => {
          this.observeIncomingRequest(request, args[1], span);
          return originalEmit.call(server, 'request', ...args);
        },
      );
    } catch {
      return originalEmit.call(server, 'request', ...args);
    }
  }

  private observeIncomingRequest(requestValue: unknown, responseValue: unknown, span?: SpanHandle) {
    try {
      const request = requestValue as {
        method?: string;
        url?: string;
        headers?: Record<string, string | string[] | undefined>;
      };
      const response = responseValue as {
        statusCode?: number;
        getHeader?(name: string): number | string | string[] | undefined;
        once?(event: string, listener: () => void): unknown;
      };
      if (!request || !response?.once) {
        span?.end('ok');
        return;
      }

      const requestMarker = Symbol.for('loggify.node.incoming-http-observed');
      const markedResponse = response as typeof response & Record<symbol, boolean>;
      if (markedResponse[requestMarker]) return;
      Object.defineProperty(markedResponse, requestMarker, { value: true });

      const start = process.hrtime.bigint();
      let recorded = false;
      const record = () => {
        if (recorded) return;
        recorded = true;
        try {
          const path = this.traceContext.getStore()?.httpRoute ?? this.requestPath(request.url);
          const statusCode = response.statusCode ?? 0;
          if (span) {
            span.setAttribute('http.status_code', statusCode);
            if (path) span.setAttribute('http.route', path);
            span.end(statusCode >= 500 ? 'error' : 'ok');
          }
          if (Math.random() > (this.opts.sampleRate ?? 1)) return;

          const requestLength = this.parseContentLength(request.headers?.['content-length']);
          const responseLength = this.parseContentLength(response.getHeader?.('content-length'));
          this.httpBuf.push({
            method: request.method ?? 'GET',
            route: path,
            statusCode,
            durationMs: Number(process.hrtime.bigint() - start) / 1_000_000,
            requestSize: requestLength,
            responseSize: responseLength,
            serviceName: this.opts.service,
            environment: this.opts.environment,
            timestamp: new Date().toISOString(),
            traceId: span?.traceId,
          });
        } catch {
          /* never throw into host app */
        }
      };

      response.once('finish', record);
      response.once('close', record);
    } catch {
      span?.end('ok');
    }
  }

  private requestPath(rawUrl?: string) {
    const raw = rawUrl ?? '/';
    try {
      return new URL(raw, 'http://loggify.local').pathname;
    } catch {
      return raw.split('?')[0] || '/';
    }
  }

  private outgoingUrl(args: unknown[]): string {
    const first = args[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') {
      const opts = first as {
        href?: string;
        protocol?: string;
        host?: string;
        hostname?: string;
        port?: string | number;
        path?: string;
      };
      if (opts.href) return opts.href;
      const protocol = opts.protocol ?? 'http:';
      const host = opts.host ?? opts.hostname ?? 'localhost';
      return `${protocol}//${host}${opts.path ?? '/'}`;
    }
    return '/';
  }

  private outgoingMethod(args: unknown[]) {
    for (const arg of args) {
      if (arg && typeof arg === 'object' && !Array.isArray(arg) && 'method' in arg) {
        return String((arg as { method?: string }).method ?? 'GET').toUpperCase();
      }
    }
    return 'GET';
  }

  private fetchUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    if (typeof input === 'object' && input && 'url' in input) return String(input.url);
    return '';
  }

  private headersWithTraceparent(
    initHeaders: HeadersInit | undefined,
    input: RequestInfo | URL,
  ): Headers {
    const headers = new Headers(initHeaders);
    if (
      (!initHeaders || [...headers.keys()].length === 0) &&
      typeof input === 'object' &&
      input &&
      'headers' in input
    ) {
      new Headers(input.headers).forEach((value, key) => headers.set(key, value));
    }
    const header = this.injectTraceparent();
    if (header) headers.set('traceparent', header);
    return headers;
  }

  private fetchHasTraceparent(input: RequestInfo | URL, init?: RequestInit) {
    if (this.hasTraceparentHeader(init?.headers)) return true;
    if (typeof input === 'object' && input && 'headers' in input) {
      return this.hasTraceparentHeader(input.headers);
    }
    return false;
  }

  private outgoingHasTraceparent(args: unknown[]) {
    for (const arg of args) {
      if (!arg || typeof arg !== 'object' || Array.isArray(arg) || !('headers' in arg)) continue;
      if (this.hasTraceparentHeader((arg as { headers?: unknown }).headers)) return true;
    }
    return false;
  }

  private hasTraceparentHeader(headers: unknown) {
    if (!headers) return false;
    if (typeof (headers as { get?: unknown }).get === 'function') {
      const value = (headers as { get: (name: string) => unknown }).get('traceparent');
      if (value) return true;
    }
    if (headers instanceof Headers) return headers.has('traceparent');
    if (Array.isArray(headers)) {
      return headers.some(
        (pair) => Array.isArray(pair) && String(pair[0]).toLowerCase() === 'traceparent',
      );
    }
    if (typeof headers === 'object') {
      return Object.keys(headers as object).some((key) => key.toLowerCase() === 'traceparent');
    }
    return false;
  }

  private parseContentLength(value: number | string | string[] | undefined): number | undefined {
    const candidate = Array.isArray(value) ? value[0] : value;
    if (candidate === undefined) return undefined;
    const length = Number(candidate);
    return Number.isFinite(length) && length >= 0 ? length : undefined;
  }

  private instrumentErrors() {
    if (this.errorsInstrumented) return;
    this.errorsInstrumented = true;

    // Unlike `uncaughtException`, this monitor event does not suppress Node's
    // default exception handling and the process still exits normally.
    process.on('uncaughtExceptionMonitor', (err) => this.captureException(err));
    process.on('unhandledRejection', (reason) => this.captureException(reason));
  }

  private instrumentConsole() {
    if (this.consoleInstrumented) return;
    this.consoleInstrumented = true;

    const methods: Array<[method: 'debug' | 'info' | 'log' | 'warn' | 'error', level: LogLevel]> = [
      ['debug', 'DEBUG'],
      ['info', 'INFO'],
      ['log', 'INFO'],
      ['warn', 'WARN'],
      ['error', 'ERROR'],
    ];
    const patchMarker = Symbol.for('loggify.node.console-patched');

    for (const [method, level] of methods) {
      const original = console[method];
      if (typeof original !== 'function') continue;
      if ((original as { [patchMarker]?: boolean })[patchMarker]) continue;

      const self = this;
      const wrapped = function (...args: unknown[]) {
        original.apply(console, args);
        self.forwardConsole(level, args);
      };
      Object.defineProperty(wrapped, patchMarker, { value: true });
      Object.defineProperty(console, method, {
        value: wrapped,
        configurable: true,
        writable: true,
      });
    }
  }

  private instrumentLoggers() {
    if (this.loggersInstrumented) return;
    this.loggersInstrumented = true;
    try {
      installLoggerInstrumentation({
        log: (level, message, attributes) => this.log(level, message, attributes),
        shouldCapture: () => Boolean(this.opts) && this.opts.captureLoggers !== false,
      });
    } catch {
      /* never throw into host app */
    }
  }

  private forwardConsole(level: LogLevel, args: unknown[]) {
    if (
      this.capturingConsole ||
      isCapturingFromLogger() ||
      !this.opts ||
      this.opts.captureConsole === false
    ) {
      return;
    }
    this.capturingConsole = true;
    try {
      const { message, attributes } = this.parseConsoleArgs(args);
      this.log(level, message, attributes);
    } catch {
      /* never throw into host app */
    } finally {
      this.capturingConsole = false;
    }
  }

  private parseConsoleArgs(args: unknown[]): {
    message: string;
    attributes: Record<string, unknown>;
  } {
    const attributes: Record<string, unknown> = { source: 'console' };
    if (args.length === 0) return { message: '', attributes };

    const last = args[args.length - 1];
    const hasMeta = args.length >= 2 && isPlainObject(last);
    const formatArgs = hasMeta ? args.slice(0, -1) : args;
    if (hasMeta) Object.assign(attributes, last);

    const first = formatArgs[0];
    if (first instanceof Error) {
      attributes.exceptionType = first.name;
      if (first.stack) attributes.stackTrace = first.stack;
      const rest = formatArgs.slice(1);
      return {
        message: rest.length ? `${first.message} ${format(...rest)}` : first.message,
        attributes,
      };
    }

    return { message: format(...formatArgs), attributes };
  }

  private runtimeTags(): Record<string, string> {
    const tags: Record<string, string> = { pid: String(process.pid) };
    if (this.hostname) tags.hostname = this.hostname;
    return tags;
  }

  private pushMetric(metricName: string, value: number) {
    this.metricBuf.push({
      metricName,
      value,
      tags: this.runtimeTags(),
      serviceName: this.opts.service,
      environment: this.opts.environment,
    });
  }

  private instrumentRuntime() {
    const collect = () => {
      try {
        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();
        this.pushMetric('memory_usage', mem.rss / 1024 / 1024);
        this.pushMetric('heap_used', mem.heapUsed / 1024 / 1024);
        this.pushMetric('cpu_usage', (cpu.user + cpu.system) / 1000);
        this.pushMetric('process_uptime', process.uptime());
        const start = Date.now();
        setImmediate(() => {
          this.pushMetric('event_loop_lag', Date.now() - start);
        });
      } catch {
        /* ignore */
      }
    };
    collect();
    if (this.runtimeTimer) clearInterval(this.runtimeTimer);
    this.runtimeTimer = setInterval(collect, 15_000);
    this.runtimeTimer.unref?.();
  }

  async flush() {
    const httpRequests = this.httpBuf.drain();
    const errors = this.errorBuf.drain();
    const metrics = this.metricBuf.drain();
    const spanEvents = this.spanBuf.drain();
    if (!httpRequests.length && !errors.length && !metrics.length && !spanEvents.length) {
      return;
    }
    const grouped = new Map<string, SpanEvent[]>();
    for (const span of spanEvents) {
      const spans = grouped.get(span.traceId) ?? [];
      spans.push(span);
      grouped.set(span.traceId, spans);
    }
    const traces = [...grouped].map(([traceId, spans]) => ({
      traceId,
      serviceName: this.opts.service,
      environment: this.opts.environment,
      spans: spans.map(({ traceId: _traceId, ...span }) => span),
    }));
    await this.post('/v1/ingest', { httpRequests, errors, metrics, traces });
  }

  private async post(path: string, body: unknown, attempt = 0): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      const res = await fetch(`${this.opts.endpoint}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.opts.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.status === 429 && attempt < 3) {
        await this.sleep(200 * 2 ** attempt);
        return this.post(path, body, attempt + 1);
      }
    } catch {
      if (attempt < 3) {
        await this.sleep(200 * 2 ** attempt);
        return this.post(path, body, attempt + 1);
      }
    }
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

export const Monitor = new MonitorImpl();
export default Monitor;
