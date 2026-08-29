import Module from 'node:module';
import { format } from 'node:util';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface LoggerSink {
  log(level: LogLevel, message: string, attributes: Record<string, unknown>): void;
  shouldCapture(): boolean;
}

const LOAD_HOOK = Symbol.for('loggify.node.logger-load-patched');
const LOGGER_PACKAGES = ['winston', 'pino', 'bunyan', 'loglevel', 'npmlog'] as const;

let captureDepth = 0;

export function isCapturingFromLogger() {
  return captureDepth > 0;
}

export function installLoggerInstrumentation(sink: LoggerSink) {
  installRequireHook((request, exported) => patchModule(request, exported, sink));
  for (const name of LOGGER_PACKAGES) {
    patchResolved(name, sink);
  }
}

function patchResolved(name: string, sink: LoggerSink) {
  try {
    const resolved = require.resolve(name);
    const cached = require.cache[resolved];
    if (cached?.exports) {
      const next = patchModule(name, cached.exports, sink);
      if (next !== undefined) cached.exports = next;
    }
  } catch {
    /* package is not installed */
  }
}

function installRequireHook(onLoad: (request: string, exported: unknown) => unknown) {
  const loader = Module as unknown as {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
    _resolveFilename(request: string, parent: NodeModule | undefined, isMain: boolean): string;
  };
  const original = loader._load;
  if ((original as unknown as Record<symbol, boolean>)[LOAD_HOOK]) return;

  const wrapped = function (
    this: unknown,
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean,
  ) {
    const exported = original.call(this, request, parent, isMain);
    try {
      const next = onLoad(request, exported);
      if (next !== undefined && next !== exported) {
        try {
          const filename = loader._resolveFilename(request, parent, isMain);
          const cached = require.cache[filename];
          if (cached) cached.exports = next;
        } catch {
          /* ignore */
        }
        return next;
      }
    } catch {
      /* never break require */
    }
    return exported;
  };
  Object.defineProperty(wrapped, LOAD_HOOK, { value: true });
  loader._load = wrapped;
}

function patchModule(request: string, exported: unknown, sink: LoggerSink) {
  if (!exported || (typeof exported !== 'object' && typeof exported !== 'function')) return;
  switch (request) {
    case 'winston':
      patchWinston(exported, sink);
      return;
    case 'pino':
      return patchPino(exported, sink);
    case 'bunyan':
      patchBunyan(exported, sink);
      return;
    case 'loglevel':
      patchLoglevel(exported, sink);
      return;
    case 'npmlog':
      patchNpmlog(exported, sink);
      return;
    default:
      return;
  }
}

function patchWinston(exported: unknown, sink: LoggerSink) {
  const winston = exported as {
    Logger?: { prototype?: object };
    createLogger?: (...args: unknown[]) => object;
  };
  if (winston.Logger?.prototype) {
    wrapWinstonLogger(winston.Logger.prototype, sink);
    return;
  }
  if (typeof winston.createLogger !== 'function') return;
  try {
    const probe = winston.createLogger({ silent: true, transports: [] });
    wrapWinstonLogger(Object.getPrototypeOf(probe), sink);
  } catch {
    /* ignore */
  }
}

function wrapWinstonLogger(proto: object, sink: LoggerSink) {
  const record = proto as Record<string, unknown>;
  if (typeof record._transform === 'function' && typeof record.write === 'function') {
    wrapKey(record, 'write', 'loggify.node.winston.write', (original) => {
      return function (this: unknown, chunk: unknown, encoding?: unknown, callback?: unknown) {
        return withLoggerCapture(() => {
          if (isPlainObject(chunk) && (typeof chunk.level === 'string' || 'message' in chunk)) {
            forwardWinston(sink, this, chunk);
          }
          return original.call(this, chunk, encoding, callback);
        });
      };
    });
    return;
  }
  if (typeof record.log === 'function') {
    wrapKey(record, 'log', 'loggify.node.winston.log', (original) => {
      return function (this: unknown, ...args: unknown[]) {
        return withLoggerCapture(() => {
          forwardWinstonLog(sink, this, args);
          return original.apply(this, args);
        });
      };
    });
  }
}

