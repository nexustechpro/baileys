import { LRUCache } from 'lru-cache';
import { isHostedPnUser, isLidUser, isPnUser, jidDecode, jidNormalizedUser, WAJIDDomains } from '../WABinary/index.js';
import { BATCH_SIZE_LID_MAPPING } from '../Defaults/index.js';
export class LIDMappingStore {
    constructor(keys, logger, pnToLIDFunc) {
        this.mappingCache = new LRUCache({
            ttl: 7 * 24 * 60 * 60 * 1000, // 7 days
            ttlAutopurge: true,
            updateAgeOnGet: true
        });
        this.keys = keys;
        this.pnToLIDFunc = pnToLIDFunc;
        this.logger = logger;
    }
    /**
     * Store LID-PN mapping - USER LEVEL (Batched storage with 500-item limit)
     */
    async storeLIDPNMappings(pairs) {
        // Validate inputs
        const pairMap = {};
        for (const { lid, pn } of pairs) {
            if (!((isLidUser(lid) && isPnUser(pn)) || (isPnUser(lid) && isLidUser(pn)))) {
                this.logger.warn(`Invalid LID-PN mapping: ${lid}, ${pn}`);
                continue;
            }
            const lidDecoded = jidDecode(lid);
            const pnDecoded = jidDecode(pn);
            if (!lidDecoded || !pnDecoded)
                return;
            const pnUser = pnDecoded.user;
            const lidUser = lidDecoded.user;
            let existingLidUser = this.mappingCache.get(`pn:${pnUser}`);
            if (!existingLidUser) {
                this.logger.trace(`Cache miss for PN user ${pnUser}; checking database`);
                // Load from batched storage
                const batchData = await this.keys.get('lid-mapping', ['_index']);
                const mappingBatch = batchData?.['_index'] || {};
                existingLidUser = mappingBatch[pnUser];
                if (existingLidUser) {
                    // Update cache with database value
                    this.mappingCache.set(`pn:${pnUser}`, existingLidUser);
                    this.mappingCache.set(`lid:${existingLidUser}`, pnUser);
                }
            }
            if (existingLidUser === lidUser) {
                this.logger.debug({ pnUser, lidUser }, 'LID mapping already exists, skipping');
                continue;
            }
            pairMap[pnUser] = lidUser;
        }
        this.logger.trace({ pairMap }, `Storing ${Object.keys(pairMap).length} pn mappings`);
        await this.keys.transaction(async () => {
            // Load existing batched mappings
            const batchData = await this.keys.get('lid-mapping', ['_index']);
            const mappingBatch = batchData?.['_index'] || {};
            
            // Add/update the mappings
            for (const [pnUser, lidUser] of Object.entries(pairMap)) {
                mappingBatch[pnUser] = lidUser;
                mappingBatch[`${lidUser}_reverse`] = pnUser;
                this.mappingCache.set(`pn:${pnUser}`, lidUser);
                this.mappingCache.set(`lid:${lidUser}`, pnUser);
            }
            
            // Enforce 500-item limit with cleanup of old entries
            const mappingKeys = Object.keys(mappingBatch).filter(k => k !== '_index');
            if (mappingKeys.length > BATCH_SIZE_LID_MAPPING) {
                // Sort and remove oldest entries (keep most recent entries)
                mappingKeys.sort();
                const toRemove = mappingKeys.slice(0, mappingKeys.length - BATCH_SIZE_LID_MAPPING);
                toRemove.forEach(k => delete mappingBatch[k]);
                this.logger.debug(`Cleaned up ${toRemove.length} old LID mappings (kept ${BATCH_SIZE_LID_MAPPING})`);
            }
            
            // Store updated batch
            await this.keys.set({ 'lid-mapping': { '_index': mappingBatch } });
        }, 'lid-mapping');
    }
    /**
     * Get LID for PN - Returns device-specific LID based on user mapping
     */
    async getLIDForPN(pn) {
        return (await this.getLIDsForPNs([pn]))?.[0]?.lid || null;
    }
    async getLIDsForPNs(pns) {
        const usyncFetch = {};
        // mapped from pn to lid mapping to prevent duplication in results later
        const successfulPairs = {};
        // Load batched mappings once
        const batchData = await this.keys.get('lid-mapping', ['_index']);
        const mappingBatch = batchData?.['_index'] || {};
        
        for (const pn of pns) {
            if (!isPnUser(pn) && !isHostedPnUser(pn))
                continue;
            const decoded = jidDecode(pn);
            if (!decoded)
                continue;
            // Check cache first for PN → LID mapping
            const pnUser = decoded.user;
            let lidUser = this.mappingCache.get(`pn:${pnUser}`);
            if (!lidUser) {
                // Cache miss - check batched database
                lidUser = mappingBatch[pnUser];
                if (lidUser) {
                    this.mappingCache.set(`pn:${pnUser}`, lidUser);
                    this.mappingCache.set(`lid:${lidUser}`, pnUser);
                }
                else {
                    this.logger.trace(`No LID mapping found for PN user ${pnUser}; batch getting from USync`);
                    const device = decoded.device || 0;
                    let normalizedPn = jidNormalizedUser(pn);
                    if (isHostedPnUser(normalizedPn)) {
                        normalizedPn = `${pnUser}@s.whatsapp.net`;
                    }
                    if (!usyncFetch[normalizedPn]) {
                        usyncFetch[normalizedPn] = [device];
                    }
                    else {
                        usyncFetch[normalizedPn]?.push(device);
                    }
                    continue;
                }
            }
            lidUser = lidUser.toString();
            if (!lidUser) {
                this.logger.warn(`Invalid or empty LID user for PN ${pn}: lidUser = "${lidUser}"`);
                return null;
            }
            // Push the PN device ID to the LID to maintain device separation
            const pnDevice = decoded.device !== undefined ? decoded.device : 0;
            const deviceSpecificLid = `${lidUser}${!!pnDevice ? `:${pnDevice}` : ``}@${decoded.server === 'hosted' ? 'hosted.lid' : 'lid'}`;
            this.logger.trace(`getLIDForPN: ${pn} → ${deviceSpecificLid} (user mapping with device ${pnDevice})`);
            successfulPairs[pn] = { lid: deviceSpecificLid, pn };
        }
        if (Object.keys(usyncFetch).length > 0) {
            const result = await this.pnToLIDFunc?.(Object.keys(usyncFetch)); // this function already adds LIDs to mapping
            if (result && result.length > 0) {
                this.storeLIDPNMappings(result);
                for (const pair of result) {
                    const pnDecoded = jidDecode(pair.pn);
                    const pnUser = pnDecoded?.user;
                    if (!pnUser)
                        continue;
                    const lidUser = jidDecode(pair.lid)?.user;
                    if (!lidUser)
                        continue;
                    for (const device of usyncFetch[pair.pn]) {
                        const deviceSpecificLid = `${lidUser}${!!device ? `:${device}` : ``}@${device === 99 ? 'hosted.lid' : 'lid'}`;
                        this.logger.trace(`getLIDForPN: USYNC success for ${pair.pn} → ${deviceSpecificLid} (user mapping with device ${device})`);
                        const deviceSpecificPn = `${pnUser}${!!device ? `:${device}` : ``}@${device === 99 ? 'hosted' : 's.whatsapp.net'}`;
                        successfulPairs[deviceSpecificPn] = { lid: deviceSpecificLid, pn: deviceSpecificPn };
                    }
                }
            }
            else {
                return null;
            }
        }
        return Object.values(successfulPairs);
    }
    /**
     * Get PN for LID - USER LEVEL with device construction (Batched storage)
     */
    async getPNForLID(lid) {
        if (!isLidUser(lid))
            return null;
        const decoded = jidDecode(lid);
        if (!decoded)
            return null;
        // Check cache first for LID → PN mapping
        const lidUser = decoded.user;
        let pnUser = this.mappingCache.get(`lid:${lidUser}`);
        if (!pnUser || typeof pnUser !== 'string') {
            // Cache miss - check batched database
            const batchData = await this.keys.get('lid-mapping', ['_index']);
            const mappingBatch = batchData?.['_index'] || {};
            pnUser = mappingBatch[`${lidUser}_reverse`];
            if (!pnUser || typeof pnUser !== 'string') {
                this.logger.trace(`No reverse mapping found for LID user: ${lidUser}`);
                return null;
            }
            this.mappingCache.set(`lid:${lidUser}`, pnUser);
        }
        // Construct device-specific PN JID
        const lidDevice = decoded.device !== undefined ? decoded.device : 0;
        const pnJid = `${pnUser}:${lidDevice}@${decoded.domainType === WAJIDDomains.HOSTED_LID ? 'hosted' : 's.whatsapp.net'}`;
        this.logger.trace(`Found reverse mapping: ${lid} → ${pnJid}`);
        return pnJid;
    }
}
//# sourceMappingURL=lid-mapping.js.map