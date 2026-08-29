const loggers = {};

function defaultMethodFactory(methodName) {
  return function (...args) {
    const method = console[methodName] || console.log;
    return method.apply(console, args);
  };
}

function replaceLoggingMethods() {
  for (const methodName of ['trace', 'debug', 'info', 'warn', 'error']) {
    this[methodName] = this.methodFactory(methodName, this.getLevel(), this.name);
  }
  this.log = this.debug;
}

function createLogger(name, factory) {
  const logger = {
    name,
    methodFactory: factory || defaultMethodFactory,
    getLevel() {
      return 0;
    },
    setLevel(_level, _persist) {
      return replaceLoggingMethods.call(this);
    },
  };
  replaceLoggingMethods.call(logger);
  return logger;
}

const log = createLogger(undefined, defaultMethodFactory);

log.getLogger = function getLogger(name) {
  if (!loggers[name]) {
    loggers[name] = createLogger(name, log.methodFactory);
  }
  return loggers[name];
};

log.getLoggers = function getLoggers() {
  return loggers;
};

module.exports = log;
