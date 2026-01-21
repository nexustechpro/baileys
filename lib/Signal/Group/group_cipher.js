import { decrypt, encrypt } from 'libsignal/src/crypto.js'
import { SenderKeyMessage } from './sender-key-message.js'
import { SenderKeyName } from './sender-key-name.js'
import { SenderKeyRecord } from './sender-key-record.js'
import { SenderKeyState } from './sender-key-state.js'

export class GroupCipher {
  constructor(senderKeyStore, senderKeyName) {
    this.senderKeyStore = senderKeyStore
    this.senderKeyName = senderKeyName
  }

  async encrypt(paddedPlaintext) {
    const record = await this.senderKeyStore.loadSenderKey(this.senderKeyName)
    if (!record) throw new Error('No SenderKeyRecord found')
    const state = record.getSenderKeyState()
    if (!state) throw new Error('No session to encrypt')
    const iteration = state.getSenderChainKey().getIteration()
    const senderKey = this.getSenderKey(state, iteration === 0 ? 0 : iteration + 1)
    const ciphertext = await this.getCipherText(senderKey.getIv(), senderKey.getCipherKey(), paddedPlaintext)
    const msg = new SenderKeyMessage(state.getKeyId(), senderKey.getIteration(), ciphertext, state.getSigningKeyPrivate())
    await this.senderKeyStore.storeSenderKey(this.senderKeyName, record)
    return msg.serialize()
  }

  async decrypt(senderKeyMessageBytes) {
    let record = await this.senderKeyStore.loadSenderKey(this.senderKeyName)
    if (!record) throw new Error('No SenderKeyRecord - requesting new session')
    
    const msg = new SenderKeyMessage(null, null, null, null, senderKeyMessageBytes)
    let state = record.getSenderKeyState(msg.getKeyId())

    if (!state) {
      const allStates = record.getSenderKeyStates?.() || []
      if (allStates.length > 0) {
        state = allStates[allStates.length - 1]
      } else {
        throw new Error(`No session found - keyId: ${msg.getKeyId()}`)
      }
    }

    try {
      msg.verifySignature(state.getSigningKeyPublic())
    } catch (e) {
      throw new Error('Signature verification failed')
    }

    const senderKey = this.getSenderKey(state, msg.getIteration())
    const plaintext = await this.getPlainText(senderKey.getIv(), senderKey.getCipherKey(), msg.getCipherText())
    
    try {
      await this.senderKeyStore.storeSenderKey(this.senderKeyName, record)
    } catch (e) {
      // Non-critical: decryption succeeded
    }

    return plaintext
  }

  getSenderKey(state, iteration) {
    let chainKey = state.getSenderChainKey()
    
    if (chainKey.getIteration() > iteration) {
      if (state.hasSenderMessageKey(iteration)) {
        const key = state.removeSenderMessageKey(iteration)
        if (!key) throw new Error('No sender message key')
        return key
      }
      throw new Error(`Old counter: ${chainKey.getIteration()} vs ${iteration}`)
    }

    if (iteration - chainKey.getIteration() > 2000) throw new Error('Over 2000 messages ahead')

    while (chainKey.getIteration() < iteration) {
      state.addSenderMessageKey(chainKey.getSenderMessageKey())
      chainKey = chainKey.getNext()
    }

    state.setSenderChainKey(chainKey.getNext())
    return chainKey.getSenderMessageKey()
  }

  async getPlainText(iv, key, ciphertext) {
    try {
      return decrypt(key, ciphertext, iv)
    } catch (e) {
      throw new Error('InvalidMessageException')
    }
  }

  async getCipherText(iv, key, plaintext) {
    try {
      return encrypt(key, plaintext, iv)
    } catch (e) {
      throw new Error('InvalidMessageException')
    }
  }
}

export default GroupCipher