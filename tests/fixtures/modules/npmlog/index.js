const { format } = require('node:util');

const log = {
  levels: {
    silly: -Infinity,
    verbose: 1000,
    info: 2000,
    http: 3000,
    notice: 3500,
    warn: 4000,
    error: 5000,
    silent: Infinity,
  },
};

log.log = function (lvl, prefix, ...rest) {
  return { lvl, prefix, message: format(...rest) };
}.bind(log);

for (const level of ['silly', 'verbose', 'info', 'http', 'notice', 'warn', 'error']) {
  log[level] = function (...args) {
    return this.log(level, ...args);
  }.bind(log);
}

module.exports = log;
