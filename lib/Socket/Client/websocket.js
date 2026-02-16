import WebSocket from 'ws'
import { DEFAULT_ORIGIN } from '../../Defaults/index.js'
import { AbstractSocketClient } from './types.js'

// ==================== CONSTANTS ====================
const CONSTANTS = {
  MIN_SEND_INTERVAL_MS: 50,
  MAX_RECONNECT_ATTEMPTS: 5,
  INITIAL_RECONNECT_DELAY: 1000,
  MAX_RECONNECT_DELAY: 30000,
  RECONNECT_BACKOFF_MULTIPLIER: 2
}

// ==================== WEBSOCKET CLIENT ====================
export class WebSocketClient extends AbstractSocketClient {
  constructor() {
    super(...arguments)
    
    // Core socket
    this.socket = null
    
    // Message queue
    this._queue = []
    this._isDispatching = false
    this._lastDispatch = 0
    this._minSendIntervalMs = CONSTANTS.MIN_SEND_INTERVAL_MS
    
    // Reconnection state
    this._reconnectTimeout = null
    this._reconnectAttempts = 0
    this._maxReconnectAttempts = CONSTANTS.MAX_RECONNECT_ATTEMPTS
    this._reconnectDelay = CONSTANTS.INITIAL_RECONNECT_DELAY
    this._shouldReconnect = true
    this._isManualClose = false
    this._isReconnecting = false
  }

  // ==================== CONNECTION STATE ====================
  get isOpen() {
    return this.socket?.readyState === WebSocket.OPEN
  }

  get isClosed() {
    return !this.socket || this.socket.readyState === WebSocket.CLOSED
  }

  get isClosing() {
    return !this.socket || this.socket.readyState === WebSocket.CLOSING
  }

  get isConnecting() {
    return this.socket?.readyState === WebSocket.CONNECTING
  }

  // ==================== CONNECTION MANAGEMENT ====================
  async connect() {
    if (this.socket && !this.isClosed) {
      console.log('[WebSocket] Already connected or connecting')
      return
    }

    try {
      console.log('[WebSocket] Establishing connection...')
      
      this.socket = new WebSocket(this.url, {
        origin: DEFAULT_ORIGIN,
        headers: this.config.options?.headers,
        handshakeTimeout: this.config.connectTimeoutMs,
        timeout: this.config.connectTimeoutMs,
        agent: this.config.agent
      })

      if (!this.socket) {
        throw new Error('WebSocket creation failed')
      }

      this.socket.setMaxListeners(0)

      // Forward all WebSocket events
      const events = ['error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response']
      events.forEach(e => {
        this.socket?.on(e, (...args) => this.emit(e, ...args))
      })

      // Handle close with auto-reconnect
      this.socket.on('close', (...args) => {
        this.emit('close', ...args)
        if (this._shouldReconnect && !this._isManualClose) {
          this._attemptReconnect()
        }
      })

      // Handle successful connection
      this.socket.on('open', () => {
        console.log('[WebSocket] Connection established')
        this._reconnectAttempts = 0
        this._reconnectDelay = CONSTANTS.INITIAL_RECONNECT_DELAY
        this._isReconnecting = false

        // Process any queued messages
        if (this._queue.length > 0) {
          console.log(`[WebSocket] Processing ${this._queue.length} queued messages`)
          this._dispatch()
        }
      })

    } catch (error) {
      console.error('[WebSocket] Connection error:', error.message)
      this.socket = null
      throw error
    }
  }

