import { Boom } from '@hapi/boom';
import { exec } from 'child_process';
import * as Crypto from 'crypto';
import { once } from 'events';
import { createReadStream, createWriteStream, promises as fs, WriteStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable, Transform } from 'stream';
import { URL } from 'url';
import { proto } from '../../WAProto/index.js';
import { DEFAULT_ORIGIN, MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP } from '../Defaults/index.js';
import { getBinaryNodeChild, getBinaryNodeChildBuffer, jidNormalizedUser } from '../WABinary/index.js';
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './crypto.js';
import { generateMessageIDV2 } from './generics.js';

export const getImageProcessingLibrary = async () => {
    const [jimp, sharp] = await Promise.all([
        import('jimp').catch(() => null),
        import('sharp').catch(() => null)
    ]);
    if (sharp) return { sharp };
    if (jimp) return { jimp };
    throw new Boom('No image processing library available');
};

export const hkdfInfoKey = (type) => `WhatsApp ${MEDIA_HKDF_KEY_MAPPING[type]} Keys`;

export const getRawMediaUploadData = async (media, mediaType, logger) => {
    const { stream } = await getStream(media);
    const hasher = Crypto.createHash('sha256');
    const filePath = join(tmpdir(), mediaType + generateMessageIDV2());
    const fileWriteStream = createWriteStream(filePath);
    let fileLength = 0;

    try {
        for await (const data of stream) {
            fileLength += data.length;
            hasher.update(data);
            if (!fileWriteStream.write(data)) await once(fileWriteStream, 'drain');
        }
        fileWriteStream.end();
        await once(fileWriteStream, 'finish');
        stream.destroy();
        logger?.debug('hashed data for raw upload');
        return { filePath, fileSha256: hasher.digest(), fileLength };
    } catch (error) {
        fileWriteStream.destroy();
        stream.destroy();
        try { await fs.unlink(filePath); } catch { }
        throw error;
    }
};

export async function getMediaKeys(buffer, mediaType) {
    if (!buffer) throw new Boom('Cannot derive from empty media key');
    if (typeof buffer === 'string') buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64');
    
    const expandedMediaKey = await hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) });
    return {
        iv: expandedMediaKey.slice(0, 16),
        cipherKey: expandedMediaKey.slice(16, 48),
        macKey: expandedMediaKey.slice(48, 80)
    };
}

const extractVideoThumb = (path, destPath, time, size) => new Promise((resolve, reject) => {
    const cmd = `ffmpeg -ss ${time} -i ${path} -y -vf scale=${size.width}:-1 -vframes 1 -f image2 ${destPath}`;
    exec(cmd, err => err ? reject(err) : resolve());
});

export const extractImageThumb = async (bufferOrFilePath, width = 32) => {
    if (bufferOrFilePath instanceof Readable) bufferOrFilePath = await toBuffer(bufferOrFilePath);
    
    const lib = await getImageProcessingLibrary();
    if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
        const img = lib.sharp.default(bufferOrFilePath);
        const dimensions = await img.metadata();
        const buffer = await img.resize(width).jpeg({ quality: 50 }).toBuffer();
        return { buffer, original: { width: dimensions.width, height: dimensions.height } };
    } else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'object') {
        const jimp = await lib.jimp.Jimp.read(bufferOrFilePath);
        const buffer = await jimp.resize({ w: width, mode: lib.jimp.ResizeStrategy.BILINEAR }).getBuffer('image/jpeg', { quality: 50 });
        return { buffer, original: { width: jimp.width, height: jimp.height } };
    }
    throw new Boom('No image processing library available');
};

export const encodeBase64EncodedStringForUpload = (b64) => encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));