function forwardWinston(sink: LoggerSink, logger: unknown, info: Record<string, unknown>) {
  const messageValue = info.message;
  const { message, errorAttrs } = normalizeMessage(messageValue);
  emit(sink, info.level, message, {
    source: 'winston',
    ...loggerMeta(logger),
    ...omitKeys(info, ['level', 'message', 'splat']),
    ...errorAttrs,
  });
}

function forwardWinstonLog(sink: LoggerSink, logger: unknown, args: unknown[]) {
  const first = args[0];
  if (isPlainObject(first) && typeof first.level === 'string') {
    forwardWinston(sink, logger, first);
    return;
  }
  const level = first;
  const second = args[1];
  if (isPlainObject(second) && args.length === 2) {
    forwardWinston(sink, logger, { level, ...second, message: second.message ?? second.msg });
    return;
  }
  const rest = args.slice(2);
  const last = rest[rest.length - 1];
  const callback = typeof last === 'function' ? rest.pop() : undefined;
  void callback;
  const meta = isPlainObject(rest[rest.length - 1]) ? (rest.pop() as Record<string, unknown>) : {};
  const { message, attributes } = parseMessageArgs(second !== undefined ? [second, ...rest] : []);
  emit(sink, level, message, {
    source: 'winston',
    ...loggerMeta(logger),
    ...meta,
    ...attributes,
  });
}

function loggerMeta(logger: unknown) {
  const meta = (logger as { defaultMeta?: unknown })?.defaultMeta;
  return isPlainObject(meta) ? meta : {};
}

function patchPino(exported: unknown, sink: LoggerSink): unknown {
  const pinoFn = pinoFactory(exported);
  if (!pinoFn) return;

  if (tryWrapPinoWrite(pinoFn, exported, sink)) return;

  const wrapped = function (this: unknown, ...args: unknown[]) {
    const logger = pinoFn.apply(this, args);
    wrapPinoMethods(logger, sink);
    return logger;
  };
  copyEnumerable(pinoFn, wrapped);
  return wrapped;
}

function pinoFactory(exported: unknown) {
  if (typeof exported === 'function') return exported as (...args: unknown[]) => unknown;
  const record = exported as { pino?: unknown; default?: unknown };
  if (typeof record?.pino === 'function') return record.pino as (...args: unknown[]) => unknown;
  if (typeof record?.default === 'function') return record.default as (...args: unknown[]) => unknown;
  return undefined;
}

function tryWrapPinoWrite(
  pinoFn: (...args: unknown[]) => unknown,
  exported: unknown,
  sink: LoggerSink,
) {
  const writeSym = pinoWriteSymbol(exported);
  if (!writeSym) return false;
  try {
    const dummy = createPinoDummy(pinoFn);
    if (!dummy) return false;
    for (const proto of prototypeChain(dummy)) {
      if (!Object.prototype.hasOwnProperty.call(proto, writeSym)) continue;
      if (typeof proto[writeSym] !== 'function') continue;
      wrapKey(proto, writeSym, 'loggify.node.pino.write', (original) => {
        return function (this: unknown, obj: unknown, msg?: unknown, num?: unknown) {
          return withLoggerCapture(() => {
            forwardPino(sink, this, obj, msg, num);
            return original.call(this, obj, msg, num);
          });
        };
      });
      return true;
    }
  } catch {
    /* fall through to factory wrapping */
  }
  return false;
}

function createPinoDummy(pinoFn: (...args: unknown[]) => unknown) {
  const mute = {
    write() {
      return true;
    },
    flushSync() {},
    flush() {},
    end() {},
    emit() {},
    on() {
      return this;
    },
    once() {
      return this;
    },
    removeListener() {
      return this;
    },
  };
  for (const attempt of [
    () => pinoFn({ enabled: false, base: null }, mute),
    () => pinoFn(mute),
    () => pinoFn({ enabled: false, base: null }),
  ]) {
    try {
      return attempt();
    } catch {
      /* try the next constructor shape */
    }
  }
  return undefined;
}

function pinoWriteSymbol(exported: unknown) {
  const record = exported as { symbols?: { writeSym?: symbol } };
  const fromExport = record?.symbols?.writeSym;
  if (typeof fromExport === 'symbol') return fromExport;
  if (typeof exported === 'function') {
    const fromFn = (exported as { symbols?: { writeSym?: symbol } }).symbols?.writeSym;
    if (typeof fromFn === 'symbol') return fromFn;
  }
  return undefined;
}

