const { EventEmitter } = require('node:events');

// Polyfill minimal WebSocketPair & Response for Node test runner
if (typeof globalThis.Response !== 'undefined') {
  const OrigResponse = globalThis.Response;
  globalThis.Response = class MockResponse extends OrigResponse {
    constructor(body, init = {}) {
      if (init && init.status === 101) {
        super(null, { status: 200 });
        Object.defineProperty(this, 'status', { value: 101, writable: false });
        this.webSocket = init.webSocket;
        return;
      }
      super(body, init);
    }
  };
}

if (typeof globalThis.WebSocketPair === 'undefined') {
  globalThis.WebSocketPair = function() {
    const client = new EventEmitter();
    const server = new EventEmitter();
    client.send = (msg) => server.emit('message', { data: msg });
    server.send = (msg) => client.emit('message', { data: msg });
    client.close = () => { client.emit('close'); server.emit('close'); };
    server.close = () => { server.emit('close'); client.emit('close'); };
    client.readyState = 1; // OPEN
    server.readyState = 1; // OPEN
    server.accept = () => {};
    return [client, server];
  };
}

module.exports = {};