export const generateProfilePicture = async (mediaUpload) => {
    let bufferOrFilePath = Buffer.isBuffer(mediaUpload) ? mediaUpload : 'url' in mediaUpload ? mediaUpload.url.toString() : await toBuffer(mediaUpload.stream);
    
    const lib = await getImageProcessingLibrary();
    let img;
    if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
        img = await lib.sharp.default(bufferOrFilePath).resize(720, 720, { fit: 'inside' }).jpeg({ quality: 50 }).toBuffer();
    } else if ('jimp' in lib && typeof lib.jimp?.read === 'function') {
        const { read, MIME_JPEG } = lib.jimp;
        const image = await read(bufferOrFilePath);
        const min = image.getWidth(), max = image.getHeight();
        img = await image.crop(0, 0, min, max).scaleToFit(720, 720).getBufferAsync(MIME_JPEG);
    } else {
        throw new Boom('No image processing library available');
    }
    return { img };
};

export const mediaMessageSHA256B64 = (message) => {
    const media = Object.values(message)[0];
    return media?.fileSha256 && Buffer.from(media.fileSha256).toString('base64');
};

export async function getAudioDuration(buffer) {
    const musicMetadata = await import('music-metadata');
    let metadata;
    if (Buffer.isBuffer(buffer)) metadata = await musicMetadata.parseBuffer(buffer, undefined, { duration: true });
    else if (typeof buffer === 'string') metadata = await musicMetadata.parseFile(buffer, { duration: true });
    else metadata = await musicMetadata.parseStream(buffer, undefined, { duration: true });
    return metadata.format.duration;
}

export async function getAudioWaveform(buffer, logger) {
    try {
        const { default: decoder } = await import('audio-decode');
        let audioData = Buffer.isBuffer(buffer) ? buffer : typeof buffer === 'string' ? await toBuffer(createReadStream(buffer)) : await toBuffer(buffer);
        const audioBuffer = await decoder(audioData);
        const rawData = audioBuffer.getChannelData(0);
        const samples = 64, blockSize = Math.floor(rawData.length / samples);
        const filteredData = [];
        for (let i = 0; i < samples; i++) {
            let sum = 0;
            for (let j = 0; j < blockSize; j++) sum += Math.abs(rawData[i * blockSize + j]);
            filteredData.push(sum / blockSize);
        }
        const multiplier = Math.pow(Math.max(...filteredData), -1);
        return new Uint8Array(filteredData.map(n => Math.floor(100 * n * multiplier)));
    } catch (e) {
        logger?.debug('Failed to generate waveform: ' + e);
    }
}

export const toReadable = (buffer) => {
    const readable = new Readable({ read: () => { } });
    readable.push(buffer);
    readable.push(null);
    return readable;
};

export const toBuffer = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    stream.destroy();
    return Buffer.concat(chunks);
};

export const getStream = async (item, opts) => {
    if (!item) throw new Boom('Item is required for getStream', { statusCode: 400 });
    
    if (Buffer.isBuffer(item)) return { stream: toReadable(item), type: 'buffer' };
    if (item?.stream?.pipe) return { stream: item.stream, type: 'readable' };
    if (item?.pipe) return { stream: item, type: 'readable' };
    
    if (item && typeof item === 'object' && 'url' in item) {
        const urlStr = item.url.toString();
        if (Buffer.isBuffer(item.url)) return { stream: toReadable(item.url), type: 'buffer' };
        if (urlStr.startsWith('data:')) return { stream: toReadable(Buffer.from(urlStr.split(',')[1], 'base64')), type: 'buffer' };
        if (urlStr.startsWith('http')) return { stream: await getHttpStream(item.url, opts), type: 'remote' };
        return { stream: createReadStream(item.url), type: 'file' };
    }
    
    if (typeof item === 'string') {
        if (item.startsWith('data:')) return { stream: toReadable(Buffer.from(item.split(',')[1], 'base64')), type: 'buffer' };
        if (item.startsWith('http')) return { stream: await getHttpStream(item, opts), type: 'remote' };
        return { stream: createReadStream(item), type: 'file' };
    }
    
    throw new Boom(`Invalid input type for getStream: ${typeof item}`, { statusCode: 400 });
};

