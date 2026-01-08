# @nexus/baileys

> A feature-rich WhatsApp Web API client with support for interactive messages, product catalogs, carousels, events, and payment requests.

[![NPM Package](https://img.shields.io/npm/v/@nexus/baileys.svg)](https://npmjs.org/package/@nexus/baileys)
[![Downloads](https://img.shields.io/npm/dt/@nexus/baileys.svg)](https://npmjs.org/package/@nexus/baileys)
[![GitHub Stars](https://img.shields.io/github/stars/nexus-baileys/baileys.svg)](https://github.com/nexus-baileys/baileys)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**@nexus/baileys** is an advanced WhatsApp Web API client built on a stable foundation with extended capabilities for building sophisticated WhatsApp automation, bots, and integrations.

## Features

### Core Features
- ✅ **Full WhatsApp Web Support** - Text, media, groups, contacts
- ✅ **Multi-Device Sync** - Connect multiple WhatsApp instances
- ✅ **WebSocket Connection** - Real-time messaging with auto-reconnect
- ✅ **Session Persistence** - Save and restore authentication state
- ✅ **QR Code Authentication** - Secure login without passwords

### Advanced Message Types
- 🎯 **Interactive Messages** - Buttons with quick replies and native flows
- 🛍️ **Product Messages** - Single product showcase
- 🏪 **Product Catalogs** - Browse and select multiple products
- 🎠 **Carousels** - Multi-product carousel displays
- 🎉 **Events** - Event invitations with dates and locations
- 💰 **Payments** - Payment request messages
- 📊 **Polls** - Poll creation and result display
- 📌 **Status Mentions** - Reply to status updates
- 📦 **Orders** - Order information and tracking
- 👥 **Group Stories** - Shared content in groups

### Developer Experience
- 📚 **Complete Documentation** - Comprehensive API docs
- 🔧 **Easy Integration** - Simple, intuitive API
- ⚡ **High Performance** - Optimized message handling
- 🛡️ **Error Handling** - Built-in retry logic
- 📝 **TypeScript Support** - Full type definitions

## Installation

```bash
npm install @nexus/baileys
```

Or with legacy peer dependencies:

```bash
npm install @nexus/baileys --legacy-peer-deps
```

### Requirements
- Node.js 18+
- Active WhatsApp account
- Stable internet connection

## Quick Start

```javascript
import baileys from '@nexus/baileys'
const { useMultiFileAuthState } = baileys

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  
  const sock = baileys.makeWASocket({
    auth: state,
    printQRInTerminal: true
  })
  
  sock.ev.on('creds.update', saveCreds)
  
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    console.log(`Message from ${msg.key.remoteJid}: ${msg.message?.conversation}`)
  })
}

main()
```

## Message Types & Examples

### 1. Interactive Messages - Buttons

**Quick Reply Buttons:**
```javascript
await sock.sendMessage(jid, {
  interactiveMessage: {
    title: 'Quick Reply Buttons',
    body: 'Select an option:',
    footer: 'Tap any button',
    buttons: [
      {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: '✓ Option 1',
          id: 'opt_1'
        })
      },
      {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: '✓ Option 2',
          id: 'opt_2'
        })
      }
    ]
  }
})
```

**URL Call to Action Buttons:**
```javascript
await sock.sendMessage(jid, {
  interactiveMessage: {
    title: 'Call to Action',
    body: 'Visit our website',
    buttons: [
      {
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({
          display_text: '🌐 Visit Website',
          url: 'https://example.com'
        })
      }
    ]
  }
})
```

**Call Button:**
```javascript
await sock.sendMessage(jid, {
  interactiveMessage: {
    title: 'Call Support',
    body: 'Need help?',
    buttons: [
      {
        name: 'cta_call',
        buttonParamsJson: JSON.stringify({
          display_text: '📞 Call Us',
          phone_number: '+1234567890'
        })
      }
    ]
  }
})
```

**List Selection Buttons:**
```javascript
await sock.sendMessage(jid, {
  interactiveMessage: {
    title: 'Select from list',
    body: 'Choose an option:',
    buttons: [
      {
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: 'Options',
          sections: [
            {
              title: 'Category 1',
              rows: [
                { id: 'row_1', title: 'Option 1', description: 'Description 1' },
                { id: 'row_2', title: 'Option 2', description: 'Description 2' }
              ]
            },
            {
              title: 'Category 2',
              rows: [
                { id: 'row_3', title: 'Option 3', description: 'Description 3' }
              ]
            }
          ]
        })
      }
    ]
  }
})
```

**Native Flow Buttons (Advanced):**
```javascript
await sock.sendMessage(jid, {
  interactiveMessage: {
    title: 'Native Flow Form',
    body: 'Fill out the form:',
    buttons: [
      {
        name: 'cta_json',
        buttonParamsJson: JSON.stringify({
          flow_token: 'UNIQUE_TOKEN_123',
          flow_action_data: {
            screen: 'initial',
            data: {
              field_1: 'value_1'
            }
          }
        })
      }
    ]
  }
})
```

### 2. Product Messages

**Single Product:**
```javascript
await sock.sendMessage(jid, {
  productMessage: {
    title: 'Premium Wireless Headphones',
    description: 'High-quality sound with noise cancellation',
    productId: 'PROD_WH_001',
    priceAmount1000: 15999, // $159.99
    currencyCode: 'USD',
    retailerId: 'NexusStore',
    url: 'https://example.com/products/headphones',
    thumbnail: Buffer.from(...) // or image URL
  }
})
```

**Product Catalog:**
```javascript
await sock.sendMessage(jid, {
  interactiveMessage: {
    title: 'Browse Catalog',
    body: 'Check our products',
    buttons: [
      {
        name: 'cta_catalog',
        buttonParamsJson: JSON.stringify({
          catalog_id: 'CAT_123456',
          product_id: 'PROD_001'
        })
      }
    ]
  }
})
```

### 3. Carousels - Multiple Products

```javascript
await sock.sendMessage(jid, {
  carouselMessage: {
    caption: 'Our Latest Products',
    footer: 'Swipe to explore',
    cards: [
      {
        productTitle: 'Wireless Earbuds',
        productDescription: 'Premium sound quality',
        productId: 'EARBUDS_001',
        priceAmount1000: 9999,
        currencyCode: 'USD',
        imageUrl: 'https://example.com/images/earbuds.jpg',
        buttons: [
          {
            name: 'cta_url',
            params: {
              display_text: '👀 View',
              url: 'https://example.com/earbuds'
            }
          }
        ]
      },
      {
        productTitle: 'Smart Watch',
        productDescription: 'Track your health',
        productId: 'WATCH_001',
        priceAmount1000: 29999,
        currencyCode: 'USD',
        imageUrl: 'https://example.com/images/watch.jpg',
        buttons: [
          {
            name: 'cta_url',
            params: {
              display_text: '👀 View',
              url: 'https://example.com/watch'
            }
          }
        ]
      }
    ]
  }
})
```

### 4. Events & Invitations

```javascript
const startTime = Math.floor(Date.now() / 1000) + 86400 * 7 // 7 days

await sock.sendMessage(jid, {
  eventMessage: {
    name: 'Tech Conference 2024',
    description: 'Join us for talks, networking, and innovation',
    location: {
      degreesLatitude: 40.7128,
      degreesLongitude: -74.0060,
      name: 'New York Convention Center'
    },
    startTime: startTime,
    endTime: startTime + 28800, // 8 hours
    joinLink: 'https://conference.example.com/register',
    extraGuestsAllowed: true
  }
})
```

### 5. Payment Requests

```javascript
await sock.sendMessage(jid, {
  requestPaymentMessage: {
    currencyCodeIso4217: 'USD',
    amount1000: 5000, // $50.00
    requestFrom: jid,
    expiryTimestamp: Math.floor(Date.now() / 1000) + 86400,
    amount: {
      value: 50,
      offset: 100,
      currencyCode: 'USD'
    }
  }
})
```

### 6. Polls

```javascript
await sock.sendMessage(jid, {
  pollResultMessage: {
    name: 'What\'s your favorite feature?',
    pollVotes: [
      { optionName: 'Interactive Buttons', optionVoteCount: 125 },
      { optionName: 'Product Carousels', optionVoteCount: 98 },
      { optionName: 'Event Invitations', optionVoteCount: 67 },
      { optionName: 'Payment Requests', optionVoteCount: 45 }
    ]
  }
})
```

### 7. Status Mentions

```javascript
await sock.sendMessage(jid, {
  statusMentionMessage: {
    message: 'Great status!',
    mentions: [userJid]
  }
})
```

### 8. Order Messages

```javascript
await sock.sendMessage(jid, {
  orderMessage: {
    orderId: '2024_001',
    thumbnail: Buffer.from(...),
    itemCount: 3,
    orderTitle: 'Your Order',
    message: 'Your order has been confirmed',
    totalAmount1000: 29999,
    totalCurrencyCode: 'USD'
  }
})
```

### 9. Media Messages

```javascript
// Image
await sock.sendMessage(jid, {
  image: { url: 'https://...' },
  caption: 'Image caption'
})

// Video
await sock.sendMessage(jid, {
  video: { url: 'https://...' },
  caption: 'Video caption'
})

// Audio
await sock.sendMessage(jid, {
  audio: { url: 'https://...' },
  mimetype: 'audio/mpeg'
})

// Document
await sock.sendMessage(jid, {
  document: { url: 'https://...' },
  fileName: 'document.pdf',
  mimetype: 'application/pdf'
})
```

### 10. Text with Mentions

```javascript
const groupMetadata = await sock.groupMetadata(groupJid)
const mentions = groupMetadata.participants.map(p => p.id)

await sock.sendMessage(groupJid, {
  text: '👋 Hey @everyone! Important announcement!',
  mentions: mentions
})
```

## Events

```javascript
// Connection updates
sock.ev.on('connection.update', (update) => {
  console.log('Connection:', update)
})

// Incoming messages
sock.ev.on('messages.upsert', async (m) => {
  console.log('New message:', m)
})

// Message reactions
sock.ev.on('message.reactions', (reactions) => {
  console.log('Reactions:', reactions)
})

// Group updates
sock.ev.on('groups.update', (updates) => {
  console.log('Groups:', updates)
})

// Contact updates
sock.ev.on('contacts.upsert', (contacts) => {
  console.log('Contacts:', contacts)
})

// Credentials update
sock.ev.on('creds.update', saveCreds)
```

## Configuration

```javascript
const sock = baileys.makeWASocket({
  // Print QR to terminal
  printQRInTerminal: true,
  
  // Auth state
  auth: state,
  
  // Browser details
  browser: baileys.Browsers.ubuntu('Chrome'),
  
  // Logger
  logger: pino({ level: 'debug' }),
  
  // Connection timeout
  connectTimeoutMs: 60_000,
  
  // Mark online on connect
  markOnlineOnConnect: true,
  
  // Sync message history
  shouldSyncHistoryMessage: true
})
```

## Utility Functions

```javascript
// Check if user exists on WhatsApp
const exists = await sock.onWhatsApp(phoneNumber)

// Get profile picture
const ppUrl = await sock.profilePictureUrl(jid)

// Get status
const status = await sock.fetchStatus(jid)

// Get group metadata
const groupInfo = await sock.groupMetadata(groupJid)

// Create group
const newGroup = await sock.groupCreate('Group Name', [jid1, jid2])

// Add user to group
await sock.groupParticipantsUpdate(groupJid, [userJid], 'add')

// Remove user
await sock.groupParticipantsUpdate(groupJid, [userJid], 'remove')

// Make admin
await sock.groupParticipantsUpdate(groupJid, [userJid], 'promote')

// Change subject
await sock.groupUpdateSubject(groupJid, 'New Subject')

// Leave group
await sock.groupLeave(groupJid)
```

## Error Handling

```javascript
try {
  await sock.sendMessage(jid, { text: 'Hello' })
} catch (error) {
  if (error.statusCode === 401) {
    console.error('Session expired')
  } else if (error.statusCode === 429) {
    console.error('Rate limited - wait before retrying')
  } else {
    console.error('Error:', error.message)
  }
}
```

## JID Format

```javascript
// Personal chat
'1234567890@s.whatsapp.net'

// Group
'120363169999999999@g.us'

// WhatsApp Business
'1234567890@business'

// Status broadcast
'status@broadcast'
```

## License

MIT © Nexus Team

## Based On

- [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)
- [Original Baileys](https://github.com/adiwajshing/Baileys)
- Community contributions

## Disclaimer

This library is not affiliated with WhatsApp Inc. Use responsibly and in compliance with WhatsApp's Terms of Service.

## Support

For issues and questions:
- GitHub Issues: https://github.com/nexus-baileys/baileys/issues
- Documentation: See this README
- Examples: Check the lib/Socket/nexus-handler.js file

---

Made with ❤️ by Nexus Team | v2.0.0

  const sock = baileys.default.makeWASocket({
    auth: state,
    printQRInTerminal: true
  })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) startBot()
    }
  })

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.message) return

    console.log('Got message from:', msg.key.remoteJid)
  })
}