function wrapPinoMethods(logger: unknown, sink: LoggerSink) {
  if (!logger || (typeof logger !== 'object' && typeof logger !== 'function')) return;
  const target = logger as Record<string, unknown>;
  for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) {
    wrapKey(target, level, `loggify.node.pino.${level}`, (original) => {
      return function (this: unknown, ...args: unknown[]) {
        return withLoggerCapture(() => {
          const parsed = parsePinoArgs(args);
          emit(sink, level, parsed.message, { source: 'pino', ...parsed.attributes });
          return original.apply(this, args);
        });
      };
    });
  }
}

function forwardPino(sink: LoggerSink, logger: unknown, obj: unknown, msg: unknown, num: unknown) {
  const labels = (logger as { levels?: { labels?: Record<string, string> } })?.levels?.labels;
  const level =
    (typeof num === 'number' || typeof num === 'string') && labels?.[String(num)]
      ? labels[String(num)]
      : typeof num === 'number'
        ? pinoLevelFromNumber(num)
        : 'info';
  const parsed = parsePinoWrite(obj, msg);
  emit(sink, level, parsed.message, { source: 'pino', ...parsed.attributes });
}

function pinoLevelFromNumber(num: number) {
  if (num >= 60) return 'fatal';
  if (num >= 50) return 'error';
  if (num >= 40) return 'warn';
  if (num >= 30) return 'info';
  return 'debug';
}

function parsePinoWrite(obj: unknown, msg: unknown) {
  if (obj instanceof Error) {
    return {
      message: typeof msg === 'string' ? msg : obj.message,
      attributes: errorAttributes(obj),
    };
  }
  if (isPlainObject(obj)) {
    const { msg: objMsg, message: objMessage, err, ...rest } = obj;
    const error = err instanceof Error ? errorAttributes(err) : {};
    const fromObj = typeof objMsg === 'string' ? objMsg : typeof objMessage === 'string' ? objMessage : '';
    return {
      message: typeof msg === 'string' ? msg : fromObj || (err instanceof Error ? err.message : ''),
      attributes: { ...rest, ...error },
    };
  }
  return {
    message: typeof obj === 'string' ? obj : typeof msg === 'string' ? msg : '',
    attributes: {},
  };
}

function parsePinoArgs(args: unknown[]) {
  if (args.length === 0) return { message: '', attributes: {} };
  return parsePinoWrite(args[0], typeof args[1] === 'string' ? format(args[1], ...args.slice(2)) : args[1]);
}

function patchBunyan(exported: unknown, sink: LoggerSink) {
  const bunyan = exported as {
    Logger?: { prototype?: Record<string, unknown> };
    createLogger?: (...args: unknown[]) => object;
  };
  if (typeof bunyan.createLogger === 'function') {
    wrapKey(bunyan as Record<string, unknown>, 'createLogger', 'loggify.node.bunyan.createLogger', (original) => {
      return function (this: unknown, ...args: unknown[]) {
        const logger = original.apply(this, args);
        wrapBunyanLogger(Object.getPrototypeOf(logger), sink);
        return logger;
      };
    });
    try {
      wrapBunyanLogger(
        Object.getPrototypeOf(bunyan.createLogger({ name: 'loggify', streams: [] })),
        sink,
      );
    } catch {
      /* ignore */
    }
  }
  if (bunyan.Logger?.prototype) wrapBunyanLogger(bunyan.Logger.prototype, sink);
}

function wrapBunyanLogger(proto: Record<string, unknown> | null, sink: LoggerSink) {
  if (!proto) return;
  if (typeof proto._emit === 'function') {
    wrapKey(proto, '_emit', 'loggify.node.bunyan.emit', (original) => {
      return function (this: unknown, rec: unknown, noemit?: unknown) {
        return withLoggerCapture(() => {
          if (!noemit && isPlainObject(rec)) forwardBunyan(sink, rec);
          return original.call(this, rec, noemit);
        });
      };
    });
    return;
  }
  for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) {
    wrapKey(proto, level, `loggify.node.bunyan.${level}`, (original) => {
      return function (this: unknown, ...args: unknown[]) {
        return withLoggerCapture(() => {
          const parsed = parsePinoArgs(args);
          emit(sink, level, parsed.message, { source: 'bunyan', ...parsed.attributes });
          return original.apply(this, args);
        });
      };
    });
  }
}

