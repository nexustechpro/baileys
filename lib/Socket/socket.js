import { Boom } from "@hapi/boom"
import { randomBytes } from "crypto"
import { URL } from "url"
import { promisify } from "util"
import { proto } from "../../WAProto/index.js"
import { DEF_CALLBACK_PREFIX, DEF_TAG_PREFIX, INITIAL_PREKEY_COUNT, MIN_PREKEY_COUNT, MIN_UPLOAD_INTERVAL, NOISE_WA_HEADER, PROCESSABLE_HISTORY_TYPES, TimeMs, UPLOAD_TIMEOUT } from "../Defaults/index.js"
import { DisconnectReason } from "../Types/index.js"
import { addTransactionCapability, aesEncryptCTR, bindWaitForConnectionUpdate, bytesToCrockford, configureSuccessfulPairing, Curve, derivePairingCodeKey, generateLoginNode, generateMdTagPrefix, generateRegistrationNode, getCodeFromWSError, getErrorCodeFromStreamError, getNextPreKeysNode, makeEventBuffer, makeNoiseHandler, promiseTimeout, signedKeyPair, xmppSignedPreKey } from "../Utils/index.js"
import { getPlatformId } from "../Utils/browser-utils.js"
import { assertNodeErrorFree, binaryNodeToString, encodeBinaryNode, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren, isLidUser, jidDecode, jidEncode, S_WHATSAPP_NET } from "../WABinary/index.js"
import { BinaryInfo } from "../WAM/BinaryInfo.js"
import { USyncQuery, USyncUser } from "../WAUSync/index.js"
import { WebSocketClient } from "./Client/index.js"

