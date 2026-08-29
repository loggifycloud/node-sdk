import Module from 'node:module';

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanLike {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: unknown): unknown;
  end(status?: SpanStatus): void;
}

export interface DatastoreTracer {
  startSpan(
    name: string,
    options?: {
      kind?: 'internal' | 'server' | 'client' | 'producer' | 'consumer';
      timestamp?: string;
      durationMs?: number;
      attributes?: Record<string, unknown>;
    },
  ): SpanLike;
  runInContext<T>(context: { traceId: string; spanId: string }, fn: () => T): T;
}

const LOAD_HOOK = Symbol.for('loggify.node.module-load-patched');
const SQL_OP =
  /^(WITH|SELECT|INSERT|UPDATE|DELETE|REPLACE|MERGE|BEGIN|COMMIT|ROLLBACK|START|SHOW|SET|CALL|CREATE|DROP|ALTER|TRUNCATE|EXPLAIN|COPY|PREPARE|EXECUTE|VALUES)\b/i;
const SKIP_REDIS = new Set(['auth', 'hello', 'quit', 'select', 'client']);

export function installDatastoreInstrumentation(tracer: DatastoreTracer) {
  installRequireHook((request, exported) => patchModule(request, exported, tracer));
  for (const name of ['pg', 'mysql', 'mysql2', 'mysql2/promise', 'ioredis', 'redis', 'mongodb', '@prisma/client']) {
    patchResolved(name, tracer);
  }
}

function patchResolved(name: string, tracer: DatastoreTracer) {
  try {
    const resolved = require.resolve(name);
    const cached = require.cache[resolved];
    if (cached?.exports) patchModule(name, cached.exports, tracer);
  } catch {
    /* package is not installed */
  }
}

function installRequireHook(
  onLoad: (request: string, exported: unknown) => void,
) {
  const loader = Module as unknown as {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
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
      onLoad(request, exported);
    } catch {
      /* never break require */
    }
    return exported;
  };
  Object.defineProperty(wrapped, LOAD_HOOK, { value: true });
  loader._load = wrapped;
}

function patchModule(request: string, exported: unknown, tracer: DatastoreTracer) {
  if (!exported || (typeof exported !== 'object' && typeof exported !== 'function')) return;
  switch (request) {
    case 'pg':
      patchPg(exported, tracer);
      break;
    case 'mysql':
      patchMysql(exported, tracer);
      break;
    case 'mysql2':
    case 'mysql2/promise':
      patchMysql2(exported, tracer);
      break;
    case 'ioredis':
      patchIoredis(exported, tracer);
      break;
    case 'redis':
      patchRedis(exported, tracer);
      break;
    case 'mongodb':
      patchMongodb(exported, tracer);
      break;
    case '@prisma/client':
      patchPrisma(exported, tracer);
      break;
    default:
      break;
  }
}

function patchPg(exported: unknown, tracer: DatastoreTracer) {
  const pg = exported as { Client?: { prototype?: object }; native?: { Client?: { prototype?: object } } };
  wrapSqlMethod(pg.Client?.prototype, 'query', 'postgresql', tracer);
  wrapSqlMethod(pg.native?.Client?.prototype, 'query', 'postgresql', tracer);
}

function patchMysql(exported: unknown, tracer: DatastoreTracer) {
  const mysql = exported as { Connection?: { prototype?: object } };
  wrapSqlMethod(mysql.Connection?.prototype, 'query', 'mysql', tracer);
}

function patchMysql2(exported: unknown, tracer: DatastoreTracer) {
  const mysql2 = exported as {
    Connection?: { prototype?: object };
    PromiseConnection?: { prototype?: object };
  };
  wrapSqlMethod(mysql2.Connection?.prototype, 'query', 'mysql', tracer);
  wrapSqlMethod(mysql2.Connection?.prototype, 'execute', 'mysql', tracer);
  wrapSqlMethod(mysql2.PromiseConnection?.prototype, 'query', 'mysql', tracer);
  wrapSqlMethod(mysql2.PromiseConnection?.prototype, 'execute', 'mysql', tracer);
}