function forwardBunyan(sink: LoggerSink, rec: Record<string, unknown>) {
  const err = rec.err;
  const errorAttrs = err instanceof Error ? errorAttributes(err) : isPlainObject(err) ? flattenBunyanErr(err) : {};
  emit(sink, rec.level, String(rec.msg ?? ''), {
    source: 'bunyan',
    ...omitKeys(rec, ['v', 'pid', 'hostname', 'time', 'name', 'component', 'level', 'msg', 'err']),
    ...errorAttrs,
  });
}

function flattenBunyanErr(err: Record<string, unknown>) {
  const attributes: Record<string, unknown> = {};
  if (typeof err.name === 'string') attributes.exceptionType = err.name;
  if (typeof err.message === 'string') attributes.errMessage = err.message;
  if (typeof err.stack === 'string') attributes.stackTrace = err.stack;
  return attributes;
}

function patchLoglevel(exported: unknown, sink: LoggerSink) {
  const log = exported as {
    methodFactory?: (...args: unknown[]) => (...args: unknown[]) => unknown;
    getLevel?: () => unknown;
    setLevel?: (level: unknown, persist?: boolean) => unknown;
    getLoggers?: () => Record<string, LoglevelLogger>;
  } & LoglevelLogger;
  if (typeof log.methodFactory !== 'function' || typeof log.setLevel !== 'function') return;

  const marker = Symbol.for('loggify.node.loglevel.factory');
  if ((log.methodFactory as { [marker]?: boolean })[marker]) return;

  const originalFactory = log.methodFactory;
  const wrappedFactory = function (
    this: unknown,
    methodName: unknown,
    level: unknown,
    loggerName: unknown,
  ) {
    const raw = originalFactory.call(this, methodName, level, loggerName);
    return function (this: unknown, ...args: unknown[]) {
      return withLoggerCapture(() => {
        const parsed = parseMessageArgs(args);
        emit(sink, methodName, parsed.message, {
          source: 'loglevel',
          ...(typeof loggerName === 'string' && loggerName ? { logger: loggerName } : {}),
          ...parsed.attributes,
        });
        return raw.apply(this, args);
      });
    };
  };
  Object.defineProperty(wrappedFactory, marker, { value: true });
  log.methodFactory = wrappedFactory;
  rebuildLoglevel(log);

  if (typeof log.getLoggers === 'function') {
    for (const logger of Object.values(log.getLoggers())) {
      logger.methodFactory = wrappedFactory;
      rebuildLoglevel(logger);
    }
  }
}

type LoglevelLogger = {
  methodFactory?: unknown;
  getLevel?: () => unknown;
  setLevel?: (level: unknown, persist?: boolean) => unknown;
};

function rebuildLoglevel(logger: LoglevelLogger) {
  if (typeof logger.setLevel !== 'function' || typeof logger.getLevel !== 'function') return;
  try {
    logger.setLevel(logger.getLevel(), false);
  } catch {
    /* ignore */
  }
}

function patchNpmlog(exported: unknown, sink: LoggerSink) {
  const log = exported as Record<string, unknown>;
  if (typeof log.log !== 'function') return;
  wrapKey(log, 'log', 'loggify.node.npmlog.log', (original) => {
    return function (this: unknown, level: unknown, prefix: unknown, ...rest: unknown[]) {
      return withLoggerCapture(() => {
        const parsed = parseMessageArgs(rest);
        emit(sink, level, parsed.message, {
          source: 'npmlog',
          ...(prefix != null && prefix !== '' ? { prefix: String(prefix) } : {}),
          ...parsed.attributes,
        });
        return original.call(this, level, prefix, ...rest);
      });
    };
  });
}

function emit(
  sink: LoggerSink,
  level: unknown,
  message: string,
  attributes: Record<string, unknown>,
) {
  if (!sink.shouldCapture()) return;
  const mapped = mapLevel(level);
  if (!mapped) return;
  try {
    sink.log(mapped, message, attributes);
  } catch {
    /* never throw into host app */
  }
}

