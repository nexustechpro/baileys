/**
 * @nexus/baileys - Advanced Message Handler
 * Combines WhiskeySockets foundation with Kelvdra's enhanced message types
 * 
 * Supported message types:
 * - PAYMENT (Request Payment)
 * - PRODUCT (Product Messages)
 * - INTERACTIVE (Buttons, Lists, Native Flows)
 * - ALBUM (Photo Albums)
 * - EVENT (Events/Invitations)
 * - POLL_RESULT (Poll Results)
 * - STATUS_MENTION (Status Mentions)
 * - ORDER (Order Messages)
 * - GROUP_STATUS (Group Stories)
 * - CAROUSEL (Product Carousels)
 */

import axios from 'axios'
import crypto from 'crypto'

class NexusHandler {
    constructor(utils, waUploadToServer, relayMessageFn) {
        this.utils = utils
        this.relayMessage = relayMessageFn
        this.waUploadToServer = waUploadToServer
    }

    /**
     * Detect message type from content
     */
    detectType(content) {
        if (content.requestPaymentMessage) return 'PAYMENT'
        if (content.productMessage) return 'PRODUCT'
        if (content.interactiveMessage) return 'INTERACTIVE'
        if (content.albumMessage) return 'ALBUM'
        if (content.eventMessage) return 'EVENT'
        if (content.pollResultMessage) return 'POLL_RESULT'
        if (content.statusMentionMessage) return 'STATUS_MENTION'
        if (content.orderMessage) return 'ORDER'
        if (content.groupStatus) return 'GROUP_STATUS'
        if (content.carouselMessage || content.carousel) return 'CAROUSEL'
        return null
    }

    /**
     * Handle Payment Messages
     */
    async handlePayment(content, quoted) {
        const data = content.requestPaymentMessage
        let notes = {}

        if (data.sticker?.stickerMessage) {
            notes = {
                stickerMessage: {
                    ...data.sticker.stickerMessage,
                    contextInfo: {
                        stanzaId: quoted?.key?.id,
                        participant: quoted?.key?.participant || content.sender,
                        quotedMessage: quoted?.message
                    }
                }
            }
        } else if (data.note) {
            notes = {
                extendedTextMessage: {
                    text: data.note,
                    contextInfo: {
                        stanzaId: quoted?.key?.id,
                        participant: quoted?.key?.participant || content.sender,
                        quotedMessage: quoted?.message
                    }
                }
            }
        }

        const WAProto = this.utils.WAProto?.proto
        return {
            requestPaymentMessage: WAProto.Message.RequestPaymentMessage.fromObject({
                expiryTimestamp: data.expiry || 0,
                amount1000: data.amount || 0,
                currencyCodeIso4217: data.currency || 'IDR',
                requestFrom: data.from || '0@s.whatsapp.net',
                noteMessage: notes,
                background: data.background ?? {
                    id: 'DEFAULT',
                    placeholderArgb: 0xfff0f0f0
                }
            })
        }
    }

    /**
     * Handle Product Messages
     */
    async handleProduct(content, jid, quoted) {
        const {
            title = '',
            description = '',
            thumbnail,
            productId,
            retailerId,
            url,
            body = '',
            footer = '',
            buttons = [],
            priceAmount1000 = null,
            currencyCode = 'IDR'
        } = content.productMessage || {}

        let productImage = null
        if (thumbnail) {
            try {
                if (Buffer.isBuffer(thumbnail)) {
                    const res = await this.utils.generateWAMessageContent(
                        { image: thumbnail },
                        { upload: this.waUploadToServer }
                    )
                    productImage = res?.imageMessage || res?.message?.imageMessage || null
                } else if (typeof thumbnail === 'object' && thumbnail.url) {
                    const res = await this.utils.generateWAMessageContent(
                        { image: { url: thumbnail.url } },
                        { upload: this.waUploadToServer }
                    )
                    productImage = res?.imageMessage || res?.message?.imageMessage || null
                }
            } catch (e) {
                console.error('Error processing product thumbnail:', e)
            }
        }

        const product = {
            productId,
            title,
            description,
            currencyCode,
            priceAmount1000,
            retailerId,
            url,
            productImageCount: productImage ? 1 : 0
        }
        if (productImage) product.productImage = productImage

        return {
            viewOnceMessage: {
                message: {
                    interactiveMessage: {
                        body: { text: body },
                        footer: { text: footer },
                        header: {
                            title,
                            hasMediaAttachment: !!productImage,
                            productMessage: {
                                product,
                                businessOwnerJid: '0@s.whatsapp.net'
                            }
                        },
                        nativeFlowMessage: { buttons }
                    }
                }
            }
        }
    }