startBot()
```

## Advanced Message Examples

### Send Interactive Message with Buttons

```javascript
await sock.sendMessage(jid, {
  interactiveMessage: {
    title: 'Select an option',
    footer: 'Powered by @nexus/baileys',
    buttons: [
      {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: 'Option 1',
          id: 'opt1'
        })
      },
      {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: 'Option 2',
          id: 'opt2'
        })
      }
    ]
  }
})
```

### Send Product Message

```javascript
await sock.sendMessage(jid, {
  productMessage: {
    title: 'Awesome Product',
    description: 'This is an amazing product',
    productId: '123456',
    retailerId: 'MyStore',
    currencyCode: 'USD',
    priceAmount1000: 9900, // $99.00
    url: 'https://example.com/product',
    thumbnail: 'https://example.com/image.jpg'
  }
})
```

### Send Carousel Message

```javascript
await sock.sendMessage(jid, {
  carouselMessage: {
    caption: 'Check out these products!',
    footer: '@nexus/baileys',
    cards: [
      {
        productTitle: 'Product 1',
        productDescription: 'Description 1',
        productId: '001',
        imageUrl: 'https://example.com/img1.jpg',
        bodyText: 'Product 1 details',
        headerTitle: 'Item 1',
        buttons: [
          {
            name: 'cta_url',
            params: { display_text: 'View', url: 'https://example.com/1' }
          }
        ]
      }
    ]
  }
})
```

### Send Tag Message (Mentions)

```javascript
const participants = await sock.groupMetadata(jid)
const mentions = participants.participants.map(p => p.id)