export async function generateThumbnail(file, mediaType, options) {
    let thumbnail, originalImageDimensions;
    
    if (mediaType === 'image') {
        const { buffer, original } = await extractImageThumb(file);
        thumbnail = buffer.toString('base64');
        if (original.width && original.height) originalImageDimensions = original;
    } else if (mediaType === 'video') {
        const imgFilename = join(tmpdir(), generateMessageIDV2() + '.jpg');
        try {
            await extractVideoThumb(file, imgFilename, '00:00:00', { width: 32, height: 32 });
            const buff = await fs.readFile(imgFilename);
            thumbnail = buff.toString('base64');
            await fs.unlink(imgFilename);
        } catch (err) {
            options.logger?.debug('could not generate video thumb: ' + err);
        }
    }
    return { thumbnail, originalImageDimensions };
}

export const getHttpStream = async (url, options = {}) => {
    const response = await fetch(url.toString(), {
        dispatcher: options.dispatcher,
        method: 'GET',
        headers: options.headers
    });
    if (!response.ok) throw new Boom(`Failed to fetch stream from ${url}`, { statusCode: response.status, data: { url } });
    
    const body = response.body;
    if (body && typeof body === 'object' && 'pipeTo' in body && typeof body.pipeTo === 'function') {
        return Readable.fromWeb(body);
    }
    if (body && typeof body.pipe === 'function' && typeof body.read === 'function') return body;
    throw new Error('Response body is not a readable stream');
};

export const encryptedStream = async (media, mediaType, { logger, saveOriginalFileIfRequired, opts, mediaKey: providedMediaKey } = {}) => {
    const { stream, type } = await getStream(media, opts);
    const mediaKey = providedMediaKey || Crypto.randomBytes(32);
    const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, mediaType);
    const encFilePath = join(tmpdir(), mediaType + generateMessageIDV2() + '-enc');
    const encFileWriteStream = createWriteStream(encFilePath);
    let originalFileStream, originalFilePath;
    
    if (saveOriginalFileIfRequired) {
        originalFilePath = join(tmpdir(), mediaType + generateMessageIDV2() + '-original');
        originalFileStream = createWriteStream(originalFilePath);
    }

    let fileLength = 0;
    const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
    const hmac = Crypto.createHmac('sha256', macKey).update(iv);
    const sha256Plain = Crypto.createHash('sha256');
    const sha256Enc = Crypto.createHash('sha256');

    try {
        for await (const data of stream) {
            fileLength += data.length;
            if (type === 'remote' && opts?.maxContentLength && fileLength > opts.maxContentLength) {
                throw new Boom('content length exceeded', { data: { media, type } });
            }
            if (originalFileStream && !originalFileStream.write(data)) await once(originalFileStream, 'drain');
            sha256Plain.update(data);
            const encrypted = aes.update(data);
            sha256Enc.update(encrypted);
            hmac.update(encrypted);
            encFileWriteStream.write(encrypted);
        }
        
        const finalData = aes.final();
        sha256Enc.update(finalData);
        hmac.update(finalData);
        encFileWriteStream.write(finalData);
        
        const mac = hmac.digest().slice(0, 10);
        sha256Enc.update(mac);
        encFileWriteStream.write(mac);
        encFileWriteStream.end();
        originalFileStream?.end?.();
        stream.destroy();
        
        logger?.debug('encrypted data successfully');
        return {
            mediaKey,
            originalFilePath,
            encFilePath,
            mac,
            fileEncSha256: sha256Enc.digest(),
            fileSha256: sha256Plain.digest(),
            fileLength
        };
    } catch (error) {
        encFileWriteStream.destroy();
        originalFileStream?.destroy?.();
        aes.destroy();
        hmac.destroy();
        sha256Plain.destroy();
        sha256Enc.destroy();
        stream.destroy();
        try {
            await fs.unlink(encFilePath);
            if (originalFilePath) await fs.unlink(originalFilePath);
        } catch (err) {
            logger?.error({ err }, 'failed deleting tmp files');
        }
        throw error;
    }
};

const DEF_HOST = 'mmg.whatsapp.net';
const AES_CHUNK_SIZE = 16;
const toSmallestChunkSize = (num) => Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE;

