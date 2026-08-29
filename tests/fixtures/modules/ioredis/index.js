class Redis {
  sendCommand(command) {
    return new Promise((resolve) => setImmediate(() => resolve('ok')));
  }

  get(key) {
    return this.sendCommand({ name: 'get', args: [key] });
  }

  set(key, value) {
    return this.sendCommand({ name: 'set', args: [key, value] });
  }
}

module.exports = Redis;
module.exports.default = Redis;
module.exports.Cluster = class Cluster {
  sendCommand(command) {
    return Redis.prototype.sendCommand.call(this, command);
  }
};
