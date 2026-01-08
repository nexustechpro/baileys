"use strict";

import chalk from 'chalk';
import gradient from 'gradient-string';

const title = "✨ @nexus/baileys | Advanced WhatsApp Web API Client | v2.0.0 ✨";

console.log(gradient(["#00D4FF", "#0099FF", "#00D4FF"])("═══════════════════════════════════════════════════════════════════════"));
console.log(gradient(["#00D4FF", "#00FF88", "#00D4FF"])(title));
console.log(gradient(["#FFD700", "#FFFFFF"])("🚀 Advanced messaging with interactive buttons, products & events"));
console.log(gradient(["#00FF88", "#FFFFFF", "#00FF88"])(">  For support & updates, visit @nexus/baileys repository  <"));
console.log(gradient(["#00D4FF", "#0099FF", "#00D4FF"])("═══════════════════════════════════════════════════════════════════════"));

import makeWASocket from './Socket/index.js';
import NexusHandler from './Socket/nexus-handler.js';

export * from '../WAProto/index.js';
export * from './Utils/index.js';
export * from './Store/index.js';
export * from './Types/index.js';
export * from './Defaults/index.js';
export * from './WABinary/index.js';
export * from './WAM/index.js';
export * from './WAUSync/index.js';
export * from './Signal/index.js';
export { NexusHandler, makeWASocket };
export default makeWASocket;
