import WebSocket from 'ws'
import { DEFAULT_ORIGIN } from '../../Defaults/index.js'
import { AbstractSocketClient } from './types.js'

export class WebSocketClient extends AbstractSocketClient {
  constructor() {
    super(...arguments)
    this.socket = null
    this._queue = []
    this._isDispatching = false
    this._lastDispatch = 0
    this._minSendIntervalMs = 50
    this._reconnectTimeout = null
    this._reconnectAttempts = 0
    this._maxReconnectAttempts = 5
    this._reconnectDelay = 1000
    this._shouldReconnect = true
    this._isManualClose = false
    this._isReconnecting = false
  }

  get isOpen() { return this.socket?.readyState === WebSocket.OPEN }
  get isClosed() { return !this.socket || this.socket.readyState === WebSocket.CLOSED }
  get isClosing() { return !this.socket || this.socket.readyState === WebSocket.CLOSING }
  get isConnecting() { return this.socket?.readyState === WebSocket.CONNECTING }

  async connect() {
    if (this.socket && !this.isClosed) return
    try {
      this.socket = new WebSocket(this.url, { origin: DEFAULT_ORIGIN, headers: this.config.options?.headers, handshakeTimeout: this.config.connectTimeoutMs, timeout: this.config.connectTimeoutMs, agent: this.config.agent })
      if (!this.socket) throw new Error('WebSocket creation failed')
      
      this.socket.setMaxListeners(0)
      
      const events = ['error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response']
      events.forEach(e => this.socket?.on(e, (...args) => this.emit(e, ...args)))
      
      this.socket.on('close', (...args) => {
        this.emit('close', ...args)
        if (this._shouldReconnect && !this._isManualClose) this._attemptReconnect()
      })

      this.socket.on('open', () => {
        this._reconnectAttempts = 0
        this._reconnectDelay = 1000
        this._isReconnecting = false
        if (this._queue.length) this._dispatch()
      })
    } catch (error) {
      console.error('[WebSocket] Connection error:', error.message)
      this.socket = null
      throw error
    }
  }

  _attemptReconnect() {
    if (this._isReconnecting || this._reconnectAttempts >= this._maxReconnectAttempts) {
      if (this._reconnectAttempts >= this._maxReconnectAttempts) {
        console.error(`[WebSocket] Max reconnect attempts reached`)
        this.emit('reconnect-failed')
      }
      return
    }

    if (this._reconnectTimeout) clearTimeout(this._reconnectTimeout)
    this._isReconnecting = true
    this._reconnectAttempts++
    
    console.log(`[WebSocket] Reconnecting... Attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts}`)
    this._reconnectTimeout = setTimeout(async () => {
      try {
        await this.connect()
      } catch (error) {
        this._isReconnecting = false
        if (this._reconnectAttempts < this._maxReconnectAttempts) this._attemptReconnect()
      }
    }, this._reconnectDelay)

    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000)
  }

  async close() {
    this._isManualClose = true
    this._shouldReconnect = false
    this._isReconnecting = false
    if (this._reconnectTimeout) clearTimeout(this._reconnectTimeout)
    this.socket?.close?.()
    this.socket = null
    this._queue = []
  }

  async restart() {
    this._isManualClose = true
    this._isReconnecting = false
    if (this.socket) {
      await new Promise(resolve => { this.socket.once('close', resolve); this.socket.terminate() })
      this.socket = null
    }
    this._queue = []
    this._reconnectAttempts = 0
    this._reconnectDelay = 1000
    this._isManualClose = false
    this._shouldReconnect = true
    await this.connect()
  }

  send(str, cb) {
    const doSend = () => {
      if (this.isClosed || this.isClosing) {
        this._isManualClose = false
        this._shouldReconnect = true
        this._attemptReconnect()
        this._queue.unshift(doSend)
        cb?.(new Error('Socket closed, reconnecting...'))
        return false
      }
      if (!this.socket || !this.isOpen) {
        cb?.(new Error('Socket not open'))
        return false
      }
      try {
        this.socket.send(str, cb)
        return true
      } catch (error) {
        cb?.(error)
        return false
      }
    }
    this._queue.push(doSend)
    this._dispatch()
    return true
  }

  _dispatch() {
    if (this._isDispatching || (!this.isOpen && !this.isConnecting)) return
    const now = Date.now()
    const elapsed = now - this._lastDispatch
    if (this._queue.length && elapsed >= this._minSendIntervalMs) {
      this._isDispatching = true
      this._queue.shift()?.()
      this._lastDispatch = Date.now()
      this._isDispatching = false
      if (this._queue.length) setTimeout(() => this._dispatch(), Math.max(0, this._minSendIntervalMs - (Date.now() - this._lastDispatch)))
    } else if (this._queue.length) {
      setTimeout(() => this._dispatch(), Math.max(0, this._minSendIntervalMs - elapsed))
    }
  }

  disableAutoReconnect() { this._shouldReconnect = false }
  enableAutoReconnect() { this._shouldReconnect = true; this._isManualClose = false }
}

export default WebSocketClient