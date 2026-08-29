class Logger {
  constructor(options = {}) {
    this.defaultMeta = options.defaultMeta || {};
  }

  write(info) {
    if (!info || typeof info !== 'object') return true;
    const method = info.level === 'error' ? 'error' : info.level === 'warn' ? 'warn' : 'info';
    const meta = { ...this.defaultMeta, ...info };
    delete meta.level;
    delete meta.message;
    console[method](info.message, meta);
    return true;
  }

  log(level, msg, meta) {
    if (arguments.length === 1 && level && typeof level === 'object') {
      return this.write({ ...this.defaultMeta, ...level });
    }
    if (msg && typeof msg === 'object' && arguments.length === 2) {
      return this.write({ ...this.defaultMeta, ...msg, level, message: msg.message ?? msg.msg });
    }
    return this.write({
      ...this.defaultMeta,
      ...(meta && typeof meta === 'object' ? meta : {}),
      level,
      message: msg,
    });
  }

  debug(msg, meta) {
    return this.log('debug', msg, meta);
  }

  info(msg, meta) {
    return this.log('info', msg, meta);
  }

  warn(msg, meta) {
    return this.log('warn', msg, meta);
  }

  error(msg, meta) {
    return this.log('error', msg, meta);
  }
}

Logger.prototype._transform = function _transform() {};

function createLogger(options) {
  return new Logger(options);
}

module.exports = Object.assign(createLogger, { createLogger, Logger });