await sock.sendMessage(jid, {
  text: `Tagging everyone! 👋\n${mentions.map((m, i) => `${i + 1}. @${m.split('@')[0]}`).join('\n')}`,
  mentions: mentions
})
```

## Message Handler Architecture

The Nexus handler automatically detects and routes special message types:

```
Content → detectType() → messageType
                             ↓
                      Appropriate Handler
                             ↓
                   generateWAMessageFromContent()
                             ↓
                      relayMessage()
```

Supported types detected automatically:
- `PAYMENT` → Payment requests
- `PRODUCT` → Product messages
- `INTERACTIVE` → Buttons/Lists
- `ALBUM` → Photo/Video albums
- `EVENT` → Events
- `POLL_RESULT` → Poll results
- `STATUS_MENTION` → Status mentions
- `ORDER` → Orders
- `GROUP_STATUS` → Group stories
- `CAROUSEL` → Carousels

## API Reference

### NexusMessageHandler

```typescript
class NexusMessageHandler {
  detectType(content): string | null
  handlePayment(content, quoted): Promise<object>
  handleProduct(content, jid, quoted): Promise<object>
  handleInteractive(content, jid, quoted): Promise<object>
  handleAlbum(content, jid, quoted): Promise<object>
  handleEvent(content, jid, quoted): Promise<object>
  handlePollResult(content, jid, quoted): Promise<object>
  handleStMention(content, jid, quoted): Promise<object>
  handleOrderMessage(content, jid, quoted): Promise<object>
  handleGroupStory(content, jid, quoted): Promise<object>
}
```

## Configuration

### Connection Options

```javascript
const sock = baileys.default.makeWASocket({
  auth: authState,
  browser: ['Nexus Bot', 'Chrome', '1.0'],
  printQRInTerminal: true,
  logger: pino({ level: 'info' }),
  maxMsgsInCache: 100
})
```

## Events

```javascript
// Connection updates
sock.ev.on('connection.update', (update) => {})