export const makeSocket = (config) => {
  const { waWebSocketUrl, connectTimeoutMs, logger, keepAliveIntervalMs, browser, auth: authState, printQRInTerminal, defaultQueryTimeoutMs, transactionOpts, qrTimeout, makeSignalRepository } = config

  if (printQRInTerminal) logger.warn({}, '⚠️ printQRInTerminal deprecated. Listen to connection.update event and handle QR yourself.')

  const syncDisabled = PROCESSABLE_HISTORY_TYPES.map(syncType => config.shouldSyncHistoryMessage({ syncType })).filter(x => x === false).length === PROCESSABLE_HISTORY_TYPES.length
  if (syncDisabled) logger.warn('⚠️ DANGER: DISABLING ALL SYNC BY shouldSyncHistoryMsg PREVENTS BAILEYS FROM ACCESSING INITIAL LID MAPPINGS')

  const url = typeof waWebSocketUrl === "string" ? new URL(waWebSocketUrl) : waWebSocketUrl
  if (config.mobile || url.protocol === "tcp:") throw new Boom("Mobile API not supported", { statusCode: DisconnectReason.loggedOut })
  if (url.protocol === "wss" && authState?.creds?.routingInfo) url.searchParams.append("ED", authState.creds.routingInfo.toString("base64url"))

  const ephemeralKeyPair = Curve.generateKeyPair()
  const noise = makeNoiseHandler({ keyPair: ephemeralKeyPair, NOISE_HEADER: NOISE_WA_HEADER, logger, routingInfo: authState?.creds?.routingInfo })
  const ws = new WebSocketClient(url, config)
  ws.connect()

  const ev = makeEventBuffer(logger)
  const { creds } = authState
  const keys = addTransactionCapability(authState.keys, logger, transactionOpts)
  const signalRepository = makeSignalRepository({ creds, keys }, logger, pnFromLIDUSync)

  const publicWAMBuffer = new BinaryInfo()
  let serverTimeOffsetMs = 0
  let epoch = 1, lastDateRecv, keepAliveReq, qrTimer, closed = false
  let uploadPreKeysPromise = null, lastUploadTime = 0

  const uqTagId = generateMdTagPrefix()
  const generateMessageTag = () => `${uqTagId}${epoch++}`
  const sendPromise = promisify(ws.send)

  const onUnexpectedError = (err, msg) => logger.error({ err }, `unexpected error in '${msg}'`)

  const sendRawMessage = async (data) => {
    if (!ws.isOpen) throw new Boom("Connection Closed", { statusCode: DisconnectReason.connectionClosed })
    const bytes = noise.encodeFrame(data)
    await promiseTimeout(connectTimeoutMs, async (resolve, reject) => {
      try {
        await sendPromise.call(ws, bytes)
        resolve()
      } catch (error) { reject(error) }
    })
  }

  const sendNode = (frame) => {
    if (logger.level === "trace") logger.trace({ xml: binaryNodeToString(frame), msg: "xml send" })
    return sendRawMessage(encodeBinaryNode(frame))
  }

  const waitForMessage = async (msgId, timeoutMs = defaultQueryTimeoutMs) => {
    let onRecv, onErr
    try {
      return await promiseTimeout(timeoutMs, (resolve, reject) => {
        onRecv = (data) => resolve(data)
        onErr = (err) => reject(err || new Boom("Connection Closed", { statusCode: DisconnectReason.connectionClosed }))
        ws.on(`TAG:${msgId}`, onRecv)
        ws.on("close", onErr)
        ws.on("error", onErr)
        return () => reject(new Boom("Query Cancelled"))
      })
    } catch (error) {
      if (error instanceof Boom && error.output?.statusCode === DisconnectReason.timedOut) {
        logger?.warn?.({ msgId }, "timed out waiting for message")
        return undefined
      }
      throw error
    } finally {
      if (onRecv) ws.off(`TAG:${msgId}`, onRecv)
      if (onErr) { ws.off("close", onErr); ws.off("error", onErr) }
    }
  }

  const query = async (node, timeoutMs) => {
    if (!node.attrs.id) node.attrs.id = generateMessageTag()
    const msgId = node.attrs.id
    const result = await promiseTimeout(timeoutMs, async (resolve, reject) => {
      const result = waitForMessage(msgId, timeoutMs).catch(reject)
      sendNode(node).then(async () => resolve(await result)).catch(reject)
    })
    if (result && "tag" in result) assertNodeErrorFree(result)
    return result
  }

  const digestKeyBundle = async () => {
    const res = await query({ tag: "iq", attrs: { to: S_WHATSAPP_NET, type: "get", xmlns: "encrypt" }, content: [{ tag: "digest", attrs: {} }] })
    const digestNode = getBinaryNodeChild(res, "digest")
    if (!digestNode) { await uploadPreKeys(); throw new Error("encrypt/get digest returned no digest node") }
  }

  const rotateSignedPreKey = async () => {
    const newId = (creds.signedPreKey.keyId || 0) + 1
    const skey = await signedKeyPair(creds.signedIdentityKey, newId)
    await query({ tag: "iq", attrs: { to: S_WHATSAPP_NET, type: "set", xmlns: "encrypt" }, content: [{ tag: "rotate", attrs: {}, content: [xmppSignedPreKey(skey)] }] })
    ev.emit("creds.update", { signedPreKey: skey })
  }

  const executeUSyncQuery = async (usyncQuery) => {
    if (usyncQuery.protocols.length === 0) throw new Boom("USyncQuery must have at least one protocol")
    const userNodes = usyncQuery.users.map((user) => ({ tag: "user", attrs: { jid: !user.phone ? user.id : undefined }, content: usyncQuery.protocols.map((a) => a.getUserElement(user)).filter((a) => a !== null) }))
    const iq = { tag: "iq", attrs: { to: S_WHATSAPP_NET, type: "get", xmlns: "usync" }, content: [{ tag: "usync", attrs: { context: usyncQuery.context, mode: usyncQuery.mode, sid: generateMessageTag(), last: "true", index: "0" }, content: [{ tag: "query", attrs: {}, content: usyncQuery.protocols.map((a) => a.getQueryElement()) }, { tag: "list", attrs: {}, content: userNodes }] }] }
    return usyncQuery.parseUSyncQueryResult(await query(iq))
  }

  const onWhatsApp = async (...phoneNumber) => {
    let usyncQuery = new USyncQuery(), contactEnabled = false
    for (const jid of phoneNumber) {
      if (isLidUser(jid)) { logger?.warn("LIDs not supported with onWhatsApp"); continue }
      if (!contactEnabled) { contactEnabled = true; usyncQuery = usyncQuery.withContactProtocol() }
      const phone = `+${jid.replace("+", "").split("@")[0]?.split(":")[0]}`
      usyncQuery.withUser(new USyncUser().withPhone(phone))
    }
    if (usyncQuery.users.length === 0) return []
    const results = await executeUSyncQuery(usyncQuery)
    return results ? results.list.filter((a) => !!a.contact).map(({ contact, id }) => ({ jid: id, exists: contact })) : []
  }

  async function pnFromLIDUSync(jids) {
    const usyncQuery = new USyncQuery().withLIDProtocol().withContext("background")
    for (const jid of jids) {
      if (isLidUser(jid)) { logger?.warn("LID user found in LID fetch call"); continue }
      else usyncQuery.withUser(new USyncUser().withId(jid))
    }
    if (usyncQuery.users.length === 0) return []
    const results = await executeUSyncQuery(usyncQuery)
    return results ? results.list.filter((a) => !!a.lid).map(({ lid, id }) => ({ pn: id, lid })) : []
  }

  const awaitNextMessage = async (sendMsg) => {
    if (!ws.isOpen) throw new Boom("Connection Closed", { statusCode: DisconnectReason.connectionClosed })
    let onOpen, onClose
    const result = promiseTimeout(connectTimeoutMs, (resolve, reject) => {
      onOpen = resolve
      onClose = mapWebSocketError(reject)
      ws.on("frame", onOpen)
      ws.on("close", onClose)
      ws.on("error", onClose)
    }).finally(() => { ws.off("frame", onOpen); ws.off("close", onClose); ws.off("error", onClose) })
    if (sendMsg) sendRawMessage(sendMsg).catch(onClose)
    return result
  }

  const validateConnection = async () => {
    let helloMsg = { clientHello: { ephemeral: ephemeralKeyPair.public } }
    helloMsg = proto.HandshakeMessage.fromObject(helloMsg)
    logger.info({ browser, helloMsg }, "connected to WA")
    const init = proto.HandshakeMessage.encode(helloMsg).finish()
    const result = await awaitNextMessage(init)
    const handshake = proto.HandshakeMessage.decode(result)
    logger.trace({ handshake }, "handshake recv from WA")
    const keyEnc = noise.processHandshake(handshake, creds.noiseKey)
    const node = !creds.me ? generateRegistrationNode(creds, config) : generateLoginNode(creds.me.id, config)
    logger.info({ node }, !creds.me ? "attempting registration..." : "logging in...")
    const payloadEnc = noise.encrypt(proto.ClientPayload.encode(node).finish())
    await sendRawMessage(proto.HandshakeMessage.encode({ clientFinish: { static: keyEnc, payload: payloadEnc } }).finish())
    await noise.finishInit()
    startKeepAliveRequest()
  }

  const getAvailablePreKeysOnServer = async () => {
    const result = await query({ tag: "iq", attrs: { id: generateMessageTag(), xmlns: "encrypt", type: "get", to: S_WHATSAPP_NET }, content: [{ tag: "count", attrs: {} }] })
    return +getBinaryNodeChild(result, "count").attrs.value
  }

  const uploadPreKeys = async (count = MIN_PREKEY_COUNT, retryCount = 0) => {
    if (retryCount === 0 && Date.now() - lastUploadTime < MIN_UPLOAD_INTERVAL) { logger.debug(`Skipping upload, only ${Date.now() - lastUploadTime}ms since last`); return }
    if (uploadPreKeysPromise) { logger.debug("Pre-key upload in progress, waiting"); await uploadPreKeysPromise; return }

    const uploadLogic = async () => {
      logger.info({ count, retryCount }, "uploading pre-keys")
      const node = await keys.transaction(async () => {
        const { update, node } = await getNextPreKeysNode({ creds, keys }, count)
        ev.emit("creds.update", update)
        return node
      }, creds?.me?.id || "upload-pre-keys")

      try {
        await query(node)
        logger.info({ count }, "uploaded pre-keys successfully")
        lastUploadTime = Date.now()
      } catch (uploadError) {
        logger.error({ uploadError: uploadError.toString(), count }, "Failed to upload pre-keys")
        if (retryCount < 3) {
          const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 10000)
          logger.info(`Retrying pre-key upload in ${backoffDelay}ms`)
          await new Promise((resolve) => setTimeout(resolve, backoffDelay))
          return uploadPreKeys(count, retryCount + 1)
        }
        throw uploadError
      }
    }

    uploadPreKeysPromise = Promise.race([uploadLogic(), new Promise((_, reject) => setTimeout(() => reject(new Boom("Pre-key upload timeout", { statusCode: 408 })), UPLOAD_TIMEOUT))])
    try { await uploadPreKeysPromise } finally { uploadPreKeysPromise = null }
  }

  const verifyCurrentPreKeyExists = async () => {
    const currentPreKeyId = creds.nextPreKeyId - 1
    if (currentPreKeyId <= 0) return { exists: false, currentPreKeyId: 0 }
    const preKeys = await keys.get("pre-key", [currentPreKeyId.toString()])
    return { exists: !!preKeys[currentPreKeyId.toString()], currentPreKeyId }
  }

  const uploadPreKeysToServerIfRequired = async () => {
    try {
      const preKeyCount = await getAvailablePreKeysOnServer()
      const count = preKeyCount === 0 ? INITIAL_PREKEY_COUNT : MIN_PREKEY_COUNT
      const { exists: currentPreKeyExists, currentPreKeyId } = await verifyCurrentPreKeyExists()
      logger.info(`${preKeyCount} pre-keys found on server`)
      logger.info(`Current prekey ID: ${currentPreKeyId}, exists in storage: ${currentPreKeyExists}`)
      const lowServerCount = preKeyCount <= count
      const missingCurrentPreKey = !currentPreKeyExists && currentPreKeyId > 0
      if (lowServerCount || missingCurrentPreKey) {
        const reasons = []
        if (lowServerCount) reasons.push(`server count low (${preKeyCount})`)
        if (missingCurrentPreKey) reasons.push(`current prekey ${currentPreKeyId} missing`)
        logger.info(`Uploading PreKeys due to: ${reasons.join(", ")}`)
        await uploadPreKeys(count)
      } else logger.info(`PreKey validation passed - Server: ${preKeyCount}, Current prekey ${currentPreKeyId} exists`)
    } catch (error) { logger.error({ error }, "Failed to check/upload pre-keys during init") }
  }

  const onMessageReceived = async (data) => {
    await noise.decodeFrame(data, (frame) => {
      lastDateRecv = new Date()
      let anyTriggered = ws.emit("frame", frame)
      if (!(frame instanceof Uint8Array)) {
        const msgId = frame.attrs.id
        if (logger.level === "trace") logger.trace({ xml: binaryNodeToString(frame), msg: "recv xml" })
        anyTriggered = ws.emit(`${DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered
        const l0 = frame.tag, l1 = frame.attrs || {}, l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : ""
        for (const key of Object.keys(l1)) {
          anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered
          anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered
          anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered
        }
        anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered
        anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered
        if (!anyTriggered && logger.level === "debug") logger.debug({ unhandled: true, msgId, fromMe: false, frame }, "communication recv")
      }
    })
  }

  const end = async (error) => {
    if (closed) { logger.trace({ trace: error?.stack }, "connection already closed"); return }
    closed = true
    logger.info({ trace: error?.stack }, error ? "connection errored" : "connection closed")
    clearInterval(keepAliveReq)
    clearTimeout(qrTimer)
    ws.removeAllListeners("close")
    ws.removeAllListeners("open")
    ws.removeAllListeners("message")
    if (!ws.isClosed && !ws.isClosing) { try { await ws.close() } catch {} }
    ev.emit("connection.update", { connection: "close", lastDisconnect: { error, date: new Date() } })
    ev.removeAllListeners("connection.update")
  }

  const waitForSocketOpen = async () => {
    if (ws.isOpen) return
    if (ws.isClosed || ws.isClosing) throw new Boom("Connection Closed", { statusCode: DisconnectReason.connectionClosed })
    let onOpen, onClose
    await new Promise((resolve, reject) => {
      onOpen = () => resolve(undefined)
      onClose = mapWebSocketError(reject)
      ws.on("open", onOpen)
      ws.on("close", onClose)
      ws.on("error", onClose)
    }).finally(() => { ws.off("open", onOpen); ws.off("close", onClose); ws.off("error", onClose) })
  }

  const startKeepAliveRequest = () => (keepAliveReq = setInterval(() => {
    if (!lastDateRecv) lastDateRecv = new Date()
    const diff = Date.now() - lastDateRecv.getTime()
    if (diff > keepAliveIntervalMs + 5000) void end(new Boom("Connection was lost", { statusCode: DisconnectReason.connectionLost }))
    else if (ws.isOpen) query({ tag: "iq", attrs: { id: generateMessageTag(), to: S_WHATSAPP_NET, type: "get", xmlns: "w:p" }, content: [{ tag: "ping", attrs: {} }] }).catch(err => logger.error({ trace: err.stack }, "error in sending keep alive"))
    else logger.warn("keep alive called when WS not open")
  }, keepAliveIntervalMs))

  const sendPassiveIq = (tag) => query({ tag: "iq", attrs: { to: S_WHATSAPP_NET, xmlns: "passive", type: "set" }, content: [{ tag, attrs: {} }] })

  const logout = async (msg) => {
    const jid = authState.creds.me?.id
    if (jid) await sendNode({ tag: "iq", attrs: { to: S_WHATSAPP_NET, type: "set", id: generateMessageTag(), xmlns: "md" }, content: [{ tag: "remove-companion-device", attrs: { jid, reason: "user_initiated" } }] })
    void end(new Boom(msg || "Intentional Logout", { statusCode: DisconnectReason.loggedOut }))
  }

  const requestPairingCode = async (phoneNumber, customPairingCode) => {
    const pairingCode = customPairingCode ?? bytesToCrockford(randomBytes(5))
    if (customPairingCode && customPairingCode?.length !== 8) throw new Error("Custom pairing code must be exactly 8 chars")
    authState.creds.pairingCode = pairingCode
    authState.creds.me = { id: jidEncode(phoneNumber, "s.whatsapp.net"), name: "~" }
    ev.emit("creds.update", authState.creds)
    await sendNode({ tag: "iq", attrs: { to: S_WHATSAPP_NET, type: "set", id: generateMessageTag(), xmlns: "md" }, content: [{ tag: "link_code_companion_reg", attrs: { jid: authState.creds.me.id, stage: "companion_hello", should_show_push_notification: "true" }, content: [{ tag: "link_code_pairing_wrapped_companion_ephemeral_pub", attrs: {}, content: await generatePairingKey() }, { tag: "companion_server_auth_key_pub", attrs: {}, content: authState.creds.noiseKey.public }, { tag: "companion_platform_id", attrs: {}, content: getPlatformId(browser[1]) }, { tag: "companion_platform_display", attrs: {}, content: `${browser[1]} (${browser[0]})` }, { tag: "link_code_pairing_nonce", attrs: {}, content: "0" }] }] })
    return authState.creds.pairingCode
  }

  async function generatePairingKey() {
    const salt = randomBytes(32), randomIv = randomBytes(16)
    const key = await derivePairingCodeKey(authState.creds.pairingCode, salt)
    const ciphered = aesEncryptCTR(authState.creds.pairingEphemeralKeyPair.public, key, randomIv)
    return Buffer.concat([salt, randomIv, ciphered])
  }

  const sendWAMBuffer = (wamBuffer) => query({ tag: "iq", attrs: { to: S_WHATSAPP_NET, id: generateMessageTag(), xmlns: "w:stats" }, content: [{ tag: "add", attrs: { t: Math.round(Date.now() / 1000) + "" }, content: wamBuffer }] })

  const updateServerTimeOffset = ({ attrs }) => {
    const tValue = attrs?.t
    if (!tValue) return
    const parsed = Number(tValue)
    if (Number.isNaN(parsed) || parsed <= 0) return
    serverTimeOffsetMs = parsed * 1000 - Date.now()
    logger.debug({ offset: serverTimeOffsetMs }, "calculated server time offset")
  }

  const getUnifiedSessionId = () => {
    const offsetMs = 3 * TimeMs.Day
    const now = Date.now() + serverTimeOffsetMs
    return ((now + offsetMs) % TimeMs.Week).toString()
  }

  const sendUnifiedSession = async () => {
    if (!ws.isOpen) return
    try { await sendNode({ tag: "ib", attrs: {}, content: [{ tag: "unified_session", attrs: { id: getUnifiedSessionId() } }] }) } 
    catch (error) { logger.debug({ error }, "failed to send unified_session telemetry") }
  }

  ws.on("message", onMessageReceived)
  ws.on("open", async () => { try { await validateConnection() } catch (err) { logger.error({ err }, "error in validating connection"); void end(err) } })
  ws.on("error", mapWebSocketError(end))
  ws.on("close", () => void end(new Boom("Connection Terminated", { statusCode: DisconnectReason.connectionClosed })))
  ws.on("CB:xmlstreamend", () => void end(new Boom("Connection Terminated by Server", { statusCode: DisconnectReason.connectionClosed })))

  ws.on("CB:iq,type:set,pair-device", async (stanza) => {
    await sendNode({ tag: "iq", attrs: { to: S_WHATSAPP_NET, type: "result", id: stanza.attrs.id } })
    const pairDeviceNode = getBinaryNodeChild(stanza, "pair-device")
    const refNodes = getBinaryNodeChildren(pairDeviceNode, "ref")
    const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString("base64")
    const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString("base64")
    const advB64 = creds.advSecretKey
    let qrMs = qrTimeout || 60000
    const genPairQR = () => {
      if (!ws.isOpen) return
      const refNode = refNodes.shift()
      if (!refNode) { void end(new Boom("QR refs attempts ended", { statusCode: DisconnectReason.timedOut })); return }
      const ref = refNode.content.toString("utf-8")
      const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(",")
      ev.emit("connection.update", { qr })
      qrTimer = setTimeout(genPairQR, qrMs)
      qrMs = qrTimeout || 20000
    }
    genPairQR()
  })

  ws.on("CB:iq,,pair-success", async (stanza) => {
    logger.debug("pair success recv")
    try {
      updateServerTimeOffset(stanza)
      const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, creds)
      logger.info({ me: updatedCreds.me, platform: updatedCreds.platform }, "pairing configured successfully")
      ev.emit("creds.update", updatedCreds)
      ev.emit("connection.update", { isNewLogin: true, qr: undefined })
      await sendNode(reply)
      void sendUnifiedSession()
    } catch (error) { logger.info({ trace: error.stack }, "error in pairing"); void end(error) }
  })

  ws.on("CB:success", async (node) => {
    try {
      updateServerTimeOffset(node)
      await uploadPreKeysToServerIfRequired()
      await sendPassiveIq("active")
      try { await digestKeyBundle() } catch (e) { logger.warn({ e }, "failed to run digest after login") }
    } catch (err) { logger.warn({ err }, "failed to send initial passive iq") }
    logger.info("opened connection to WA")
    clearTimeout(qrTimer)
    ev.emit("creds.update", { me: { ...authState.creds.me, lid: node.attrs.lid } })
    ev.emit("connection.update", { connection: "open" })
    void sendUnifiedSession()

    if (node.attrs.lid && authState.creds.me?.id) {
      const myLID = node.attrs.lid
      process.nextTick(async () => {
        try {
          const myPN = authState.creds.me.id
          await signalRepository.lidMapping.storeLIDPNMappings([{ lid: myLID, pn: myPN }])
          const { user, device } = jidDecode(myPN)
          await authState.keys.set({ "device-list": { [user]: [device?.toString() || "0"] } })
          await signalRepository.migrateSession(myPN, myLID)
          logger.info({ myPN, myLID }, "Own LID session created successfully")
        } catch (error) { logger.error({ error, lid: myLID }, "Failed to create own LID session") }
      })
    }
  })

  ws.on("CB:stream:error", (node) => {
    logger.error({ node }, "stream errored out")
    const { reason, statusCode } = getErrorCodeFromStreamError(node)
    void end(new Boom(`Stream Errored (${reason})`, { statusCode, data: node }))
  })

  ws.on("CB:failure", (node) => {
    const reason = +(node.attrs.reason || 500)
    void end(new Boom("Connection Failure", { statusCode: reason, data: node.attrs }))
  })

  ws.on("CB:ib,,downgrade_webclient", () => void end(new Boom("Multi-device beta not joined", { statusCode: DisconnectReason.multideviceMismatch })))

  ws.on("CB:ib,,offline_preview", async (node) => {
    logger.info("offline preview received", JSON.stringify(node))
    await sendNode({ tag: "ib", attrs: {}, content: [{ tag: "offline_batch", attrs: { count: "100" } }] })
  })

  ws.on("CB:ib,,edge_routing", (node) => {
    const edgeRoutingNode = getBinaryNodeChild(node, "edge_routing")
    const routingInfo = getBinaryNodeChild(edgeRoutingNode, "routing_info")
    if (routingInfo?.content) { authState.creds.routingInfo = Buffer.from(routingInfo?.content); ev.emit("creds.update", authState.creds) }
  })

  let didStartBuffer = false
  process.nextTick(() => {
    if (creds.me?.id) { ev.buffer(); didStartBuffer = true }
    ev.emit("connection.update", { connection: "connecting", receivedPendingNotifications: false, qr: undefined })
  })

  ws.on("CB:ib,,offline", (node) => {
    const child = getBinaryNodeChild(node, "offline")
    const offlineNotifs = +(child?.attrs.count || 0)
    logger.info(`handled ${offlineNotifs} offline messages/notifications`)
    if (didStartBuffer) { ev.flush(); logger.trace("flushed events for initial buffer") }
    ev.emit("connection.update", { receivedPendingNotifications: true })
  })

  ev.on("creds.update", (update) => {
    const name = update.me?.name
    if (creds.me?.name !== name) {
      logger.debug({ name }, "updated pushName")
      sendNode({ tag: "presence", attrs: { name } }).catch((err) => logger.warn({ trace: err.stack }, "error in sending presence update on name change"))
    }
    Object.assign(creds, update)
  })

  return {
    type: "md", ws, ev, authState: { creds, keys }, signalRepository,
    get user() { return authState.creds.me },
    generateMessageTag, query, waitForMessage, waitForSocketOpen, sendRawMessage, sendNode,
    logout, end, onUnexpectedError, uploadPreKeys, uploadPreKeysToServerIfRequired,
    digestKeyBundle, rotateSignedPreKey, requestPairingCode,
    updateServerTimeOffset, sendUnifiedSession, wamBuffer: publicWAMBuffer,
    waitForConnectionUpdate: bindWaitForConnectionUpdate(ev), sendWAMBuffer,
    executeUSyncQuery, onWhatsApp
  }
}

function mapWebSocketError(handler) {
  return (error) => handler(new Boom(`WebSocket Error (${error?.message})`, { statusCode: getCodeFromWSError(error), data: error }))
}