# 🚀 NexusTechPro Baileys

<div align="center">
  
  ![NexusTechPro Banner](https://files.catbox.moe/1rjzor.jpeg)
  
  **Advanced WhatsApp Web API Built on WhiskeySockets/Baileys**
  
  [![NPM Version](https://img.shields.io/npm/v/@nexustechpro/baileys?color=success&logo=npm)](https://www.npmjs.com/package/@nexustechpro/baileys)
  [![Downloads](https://img.shields.io/npm/dt/@nexustechpro/baileys?color=blue&logo=npm)](https://www.npmjs.com/package/@nexustechpro/baileys)
  [![License](https://img.shields.io/github/license/nexustechpro/baileys?color=yellow)](./LICENSE)
  [![Node Version](https://img.shields.io/node/v/@nexustechpro/baileys)](https://nodejs.org)
  
  *Modern, feature-rich, and developer-friendly WhatsApp automation library*

</div>

---

## 📋 Table of Contents

- [✨ Features](#-features)
- [📦 Installation](#-installation)
- [🔌 Quick Start](#-quick-start)
- [🔐 Authentication](#-authentication)
- [💡 Socket Configuration](#-socket-configuration)
- [💾 Session Management](#-session-management)
- [📡 Event Handling](#-event-handling)
- [🛠️ Data Store](#️-data-store)
- [🔑 WhatsApp IDs](#-whatsapp-ids)
- [💬 Sending Messages](#-sending-messages)
  - [Non-Media Messages](#non-media-messages)
  - [Media Messages](#media-messages)
  - [Interactive Messages](#interactive-messages)
- [✏️ Message Modifications](#️-message-modifications)
- [📥 Media Operations](#-media-operations)
- [👥 Group Management](#-group-management)
- [📱 User Operations](#-user-operations)
- [🔒 Privacy Controls](#-privacy-controls)
- [💬 Chat Operations](#-chat-operations)
- [📢 Broadcast & Stories](#-broadcast--stories)
- [🧩 Advanced Features](#-advanced-features)

---

## ✨ Features

<table>
<tr>
<td>

### Core Features
- 🔥 **Multi-Device Support** - Connect without phone always online
- ⚡ **WebSocket Based** - Fast and efficient communication
- 💾 **Session Management** - Save and restore authentication
- 🎯 **Event-Driven** - Reactive message handling
- 📦 **TypeScript Ready** - Full type definitions included
- 🚀 **Built on WhiskeySockets** - Latest Baileys implementation

</td>
<td>

### Extended Features
- 🎨 **Interactive Messages** - Buttons, lists, and native flows
- 📸 **Media Handling** - Images, videos, audio, documents
- 🤖 **Poll Support** - Create and manage polls
- 📍 **Location Sharing** - Share locations with metadata
- 🔔 **Newsletter Support** - Manage WhatsApp channels
- 🎪 **Carousel Messages** - Multi-card interactive displays

</td>
</tr>
</table>

---

## 📦 Installation

### NPM
```bash
npm install @nexustechpro/baileys
```

### Yarn
```bash
yarn add @nexustechpro/baileys
```

### Using Different Package Name
Add to your `package.json`:
```json
{
  "dependencies": {
    "@whiskeysockets/baileys": "npm:@nexustechpro/baileys"
  }
}
```

### Import
```javascript
// ESM
import makeWASocket from '@nexustechpro/baileys'

// CommonJS
const { default: makeWASocket } = require('@nexustechpro/baileys')
```

---

## 🔌 Quick Start

```javascript
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@nexustechpro/baileys'

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session')
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ['NexusTechPro', 'Chrome', '1.0.0']
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        if(connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            if(shouldReconnect) {
                connectToWhatsApp()
            }
        } else if(connection === 'open') {
            console.log('✅ Connected to WhatsApp!')
        }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for(const msg of messages) {
            if(!msg.key.fromMe && msg.message) {
                await sock.sendMessage(msg.key.remoteJid, { 
                    text: 'Hello from NexusTechPro Baileys!' 
                })
            }
        }
    })

    sock.ev.on('creds.update', saveCreds)
}

connectToWhatsApp()
```

---

## 🔐 Authentication

### QR Code Authentication
```javascript
import makeWASocket from '@nexustechpro/baileys'

const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['NexusTechPro Bot', 'Chrome', '1.0.0']
})
```

### Pairing Code Authentication
```javascript
const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
})

if(!sock.authState.creds.registered) {
    const phoneNumber = '1234567890' // without + or spaces
    const code = await sock.requestPairingCode(phoneNumber)
    console.log(`Pairing code: ${code}`)
}
```

### Custom Pairing Code
```javascript
const phoneNumber = "628XXXXX"
const code = await sock.requestPairingCode(phoneNumber.trim(), "NEXUS01")
console.log("Your pairing code: " + code)
```

---

## 💡 Socket Configuration

### Cache Group Metadata (Recommended)
```javascript
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false })

const sock = makeWASocket({
    cachedGroupMetadata: async (jid) => groupCache.get(jid)
})

sock.ev.on('groups.update', async ([event]) => {
    const metadata = await sock.groupMetadata(event.id)
    groupCache.set(event.id, metadata)
})
```

### Improve Retry & Poll Decryption
```javascript
const sock = makeWASocket({
    getMessage: async (key) => await getMessageFromStore(key)
})
```

### Receive Notifications in WhatsApp App
```javascript
const sock = makeWASocket({
    markOnlineOnConnect: false
})
```

---

## 💾 Session Management

Avoid scanning QR every time:
```javascript
import makeWASocket, { useMultiFileAuthState } from '@nexustechpro/baileys'

const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
const sock = makeWASocket({ auth: state })

sock.ev.on('creds.update', saveCreds)
```

> 💡 **Tip:** For production, store auth in a database instead of files.

---

## 📡 Event Handling

### Connection Updates
```javascript
sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    if(connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
        console.log('Connection closed, reconnecting:', shouldReconnect)
        if(shouldReconnect) connectToWhatsApp()
    } else if(connection === 'open') {
        console.log('Connection opened')
    }
})
```

### New Messages
```javascript
sock.ev.on('messages.upsert', async ({ messages }) => {
    for(const msg of messages) {
        console.log('New message:', msg)
    }
})
```

### Message Updates
```javascript
sock.ev.on('messages.update', async (updates) => {
    for(const update of updates) {
        console.log('Message updated:', update)
    }
})
```

### Decrypt Poll Votes
```javascript
sock.ev.on('messages.update', async (event) => {
    for(const { key, update } of event) {
        if(update.pollUpdates) {
            const pollCreation = await getMessage(key)
            if(pollCreation) {
                console.log('Poll update:', getAggregateVotesInPollMessage({
                    message: pollCreation,
                    pollUpdates: update.pollUpdates,
                }))
            }
        }
    }
})
```

---

## 🛠️ Data Store

```javascript
import makeWASocket, { makeInMemoryStore } from '@nexustechpro/baileys'

const store = makeInMemoryStore({})
store.readFromFile('./baileys_store.json')

setInterval(() => {
    store.writeToFile('./baileys_store.json')
}, 10_000)

const sock = makeWASocket({})
store.bind(sock.ev)

sock.ev.on('chats.upsert', () => {
    console.log('Got chats:', store.chats.all())
})

sock.ev.on('contacts.upsert', () => {
    console.log('Got contacts:', Object.values(store.contacts))
})
```

> ⚠️ **Important:** Build your own data store for production. In-memory storage wastes RAM.

---

## 🔑 WhatsApp IDs

- **Personal Chats**: `[country code][phone number]@s.whatsapp.net`
  - Example: `1234567890@s.whatsapp.net`
- **Groups**: `[group id]@g.us`
  - Example: `123456789-987654321@g.us`
- **Broadcast Lists**: `[timestamp]@broadcast`
- **Status**: `status@broadcast`

---

## 💬 Sending Messages

### Non-Media Messages

#### Text Message
```javascript
await sock.sendMessage(jid, { text: 'Hello World!' })
```

#### Quote Message (works with all types)
```javascript
await sock.sendMessage(jid, { text: 'This is a reply' }, { quoted: message })
```

#### Mention User (works with most types)
```javascript
await sock.sendMessage(jid, {
    text: '@12345678901',
    mentions: ['12345678901@s.whatsapp.net']
})
```

#### Mention Status
```javascript
await sock.sendStatusMentions(
    {
        text: "Hello", // or image / video / audio (url or buffer)
    },
    [
        "123456789123456789@g.us",
        "123456789@s.whatsapp.net",
        // Enter jid chat here
    ] 
)
```

#### Result Poll From Newsletter
```javascript
await sock.sendMessage(jid, {
    pollResult: {
        name: "Text poll",
        votes: [["Options 1", 10], ["Options 2", 10]], // 10 for fake polling count results
    }
}, { quoted: message })
```

#### Send Album Message
```javascript
await sock.sendAlbumMessage(
    jid,
    [
        {
            image: { url: "https://example.jpg" }, // or buffer
            caption: "Hello World",
        },
        {
            video: { url: "https://example.mp4" }, // or buffer
            caption: "Hello World",
        },
    ],
    { 
        quoted: message, 
        delay: 2000 // number in milliseconds
    }
)
```

#### Request Payment
```javascript
// Example non media sticker
await sock.sendMessage(jid, {
    requestPayment: {      
        currency: "IDR",
        amount: "10000000",
        from: "123456@s.whatsapp.net",
        note: "Payment Request",
        background: { /* background of the message */ }
    }
}, { quoted: message })

// With media sticker buffer
await sock.sendMessage(jid, {
    requestPayment: {      
        currency: "IDR",
        amount: "10000000",
        from: "123456@s.whatsapp.net",
        sticker: buffer,
        background: { /* background of the message */ }
    }
}, { quoted: message })

// With media sticker url
await sock.sendMessage(jid, {
    requestPayment: {      
        currency: "IDR",
        amount: "10000000",
        from: "123456@s.whatsapp.net",
        sticker: { url: "https://example.com/sticker.webp" },
        background: { /* background of the message */ }
    }
}, { quoted: message })
```

#### Event Message
```javascript
await sock.sendMessage(jid, { 
    event: {
        isCanceled: false, // or true for cancel event 
        name: "Event Name", 
        description: "Event Description",
        location: { 
            degreesLatitude: -0, 
            degreesLongitude: -0 
        },
        link: "https://call-link.example.com",
        startTime: m.messageTimestamp.low,
        endTime: m.messageTimestamp.low + 86400, // 86400 is day in seconds
        extraGuestsAllowed: true // or false
    }
}, { quoted: message })
```

#### Product Message
```javascript
await sock.sendMessage(jid, {
    productMessage: {
        title: "Product Title",
        description: "Product Description",
        thumbnail: "https://example.png",
        productId: "123456789",
        retailerId: "STORE",
        url: "https://example.png",
        body: "Product Body",
        footer: "Product Footer",
        buttons: [
            {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                    display_text: "Visit Site",
                    url: "https://example.com"
                })
            }
        ]
    }
}, { quoted: message })
```

#### Carousel Message
```javascript
await sock.sendMessage(jid, {
    carouselMessage: {
        caption: "Click URL",
        footer: "Powered By NexusTechPro",
        cards: [
            // Card Mode Product
            {
                headerTitle: "`</> Owner Bot </>`",
                imageUrl: "https://example.com/image.jpg",
                productTitle: "Premium Bot",
                productDescription: "Get premium access",
                bodyText: "[NexusTechPro]\n- Important chat only\n- Don't call owner",
                buttons: [
                    {
                        name: "cta_call",
                        params: { 
                            display_text: "Contact Owner", 
                            phone_number: "+1234567890" 
                        }
                    }
                ]
            },
            // Card Mode Image
            {
                headerTitle: "`</> Bot Assistant </>`",
                imageUrl: "https://example.com/image2.jpg",
                bodyText: "[AI Assistant]\n- Don't spam bot\n- Don't call bot",
                buttons: [
                    {
                        name: "cta_url",
                        params: {
                            display_text: "Chat Bot",
                            url: "https://wa.me/1234567890",
                            merchant_url: "https://wa.me/1234567890"
                        }
                    }
                ]
            }
        ]
    }
}, { quoted: message })
```

#### Interactive Message with Native Flow
```javascript
await sock.sendMessage(jid, {    
    interactiveMessage: {      
        title: "Hello World",      
        footer: "NexusTechPro",      
        image: { url: "https://example.com/image.jpg" },      
        nativeFlowMessage: {        
            messageParamsJson: JSON.stringify({          
                limited_time_offer: {            
                    text: "Limited offer!",            
                    url: "https://nexustechpro.com",            
                    copy_code: "NEXUS2025",            
                    expiration_time: Date.now() + (24 * 60 * 60 * 1000)
                },          
                bottom_sheet: {            
                    in_thread_buttons_limit: 2,            
                    divider_indices: [1, 2, 3, 4, 5],            
                    list_title: "Select Option",            
                    button_title: "Click Here"          
                },          
                tap_target_configuration: {            
                    title: "Tap Target",            
                    description: "Description here",            
                    canonical_url: "https://nexustechpro.com",            
                    domain: "nexustechpro.com",            
                    button_index: 0          
                }        
            }),        
            buttons: [          
                {            
                    name: "single_select",            
                    buttonParamsJson: JSON.stringify({              
                        has_multiple_buttons: true            
                    })          
                },          
                {            
                    name: "call_permission_request",            
                    buttonParamsJson: JSON.stringify({              
                        has_multiple_buttons: true            
                    })          
                },          
                {            
                    name: "single_select",            
                    buttonParamsJson: JSON.stringify({              
                        title: "Select Option",              
                        sections: [                
                            {                  
                                title: "Section Title",                  
                                highlight_label: "Popular",                  
                                rows: [                    
                                    {                      
                                        title: "Option 1",                      
                                        description: "Description 1",                      
                                        id: "row_1"                    
                                    },
                                    {                      
                                        title: "Option 2",                      
                                        description: "Description 2",                      
                                        id: "row_2"                    
                                    }
                                ]                
                            }              
                        ],              
                        has_multiple_buttons: true            
                    })          
                },          
                {            
                    name: "cta_copy",            
                    buttonParamsJson: JSON.stringify({              
                        display_text: "Copy Code",              
                        id: "123456789",              
                        copy_code: "NEXUS2025"            
                    })          
                }        
            ]      
        }    
    }  
}, { quoted: message })
```

#### Interactive Buttons
```javascript
// Example non header media
await sock.sendMessage(jid, {
    text: "Description of Message",
    title: "Title of Message",
    subtitle: "Subtitle Message",
    footer: "Footer Message",
    interactiveButtons: [
        {
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: "Quick Reply",
                id: "button_1"
            })
        },
        {
            name: "cta_url",
            buttonParamsJson: JSON.stringify({
                display_text: "Visit Website",
                url: "https://nexustechpro.com"
            })
        }
    ]
}, { quoted: message })

// Example with media
await sock.sendMessage(jid, {
    image: { url: "https://example.jpg" }, // or buffer
    caption: "Description of Message",
    title: "Title of Message",
    subtitle: "Subtitle Message",
    footer: "Footer Message",
    media: true,
    interactiveButtons: [
        {
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: "Quick Reply",
                id: "button_1"
            })
        },
        {
            name: "cta_url",
            buttonParamsJson: JSON.stringify({
                display_text: "Visit Website",
                url: "https://nexustechpro.com"
            })
        }
    ]
}, { quoted: message })

// Example with header product
await sock.sendMessage(jid, {
    product: {
        productImage: { url: "https://example.jpg" }, // or buffer
        productImageCount: 1,
        title: "Product Title",
        description: "Product Description",
        priceAmount1000: 20000 * 1000,
        currencyCode: "USD",
        retailerId: "Retail",
        url: "https://example.com",            
    },
    businessOwnerJid: "1234@s.whatsapp.net",
    caption: "Description of Message",
    title: "Title of Message",
    footer: "Footer Message",
    media: true,
    interactiveButtons: [
        {
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: "Quick Reply",
                id: "button_1"
            })
        },
        {
            name: "cta_url",
            buttonParamsJson: JSON.stringify({
                display_text: "Visit Website",
                url: "https://nexustechpro.com"
            })
        }
    ]
}, { quoted: message })
```

#### Forward Messages
```javascript
const msg = getMessageFromStore() // implement this on your end
await sock.sendMessage(jid, { forward: msg })
```

#### Location Message
```javascript
await sock.sendMessage(jid, {
    location: {
        degreesLatitude: 24.121231,
        degreesLongitude: 55.1121221,
        name: "Location Name",
        address: "Location Address"
    }
})
```

#### Contact Message
```javascript
const vcard = 'BEGIN:VCARD\n'
    + 'VERSION:3.0\n'
    + 'FN:John Doe\n'
    + 'ORG:NexusTechPro;\n'
    + 'TEL;type=CELL;type=VOICE;waid=1234567890:+1 234 567 890\n'
    + 'END:VCARD'

await sock.sendMessage(jid, {
    contacts: {
        displayName: 'John Doe',
        contacts: [{ vcard }]
    }
})
```

#### Reaction Message
```javascript
await sock.sendMessage(jid, {
    react: {
        text: '💖', // use empty string to remove reaction
        key: message.key
    }
})
```

#### Poll Message
```javascript
await sock.sendMessage(jid, {
    poll: {
        name: 'Favorite Color?',
        values: ['Red', 'Blue', 'Green', 'Yellow'],
        selectableCount: 1,
        toAnnouncementGroup: false
    }
})
```

#### Link Preview
```javascript
await sock.sendMessage(jid, {
    text: 'Check out https://github.com/nexustechpro/baileys'
})
```

---

### Media Messages

> 📝 **Note:** You can pass `{ stream: Stream }`, `{ url: Url }`, or `Buffer` directly

#### Image Message
```javascript
// From URL
await sock.sendMessage(jid, {
    image: { url: 'https://example.com/image.jpg' },
    caption: 'Beautiful image!'
})

// From Buffer
await sock.sendMessage(jid, {
    image: buffer,
    caption: 'Image from buffer'
})

// From File
await sock.sendMessage(jid, {
    image: fs.readFileSync('./image.jpg'),
    caption: 'Local image'
})
```

#### Video Message
```javascript
await sock.sendMessage(jid, {
    video: { url: './video.mp4' },
    caption: 'Check this out!',
    gifPlayback: false, // set true for GIF
    ptv: false // set true for video note
})
```

#### GIF Message
```javascript
await sock.sendMessage(jid, {
    video: fs.readFileSync('Media/gif.mp4'),
    caption: 'Funny GIF',
    gifPlayback: true
})
```

#### Audio Message
```javascript
await sock.sendMessage(jid, {
    audio: { url: './audio.mp3' },
    mimetype: 'audio/mp4',
    ptt: true // voice message
})
```

> 💡 **Audio Conversion Tip:**
> ```bash
> ffmpeg -i input.mp4 -avoid_negative_ts make_zero -ac 1 output.ogg
> ```

#### Document
```javascript
await sock.sendMessage(jid, {
    document: { url: './document.pdf' },
    fileName: 'document.pdf',
    mimetype: 'application/pdf'
})
```

#### Sticker
```javascript
await sock.sendMessage(jid, {
    sticker: { url: './sticker.webp' }
})
```
#### Sticker Pack

## Usage Examples

### Method 1: Direct Socket Method (Recommended)

```javascript
await sock.stickerPackMessage(jid, {
    name: 'My Stickers',
    publisher: 'Your Bot',
    description: 'Collection of stickers',
    stickers: [
        { data: buffer, emojis: ['😊'] },
        { data: './sticker.png', emojis: ['😂'] },
        { data: './sticker.webp', emojis: ['🎉'] },
        { data: 'https://example.com/sticker.jpg', emojis: ['❤️'] }
    ],
    cover: buffer
}, { quoted: message });
```

### Method 2: Via sendMessage

```javascript
await sock.sendMessage(jid, {
    stickerPack: {
        name: 'My Stickers',
        publisher: 'Your Bot',
        description: 'Collection of stickers',
        stickers: [
            { data: buffer, emojis: ['😊'] },
            { data: './sticker.png', emojis: ['😂'] },
            { data: './sticker.webp', emojis: ['🎉'] },
            { data: 'https://example.com/sticker.jpg', emojis: ['❤️'] }
        ],
        cover: buffer
    }
}, { quoted: message });
```

---

## Supported Image Formats

Stickers automatically convert to WebP format. The following image formats are supported:

| Format | Support | Notes |
|--------|---------|-------|
| **WebP** | ✅ Full | Used as-is, no conversion needed |
| **PNG** | ✅ Full | Auto-converts to WebP |
| **JPG/JPEG** | ✅ Full | Auto-converts to WebP |
| **GIF** | ✅ Limited | Converts to static WebP (animated GIFs become static) |
| **BMP** | ✅ Full | Auto-converts to WebP |
| **Video (MP4, MOV, WebM, etc.)** | ❌ Not supported | Only static images are supported |

---

## Sticker Data Formats

Each sticker can be provided in multiple formats:

### From Buffer
```javascript
{ 
    data: fs.readFileSync('./sticker.png'), 
    emojis: ['😊'] 
}
```

### From File Path
```javascript
{ 
    data: './stickers/sticker.jpg', 
    emojis: ['😊'] 
}
```

### From URL
```javascript
{ 
    data: 'https://example.com/sticker.png', 
    emojis: ['😊'] 
}
```

### Cover Image
The cover image supports all the same formats:

```javascript
// From buffer
cover: fs.readFileSync('./cover.png')

// From file path
cover: './cover.jpg'

// From URL
cover: 'https://example.com/cover.png'
```

### Complete Example with Mixed Formats
```javascript
await sock.stickerPackMessage(jid, {
    name: 'My Stickers',
    publisher: 'Your Bot',
    description: 'Collection of stickers',
    stickers: [
        { data: fs.readFileSync('./sticker1.png'), emojis: ['😊', '😄'] },
        { data: './sticker2.jpg', emojis: ['😂'] },
        { data: './sticker3.webp', emojis: ['🎉'] },
        { data: 'https://example.com/sticker4.png', emojis: ['❤️'] }
    ],
    cover: './cover.jpg'
});
```

---

## Key Features

✅ **Automatic batching** - Splits packs >60 stickers into multiple messages  
✅ **Compression** - Auto-compresses stickers exceeding 1MB  
✅ **Auto-conversion** - Converts PNG, JPG, GIF, BMP to WebP  
✅ **Multiple formats** - Supports buffers, file paths, URLs, and streams  
✅ **Rate limiting** - 2-second delays between batch sends  
✅ **Error handling** - Gracefully skips invalid stickers  
✅ **Emoji support** - Each sticker supports multiple emojis  
✅ **Cover image** - Custom pack thumbnail


#### View Once Message
```javascript
await sock.sendMessage(jid, {
    image: { url: './secret.jpg' },
    viewOnce: true,
    caption: 'View once only!'
})
```

---

### Interactive Messages

All button types available in NexusTechPro Baileys:

#### Quick Reply Button
```javascript
{
    name: "quick_reply",
    buttonParamsJson: JSON.stringify({
        display_text: "Quick Reply",
        id: "button_id"
    })
}
```

#### URL Button
```javascript
{
    name: "cta_url",
    buttonParamsJson: JSON.stringify({
        display_text: "Visit Website",
        url: "https://nexustechpro.com",
        merchant_url: "https://nexustechpro.com"
    })
}
```

#### Call Button
```javascript
{
    name: "cta_call",
    buttonParamsJson: JSON.stringify({
        display_text: "Call Us",
        phone_number: "+1234567890"
    })
}
```

#### Copy Button
```javascript
{
    name: "cta_copy",
    buttonParamsJson: JSON.stringify({
        display_text: "Copy Code",
        id: "copy_id",
        copy_code: "PROMO2025"
    })
}
```

#### Single Select (List)
```javascript
{
    name: "single_select",
    buttonParamsJson: JSON.stringify({
        title: "Select Option",
        sections: [{
            title: "Section 1",
            highlight_label: "Popular",
            rows: [
                { title: "Option 1", description: "Description 1", id: "opt1" },
                { title: "Option 2", description: "Description 2", id: "opt2" }
            ]
        }]
    })
}
```

#### Call Permission Request
```javascript
{
    name: "call_permission_request",
    buttonParamsJson: JSON.stringify({
        has_multiple_buttons: true
    })
}
```

---

## ✏️ Message Modifications

### Delete Message (for everyone)
```javascript
const msg = await sock.sendMessage(jid, { text: 'hello' })
await sock.sendMessage(jid, { delete: msg.key })
```

### Edit Message
```javascript
await sock.sendMessage(jid, {
    text: 'Updated message text',
    edit: originalMessage.key
})
```

---

## 📥 Media Operations

### Download Media
```javascript
import { downloadMediaMessage, getContentType } from '@nexustechpro/baileys'

sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if(!msg.message) return
    
    const messageType = getContentType(msg.message)
    
    if(messageType === 'imageMessage') {
        const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            {
                logger: console,
                reuploadRequest: sock.updateMediaMessage
            }
        )
        // Save buffer to file
        fs.writeFileSync('./download.jpeg', buffer)
    }
})
```

### Re-upload Media
```javascript
await sock.updateMediaMessage(msg)
```

---

## 👥 Group Management

### Create Group
```javascript
const group = await sock.groupCreate('Group Name', [
    '1234567890@s.whatsapp.net',
    '0987654321@s.whatsapp.net'
])
console.log('Group created:', group.id)
```

### Add/Remove Participants
```javascript
// Add
await sock.groupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'add')

// Remove
await sock.groupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'remove')

// Promote to admin
await sock.groupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'promote')

// Demote from admin
await sock.groupParticipantsUpdate(groupJid, ['1234567890@s.whatsapp.net'], 'demote')
```

### Update Group Subject
```javascript
await sock.groupUpdateSubject(groupJid, 'New Group Name')
```

### Update Group Description
```javascript
await sock.groupUpdateDescription(groupJid, 'New group description')
```

### Group Settings
```javascript
// Only admins can send messages
await sock.groupSettingUpdate(groupJid, 'announcement')

// Everyone can send messages
await sock.groupSettingUpdate(groupJid, 'not_announcement')

// Only admins can edit group info
await sock.groupSettingUpdate(groupJid, 'locked')

// Everyone can edit group info
await sock.groupSettingUpdate(groupJid, 'unlocked')
```

### Get Group Metadata
```javascript
const metadata = await sock.groupMetadata(groupJid)
console.log('Group:', metadata.subject)
console.log('Participants:', metadata.participants.length)
```

### Get Invite Code
```javascript
const code = await sock.groupInviteCode(groupJid)
console.log('Invite link:', `https://chat.whatsapp.com/${code}`)
```

### Revoke Invite Code
```javascript
const newCode = await sock.groupRevokeInvite(groupJid)
console.log('New invite code:', newCode)
```

### Join Group via Invite Code
```javascript
await sock.groupAcceptInvite('INVITE_CODE_HERE')
```

### Leave Group
```javascript
await sock.groupLeave(groupJid)
```

### Get Group Invite Info
```javascript
const info = await sock.groupGetInviteInfo('INVITE_CODE')
console.log('Group info:', info)
```

---

## 📱 User Operations

### Check if Number Exists
```javascript
const [result] = await sock.onWhatsApp('1234567890')
if(result?.exists) {
    console.log('Number exists:', result.jid)
}
```

### Get Profile Picture
```javascript
// Low resolution
const ppUrl = await sock.profilePictureUrl(jid)

// High resolution
const ppUrlHD = await sock.profilePictureUrl(jid, 'image')
```

### Update Profile Picture
```javascript
await sock.updateProfilePicture(jid, {
    url: './profile.jpg'
})
```

### Remove Profile Picture
```javascript
await sock.removeProfilePicture(jid)
```

### Get Status
```javascript
const status = await sock.fetchStatus(jid)
console.log('Status:', status)
```

### Update Profile Status
```javascript
await sock.updateProfileStatus('Available 24/7')
```

### Update Profile Name
```javascript
await sock.updateProfileName('NexusTech Bot')
```

### Get Business Profile
```javascript
const profile = await sock.getBusinessProfile(jid)
console.log('Business:', profile.description)
```

### Presence Updates
```javascript
// Subscribe to presence updates
await sock.presenceSubscribe(jid)

// Send presence
await sock.sendPresenceUpdate('available', jid) // available, unavailable, composing, recording, paused
```

### Read Messages
```javascript
await sock.readMessages([message.key])
```

---

## 🔒 Privacy Controls

### Block/Unblock User
```javascript
// Block
await sock.updateBlockStatus(jid, 'block')

// Unblock
await sock.updateBlockStatus(jid, 'unblock')
```

### Get Privacy Settings
```javascript
const settings = await sock.fetchPrivacySettings()
console.log(settings)
```

### Update Privacy Settings
```javascript
// Last seen: 'all', 'contacts', 'contact_blacklist', 'none'
await sock.updateLastSeenPrivacy('contacts')

// Online: 'all', 'match_last_seen'
await sock.updateOnlinePrivacy('all')

// Profile picture: 'all', 'contacts', 'contact_blacklist', 'none'
await sock.updateProfilePicturePrivacy('contacts')

// Status: 'all', 'contacts', 'contact_blacklist', 'none'
await sock.updateStatusPrivacy('contacts')

// Read receipts: 'all', 'none'
await sock.updateReadReceiptsPrivacy('all')

// Groups add: 'all', 'contacts', 'contact_blacklist'
await sock.updateGroupsAddPrivacy('contacts')
```

### Get Block List
```javascript
const blocklist = await sock.fetchBlocklist()
console.log('Blocked users:', blocklist)
```

---

## 💬 Chat Operations

### Archive/Unarchive Chat
```javascript
const lastMsg = await getLastMessageInChat(jid)

await sock.chatModify({
    archive: true,
    lastMessages: [lastMsg]
}, jid)
```

### Mute/Unmute Chat
```javascript
// Mute for 8 hours
await sock.chatModify({
    mute: 8 * 60 * 60 * 1000
}, jid)

// Unmute
await sock.chatModify({
    mute: null
}, jid)
```

### Pin/Unpin Chat
```javascript
// Pin
await sock.chatModify({ pin: true }, jid)

// Unpin
await sock.chatModify({ pin: false }, jid)
```


#### Pin Message
```javascript
// Method 1: Using boolean (requires quoted message)
await sock.sendMessage(jid, { pin: true }, { quoted: message })

// Method 2: Using pin object with message key
await sock.sendMessage(jid, {
    pin: {
        key: message.key  // or stanzaId, id, etc.
    }
})

// Unpin message
await sock.sendMessage(jid, {
    pin: {
        key: message.key,
        unpin: true
    }
})

// Alternative unpin syntax
await sock.sendMessage(jid, { pin: false }, { quoted: message })
```

#### Keep Message
```javascript
await sock.sendMessage(jid, {
    keep: message.key,
    type: 1  // 1 to keep, 2 to unkeep
})
```

**Pin/Keep Details:**

| Operation | Method | Syntax |
|-----------|--------|--------|
| Pin (quoted) | Boolean | `{ pin: true }` with `{ quoted: message }` |
| Pin (object) | Object | `{ pin: { key: message.key } }` |
| Unpin (quoted) | Boolean | `{ pin: false }` with `{ quoted: message }` |
| Unpin (object) | Object | `{ pin: { key: message.key, unpin: true } }` |
| Keep | Key | `{ keep: message.key, type: 1 }` |
| Unkeep | Key | `{ keep: message.key, type: 2 }` |


### Delete Chat
```javascript
const lastMsg = await getLastMessageInChat(jid)

await sock.chatModify({
    delete: true,
    lastMessages: [{
        key: lastMsg.key,
        messageTimestamp: lastMsg.messageTimestamp
    }]
}, jid)
```

### Mark Chat as Read/Unread
```javascript
// Mark as read
await sock.chatModify({ markRead: true }, jid)

// Mark as unread
await sock.chatModify({ markRead: false }, jid)
```

---

## 📢 Broadcast & Stories

### Send Broadcast Message
```javascript
await sock.sendMessage(jid, {
    text: 'Broadcast message',
    statusJidList: [
        '1234567890@s.whatsapp.net',
        '0987654321@s.whatsapp.net'
    ],
    broadcast: true
})
```

### Send Story/Status
```javascript
await sock.sendMessage('status@broadcast', {
    image: { url: './story.jpg' },
    caption: 'My story update!'
})
```

### Newsletter/Channel Management
```javascript
// Create newsletter
await sock.newsletterCreate('Newsletter Name', {
    description: 'Newsletter description',
    picture: buffer // optional
})

// Update newsletter metadata
await sock.newsletterUpdateMetadata(newsletterJid, {
    name: 'New Name',
    description: 'New description'
})

// Update newsletter picture
await sock.newsletterUpdatePicture(newsletterJid, buffer)

// React to newsletter message
await sock.newsletterReactMessage(newsletterJid, messageId, '👍')

// Follow newsletter
await sock.newsletterFollow(newsletterJid)

// Unfollow newsletter
await sock.newsletterUnfollow(newsletterJid)

// Mute newsletter
await sock.newsletterMute(newsletterJid)

// Unmute newsletter
await sock.newsletterUnmute(newsletterJid)
```

---

## 🧩 Advanced Features

### Disappearing Messages
```javascript
// Enable (86400 = 24 hours, 604800 = 7 days, 7776000 = 90 days)
await sock.sendMessage(jid, {
    disappearingMessagesInChat: 86400
})

// Disable
await sock.sendMessage(jid, {
    disappearingMessagesInChat: false
})
```

### Query Message
```javascript
const msg = await sock.loadMessage(jid, messageId)
console.log('Message:', msg)
```

### Get Message Info
```javascript
const info = await sock.messageInfo(jid, messageId)
console.log('Read by:', info.readBy.length)
console.log('Played by:', info.playedBy.length)
```

### App State Sync
```javascript
// Sync app state
await sock.appPatch(['regular', 'critical_block', 'critical_unblock_low'])
```

### WABrowserId
```javascript
const browserId = sock.generateBrowserId()
console.log('Browser ID:', browserId)
```

---

## 🎯 Best Practices

### 1. Session Management
```javascript
import { useMultiFileAuthState } from '@nexustechpro/baileys'

const { state, saveCreds } = await useMultiFileAuthState('auth_folder')
const sock = makeWASocket({ auth: state })

sock.ev.on('creds.update', saveCreds)
```

### 2. Store Implementation
```javascript
import { makeInMemoryStore } from '@nexustechpro/baileys'

const store = makeInMemoryStore({})
store.readFromFile('./store.json')

setInterval(() => {
    store.writeToFile('./store.json')
}, 10_000)

store.bind(sock.ev)
```

### 3. Error Handling
```javascript
try {
    await sock.sendMessage(jid, { text: 'Hello' })
} catch(error) {
    if(error.output?.statusCode === 401) {
        console.log('Not authorized')
    } else {
        console.error('Send failed:', error)
    }
}
```

### 4. Reconnection Logic
```javascript
sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update
    
    if(connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
        
        if(shouldReconnect) {
            console.log('Reconnecting...')
            await connectToWhatsApp()
        } else {
            console.log('Logged out')
        }
    }
})
```

### 5. Rate Limiting
```javascript
const queue = []
const sending = false

async function queueMessage(jid, message) {
    queue.push({ jid, message })
    if(!sending) processQueue()
}

async function processQueue() {
    sending = true
    while(queue.length > 0) {
        const { jid, message } = queue.shift()
        await sock.sendMessage(jid, message)
        await delay(1000) // 1 second delay between messages
    }
    sending = false
}
```

---

## 📝 Important Notes

### WhatsApp ID Formats
- **Personal**: `[country_code][phone_number]@s.whatsapp.net`
- **Group**: `[group_id]@g.us`
- **Broadcast**: `[timestamp]@broadcast`
- **Status**: `status@broadcast`
- **Newsletter**: `[newsletter_id]@newsletter`

### Message Types
All supported message types:
- `conversation` - Text
- `imageMessage` - Image
- `videoMessage` - Video
- `audioMessage` - Audio
- `documentMessage` - Document
- `stickerMessage` - Sticker
- `locationMessage` - Location
- `contactMessage` - Contact
- `pollCreationMessage` - Poll
- `reactionMessage` - Reaction
- `editedMessage` - Edited message
- `viewOnceMessage` - View once media
- `extendedTextMessage` - Text with link preview

### Events Reference
```javascript
// Connection events
'connection.update'
'creds.update'

// Message events
'messages.upsert'
'messages.update'
'messages.delete'
'message-receipt.update'

// Chat events
'chats.set'
'chats.upsert'
'chats.update'
'chats.delete'

// Contact events
'contacts.set'
'contacts.upsert'
'contacts.update'

// Group events
'groups.upsert'
'groups.update'
'group-participants.update'

// Presence events
'presence.update'

// Call events
'call'

// Blocklist events
'blocklist.set'
'blocklist.update'
```

---

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## ⚠️ Disclaimer

This project is **NOT** officially affiliated with WhatsApp or Meta. This is an independent project and should be used responsibly. The authors and maintainers are not responsible for any misuse of this library.

**Important**: 
- Follow WhatsApp's Terms of Service
- Don't spam or send unsolicited messages
- Respect user privacy
- Use for legitimate purposes only
- Be aware of WhatsApp's rate limits

---

## 🙏 Acknowledgments

Special thanks to:
- [WhiskeySockets](https://github.com/WhiskeySockets) for the original Baileys library
- All contributors who have helped improve this project
- The open-source community for their continuous support

---

## 📞 Support

- **Issues**: [Whatsapp Channel](https://whatsapp.com/channel/0029VbBK53XBvvslYeZlBe0V)
- **Discussions**: [Whatsapp Channel](https://whatsapp.com/channel/0029VbBK53XBvvslYeZlBe0V)
- **NPM**: [@nexustechpro/baileys](https://www.npmjs.com/package/@nexustechpro/baileys)

---

<div align="center">
  
  **Made with ❤️ by [NexusTechPro](https://github.com/nexustechpro)**
  
  ⭐ **Star us on GitHub!** ⭐
  
  [GitHub](https://github.com/nexustechpro/baileys) • [NPM](https://www.npmjs.com/package/@nexustechpro/baileys) • [Documentation](https://github.com/nexustechpro/baileys/wiki)

</div>
