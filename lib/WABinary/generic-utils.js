import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import {} from './types.js';
// some extra useful utilities
export const getBinaryNodeChildren = (node, childTag) => {
    if (Array.isArray(node?.content)) {
        return node.content.filter(item => item.tag === childTag);
    }
    return [];
};
export const getAllBinaryNodeChildren = ({ content }) => {
    if (Array.isArray(content)) {
        return content;
    }
    return [];
};
export const getBinaryNodeChild = (node, childTag) => {
    if (Array.isArray(node?.content)) {
        return node?.content.find(item => item.tag === childTag);
    }
};
export const getBinaryNodeChildBuffer = (node, childTag) => {
    const child = getBinaryNodeChild(node, childTag)?.content;
    if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
        return child;
    }
};
// Add this function after getBinaryFilteredButtons
export const getButtonArgs = (message) => {
    const msgContent = message.viewOnceMessage?.message || message;
    // Check both interactiveMessage and interactive keys
    const interactiveMsg = msgContent.interactiveMessage || msgContent.interactive;
    const flowMsg = interactiveMsg?.nativeFlowMessage;
    const btnFirst = flowMsg?.buttons?.[0]?.name;
    const specialBtns = [
        'mpm', 'cta_catalog', 'send_location', 'call_permission_request',
        'wa_payment_transaction_details', 'automated_greeting_message_view_catalog',
        'open_webview', 'galaxy_message'
    ];

    const base = {
        tag: 'biz',
        attrs: {
            actual_actors: '2',
            host_storage: '2',
            privacy_mode_ts: Math.floor(Date.now() / 1000).toString()
        }
    };

    // Special buttons need full interactive structure
    if (flowMsg && specialBtns.includes(btnFirst)) {
        return {
            ...base,
            content: [
                {
                    tag: 'interactive',
                    attrs: { type: 'native_flow', v: '1' },
                    content: [{
                        tag: 'native_flow',
                        attrs: { v: '2', name: btnFirst }
                    }]
                },
                { tag: 'quality_control', attrs: { source_type: 'third_party' } }
            ]
        };
    }

    // Regular interactive/button messages
    if (flowMsg || msgContent.buttonsMessage) {
        return {
            ...base,
            content: [
                {
                    tag: 'interactive',
                    attrs: { type: 'native_flow', v: '1' },
                    content: [{
                        tag: 'native_flow',
                        attrs: { v: '9', name: 'mixed' }
                    }]
                },
                { tag: 'quality_control', attrs: { source_type: 'third_party' } }
            ]
        };
    }

    // List messages
    if (msgContent.listMessage) {
        return {
            ...base,
            content: [
                { tag: 'list', attrs: { v: '2', type: 'product_list' } },
                { tag: 'quality_control', attrs: { source_type: 'third_party' } }
            ]
        };
    }

    return base;
};

// Add button type detection helper
export const getButtonType = (message) => {
    if (message.listMessage) return 'list';
    if (message.buttonsMessage) return 'buttons';
    
    // Check both interactiveMessage and interactive keys
    const interactiveMsg = message.interactiveMessage || message.interactive;
    if (!interactiveMsg?.nativeFlowMessage) return null;
    
    const btn = interactiveMsg?.nativeFlowMessage?.buttons?.[0]?.name;
    if (['review_and_pay', 'review_order', 'payment_info', 'payment_status', 'payment_method'].includes(btn)) {
        return btn;
    }
    
    // Return 'interactive' for ANY native flow message that has buttons or nativeFlowMessage
    if (interactiveMsg?.nativeFlowMessage?.buttons?.length || interactiveMsg?.nativeFlowMessage) {
        return 'interactive';
    }
    
    return null;
};

export const getBinaryNodeChildString = (node, childTag) => {
    const child = getBinaryNodeChild(node, childTag)?.content;
    if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
        return Buffer.from(child).toString('utf-8');
    }
    else if (typeof child === 'string') {
        return child;
    }
};
export const getBinaryFilteredButtons = (nodeContent) => {
	if (!Array.isArray(nodeContent)) return false

    return nodeContent.some(a =>
        ['native_flow'].includes(a?.content?.[0]?.content?.[0]?.tag) ||
        ['interactive', 'buttons', 'list'].includes(a?.content?.[0]?.tag) ||
        ['hsm', 'biz'].includes(a?.tag)
    )
}
export const getBinaryNodeChildUInt = (node, childTag, length) => {
    const buff = getBinaryNodeChildBuffer(node, childTag);
    if (buff) {
        return bufferToUInt(buff, length);
    }
};
export const assertNodeErrorFree = (node) => {
    const errNode = getBinaryNodeChild(node, 'error');
    if (errNode) {
        const errorCode = +errNode.attrs.code;
        if (errorCode === 429) {
            const error = new Boom('Rate limit', { data: 429 });
            error.isRateLimit = true;
            throw error;
        }
        throw new Boom(errNode.attrs.text || 'Unknown error', { data: errorCode });
    }
};
export const reduceBinaryNodeToDictionary = (node, tag) => {
    const nodes = getBinaryNodeChildren(node, tag);
    const dict = nodes.reduce((dict, { attrs }) => {
        if (typeof attrs.name === 'string') {
            dict[attrs.name] = attrs.value || attrs.config_value;
        }
        else {
            dict[attrs.config_code] = attrs.value || attrs.config_value;
        }
        return dict;
    }, {});
    return dict;
};
export const getBinaryNodeMessages = ({ content }) => {
    const msgs = [];
    if (Array.isArray(content)) {
        for (const item of content) {
            if (item.tag === 'message') {
                msgs.push(proto.WebMessageInfo.decode(item.content).toJSON());
            }
        }
    }
    return msgs;
};
function bufferToUInt(e, t) {
    let a = 0;
    for (let i = 0; i < t; i++) {
        a = 256 * a + e[i];
    }
    return a;
}
const tabs = (n) => '\t'.repeat(n);
export function binaryNodeToString(node, i = 0) {
    if (!node) {
        return node;
    }
    if (typeof node === 'string') {
        return tabs(i) + node;
    }
    if (node instanceof Uint8Array) {
        return tabs(i) + Buffer.from(node).toString('hex');
    }
    if (Array.isArray(node)) {
        return node.map(x => tabs(i + 1) + binaryNodeToString(x, i + 1)).join('\n');
    }
    const children = binaryNodeToString(node.content, i + 1);
    const tag = `<${node.tag} ${Object.entries(node.attrs || {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}='${v}'`)
        .join(' ')}`;
    const content = children ? `>\n${children}\n${tabs(i)}</${node.tag}>` : '/>';
    return tag + content;
}
//# sourceMappingURL=generic-utils.js.map