export const getUrlFromDirectPath = (directPath) => `https://${DEF_HOST}${directPath}`;

export const downloadContentFromMessage = async ({ mediaKey, directPath, url }, type, opts = {}) => {
    const isValidMediaUrl = url?.startsWith('https://mmg.whatsapp.net/');
    const downloadUrl = isValidMediaUrl ? url : getUrlFromDirectPath(directPath);
    if (!downloadUrl) throw new Boom('No valid media URL or directPath present', { statusCode: 400 });
    
    const keys = await getMediaKeys(mediaKey, type);
    return downloadEncryptedContent(downloadUrl, keys, opts);
};

export const downloadEncryptedContent = async (downloadUrl, { cipherKey, iv }, { startByte, endByte, options } = {}) => {
    let bytesFetched = 0, startChunk = 0, firstBlockIsIV = false;
    
    if (startByte) {
        const chunk = toSmallestChunkSize(startByte || 0);
        if (chunk) {
            startChunk = chunk - AES_CHUNK_SIZE;
            bytesFetched = chunk;
            firstBlockIsIV = true;
        }
    }
    
    const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined;
    const headers = {
        ...(options?.headers ? (Array.isArray(options.headers) ? Object.fromEntries(options.headers) : options.headers) : {}),
        Origin: DEFAULT_ORIGIN
    };
    
    if (startChunk || endChunk) {
        headers.Range = `bytes=${startChunk}-${endChunk || ''}`;
    }

    const fetched = await getHttpStream(downloadUrl, { ...(options || {}), headers });
    let remainingBytes = Buffer.from([]), aes;

    const pushBytes = (bytes, push) => {
        if (startByte || endByte) {
            const start = bytesFetched >= startByte ? undefined : Math.max(startByte - bytesFetched, 0);
            const end = bytesFetched + bytes.length < endByte ? undefined : Math.max(endByte - bytesFetched, 0);
            push(bytes.slice(start, end));
            bytesFetched += bytes.length;
        } else {
            push(bytes);
        }
    };

    const output = new Transform({
        transform(chunk, _, callback) {
            let data = Buffer.concat([remainingBytes, chunk]);
            const decryptLength = toSmallestChunkSize(data.length);
            remainingBytes = data.slice(decryptLength);
            data = data.slice(0, decryptLength);
            
            if (!aes) {
                let ivValue = iv;
                if (firstBlockIsIV) {
                    ivValue = data.slice(0, AES_CHUNK_SIZE);
                    data = data.slice(AES_CHUNK_SIZE);
                }
                aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue);
                if (endByte) aes.setAutoPadding(false);
            }
            
            try {
                pushBytes(aes.update(data), b => this.push(b));
                callback();
            } catch (error) {
                callback(error);
            }
        },
        final(callback) {
            try {
                pushBytes(aes.final(), b => this.push(b));
                callback();
            } catch (error) {
                callback(error);
            }
        }
    });
    return fetched.pipe(output, { end: true });
};

export function extensionForMediaMessage(message) {
    const getExtension = (mimetype) => mimetype.split(';')[0]?.split('/')[1];
    const type = Object.keys(message)[0];
    let extension;
    
    if (type === 'locationMessage' || type === 'liveLocationMessage' || type === 'productMessage') {
        extension = '.jpeg';
    } else {
        const messageContent = message[type];
        extension = getExtension(messageContent.mimetype);
    }
    return extension;
}

