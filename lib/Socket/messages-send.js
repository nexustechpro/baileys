import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import * as Utils from '../Utils/index.js'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL, BATCH_SIZE } from '../Defaults/index.js'
import * as WABinary from '../WABinary/index.js'
import { getUrlInfo } from '../Utils/link-preview.js'
import { makeKeyedMutex } from '../Utils/make-mutex.js'
import { USyncQuery, USyncUser } from '../WAUSync/index.js'
import { makeNewsletterSocket } from './newsletter.js'
import NexusHandler from './nexus-handler.js'
import { randomBytes } from 'crypto'

const {
    aggregateMessageKeysNotFromMe, assertMediaContent, bindWaitForEvent, decryptMediaRetryData,
    encodeNewsletterMessage, encodeSignedDeviceIdentity, encodeWAMessage, encryptMediaRetryRequest,
    extractDeviceJids, generateMessageIDV2, generateParticipantHashV2, generateWAMessage,
    getStatusCodeForMediaRetry, getUrlFromDirectPath, getWAUploadToServer, MessageRetryManager,
    normalizeMessageContent, parseAndInjectE2ESessions, unixTimestampSeconds,
    generateWAMessageFromContent, delay, generateMessageID
} = Utils

const {
    areJidsSameUser, getBinaryNodeChild, getBinaryNodeChildren, isHostedLidUser, isHostedPnUser,
    isJidGroup, isLidUser, isPnUser, jidDecode, jidEncode, jidNormalizedUser, S_WHATSAPP_NET,
    getBinaryFilteredButtons, STORIES_JID, isJidUser, isJidNewsletter
} = WABinary