    /**
     * Handle Interactive Messages (Buttons, Lists, Native Flows)
     */
    async handleInteractive(content, jid, quoted) {
        const {
            title,
            footer,
            thumbnail,
            image,
            video,
            document,
            mimetype,
            fileName,
            jpegThumbnail,
            contextInfo,
            externalAdReply,
            buttons = [],
            nativeFlowMessage,
            header
        } = content.interactiveMessage || {}

        let media = null

        if (thumbnail) {
            media = await this.utils.prepareWAMessageMedia(
                { image: { url: thumbnail } },
                { upload: this.waUploadToServer }
            )
        } else if (image) {
            media = await this.utils.prepareWAMessageMedia(
                typeof image === 'object' && image.url ? { image: { url: image.url } } : { image },
                { upload: this.waUploadToServer }
            )
        } else if (video) {
            media = await this.utils.prepareWAMessageMedia(
                typeof video === 'object' && video.url ? { video: { url: video.url } } : { video },
                { upload: this.waUploadToServer }
            )
        } else if (document) {
            const docPayload = { document }
            if (jpegThumbnail) {
                docPayload.jpegThumbnail =
                    typeof jpegThumbnail === 'object' && jpegThumbnail.url
                        ? { url: jpegThumbnail.url }
                        : jpegThumbnail
            }
            media = await this.utils.prepareWAMessageMedia(docPayload, { upload: this.waUploadToServer })
            if (fileName) media.documentMessage.fileName = fileName
            if (mimetype) media.documentMessage.mimetype = mimetype
        }

        const interactiveMessage = {
            body: { text: title || '' },
            footer: { text: footer || '' }
        }

        if (buttons.length > 0) {
            interactiveMessage.nativeFlowMessage = { buttons }
            if (nativeFlowMessage) Object.assign(interactiveMessage.nativeFlowMessage, nativeFlowMessage)
        } else if (nativeFlowMessage) {
            interactiveMessage.nativeFlowMessage = nativeFlowMessage
        }

        if (media) {
            const headerMedia = {}
            if (media.imageMessage) headerMedia.imageMessage = media.imageMessage
            if (media.videoMessage) headerMedia.videoMessage = media.videoMessage
            if (media.documentMessage) headerMedia.documentMessage = media.documentMessage
            interactiveMessage.header = { title: header || '', hasMediaAttachment: true, ...headerMedia }
        } else {
            interactiveMessage.header = { title: header || '', hasMediaAttachment: false }
        }

        let finalContextInfo = {}
        if (contextInfo) {
            finalContextInfo = {
                mentionedJid: contextInfo.mentionedJid || [],
                forwardingScore: contextInfo.forwardingScore || 0,
                isForwarded: contextInfo.isForwarded || false,
                ...contextInfo
            }
        }

        if (externalAdReply) {
            finalContextInfo.externalAdReply = {
                title: externalAdReply.title || '',
                body: externalAdReply.body || '',
                mediaType: externalAdReply.mediaType || 1,
                thumbnailUrl: externalAdReply.thumbnailUrl || '',
                mediaUrl: externalAdReply.mediaUrl || '',
                sourceUrl: externalAdReply.sourceUrl || '',
                showAdAttribution: externalAdReply.showAdAttribution || false,
                renderLargerThumbnail: externalAdReply.renderLargerThumbnail || false,
                ...externalAdReply
            }
        }

        if (Object.keys(finalContextInfo).length > 0) {
            interactiveMessage.contextInfo = finalContextInfo
        }

        return { interactiveMessage }
    }

    /**
     * Handle Album Messages
     */
    async handleAlbum(content, jid, quoted) {
        const array = Array.isArray(content.albumMessage) ? content.albumMessage : []

        if (array.length === 0) {
            throw new Error('albumMessage must be an array with media items')
        }

        const album = await this.utils.generateWAMessageFromContent(
            jid,
            {
                messageContextInfo: { messageSecret: crypto.randomBytes(32) },
                albumMessage: {
                    expectedImageCount: array.filter(a => a.image).length,
                    expectedVideoCount: array.filter(a => a.video).length
                }
            },
            {
                userJid: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
                quoted,
                upload: this.waUploadToServer
            }
        )

        await this.relayMessage(jid, album.message, { messageId: album.key.id })

        for (const item of array) {
            const img = await this.utils.generateWAMessage(jid, item, { upload: this.waUploadToServer })
            img.message.messageContextInfo = {
                messageSecret: crypto.randomBytes(32),
                messageAssociation: {
                    associationType: 1,
                    parentMessageKey: album.key
                },
                participant: '0@s.whatsapp.net',
                remoteJid: 'status@broadcast',
                forwardingScore: 99999,
                isForwarded: true,
                mentionedJid: [jid],
                starred: true,
                labels: ['Y', 'Important'],
                isHighlighted: true,
                businessMessageForwardInfo: { businessOwnerJid: jid },
                dataSharingContext: { showMmDisclosure: true }
            }

            await this.relayMessage(jid, img.message, {
                messageId: img.key.id,
                quoted: {
                    key: {
                        remoteJid: album.key.remoteJid,
                        id: album.key.id,
                        fromMe: true,
                        participant: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net'
                    },
                    message: album.message
                }
            })
        }

        return album
    }

