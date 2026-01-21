import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { NOISE_MODE, WA_CERT_DETAILS } from '../Defaults/index.js';
import { decodeBinaryNode } from '../WABinary/index.js';
import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, sha256 } from './crypto.js';
const generateIV = (counter) => {
    const iv = new ArrayBuffer(12);
    new DataView(iv).setUint32(8, counter);
    return new Uint8Array(iv);
};
export const makeNoiseHandler = ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }) => {
    logger = logger.child({ class: 'ns' });
    const authenticate = (data) => {
        if (!isFinished) {
            hash = sha256(Buffer.concat([hash, data]));
        }
    };
    const encrypt = (plaintext) => {
        const result = aesEncryptGCM(plaintext, encKey, generateIV(writeCounter), hash);
        writeCounter += 1;
        authenticate(result);
        return result;
    };
    const decrypt = (ciphertext) => {
    const attemptDecrypt = (counter) => {
        try {
            const iv = generateIV(counter);
            const result = aesDecryptGCM(ciphertext, decKey, iv, hash);
            return { success: true, result, counter };
        } catch {
            return { success: false };
        }
    };
    
    // Try with current counter
    const currentCounter = isFinished ? readCounter : writeCounter;
    let attempt = attemptDecrypt(currentCounter);
    
    if (attempt.success) {
        if (isFinished) {
            readCounter += 1;
        } else {
            writeCounter += 1;
        }
        authenticate(ciphertext);
        return attempt.result;
    }
    
    // Try with next counter (desync recovery)
    logger.debug('Trying alternate counter for decryption');
    attempt = attemptDecrypt(currentCounter + 1);
    
    if (attempt.success) {
        logger.info('Decryption succeeded with alternate counter - syncing');
        if (isFinished) {
            readCounter = currentCounter + 2; // Skip ahead
        } else {
            writeCounter = currentCounter + 2;
        }
        authenticate(ciphertext);
        return attempt.result;
    }
    
    // Try previous counter
    if (currentCounter > 0) {
        attempt = attemptDecrypt(currentCounter - 1);
        
        if (attempt.success) {
            logger.info('Decryption succeeded with previous counter - syncing');
            if (isFinished) {
                readCounter = currentCounter;
            } else {
                writeCounter = currentCounter;
            }
            authenticate(ciphertext);
            return attempt.result;
        }
    }
    
    // All attempts failed - throw so frame gets skipped
    logger.warn({ currentCounter, isFinished }, 'All decryption attempts failed - frame will be skipped');
    throw new Error('Decryption failed - counter mismatch');
};
    const localHKDF = async (data) => {
        const key = await hkdf(Buffer.from(data), 64, { salt, info: '' });
        return [key.slice(0, 32), key.slice(32)];
    };
    const mixIntoKey = async (data) => {
        const [write, read] = await localHKDF(data);
        salt = write;
        encKey = read;
        decKey = read;
        readCounter = 0;
        writeCounter = 0;
    };
    const finishInit = async () => {
        const [write, read] = await localHKDF(new Uint8Array(0));
        encKey = write;
        decKey = read;
        hash = Buffer.from([]);
        readCounter = 0;
        writeCounter = 0;
        isFinished = true;
    };
    const data = Buffer.from(NOISE_MODE);
    let hash = data.byteLength === 32 ? data : sha256(data);
    let salt = hash;
    let encKey = hash;
    let decKey = hash;
    let readCounter = 0;
    let writeCounter = 0;
    let isFinished = false;
    let sentIntro = false;
    let inBytes = Buffer.alloc(0);
    authenticate(NOISE_HEADER);
    authenticate(publicKey);
    return {
        encrypt,
        decrypt,
        authenticate,
        mixIntoKey,
        finishInit,
        processHandshake: async ({ serverHello }, noiseKey) => {
            authenticate(serverHello.ephemeral);
            await mixIntoKey(Curve.sharedKey(privateKey, serverHello.ephemeral));
            const decStaticContent = decrypt(serverHello.static);
            await mixIntoKey(Curve.sharedKey(privateKey, decStaticContent));
            const certDecoded = decrypt(serverHello.payload);
            const { intermediate: certIntermediate /*leaf*/ } = proto.CertChain.decode(certDecoded);
            // TODO: handle this leaf stuff
            const { issuerSerial } = proto.CertChain.NoiseCertificate.Details.decode(certIntermediate.details);
            if (issuerSerial !== WA_CERT_DETAILS.SERIAL) {
                throw new Boom('certification match failed', { statusCode: 400 });
            }
            const keyEnc = encrypt(noiseKey.public);
            await mixIntoKey(Curve.sharedKey(noiseKey.private, serverHello.ephemeral));
            return keyEnc;
        },
        encodeFrame: (data) => {
            if (isFinished) {
                data = encrypt(data);
            }
            let header;
            if (routingInfo) {
                header = Buffer.alloc(7);
                header.write('ED', 0, 'utf8');
                header.writeUint8(0, 2);
                header.writeUint8(1, 3);
                header.writeUint8(routingInfo.byteLength >> 16, 4);
                header.writeUint16BE(routingInfo.byteLength & 65535, 5);
                header = Buffer.concat([header, routingInfo, NOISE_HEADER]);
            }
            else {
                header = Buffer.from(NOISE_HEADER);
            }
            const introSize = sentIntro ? 0 : header.length;
            const frame = Buffer.alloc(introSize + 3 + data.byteLength);
            if (!sentIntro) {
                frame.set(header);
                sentIntro = true;
            }
            frame.writeUInt8(data.byteLength >> 16, introSize);
            frame.writeUInt16BE(65535 & data.byteLength, introSize + 1);
            frame.set(data, introSize + 3);
            return frame;
        },
decodeFrame: async (newData, onFrame) => {
    const getBytesSize = () => {
        if (inBytes.length >= 3) {
            return (inBytes.readUInt8() << 16) | inBytes.readUInt16BE(1);
        }
    };
    
    try {
        inBytes = Buffer.concat([inBytes, newData]);
        logger.trace(`recv ${newData.length} bytes, total recv ${inBytes.length} bytes`);
        
        let size = getBytesSize();
        
        while (size && inBytes.length >= size + 3) {
            let frame = inBytes.slice(3, size + 3);
            inBytes = inBytes.slice(size + 3);
            
            try {
                if (isFinished) {
                    try {
                        const result = decrypt(frame);
                        frame = await decodeBinaryNode(result);
                    } catch (decryptError) {
                        logger.warn({ 
                            error: decryptError.message,
                            frameSize: frame.length
                        }, 'Frame decryption failed - skipping this frame');
                        
                        // Just skip and move to next frame - never stop processing
                        size = getBytesSize();
                        continue;
                    }
                }
                
                logger.trace({ msg: frame?.attrs?.id }, 'recv frame');
                onFrame(frame);
            } catch (frameError) {
                logger.warn({ 
                    error: frameError.message,
                    frameSize: frame?.length
                }, 'Frame processing error - skipping');
                // Continue to next frame
            }
            
            size = getBytesSize();
        }
    } catch (outerError) {
        // Even on outer errors, just log and continue
        logger.warn({ error: outerError.message }, 'Buffer processing error - resetting buffer and continuing');
        inBytes = Buffer.alloc(0);
        // Don't throw - just continue processing next data
    }
}
    };
};
//# sourceMappingURL=noise-handler.js.map