function withLoggerCapture<T>(fn: () => T): T {
  captureDepth += 1;
  try {
    return fn();
  } finally {
    captureDepth = Math.max(0, captureDepth - 1);
  }
}

function mapLevel(value: unknown): LogLevel | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (value >= 60) return 'FATAL';
    if (value >= 50) return 'ERROR';
    if (value >= 40) return 'WARN';
    if (value >= 30) return 'INFO';
    if (value < 0) return 'DEBUG';
    return 'DEBUG';
  }
  const level = String(value ?? '').toLowerCase();
  if (!level || level === 'silent') return undefined;
  if (['fatal', 'emerg', 'emergency', 'alert', 'crit', 'critical'].includes(level)) return 'FATAL';
  if (['error', 'err'].includes(level)) return 'ERROR';
  if (['warn', 'warning'].includes(level)) return 'WARN';
  if (['info', 'log', 'http', 'notice', 'timing'].includes(level)) return 'INFO';
  if (['debug', 'verbose', 'trace', 'silly'].includes(level)) return 'DEBUG';
  return 'INFO';
}

function parseMessageArgs(args: unknown[]) {
  const attributes: Record<string, unknown> = {};
  if (args.length === 0) return { message: '', attributes };
  const last = args[args.length - 1];
  const hasMeta = args.length >= 2 && isPlainObject(last);
  const formatArgs = hasMeta ? args.slice(0, -1) : args;
  if (hasMeta) Object.assign(attributes, last);
  return { message: stringifyArgs(formatArgs, attributes), attributes };
}

function stringifyArgs(args: unknown[], attributes: Record<string, unknown>) {
  if (args.length === 0) return '';
  const first = args[0];
  if (first instanceof Error) {
    Object.assign(attributes, errorAttributes(first));
    const rest = args.slice(1);
    return rest.length ? `${first.message} ${format(...rest)}` : first.message;
  }
  const { message, errorAttrs } = normalizeMessage(first);
  Object.assign(attributes, errorAttrs);
  if (args.length === 1) return message;
  return format(message, ...args.slice(1));
}

function normalizeMessage(value: unknown) {
  if (value instanceof Error) {
    return { message: value.message, errorAttrs: errorAttributes(value) };
  }
  if (typeof value === 'string') return { message: value, errorAttrs: {} };
  if (value == null) return { message: '', errorAttrs: {} };
  return { message: String(value), errorAttrs: {} };
}

function errorAttributes(error: Error) {
  const attributes: Record<string, unknown> = { exceptionType: error.name };
  if (error.stack) attributes.stackTrace = error.stack;
  return attributes;
}

function wrapKey(
  target: Record<string | symbol, unknown>,
  key: string | symbol,
  markerName: string,
  wrapper: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
) {
  const original = target[key];
  if (typeof original !== 'function') return;
  const marker = Symbol.for(markerName);
  if ((original as { [marker]?: boolean })[marker]) return;
  const wrapped = wrapper(original as (...args: unknown[]) => unknown);
  Object.defineProperty(wrapped, marker, { value: true });
  try {
    target[key] = wrapped;
  } catch {
    /* ignore frozen exports */
  }
}

function prototypeChain(value: unknown) {
  const chain: Array<Record<string | symbol, unknown>> = [];
  let current = value;
  for (let i = 0; i < 6 && current; i += 1) {
    current = Object.getPrototypeOf(current);
    if (!current || current === Object.prototype) break;
    chain.push(current as Record<string | symbol, unknown>);
  }
  return chain;
}

function copyEnumerable(from: object, to: object) {
  for (const key of Object.getOwnPropertyNames(from)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    const descriptor = Object.getOwnPropertyDescriptor(from, key);
    if (descriptor) Object.defineProperty(to, key, descriptor);
  }
  for (const key of Object.getOwnPropertySymbols(from)) {
    const descriptor = Object.getOwnPropertyDescriptor(from, key);
    if (descriptor) Object.defineProperty(to, key, descriptor);
  }
}

function omitKeys(record: Record<string, unknown>, keys: string[]) {
  const skip = new Set(keys);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (skip.has(key) || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