    /**
     * Handle Event Messages
     */
    async handleEvent(content, jid, quoted) {
        const eventData = content.eventMessage

        const msg = await this.utils.generateWAMessageFromContent(
            jid,
            {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2,
                            messageSecret: crypto.randomBytes(32)
                        },
                        eventMessage: {
                            isCanceled: eventData.isCanceled || false,
                            name: eventData.name,
                            description: eventData.description,
                            location: eventData.location || {
                                degreesLatitude: 0,
                                degreesLongitude: 0,
                                name: 'Location'
                            },
                            joinLink: eventData.joinLink || '',
                            startTime:
                                typeof eventData.startTime === 'string'
                                    ? parseInt(eventData.startTime)
                                    : eventData.startTime || Date.now(),
                            endTime:
                                typeof eventData.endTime === 'string'
                                    ? parseInt(eventData.endTime)
                                    : eventData.endTime || Date.now() + 3600000,
                            extraGuestsAllowed: eventData.extraGuestsAllowed !== false
                        }
                    }
                }
            },
            { quoted }
        )

        await this.relayMessage(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    /**
     * Handle Poll Results
     */
    async handlePollResult(content, jid, quoted) {
        const pollData = content.pollResultMessage

        const msg = await this.utils.generateWAMessageFromContent(
            jid,
            {
                pollResultSnapshotMessage: {
                    name: pollData.name,
                    pollVotes: (pollData.pollVotes || []).map(vote => ({
                        optionName: vote.optionName,
                        optionVoteCount:
                            typeof vote.optionVoteCount === 'number'
                                ? vote.optionVoteCount.toString()
                                : vote.optionVoteCount
                    }))
                }
            },
            {
                userJid: this.utils.generateMessageID().split('@')[0] + '@s.whatsapp.net',
                quoted
            }
        )

        await this.relayMessage(jid, msg.message, { messageId: msg.key.id })
        return msg
    }

    /**
     * Handle Status Mentions
     */
    async handleStMention(content, jid, quoted) {
        const data = content.statusMentionMessage

        let media = null

        if (data.image) {
            media = await this.utils.prepareWAMessageMedia(
                typeof data.image === 'object' && data.image.url
                    ? { image: { url: data.image.url } }
                    : { image: data.image },
                { upload: this.waUploadToServer }
            )
        } else if (data.video) {
            media = await this.utils.prepareWAMessageMedia(
                typeof data.video === 'object' && data.video.url
                    ? { video: { url: data.video.url } }
                    : { video: data.video },
                { upload: this.waUploadToServer }
            )
        }

        const msg = await this.relayMessage('status@broadcast', { ...media }, {
            statusJidList: [data.mentions, this.user?.id],
            additionalNodes: [
                {
                    tag: 'meta',
                    attrs: {},
                    content: [
                        {
                            tag: 'mentioned_users',
                            attrs: {},
                            content: [
                                {
                                    tag: 'to',
                                    attrs: { jid: data.mentions },
                                    content: undefined
                                }
                            ]
                        }
                    ]
                }
            ]
        })

        const xontols = await this.utils.generateWAMessageFromContent(
            jid,
            {
                statusMentionMessage: {
                    message: {
                        protocolMessage: {
                            messageId: msg.key,
                            type: 'STATUS_MENTION_MESSAGE'
                        }
                    }
                }
            },
            {
                additionalNodes: [
                    {
                        tag: 'meta',
                        attrs: { is_status_mention: true },
                        content: undefined
                    }
                ]
            }
        )

        await this.relayMessage(jid, xontols.message, { messageId: xontols.key.id })
        return xontols
    }

    /**
     * Handle Order Messages
     */
    async handleOrderMessage(content, jid, quoted) {
        const orderData = content.orderMessage

        let thumbnail = null
        if (orderData.thumbnail) {
            if (Buffer.isBuffer(orderData.thumbnail)) {
                thumbnail = orderData.thumbnail
            } else if (typeof orderData.thumbnail === 'string') {
                try {
                    const res = await axios.get(orderData.thumbnail, { responseType: 'arraybuffer' })
                    thumbnail = Buffer.from(res.data)
                } catch (e) {
                    console.error('Error downloading thumbnail:', e)
                    thumbnail = null
                }
            }
        }

        const msg = await this.utils.generateWAMessageFromContent(
            jid,
            {
                orderMessage: {
                    orderId: '7NEXUS25022008',
                    thumbnail,
                    itemCount: orderData.itemCount || 0,
                    status: 'ACCEPTED',
                    surface: 'CATALOG',
                    message: orderData.message,
                    orderTitle: orderData.orderTitle,
                    sellerJid: '0@whatsapp.net',
                    token: 'NEXUS_EXAMPLE_TOKEN',
                    totalAmount1000: orderData.totalAmount1000 || 0,
                    totalCurrencyCode: orderData.totalCurrencyCode || 'IDR',
                    messageVersion: 2
                }
            },
            { quoted }
        )

        await this.relayMessage(jid, msg.message, {})
        return msg
    }

    /**
     * Handle Group Stories
     */
    async handleGroupStory(content, jid, quoted) {
        const storyData = content.groupStatus
        let messageContent

        if (storyData.message) {
            messageContent = storyData
        } else {
            try {
                messageContent = await this.utils.generateWAMessageContent(storyData, {
                    upload: this.waUploadToServer
                })
            } catch (e) {
                console.error('Error generating group story content:', e)
                messageContent = { text: 'Group story' }
            }
        }

        const msg = {
            message: {
                groupStatusMessageV2: {
                    message: messageContent.message || messageContent
                }
            }
        }

        return await this.relayMessage(jid, msg.message, { messageId: this.utils.generateMessageID() })
    }

    /**
     * Handle Carousel Messages (Product/Image Carousels)
     */
    async handleCarousel(content, jid, quoted) {
        // Support carouselMessage (native) & carousel (wrapper)
        const root = content.carouselMessage || content.carousel || {}
        const { caption = '', footer = '', cards = [] } = root

        const carouselCards = await Promise.all(
            cards.map(async (card) => {
                if (card.productTitle) {
                    // Mode Product
                    return {
                        header: {
                            title: card.headerTitle || '',
                            subtitle: card.headerSubtitle || '',
                            productMessage: {
                                product: {
                                    productImage: (
                                        await this.utils.prepareWAMessageMedia(
                                            { image: { url: card.imageUrl } },
                                            { upload: this.waUploadToServer }
                                        )
                                    ).imageMessage,
                                    productId: card.productId || '123456',
                                    title: card.productTitle,
                                    description: card.productDescription || '',
                                    currencyCode: card.currencyCode || 'IDR',
                                    priceAmount1000: card.priceAmount1000 || '100000',
                                    retailerId: card.retailerId || 'Retailer',
                                    url: card.url || '',
                                    productImageCount: 1
                                },
                                businessOwnerJid: card.businessOwnerJid || '0@s.whatsapp.net'
                            },
                            hasMediaAttachment: false
                        },
                        body: {
                            text: card.bodyText || ''
                        },
                        footer: {
                            text: card.footerText || ''
                        },
                        nativeFlowMessage: {
                            buttons: (card.buttons || []).map((btn) => ({
                                name: btn.name,
                                buttonParamsJson: JSON.stringify(btn.params || {})
                            }))
                        }
                    }
                } else {
                    // Mode Image
                    const imageMedia = card.imageUrl
                        ? await this.utils.prepareWAMessageMedia(
                              { image: { url: card.imageUrl } },
                              { upload: this.waUploadToServer }
                          )
                        : {}

                    return {
                        header: {
                            title: card.headerTitle || '',
                            subtitle: card.headerSubtitle || '',
                            hasMediaAttachment: !!card.imageUrl,
                            ...imageMedia
                        },
                        body: {
                            text: card.bodyText || ''
                        },
                        footer: {
                            text: card.footerText || ''
                        },
                        nativeFlowMessage: {
                            buttons: (card.buttons || []).map((btn) => ({
                                name: btn.name,
                                buttonParamsJson: JSON.stringify(btn.params || {})
                            }))
                        }
                    }
                }
            })
        )

        const msg = await this.utils.generateWAMessageFromContent(
            jid,
            {
                viewOnceMessage: {
                    message: {
                        interactiveMessage: {
                            body: { text: caption },
                            footer: { text: footer },
                            carouselMessage: {
                                cards: carouselCards,
                                messageVersion: 1
                            }
                        }
                    }
                }
            },
            { quoted }
        )

        await this.relayMessage(jid, msg.message, { messageId: msg.key.id })
        return msg
    }
}

export default NexusHandler
