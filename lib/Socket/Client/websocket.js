import WebSocket from 'ws';
import { DEFAULT_ORIGIN } from '../../Defaults/index.js';
import { AbstractSocketClient } from './types.js';
export class WebSocketClient extends AbstractSocketClient {
    constructor() {
        super(...arguments);
        this.socket = null;
        // queue & dispatch variables for throttling outgoing messages to avoid rate limits
        this._queue = [];
        this._isDispatching = false;
        this._lastDispatch = 0;
        this._minSendIntervalMs = 50; // 50ms minimum interval between sends
    }
    get isOpen() {
        return this.socket?.readyState === WebSocket.OPEN;
    }
    get isClosed() {
        return this.socket === null || this.socket?.readyState === WebSocket.CLOSED;
    }
    get isClosing() {
        return this.socket === null || this.socket?.readyState === WebSocket.CLOSING;
    }
    get isConnecting() {
        return this.socket?.readyState === WebSocket.CONNECTING;
    }
    async connect() {
        if (this.socket) {
            return;
        }
        this.socket = new WebSocket(this.url, {
            origin: DEFAULT_ORIGIN,
            headers: this.config.options?.headers,
            handshakeTimeout: this.config.connectTimeoutMs,
            timeout: this.config.connectTimeoutMs,
            agent: this.config.agent
        });
        this.socket.setMaxListeners(0);
        const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response'];
        for (const event of events) {
            this.socket?.on(event, (...args) => this.emit(event, ...args));
        }
    }
    async close() {
        if (!this.socket) {
            return;
        }
        this.socket.close();
        this.socket = null;
    }
    async restart() {
        if (this.socket) {
            await new Promise(resolve => {
                this.socket.once('close', resolve);
                this.socket.terminate();
            });
            this.socket = null;
        }
        await this.connect();
    }
    send(str, cb) {
        // throttle sends to reduce rate-limit likelihood
        const doSend = () => {
            this.socket?.send(str, cb);
            return Boolean(this.socket);
        };
        this._queue.push(doSend);
        this._dispatch();
        return true;
    }
    _dispatch() {
        if (this._isDispatching) {
            return;
        }
        const now = Date.now();
        if (this._queue.length > 0 && (now - this._lastDispatch) >= this._minSendIntervalMs) {
            this._isDispatching = true;
            const fn = this._queue.shift();
            fn();
            this._lastDispatch = Date.now();
            this._isDispatching = false;
            // continue dispatching if queue not empty
            if (this._queue.length > 0) {
                setTimeout(() => this._dispatch(), this._minSendIntervalMs - (Date.now() - this._lastDispatch));
            }
        }
        else if (this._queue.length > 0 && !this._isDispatching) {
            setTimeout(() => this._dispatch(), this._minSendIntervalMs - (now - this._lastDispatch));
        }
    }
}
//# sourceMappingURL=websocket.js.map