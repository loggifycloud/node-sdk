const { format } = require('node:util');

const writeSym = Symbol('pino.write');
const shared = {
  [writeSym](_obj, _msg, _num) {},
};

const labels = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const values = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

function logAt(levelNum) {
  return function (obj, msg, ...rest) {
    if (typeof obj === 'string') {
      return this[writeSym](undefined, format(obj, msg, ...rest), levelNum);
    }
    if (obj instanceof Error) {
      return this[writeSym](obj, typeof msg === 'string' ? format(msg, ...rest) : undefined, levelNum);
    }
    const rendered = typeof msg === 'string' ? format(msg, ...rest) : msg;
    return this[writeSym](obj, rendered, levelNum);
  };
}

function pino() {
  const instance = Object.create(Object.create(shared));
  instance.levels = { labels, values };
  instance.fatal = logAt(60);
  instance.error = logAt(50);
  instance.warn = logAt(40);
  instance.info = logAt(30);
  instance.debug = logAt(20);
  instance.trace = logAt(10);
  return instance;
}

pino.symbols = { writeSym };
pino.levels = { labels, values };
pino.pino = pino;
pino.default = pino;

module.exports = pino;
