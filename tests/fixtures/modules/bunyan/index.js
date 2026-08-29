const { format } = require('node:util');

const TRACE = 10;
const DEBUG = 20;
const INFO = 30;
const WARN = 40;
const ERROR = 50;
const FATAL = 60;

class Logger {
  constructor(options = {}) {
    this.fields = { name: options.name || 'app' };
  }

  _emit(_rec, _noemit) {
    return '';
  }

  _log(level, args) {
    const rec = { ...this.fields, level, v: 0, pid: process.pid, hostname: 'test', time: new Date() };
    const first = args[0];
    if (first instanceof Error) {
      rec.err = first;
      rec.msg = args.length > 1 ? format(...args.slice(1)) : first.message;
    } else if (first && typeof first === 'object' && !Array.isArray(first)) {
      Object.assign(rec, first);
      rec.msg = args.length > 1 ? format(...args.slice(1)) : String(first.msg ?? '');
    } else {
      rec.msg = format(...args);
    }
    this._emit(rec);
  }
}

Logger.prototype.trace = function (...args) {
  this._log(TRACE, args);
};
Logger.prototype.debug = function (...args) {
  this._log(DEBUG, args);
};
Logger.prototype.info = function (...args) {
  this._log(INFO, args);
};
Logger.prototype.warn = function (...args) {
  this._log(WARN, args);
};
Logger.prototype.error = function (...args) {
  this._log(ERROR, args);
};
Logger.prototype.fatal = function (...args) {
  this._log(FATAL, args);
};

function createLogger(options) {
  return new Logger(options);
}

module.exports = { createLogger, Logger };
