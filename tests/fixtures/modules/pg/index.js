class Client {
  query(text, values, cb) {
    const callback = typeof values === 'function' ? values : cb;
    const result = { rows: [{ id: 1 }], rowCount: 1 };
    if (typeof callback === 'function') {
      setImmediate(() => callback(null, result));
      return this;
    }
    return new Promise((resolve) => setImmediate(() => resolve(result)));
  }
}

module.exports = { Client, Pool: Client };