export const makeMessagesSocket = (config) => {
    const {
        logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview,
        options: httpRequestOptions, patchMessageBeforeSending, cachedGroupMetadata,
        enableRecentMessageCache, maxMsgRetryCount
    } = config

    const sock = makeNewsletterSocket(config)
    const { ev, authState, processingMutex, signalRepository, upsertMessage, query, fetchPrivacySettings, sendNode, groupMetadata, groupToggleEphemeral } = sock

    // Initialize caches
    const userDevicesCache = config.userDevicesCache || new NodeCache({ stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, useClones: false })
    const peerSessionsCache = new NodeCache({ stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, useClones: false })
    const messageRetryManager = enableRecentMessageCache ? new MessageRetryManager(logger, maxMsgRetryCount) : null
    const encryptionMutex = makeKeyedMutex()

    let mediaConn

    // ===== MEDIA CONNECTION MANAGEMENT =====
    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn
        if (!media || forceGet || Date.now() - media.fetchDate.getTime() > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({
                    tag: 'iq',
                    attrs: { type: 'set', xmlns: 'w:m', to: S_WHATSAPP_NET },
                    content: [{ tag: 'media_conn', attrs: {} }]
                })
                const mediaConnNode = getBinaryNodeChild(result, 'media_conn')
                return {
                    hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                }
            })()
            logger.debug('fetched media conn')
        }
        return mediaConn
    }

    // ===== RECEIPT HANDLING =====
    const sendReceipt = async (jid, participant, messageIds, type) => {
        if (!messageIds?.length) throw new Boom('missing ids in receipt')

        const node = { tag: 'receipt', attrs: { id: messageIds[0] } }
        const isReadReceipt = type === 'read' || type === 'read-self'
        
        if (isReadReceipt) node.attrs.t = unixTimestampSeconds().toString()
        
        if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) {
            node.attrs.recipient = jid
            node.attrs.to = participant
        } else {
            node.attrs.to = jid
            if (participant) node.attrs.participant = participant
        }
        
        if (type) node.attrs.type = type
        
        if (messageIds.length > 1) {
            node.content = [{
                tag: 'list',
                attrs: {},
                content: messageIds.slice(1).map(id => ({ tag: 'item', attrs: { id } }))
            }]
        }

        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt')
        await sendNode(node)
    }

    const sendReceipts = async (keys, type) => {
        const recps = aggregateMessageKeysNotFromMe(keys)
        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type)
        }
    }

    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings()
        const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
        await sendReceipts(keys, readType)
    }

    // ===== DEVICE & SESSION MANAGEMENT =====
    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = []
        if (!useCache) logger.debug('not using cache for devices')

        const jidsWithUser = jids.map(jid => {
            const decoded = jidDecode(jid)
            const user = decoded?.user
            const device = decoded?.device
            
            if (typeof device === 'number' && device >= 0 && user) {
                deviceResults.push({ user, device, jid })
                return null
            }
            return { jid: jidNormalizedUser(jid), user }
        }).filter(Boolean)

        // Check cache
        let mgetDevices
        if (useCache && userDevicesCache.mget) {
            mgetDevices = await userDevicesCache.mget(jidsWithUser.map(j => j?.user).filter(Boolean))
        }

        const toFetch = []
        for (const { jid, user } of jidsWithUser) {
            if (useCache) {
                const devices = mgetDevices?.[user] || (userDevicesCache.mget ? undefined : await userDevicesCache.get(user))
                if (devices) {
                    deviceResults.push(...devices.map(d => ({ ...d, jid: jidEncode(d.user, d.server, d.device) })))
                    logger.trace({ user }, 'using cache for devices')
                } else {
                    toFetch.push(jid)
                }
            } else {
                toFetch.push(jid)
            }
        }

        if (!toFetch.length) return deviceResults

        // Fetch from server
        const requestedLidUsers = new Set()
        for (const jid of toFetch) {
            if (isLidUser(jid) || isHostedLidUser(jid)) {
                const user = jidDecode(jid)?.user
                if (user) requestedLidUsers.add(user)
            }
        }

        const query = new USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol()
        for (const jid of toFetch) query.withUser(new USyncUser().withId(jid))

        const result = await sock.executeUSyncQuery(query)
        if (result) {
            // Store LID mappings
            const lidResults = result.list.filter(a => !!a.lid)
            if (lidResults.length > 0) {
                logger.trace('Storing LID maps from device call')
                await signalRepository.lidMapping.storeLIDPNMappings(lidResults.map(a => ({ lid: a.lid, pn: a.id })))
            }

            const extracted = extractDeviceJids(result?.list, authState.creds.me.id, authState.creds.me.lid, ignoreZeroDevices)
            const deviceMap = {}
            
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || []
                deviceMap[item.user]?.push(item)
            }

            for (const [user, userDevices] of Object.entries(deviceMap)) {
                const isLidUser = requestedLidUsers.has(user)
                for (const item of userDevices) {
                    const finalJid = isLidUser ? jidEncode(user, item.server, item.device) : jidEncode(item.user, item.server, item.device)
                    deviceResults.push({ ...item, jid: finalJid })
                }
            }

            // Cache results
            if (userDevicesCache.mset) {
                await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })))
            } else {
                for (const key in deviceMap) {
                    if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key])
                }
            }

            // Store device lists
            const userDeviceUpdates = {}
            for (const [userId, devices] of Object.entries(deviceMap)) {
                if (devices?.length > 0) userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0')
            }

            if (Object.keys(userDeviceUpdates).length > 0) {
                try {
                    const existingData = await authState.keys.get('device-list', ['_index'])
                    const currentBatch = existingData?.['_index'] || {}
                    const mergedBatch = { ...currentBatch, ...userDeviceUpdates }
                    
                    // Keep only the most recent users (enforce batch size limit)
                    const userKeys = Object.keys(mergedBatch).sort()
                    const trimmedBatch = {}
                    userKeys.slice(-BATCH_SIZE).forEach(userId => { trimmedBatch[userId] = mergedBatch[userId] })
                    
                    await authState.keys.set({ 'device-list': { '_index': trimmedBatch } })
                    logger.debug({ userCount: Object.keys(userDeviceUpdates).length, batchSize: Object.keys(trimmedBatch).length }, 'stored user device lists')
                } catch (error) {
                    logger.warn({ error }, 'failed to store user device lists')
                }
            }
        }

        return deviceResults
    }

    const assertSessions = async (jids) => {
        let didFetchNewSession = false
        const uniqueJids = [...new Set(jids)]
        const jidsRequiringFetch = []

        for (const jid of uniqueJids) {
            const signalId = signalRepository.jidToSignalProtocolAddress(jid)
            const cachedSession = peerSessionsCache.get(signalId)

            if (cachedSession !== undefined) {
                if (cachedSession) continue
            } else {
                const sessionValidation = await signalRepository.validateSession(jid)
                peerSessionsCache.set(signalId, sessionValidation.exists)
                if (sessionValidation.exists) continue
            }
            jidsRequiringFetch.push(jid)
        }

        if (jidsRequiringFetch.length) {
            const wireJids = [
                ...jidsRequiringFetch.filter(jid => isLidUser(jid) || isHostedLidUser(jid)),
                ...(await signalRepository.lidMapping.getLIDsForPNs(jidsRequiringFetch.filter(jid => isPnUser(jid) || isHostedPnUser(jid))) || []).map(a => a.lid)
            ]

            logger.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions')
            const result = await query({
                tag: 'iq',
                attrs: { xmlns: 'encrypt', type: 'get', to: S_WHATSAPP_NET },
                content: [{ tag: 'key', attrs: {}, content: wireJids.map(jid => ({ tag: 'user', attrs: { jid } })) }]
            })

            await parseAndInjectE2ESessions(result, signalRepository)
            didFetchNewSession = true

            for (const wireJid of wireJids) {
                peerSessionsCache.set(signalRepository.jidToSignalProtocolAddress(wireJid), true)
            }
        }

        return didFetchNewSession
    }

    // ===== PEER DATA OPERATION =====
    const sendPeerDataOperationMessage = async (pdoMessage) => {
        if (!authState.creds.me?.id) throw new Boom('Not authenticated')

        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        }

        return await relayMessage(jidNormalizedUser(authState.creds.me.id), protocolMessage, {
            additionalAttributes: { category: 'peer', push_priority: 'high_force' },
            additionalNodes: [{ tag: 'meta', attrs: { appdata: 'default' } }]
        })
    }

    // ===== PARTICIPANT NODE CREATION =====
    const createParticipantNodes = async (recipientJids, message, extraAttrs, dsmMessage) => {
        if (!recipientJids.length) return { nodes: [], shouldIncludeDeviceIdentity: false }

        const patched = await patchMessageBeforeSending(message, recipientJids)
        const patchedMessages = Array.isArray(patched) ? patched : recipientJids.map(jid => ({ recipientJid: jid, message: patched }))

        let shouldIncludeDeviceIdentity = false
        const meId = authState.creds.me.id
        const meLid = authState.creds.me?.lid
        const meLidUser = meLid ? jidDecode(meLid)?.user : null

        const encryptionPromises = patchedMessages.map(async ({ recipientJid: jid, message: patchedMessage }) => {
            if (!jid) return null

            let msgToEncrypt = patchedMessage
            if (dsmMessage) {
                const { user: targetUser } = jidDecode(jid)
                const { user: ownPnUser } = jidDecode(meId)
                const isOwnUser = targetUser === ownPnUser || (meLidUser && targetUser === meLidUser)
                const isExactSenderDevice = jid === meId || (meLid && jid === meLid)

                if (isOwnUser && !isExactSenderDevice) {
                    msgToEncrypt = dsmMessage
                    logger.debug({ jid, targetUser }, 'Using DSM for own device')
                }
            }

            const bytes = encodeWAMessage(msgToEncrypt)
            return await encryptionMutex.mutex(jid, async () => {
                const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes })
                if (type === 'pkmsg') shouldIncludeDeviceIdentity = true
                return {
                    tag: 'to',
                    attrs: { jid },
                    content: [{ tag: 'enc', attrs: { v: '2', type, ...(extraAttrs || {}) }, content: ciphertext }]
                }
            })
        })

        const nodes = (await Promise.all(encryptionPromises)).filter(Boolean)
        return { nodes, shouldIncludeDeviceIdentity }
    }

    // ===== MESSAGE TYPE HELPERS =====
    const getMessageType = (msg) => {
        const message = normalizeMessageContent(msg)
        if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) return 'poll'
        if (message.reactionMessage) return 'reaction'
        if (message.eventMessage) return 'event'
        if (getMediaType(message)) return 'media'
        return 'text'
    }

    const getMediaType = (message) => {
        if (message.imageMessage) return 'image'
        if (message.stickerMessage) return message.stickerMessage.isLottie ? '1p_sticker' : message.stickerMessage.isAvatar ? 'avatar_sticker' : 'sticker'
        if (message.videoMessage) return message.videoMessage.gifPlayback ? 'gif' : 'video'
        if (message.audioMessage) return message.audioMessage.ptt ? 'ptt' : 'audio'
        if (message.ptvMessage) return 'ptv'
        if (message.albumMessage) return 'collection'
        if (message.contactMessage) return 'vcard'
        if (message.documentMessage) return 'document'
        if (message.stickerPackMessage) return 'sticker_pack'
        if (message.contactsArrayMessage) return 'contact_array'
        if (message.locationMessage) return 'location'
        if (message.liveLocationMessage) return 'livelocation'
        if (message.listMessage) return 'list'
        if (message.listResponseMessage) return 'list_response'
        if (message.buttonsResponseMessage) return 'buttons_response'
        if (message.orderMessage) return 'order'
        if (message.productMessage) return 'product'
        if (message.interactiveResponseMessage) return 'native_flow_response'
        if (/https:\/\/wa\.me\/c\/\d+/.test(message.extendedTextMessage?.text)) return 'cataloglink'
        if (/https:\/\/wa\.me\/p\/\d+\/\d+/.test(message.extendedTextMessage?.text)) return 'productlink'
        if (message.extendedTextMessage?.matchedText || message.groupInviteMessage) return 'url'
    }

    const getButtonType = (message) => {
        if (message.listMessage) return 'list'
        if (message.buttonsMessage) return 'buttons'
        const btn = message.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name
        if (['review_and_pay', 'review_order', 'payment_info', 'payment_status', 'payment_method'].includes(btn)) return btn
        if (message.interactiveMessage?.nativeFlowMessage) return 'interactive'
    }

    const getButtonArgs = (message) => {
        const msgContent = message.viewOnceMessage?.message || message
        const flowMsg = msgContent.interactiveMessage?.nativeFlowMessage
        const btnFirst = flowMsg?.buttons?.[0]?.name
        const specialBtns = ['mpm', 'cta_catalog', 'send_location', 'call_permission_request', 'wa_payment_transaction_details', 'automated_greeting_message_view_catalog']

        const base = {
            tag: 'biz',
            attrs: { actual_actors: '2', host_storage: '2', privacy_mode_ts: unixTimestampSeconds().toString() }
        }

        if (flowMsg && (btnFirst === 'review_and_pay' || btnFirst === 'payment_info')) {
            return { tag: 'biz', attrs: { native_flow_name: btnFirst === 'review_and_pay' ? 'order_details' : btnFirst } }
        }

        if (flowMsg && specialBtns.includes(btnFirst)) {
            return {
                ...base,
                content: [
                    { tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '2', name: btnFirst } }] },
                    { tag: 'quality_control', attrs: { source_type: 'third_party' } }
                ]
            }
        }

        if (flowMsg || msgContent.buttonsMessage) {
            return {
                ...base,
                content: [
                    { tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] },
                    { tag: 'quality_control', attrs: { source_type: 'third_party' } }
                ]
            }
        }

        if (msgContent.listMessage) {
            return {
                ...base,
                content: [
                    { tag: 'list', attrs: { v: '2', type: 'product_list' } },
                    { tag: 'quality_control', attrs: { source_type: 'third_party' } }
                ]
            }
        }

        return base
    }

    // ===== CORE MESSAGE RELAY =====
    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList } = {}) => {
        const meId = authState.creds.me.id
        const meLid = authState.creds.me?.lid
        const isRetryResend = Boolean(participant?.jid)
        let shouldIncludeDeviceIdentity = isRetryResend

        const { user, server } = jidDecode(jid)
        const isGroup = server === 'g.us'
        const isStatus = jid === 'status@broadcast'
        const isLid = server === 'lid'
        const isNewsletter = server === 'newsletter'

        msgId = msgId || generateMessageIDV2(meId)
        useUserDevicesCache = useUserDevicesCache !== false
        useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus

        const participants = []
        const destinationJid = !isStatus ? jid : 'status@broadcast'
        const binaryNodeContent = []
        const devices = []

        const meMsg = { deviceSentMessage: { destinationJid, message }, messageContextInfo: message.messageContextInfo }
        const extraAttrs = {}
        const messages = normalizeMessageContent(message)
        const buttonType = getButtonType(messages)

        if (participant) {
            if (!isGroup && !isStatus) additionalAttributes = { ...additionalAttributes, device_fanout: 'false' }
            const { user, device } = jidDecode(participant.jid)
            devices.push({ user, device, jid: participant.jid })
        }

        await authState.keys.transaction(async () => {
            const mediaType = getMediaType(message)
            if (mediaType) extraAttrs.mediatype = mediaType

            // Handle newsletter messages
            if (isNewsletter) {
                const patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message
                const bytes = encodeNewsletterMessage(patched)
                binaryNodeContent.push({ tag: 'plaintext', attrs: {}, content: bytes })

                const stanza = {
                    tag: 'message',
                    attrs: { to: jid, id: msgId, type: getMessageType(message), ...(additionalAttributes || {}) },
                    content: binaryNodeContent
                }

                logger.debug({ msgId }, `sending newsletter message to ${jid}`)
                await sendNode(stanza)
                return
            }

            if (messages.pinInChatMessage || messages.keepInChatMessage || message.reactionMessage || message.protocolMessage?.editedMessage) {
                extraAttrs['decrypt-fail'] = 'hide'
            }

            // Handle group/status messages
            if (isGroup || isStatus) {
                const [groupData, senderKeyMap] = await Promise.all([
                    (async () => {
                        let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
                        if (groupData?.participants) {
                            logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata')
                        } else if (!isStatus) {
                            groupData = await groupMetadata(jid)
                        }
                        return groupData
                    })(),
                    (async () => {
                        if (!participant && !isStatus) {
                            // Load from batched sender-key-memory storage
                            const result = await authState.keys.get('sender-key-memory', ['_index'])
                            const memoryBatch = result?.['_index'] || {}
                            return memoryBatch[jid] || {}
                        }
                        return {}
                    })()
                ])

                if (!participant) {
                    const participantsList = []
                    if (isStatus) {
                        if (statusJidList?.length) participantsList.push(...statusJidList)
                    } else {
                        let groupAddressingMode = 'lid'
                        if (groupData) {
                            participantsList.push(...groupData.participants.map(p => p.id))
                            groupAddressingMode = groupData?.addressingMode || groupAddressingMode
                        }
                        additionalAttributes = { ...additionalAttributes, addressing_mode: groupAddressingMode }
                    }

                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
                    devices.push(...additionalDevices)
                }

                if (groupData?.ephemeralDuration > 0) {
                    additionalAttributes = { ...additionalAttributes, expiration: groupData.ephemeralDuration.toString() }
                }

                const patched = await patchMessageBeforeSending(message)
                if (Array.isArray(patched)) throw new Boom('Per-jid patching not supported in groups')

                const bytes = encodeWAMessage(patched)
                const groupAddressingMode = additionalAttributes?.addressing_mode || groupData?.addressingMode || 'lid'
                const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId

                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId: groupSenderIdentity
                })

                const senderKeyRecipients = []
                for (const device of devices) {
                    const deviceJid = device.jid
                    const hasKey = !!senderKeyMap[deviceJid]
                    if ((!hasKey || !!participant) && !isHostedLidUser(deviceJid) && !isHostedPnUser(deviceJid) && device.device !== 99) {
                        senderKeyRecipients.push(deviceJid)
                        senderKeyMap[deviceJid] = true
                    }
                }

                if (senderKeyRecipients.length) {
                    logger.debug({ senderKeyJids: senderKeyRecipients }, 'sending sender key')
                    const senderKeyMsg = {
                        senderKeyDistributionMessage: {
                            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                            groupId: destinationJid
                        }
                    }

                    await assertSessions(senderKeyRecipients)
                    const result = await createParticipantNodes(senderKeyRecipients, senderKeyMsg, extraAttrs)
                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity
                    participants.push(...result.nodes)
                }

                if (isRetryResend) {
                    const { type, ciphertext: encryptedContent } = await signalRepository.encryptMessage({ data: bytes, jid: participant?.jid })
                    binaryNodeContent.push({ tag: 'enc', attrs: { v: '2', type, count: participant.count.toString() }, content: encryptedContent })
                } else {
                    binaryNodeContent.push({ tag: 'enc', attrs: { v: '2', type: 'skmsg', ...extraAttrs }, content: ciphertext })
                    // Store in batched sender-key-memory with cleanup
                    const batchData = await authState.keys.get('sender-key-memory', ['_index'])
                    const memoryBatch = batchData?.['_index'] || {}
                    memoryBatch[jid] = senderKeyMap
                    
                    // Enforce batch size limit with cleanup of old entries
                    const memoryKeys = Object.keys(memoryBatch).filter(k => k !== '_index')
                    if (memoryKeys.length > BATCH_SIZE) {
                        // Sort and remove oldest entries (keep most recent entries)
                        memoryKeys.sort()
                        const toRemove = memoryKeys.slice(0, memoryKeys.length - BATCH_SIZE)
                        toRemove.forEach(k => delete memoryBatch[k])
                        logger.debug(`Cleaned up ${toRemove.length} old sender-key-memory entries (kept ${BATCH_SIZE})`)
                    }
                    
                    await authState.keys.set({ 'sender-key-memory': { '_index': memoryBatch } })
                }
            } else {
                // Handle 1:1 messages
                let ownId = meId
                if (isLid && meLid) {
                    ownId = meLid
                    logger.debug({ to: jid, ownId }, 'Using LID identity')
                }

                const { user: ownUser } = jidDecode(ownId)

                if (!participant) {
                    const targetUserServer = isLid ? 'lid' : 's.whatsapp.net'
                    devices.push({ user, device: 0, jid: jidEncode(user, targetUserServer, 0) })

                    if (user !== ownUser) {
                        const ownUserServer = isLid ? 'lid' : 's.whatsapp.net'
                        const ownUserForAddressing = isLid && meLid ? jidDecode(meLid).user : jidDecode(meId).user
                        devices.push({ user: ownUserForAddressing, device: 0, jid: jidEncode(ownUserForAddressing, ownUserServer, 0) })
                    }

                    if (additionalAttributes?.category !== 'peer') {
                        devices.length = 0
                        const senderIdentity = isLid && meLid ? jidEncode(jidDecode(meLid)?.user, 'lid', undefined) : jidEncode(jidDecode(meId)?.user, 's.whatsapp.net', undefined)
                        const sessionDevices = await getUSyncDevices([senderIdentity, jid], true, false)
                        devices.push(...sessionDevices)
                    }
                }

                const allRecipients = []
                const meRecipients = []
                const otherRecipients = []
                const { user: mePnUser } = jidDecode(meId)
                const { user: meLidUser } = meLid ? jidDecode(meLid) : { user: null }

                for (const { user, jid } of devices) {
                    const isExactSenderDevice = jid === meId || (meLid && jid === meLid)
                    if (isExactSenderDevice) continue

                    const isMe = user === mePnUser || user === meLidUser
                    if (isMe) {
                        meRecipients.push(jid)
                    } else {
                        otherRecipients.push(jid)
                    }
                    allRecipients.push(jid)
                }

                await assertSessions(allRecipients)

                const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = await Promise.all([
                    createParticipantNodes(meRecipients, meMsg || message, extraAttrs),
                    createParticipantNodes(otherRecipients, message, extraAttrs, meMsg)
                ])

                participants.push(...meNodes, ...otherNodes)

                if (meRecipients.length > 0 || otherRecipients.length > 0) {
                    extraAttrs.phash = generateParticipantHashV2([...meRecipients, ...otherRecipients])
                }

                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
            }

            if (participants.length) {
                if (additionalAttributes?.category === 'peer') {
                    const peerNode = participants[0]?.content?.[0]
                    if (peerNode) binaryNodeContent.push(peerNode)
                } else {
                    binaryNodeContent.push({ tag: 'participants', attrs: {}, content: participants })
                }
            }

            const stanza = {
                tag: 'message',
                attrs: { id: msgId, to: destinationJid, type: getMessageType(message), ...(additionalAttributes || {}) },
                content: binaryNodeContent
            }

            if (participant) {
                if (isJidGroup(destinationJid)) {
                    stanza.attrs.to = destinationJid
                    stanza.attrs.participant = participant.jid
                } else if (areJidsSameUser(participant.jid, meId)) {
                    stanza.attrs.to = participant.jid
                    stanza.attrs.recipient = destinationJid
                } else {
                    stanza.attrs.to = participant.jid
                }
            } else {
                stanza.attrs.to = destinationJid
            }

            let additionalAlready = false
            if (!isNewsletter && buttonType) {
                const buttonsNode = getButtonArgs(messages)
                const filteredButtons = getBinaryFilteredButtons(additionalNodes || [])
                if (filteredButtons) {
                    stanza.content.push(...additionalNodes)
                    additionalAlready = true
                } else {
                    stanza.content.push(buttonsNode)
                }
            }

            if (shouldIncludeDeviceIdentity) {
                stanza.content.push({ tag: 'device-identity', attrs: {}, content: encodeSignedDeviceIdentity(authState.creds.account, true) })
                logger.debug({ jid }, 'adding device identity')
            }

            if (additionalNodes?.length > 0 && !additionalAlready) {
                stanza.content.push(...additionalNodes)
            }

            logger.debug({ msgId }, `sending message to ${participants.length} devices`)
            await sendNode(stanza)

            if (messageRetryManager && !participant) {
                messageRetryManager.addRecentMessage(destinationJid, msgId, message)
            }
        }, meId)

        return msgId
    }

    // ===== PRIVACY TOKENS =====
    const getPrivacyTokens = async (jids) => {
        const t = unixTimestampSeconds().toString()
        return await query({
            tag: 'iq',
            attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'privacy' },
            content: [{
                tag: 'tokens',
                attrs: {},
                content: jids.map(jid => ({ tag: 'token', attrs: { jid: jidNormalizedUser(jid), t, type: 'trusted_contact' } }))
            }]
        })
    }

    const waUploadToServer = getWAUploadToServer(config, refreshMediaConn)
    const nexus = new NexusHandler(Utils, waUploadToServer, relayMessage, {
        logger,
        mediaCache: config.mediaCache,
        options: config.options,
        mediaUploadTimeoutMs: config.mediaUploadTimeoutMs,
        user: authState.creds.me
    })

    const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update')

    return {
        ...sock,
        getPrivacyTokens,
        assertSessions,
        relayMessage,
        sendReceipt,
        sendReceipts,
        nexus,
        readMessages,
        refreshMediaConn,
        waUploadToServer,
        fetchPrivacySettings,
        sendPeerDataOperationMessage,
        createParticipantNodes,
        getUSyncDevices,
        messageRetryManager,

        // ===== MEDIA UPDATE =====
        updateMediaMessage: async (message) => {
            const content = assertMediaContent(message.message)
            const mediaKey = content.mediaKey
            const meId = authState.creds.me.id
            const node = await encryptMediaRetryRequest(message.key, mediaKey, meId)
            let error

            await Promise.all([
                sendNode(node),
                waitForMsgMediaUpdate(async (update) => {
                    const result = update.find(c => c.key.id === message.key.id)
                    if (result) {
                        if (result.error) {
                            error = result.error
                        } else {
                            try {
                                const media = await decryptMediaRetryData(result.media, mediaKey, result.key.id)
                                if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = proto.MediaRetryNotification.ResultType[media.result]
                                    throw new Boom(`Media re-upload failed (${resultStr})`, {
                                        data: media,
                                        statusCode: getStatusCodeForMediaRetry(media.result) || 404
                                    })
                                }
                                content.directPath = media.directPath
                                content.url = getUrlFromDirectPath(content.directPath)
                                logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful')
                            } catch (err) {
                                error = err
                            }
                        }
                        return true
                    }
                })
            ])

            if (error) throw error
            ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }])
            return message
        },

        // ===== STATUS MENTIONS =====
        sendStatusMentions: async (content, jids = []) => {
            const userJid = jidNormalizedUser(authState.creds.me.id)
            const allUsers = new Set([userJid])

            for (const id of jids) {
                if (isJidGroup(id)) {
                    try {
                        const metadata = await cachedGroupMetadata(id) || await groupMetadata(id)
                        metadata.participants.forEach(p => allUsers.add(jidNormalizedUser(p.id)))
                    } catch (error) {
                        logger.error(`Error getting metadata for ${id}: ${error}`)
                    }
                } else if (isJidUser(id)) {
                    allUsers.add(jidNormalizedUser(id))
                }
            }

            const uniqueUsers = Array.from(allUsers)
            const getRandomHex = () => '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')

            const isMedia = content.image || content.video || content.audio
            const isAudio = !!content.audio
            const msgContent = { ...content }

            if (isMedia && !isAudio) {
                if (msgContent.text) {
                    msgContent.caption = msgContent.text
                    delete msgContent.text
                }
                delete msgContent.ptt
                delete msgContent.font
                delete msgContent.backgroundColor
                delete msgContent.textColor
            }

            if (isAudio) {
                delete msgContent.text
                delete msgContent.caption
                delete msgContent.font
                delete msgContent.textColor
            }

            const font = !isMedia ? (content.font || Math.floor(Math.random() * 9)) : undefined
            const textColor = !isMedia ? (content.textColor || getRandomHex()) : undefined
            const backgroundColor = (!isMedia || isAudio) ? (content.backgroundColor || getRandomHex()) : undefined
            const ptt = isAudio ? (typeof content.ptt === 'boolean' ? content.ptt : true) : undefined

            let msg, mediaHandle
            try {
                msg = await generateWAMessage(STORIES_JID, msgContent, {
                    logger,
                    userJid,
                    getUrlInfo: text => getUrlInfo(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: { timeout: 3000, ...(httpRequestOptions || {}) },
                        logger,
                        uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
                    }),
                    upload: async (encFilePath, opts) => {
                        const up = await waUploadToServer(encFilePath, { ...opts })
                        mediaHandle = up.handle
                        return up
                    },
                    mediaCache: config.mediaCache,
                    options: config.options,
                    font,
                    textColor,
                    backgroundColor,
                    ptt
                })
            } catch (error) {
                logger.error(`Error generating message: ${error}`)
                throw error
            }

            await relayMessage(STORIES_JID, msg.message, {
                messageId: msg.key.id,
                statusJidList: uniqueUsers,
                additionalNodes: [{
                    tag: 'meta',
                    attrs: {},
                    content: [{ tag: 'mentioned_users', attrs: {}, content: jids.map(jid => ({ tag: 'to', attrs: { jid: jidNormalizedUser(jid) } })) }]
                }]
            })

            for (const id of jids) {
                try {
                    const normalizedId = jidNormalizedUser(id)
                    const isPrivate = isJidUser(normalizedId)
                    const type = isPrivate ? 'statusMentionMessage' : 'groupStatusMentionMessage'

                    const protocolMessage = {
                        [type]: { message: { protocolMessage: { key: msg.key, type: 25 } } },
                        messageContextInfo: { messageSecret: randomBytes(32) }
                    }

                    const statusMsg = await generateWAMessageFromContent(normalizedId, protocolMessage, {})
                    await relayMessage(normalizedId, statusMsg.message, {
                        additionalNodes: [{ tag: 'meta', attrs: isPrivate ? { is_status_mention: 'true' } : { is_group_status_mention: 'true' } }]
                    })

                    await delay(2000)
                } catch (error) {
                    logger.error(`Error sending to ${id}: ${error}`)
                }
            }

            return msg
        },

        // ===== NEXUS MAPPED METHODS =====
        sendPaymentMessage: (jid, data, quoted) => nexus.handlePayment({ requestPaymentMessage: data }, jid, quoted),
        sendProductMessage: (jid, data, quoted) => nexus.handleProduct({ productMessage: data }, jid, quoted),
        sendInteractiveMessage: (jid, data, quoted) => nexus.handleInteractive({ interactiveMessage: data }, jid, quoted),
        sendAlbumMessage: (jid, medias, quoted) => nexus.handleAlbum({ albumMessage: medias }, jid, quoted),
        sendEventMessage: (jid, data, quoted) => nexus.handleEvent({ eventMessage: data }, jid, quoted),
        sendPollResultMessage: (jid, data, quoted) => nexus.handlePollResult({ pollResultMessage: data }, jid, quoted),
        sendStatusMentionMessage: (jid, data, quoted) => nexus.handleStMention({ statusMentionMessage: data }, jid, quoted),
        sendOrderMessage: (jid, data, quoted) => nexus.handleOrderMessage({ orderMessage: data }, jid, quoted),
        sendGroupStatusMessage: (jid, data, quoted) => nexus.handleGroupStory({ groupStatus: data }, jid, quoted),
        sendCarouselMessage: (jid, data, quoted) => nexus.handleCarousel({ carouselMessage: data }, jid, quoted),
        sendCarouselProtoMessage: (jid, data, quoted) => nexus.handleCarouselProto({ carouselProto: data }, jid, quoted),
        stickerPackMessage: (jid, data, options) => nexus.handleStickerPack(data, jid, options?.quoted),

        // ===== MAIN SEND MESSAGE =====
        sendMessage: async (jid, content, options = {}) => {
            const userJid = authState.creds.me.id
            const { quoted } = options
            
            // Check if nexus can handle this message type
            const messageType = nexus.detectType(content)
            if (messageType) return await nexus.processMessage(content, jid, quoted)

            // Handle ephemeral settings for groups
            if (typeof content === 'object' && 'disappearingMessagesInChat' in content && isJidGroup(jid)) {
                const { disappearingMessagesInChat } = content
                const value = typeof disappearingMessagesInChat === 'boolean' ? (disappearingMessagesInChat ? WA_DEFAULT_EPHEMERAL : 0) : disappearingMessagesInChat
                await groupToggleEphemeral(jid, value)
                return
            }
            
            // Handle pin/unpin messages
            if (typeof content === 'object' && 'pin' in content) {
                let messageKey
                let shouldPin = true
                
                if (typeof content.pin === 'boolean') {
                    shouldPin = content.pin
                    if (options.quoted?.key) {
                        messageKey = options.quoted.key
                    } else {
                        throw new Boom('No quoted message key found for pin operation')
                    }
                } else if (content.pin && typeof content.pin === 'object') {
                    messageKey = content.pin.key || content.pin.stanzaId
                    
                    if (!messageKey && content.pin.id) {
                        messageKey = {
                            remoteJid: jid,
                            fromMe: content.pin.fromMe || false,
                            id: content.pin.id,
                            participant: content.pin.participant || content.pin.sender
                        }
                    }
                    
                    shouldPin = content.pin.unpin !== true
                } else {
                    messageKey = content.pin
                }
                
                if (!messageKey || !messageKey.id) {
                    throw new Boom('Invalid message key for pin operation')
                }
                
                const pinMessage = await generateWAMessageFromContent(jid, {
                    pinInChatMessage: {
                        key: messageKey,
                        type: shouldPin ? 1 : 2,
                        senderTimestampMs: Date.now().toString()
                    }
                }, {})
                
                await relayMessage(jid, pinMessage.message, { messageId: pinMessage.key.id, additionalAttributes: { edit: '2' } })
                return pinMessage
            }

            // Generate standard message
            const fullMsg = await generateWAMessage(jid, content, {
                logger,
                userJid,
                getUrlInfo: text => getUrlInfo(text, {
                    thumbnailWidth: linkPreviewImageThumbnailWidth,
                    fetchOpts: { timeout: 3000, ...(httpRequestOptions || {}) },
                    logger,
                    uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
                }),
                getProfilePicUrl: sock.profilePictureUrl,
                getCallLink: sock.createCallLink,
                upload: waUploadToServer,
                mediaCache: config.mediaCache,
                options: config.options,
                messageId: generateMessageIDV2(sock.user?.id),
                ...options
            })

            const isDeleteMsg = 'delete' in content && !!content.delete
            const isEditMsg = 'edit' in content && !!content.edit
            const isPinMsg = 'pin' in content && !!content.pin
            const isPollMessage = 'poll' in content && !!content.poll
            const isEventMsg = 'event' in content && !!content.event

            const additionalAttributes = {}
            const additionalNodes = []

            if (isDeleteMsg) {
                additionalAttributes.edit = isJidGroup(content.delete?.remoteJid) && !content.delete?.fromMe ? '8' : '7'
            } else if (isEditMsg) {
                additionalAttributes.edit = '1'
            } else if (isPinMsg) {
                additionalAttributes.edit = '2'
            } else if (isPollMessage) {
                additionalNodes.push({ tag: 'meta', attrs: { polltype: 'creation' } })
            } else if (isEventMsg) {
                additionalNodes.push({ tag: 'meta', attrs: { event_type: 'creation' } })
            }

            await relayMessage(jid, fullMsg.message, {
                messageId: fullMsg.key.id,
                useCachedGroupMetadata: options.useCachedGroupMetadata,
                additionalAttributes,
                statusJidList: options.statusJidList,
                additionalNodes
            })

            if (config.emitOwnEvents) {
                process.nextTick(() => { processingMutex.mutex(() => upsertMessage(fullMsg, 'append')) })
            }

            return fullMsg
        }
    }
}