export const getWAUploadToServer = ({ customUploadHosts, fetchAgent, logger, options }, refreshMediaConn) => {
    return async (filePath, { mediaType, fileEncSha256B64, timeoutMs }) => {
        let uploadInfo = await refreshMediaConn(false);
        let urls;
        const hosts = [...customUploadHosts, ...uploadInfo.hosts];
        fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64);
        
        for (const { hostname } of hosts) {
            logger.debug(`uploading to "${hostname}"`);
            const auth = encodeURIComponent(uploadInfo.auth);
            const url = `https://${hostname}${MEDIA_PATH_MAP[mediaType]}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`;
            
            try {
                const stream = createReadStream(filePath);
                const response = await fetch(url, {
                    dispatcher: fetchAgent,
                    method: 'POST',
                    body: stream,
                    headers: {
                        ...(options?.headers ? (Array.isArray(options.headers) ? Object.fromEntries(options.headers) : options.headers) : {}),
                        'Content-Type': 'application/octet-stream',
                        Origin: DEFAULT_ORIGIN
                    },
                    duplex: 'half',
                    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
                });
                
                let result;
                try { result = await response.json(); } 
                catch { result = undefined; }
                
                if (result?.url || result?.directPath) {
                    urls = {
                        mediaUrl: result.url,
                        directPath: result.direct_path,
                        meta_hmac: result.meta_hmac,
                        fbid: result.fbid,
                        ts: result.ts
                    };
                    break;
                } else {
                    uploadInfo = await refreshMediaConn(true);
                    throw new Error(`upload failed: ${JSON.stringify(result)}`);
                }
            } catch (error) {
                const isLast = hostname === hosts[uploadInfo.hosts.length - 1]?.hostname;
                logger.warn({ trace: error?.stack }, `Error uploading to ${hostname}${isLast ? '' : ', retrying...'}`);
            }
        }
        
        if (!urls) throw new Boom('Media upload failed on all hosts', { statusCode: 500 });
        return urls;
    };
};

const getMediaRetryKey = (mediaKey) => hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' });

export const encryptMediaRetryRequest = async (key, mediaKey, meId) => {
    const recp = { stanzaId: key.id };
    const recpBuffer = proto.ServerErrorReceipt.encode(recp).finish();
    const iv = Crypto.randomBytes(12);
    const retryKey = await getMediaRetryKey(mediaKey);
    const ciphertext = aesEncryptGCM(recpBuffer, retryKey, iv, Buffer.from(key.id));
    
    return {
        tag: 'receipt',
        attrs: { id: key.id, to: jidNormalizedUser(meId), type: 'server-error' },
        content: [
            { tag: 'encrypt', attrs: {}, content: [
                { tag: 'enc_p', attrs: {}, content: ciphertext },
                { tag: 'enc_iv', attrs: {}, content: iv }
            ]},
            { tag: 'rmr', attrs: { jid: key.remoteJid, from_me: (!!key.fromMe).toString(), participant: key.participant } }
        ]
    };
};

export const decodeMediaRetryNode = (node) => {
    const rmrNode = getBinaryNodeChild(node, 'rmr');
    const event = {
        key: {
            id: node.attrs.id,
            remoteJid: rmrNode.attrs.jid,
            fromMe: rmrNode.attrs.from_me === 'true',
            participant: rmrNode.attrs.participant
        }
    };
    
    const errorNode = getBinaryNodeChild(node, 'error');
    if (errorNode) {
        const errorCode = +errorNode.attrs.code;
        event.error = new Boom(`Failed to re-upload media (${errorCode})`, { data: errorNode.attrs, statusCode: getStatusCodeForMediaRetry(errorCode) });
    } else {
        const encryptedInfoNode = getBinaryNodeChild(node, 'encrypt');
        const ciphertext = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_p');
        const iv = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_iv');
        if (ciphertext && iv) event.media = { ciphertext, iv };
        else event.error = new Boom('Failed to re-upload media (missing ciphertext)', { statusCode: 404 });
    }
    return event;
};

export const decryptMediaRetryData = async ({ ciphertext, iv }, mediaKey, msgId) => {
    const retryKey = await getMediaRetryKey(mediaKey);
    const plaintext = aesDecryptGCM(ciphertext, retryKey, iv, Buffer.from(msgId));
    return proto.MediaRetryNotification.decode(plaintext);
};

export const getStatusCodeForMediaRetry = (code) => MEDIA_RETRY_STATUS_MAP[code];

const MEDIA_RETRY_STATUS_MAP = {
    [proto.MediaRetryNotification.ResultType.SUCCESS]: 200,
    [proto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
    [proto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
    [proto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418
};