  async close() {
    console.log('[WebSocket] Closing connection (manual)')
    
    this._isManualClose = true
    this._shouldReconnect = false
    this._isReconnecting = false

    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout)
      this._reconnectTimeout = null
    }

    this.socket?.close?.()
    this.socket = null
    this._queue = []
  }

  async restart() {
    console.log('[WebSocket] Restarting connection...')
    
    this._isManualClose = true
    this._isReconnecting = false

    // Force close existing connection
    if (this.socket) {
      await new Promise(resolve => {
        this.socket.once('close', resolve)
        this.socket.terminate()
      })
      this.socket = null
    }

    // Clear queue and reset state
    this._queue = []
    this._reconnectDelay = CONSTANTS.INITIAL_RECONNECT_DELAY
    this._isManualClose = false
    this._shouldReconnect = true

    // Reconnect
    await this.connect()
  }

  // ==================== RECONNECTION LOGIC ====================
  _attemptReconnect() {
    if (this._isReconnecting) {
      console.log('[WebSocket] Reconnection already in progress')
      return
    }

    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.error(`[WebSocket] Max reconnect attempts (${this._maxReconnectAttempts}) reached`)
      this.emit('reconnect-failed')
      return
    }

    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout)
    }

    this._isReconnecting = true
    this._reconnectAttempts++

    console.log(
      `[WebSocket] Reconnecting... Attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts} ` +
      `(delay: ${this._reconnectDelay}ms)`
    )

    this._reconnectTimeout = setTimeout(async () => {
      try {
        await this.connect()
      } catch (error) {
        console.error('[WebSocket] Reconnection failed:', error.message)
        this._isReconnecting = false

        if (this._reconnectAttempts < this._maxReconnectAttempts) {
          this._attemptReconnect()
        } else {
          this.emit('reconnect-failed')
        }
      }
    }, this._reconnectDelay)

    // Exponential backoff with cap
    this._reconnectDelay = Math.min(
      this._reconnectDelay * CONSTANTS.RECONNECT_BACKOFF_MULTIPLIER,
      CONSTANTS.MAX_RECONNECT_DELAY
    )
  }

  // ==================== MESSAGE SENDING ====================
  send(str, cb) {
    const doSend = () => {
      // Handle closed/closing socket
      if (this.isClosed || this.isClosing) {
        console.warn('[WebSocket] Socket closed, attempting reconnection...')
        
        this._isManualClose = false
        this._shouldReconnect = true
        this._attemptReconnect()
        this._queue.unshift(doSend) // Re-queue at front
        
        cb?.(new Error('Socket closed, reconnecting...'))
        return false
      }

      // Check if socket is ready
      if (!this.socket || !this.isOpen) {
        cb?.(new Error('Socket not open'))
        return false
      }

      // Send the message
      try {
        this.socket.send(str, cb)
        return true
      } catch (error) {
        console.error('[WebSocket] Send error:', error.message)
        cb?.(error)
        return false
      }
    }

    this._queue.push(doSend)
    this._dispatch()
    return true
  }

  // ==================== MESSAGE QUEUE DISPATCH ====================
  _dispatch() {
    // Don't dispatch if already dispatching or socket not ready
    if (this._isDispatching || (!this.isOpen && !this.isConnecting)) {
      return
    }

    const now = Date.now()
    const elapsed = now - this._lastDispatch

    // Check if enough time has passed and queue has items
    if (this._queue.length && elapsed >= this._minSendIntervalMs) {
      this._isDispatching = true
      
      const sendFn = this._queue.shift()
      sendFn?.()
      
      this._lastDispatch = Date.now()
      this._isDispatching = false

      // Schedule next dispatch if queue not empty
      if (this._queue.length) {
        const nextDelay = Math.max(0, this._minSendIntervalMs - (Date.now() - this._lastDispatch))
        setTimeout(() => this._dispatch(), nextDelay)
      }
    } else if (this._queue.length) {
      // Schedule dispatch after required interval
      const delay = Math.max(0, this._minSendIntervalMs - elapsed)
      setTimeout(() => this._dispatch(), delay)
    }
  }

  // ==================== PUBLIC CONTROL METHODS ====================
  disableAutoReconnect() {
    console.log('[WebSocket] Auto-reconnect disabled')
    this._shouldReconnect = false
  }

  enableAutoReconnect() {
    console.log('[WebSocket] Auto-reconnect enabled')
    this._shouldReconnect = true
    this._isManualClose = false
  }

  // Getters for external monitoring
  get reconnectAttempts() {
    return this._reconnectAttempts
  }

  get queueLength() {
    return this._queue.length
  }

  get isReconnecting() {
    return this._isReconnecting
  }
}

export default WebSocketClient