function patchIoredis(exported: unknown, tracer: DatastoreTracer) {
  const Redis = typeof exported === 'function' ? exported : (exported as { default?: unknown }).default;
  const proto = (Redis as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  wrapRedisSend(proto, 'sendCommand', (command) => {
    if (!command || typeof command === 'string') {
      return { name: String(command ?? 'command'), args: [] };
    }
    if (Array.isArray(command)) {
      return { name: String(command[0] ?? 'command'), args: command.slice(1) };
    }
    const record = command as { name?: unknown; args?: unknown };
    return {
      name: String(record.name ?? 'command'),
      args: Array.isArray(record.args) ? record.args : [],
    };
  }, tracer);

  const Cluster = (exported as { Cluster?: { prototype?: Record<string, unknown> } }).Cluster;
  wrapRedisSend(Cluster?.prototype, 'sendCommand', (command) => {
    const record = command as { name?: unknown; args?: unknown };
    return {
      name: String(record?.name ?? 'command'),
      args: Array.isArray(record?.args) ? record.args : [],
    };
  }, tracer);
}

function patchRedis(exported: unknown, tracer: DatastoreTracer) {
  const redis = exported as {
    RedisClient?: { prototype?: Record<string, unknown> };
    createClient?: (...args: unknown[]) => { sendCommand?: (...args: unknown[]) => unknown };
  };
  wrapRedisSend(redis.RedisClient?.prototype, 'send_command', (name, args) => ({
    name: String(name ?? 'command'),
    args: Array.isArray(args) ? args : [],
  }), tracer);

  const originalCreate = redis.createClient;
  if (typeof originalCreate !== 'function') return;
  const marker = Symbol.for('loggify.node.redis-createClient');
  if ((originalCreate as unknown as Record<symbol, boolean>)[marker]) return;

  const wrapped = function (this: unknown, ...args: unknown[]) {
    const client = originalCreate.apply(this, args);
    wrapRedisV4Client(client, tracer);
    return client;
  };
  Object.defineProperty(wrapped, marker, { value: true });
  redis.createClient = wrapped;
}

function wrapRedisV4Client(
  client: { sendCommand?: (...args: unknown[]) => unknown } | undefined,
  tracer: DatastoreTracer,
) {
  if (!client || typeof client.sendCommand !== 'function') return;
  wrapRedisSend(client as Record<string, unknown>, 'sendCommand', (command) => {
    if (Array.isArray(command)) {
      return { name: String(command[0] ?? 'command'), args: command.slice(1) };
    }
    return { name: String((command as { name?: unknown })?.name ?? 'command'), args: [] };
  }, tracer);
}

function patchMongodb(exported: unknown, tracer: DatastoreTracer) {
  const mongodb = exported as { Collection?: { prototype?: Record<string, unknown> } };
  const proto = mongodb.Collection?.prototype;
  if (!proto) return;
  const writes = [
    'findOne',
    'insertOne',
    'insertMany',
    'updateOne',
    'updateMany',
    'deleteOne',
    'deleteMany',
    'countDocuments',
    'distinct',
    'bulkWrite',
    'replaceOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'aggregate',
  ];
  for (const method of writes) {
    wrapNamedClientMethod(proto, method, 'mongodb', method, tracer, (target) => ({
      'db.mongodb.collection': collectionName(target),
    }));
  }
  wrapMongoFind(proto, tracer);
}

function patchPrisma(exported: unknown, tracer: DatastoreTracer) {
  const mod = exported as {
    PrismaClient?: new (...args: unknown[]) => {
      $on?: (event: string, handler: (payload: { query?: string; duration?: number }) => void) => void;
    };
  };
  const Orig = mod.PrismaClient;
  if (typeof Orig !== 'function') return;
  const marker = Symbol.for('loggify.node.prisma');
  if ((Orig as unknown as Record<symbol, boolean>)[marker]) return;

  class WrappedPrismaClient extends (Orig as new (...args: unknown[]) => {
    $on?: (event: string, handler: (payload: { query?: string; duration?: number }) => void) => void;
  }) {
    constructor(...args: unknown[]) {
      const opts = (args[0] && typeof args[0] === 'object' ? { ...(args[0] as object) } : {}) as {
        log?: unknown[];
      };
      const existingLog = Array.isArray(opts.log) ? [...opts.log] : [];
      const hasQuery = existingLog.some(
        (item) =>
          item === 'query' ||
          (item && typeof item === 'object' && (item as { level?: string }).level === 'query'),
      );
      if (!hasQuery) existingLog.push({ emit: 'event', level: 'query' });
      super({ ...opts, log: existingLog });
      try {
        this.$on?.('query', (event: { query?: string; duration?: number }) => {
          const query = String(event.query ?? 'QUERY');
          const op = (query.match(/^\s*(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)/i) || [
            'QUERY',
          ])[0];
          const durationMs = Number(event.duration ?? 0);
          const startedAt = new Date(Date.now() - durationMs).toISOString();
          const span = tracer.startSpan(`prisma ${String(op).toUpperCase()}`, {
            kind: 'client',
            timestamp: startedAt,
            durationMs,
            attributes: {
              'db.system': 'prisma',
              'db.operation': String(op).toUpperCase(),
              'db.statement': query.replace(/\s+/g, ' ').trim().slice(0, 2048),
            },
          });
          span.end('ok');
        });
      } catch {
        /* never break prisma */
      }
    }
  }
  Object.defineProperty(WrappedPrismaClient, marker, { value: true });
  Object.setPrototypeOf(WrappedPrismaClient, Orig);
  Object.setPrototypeOf(WrappedPrismaClient.prototype, Orig.prototype);
  mod.PrismaClient = WrappedPrismaClient as typeof Orig;
}

function wrapMongoFind(proto: Record<string, unknown>, tracer: DatastoreTracer) {
  const original = proto.find;
  if (typeof original !== 'function') return;
  const marker = Symbol.for('loggify.node.mongodb.find');
  if ((original as { [marker]?: boolean })[marker]) return;

  const wrapped = function (this: unknown, ...args: unknown[]) {
    const cursor = original.apply(this, args);
    instrumentMongoCursor(cursor, collectionName(this), tracer);
    return cursor;
  };
  Object.defineProperty(wrapped, marker, { value: true });
  proto.find = wrapped;
}

function instrumentMongoCursor(cursor: unknown, collection: string, tracer: DatastoreTracer) {
  if (!cursor || typeof cursor !== 'object') return;
  const proto = cursor as Record<string, unknown>;
  for (const method of ['toArray', 'next', 'forEach']) {
    wrapNamedClientMethod(proto, method, 'mongodb', `find.${method}`, tracer, () => ({
      'db.mongodb.collection': collection,
    }));
  }
}

function wrapSqlMethod(
  proto: object | undefined,
  method: string,
  system: string,
  tracer: DatastoreTracer,
) {
  if (!proto) return;
  const original = (proto as Record<string, unknown>)[method];
  if (typeof original !== 'function') return;
  const marker = Symbol.for(`loggify.node.${system}.${method}`);
  if ((original as { [marker]?: boolean })[marker]) return;

  const wrapped = function (this: unknown, ...args: unknown[]) {
    const statement = extractSql(args);
    const operation = sqlOperation(statement);
    const span = tracer.startSpan(`${system} ${operation}`, {
      kind: 'client',
      attributes: {
        'db.system': system,
        'db.operation': operation,
        'db.statement': truncateStatement(statement),
      },
    });
    return invokeTraced(tracer, span, original as (...args: unknown[]) => unknown, this, args);
  };
  Object.defineProperty(wrapped, marker, { value: true });
  (proto as Record<string, unknown>)[method] = wrapped;
}

function wrapNamedClientMethod(
  proto: Record<string, unknown>,
  method: string,
  system: string,
  operation: string,
  tracer: DatastoreTracer,
  extra: (target: unknown) => Record<string, unknown>,
) {
  const original = proto[method];
  if (typeof original !== 'function') return;
  const marker = Symbol.for(`loggify.node.${system}.${method}`);
  if ((original as { [marker]?: boolean })[marker]) return;

  const wrapped = function (this: unknown, ...args: unknown[]) {
    const span = tracer.startSpan(`${system} ${operation}`, {
      kind: 'client',
      attributes: {
        'db.system': system,
        'db.operation': operation,
        'db.statement': operation,
        ...extra(this),
      },
    });
    return invokeTraced(tracer, span, original as (...args: unknown[]) => unknown, this, args);
  };
  Object.defineProperty(wrapped, marker, { value: true });
  proto[method] = wrapped;
}

function wrapRedisSend(
  target: Record<string, unknown> | undefined,
  method: string,
  parse: (...args: unknown[]) => { name: string; args: unknown[] },
  tracer: DatastoreTracer,
) {
  if (!target) return;
  const original = target[method];
  if (typeof original !== 'function') return;
  const marker = Symbol.for(`loggify.node.redis.${method}`);
  if ((original as { [marker]?: boolean })[marker]) return;

  const wrapped = function (this: unknown, ...args: unknown[]) {
    const command = parse(...args);
    const operation = command.name.toLowerCase();
    if (SKIP_REDIS.has(operation)) {
      return original.apply(this, args);
    }
    const span = tracer.startSpan(`redis ${operation.toUpperCase()}`, {
      kind: 'client',
      attributes: {
        'db.system': 'redis',
        'db.operation': operation.toUpperCase(),
        'db.statement': redisStatement(operation, command.args),
      },
    });
    return invokeTraced(tracer, span, original as (...args: unknown[]) => unknown, this, args);
  };
  Object.defineProperty(wrapped, marker, { value: true });
  target[method] = wrapped;
}

function invokeTraced(
  tracer: DatastoreTracer,
  span: SpanLike,
  original: (...args: unknown[]) => unknown,
  ctx: unknown,
  args: unknown[],
) {
  return tracer.runInContext({ traceId: span.traceId, spanId: span.spanId }, () => {
    const last = args[args.length - 1];
    const hasCallback = typeof last === 'function';
    const callArgs = hasCallback
      ? args.slice(0, -1).concat([
          function callback(this: unknown, err: unknown, ...rest: unknown[]) {
            span.end(err ? 'error' : 'ok');
            return (last as (...cbArgs: unknown[]) => unknown).apply(this, [err, ...rest]);
          },
        ])
      : args;
    try {
      const result = original.apply(ctx, callArgs);
      settleSpan(span, result, hasCallback);
      return result;
    } catch (error) {
      span.end('error');
      throw error;
    }
  });
}

function settleSpan(span: SpanLike, result: unknown, callbackWrapped: boolean) {
  const thenable = result as { then?: unknown; once?: unknown } | null;
  if (thenable && typeof thenable.then === 'function') {
    (result as Promise<unknown>).then(
      () => span.end('ok'),
      () => span.end('error'),
    );
    return;
  }
  if (thenable && typeof thenable.once === 'function') {
    const emitter = result as { once(event: string, listener: (...args: unknown[]) => void): unknown };
    emitter.once('end', () => span.end('ok'));
    emitter.once('error', () => span.end('error'));
    return;
  }
  if (!callbackWrapped) span.end('ok');
}

function extractSql(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const obj = first as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.sql === 'string') return obj.sql;
    if (typeof obj.statement === 'string') return obj.statement;
  }
  return '';
}

function sqlOperation(sql: string): string {
  const match = SQL_OP.exec(sql.trim());
  if (!match) return 'QUERY';
  const op = match[1].toUpperCase();
  if (op === 'WITH') return 'SELECT';
  if (op === 'START') return 'BEGIN';
  return op;
}

function truncateStatement(sql: string, max = 2048): string {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function redisStatement(name: string, args: unknown[]): string {
  const key = args[0] == null ? '' : String(args[0]).slice(0, 120);
  return key ? `${name} ${key}` : name;
}

function collectionName(target: unknown): string {
  const record = target as { collectionName?: unknown; namespace?: unknown; s?: { namespace?: { collection?: unknown } } };
  if (typeof record?.collectionName === 'string') return record.collectionName;
  if (typeof record?.namespace === 'string') return record.namespace;
  const nested = record?.s?.namespace?.collection;
  return typeof nested === 'string' ? nested : '';
}