// Credentials update
sock.ev.on('creds.update', (update) => {})

// New messages
sock.ev.on('messages.upsert', (m) => {})

// Messages updated (read, reactions, etc)
sock.ev.on('messages.update', (updates) => {})

// Chat updates
sock.ev.on('chats.update', (updates) => {})
```

## Best Practices

1. **Always handle disconnections** - Implement automatic reconnection logic
2. **Use message queuing** - Batch send messages to avoid rate limits
3. **Cache group metadata** - Reduce API calls for group operations
4. **Validate user input** - Sanitize mentions and message content
5. **Error handling** - Wrap all message sends in try-catch blocks
6. **Session management** - Store auth credentials securely

## Differences from WhiskeySockets

@nexus/baileys extends WhiskeySockets with:

- ✨ Automatic message type detection and routing
- ✨ Enhanced interactive message support
- ✨ Product carousel handling
- ✨ Payment request integration
- ✨ Event message support
- ✨ Status mention handling
- ✨ Unified error handling

## Contributing

Contributions are welcome! Please follow the existing code style and add tests for new features.

## License

MIT © Nexus Team

## Credits

Built on top of:
- **WhiskeySockets/Baileys** - Core WebSocket implementation
- **Kelvdra/Baileys** - Enhanced message handlers inspiration

## Support

For issues and questions:
- Create an issue on GitHub
- Check existing documentation
- Review example implementations

## Changelog

### v1.0.0
- Initial release
- Full Kelvdra message handler integration
- WhiskeySockets foundation
- Complete API documentation
