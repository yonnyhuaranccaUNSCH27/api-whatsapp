const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, proto, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

process.on('unhandledRejection', (reason) => {
    console.error(' Error no manejado:', reason);
});
process.on('uncaughtException', (error) => {
    console.error(' Excepción no capturada:', error);
});

app.use(cors({
    origin: [
        'https://meerkadito.com/bk',
        'https://home.meerkadito.com',
        'http://localhost:4200',
        'http://localhost:82',
    ],
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const sessions = new Map();
const AUTH_BASE_PATH = path.resolve(__dirname, '..', 'baileys_auth');

console.log(' Iniciando Servidor WhatsApp Web API (Baileys)');
console.log(' Ruta auth:', AUTH_BASE_PATH);

if (!fs.existsSync(AUTH_BASE_PATH)) {
    fs.mkdirSync(AUTH_BASE_PATH, { recursive: true });
}

const formatNumber = (number) => {
    let cleanNumber = number.replace(/\D/g, '');
    if (cleanNumber.length === 9 && cleanNumber.startsWith('9')) {
        cleanNumber = `51${cleanNumber}`;
    }
    return cleanNumber;
};

const deleteSessionFolder = async (pathStr) => {
    if (!fs.existsSync(pathStr)) return true;
    try {
        fs.rmSync(pathStr, { recursive: true, force: true });
        return true;
    } catch (error) {
        if (error.code === 'EBUSY' || error.code === 'EPERM') {
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
                fs.renameSync(pathStr, `${pathStr}-trash-${Date.now()}`);
                return true;
            } catch (renameError) {
                return false;
            }
        }
        return false;
    }
};

const getProfilePicWithTimeout = async (sock, jid) => {
    try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000));
        const picPromise = sock.profilePictureUrl(jid, 'image');
        return await Promise.race([picPromise, timeout]);
    } catch (e) {
        return null;
    }
};

const normalizeTimestamp = (ts) => {
    if (typeof ts === 'number' && isFinite(ts)) return ts;
    if (typeof ts === 'bigint') return Number(ts);
    if (typeof ts === 'string' && ts.trim() !== '' && !isNaN(Number(ts))) return Number(ts);
    if (ts && typeof ts === 'object' && ts.low !== undefined) {
        return ts.low + (ts.high > 0 ? ts.high * 0x100000000 : 0);
    }
    console.warn('[TIMESTAMP] Formato desconocido, usando fallback:', typeof ts, ts);
    return Math.floor(Date.now() / 1000);
};

const hasRealContent = (msg) => {
    if (!msg?.message || typeof msg.message !== 'object') return false;

    const realMessage = unwrapMessage(msg.message);
    const keys = Object.keys(realMessage);
    if (keys.length === 0) return false;

    const ignoredTypes = [
        'reactionMessage',
        'protocolMessage',
        'senderKeyDistributionMessage',
        'pollUpdateMessage',
        'messageContextInfo',
    ];

    const visibleKeys = keys.filter(k => !ignoredTypes.includes(k));
    return visibleKeys.length > 0;
};


const unwrapMessage = (message) => {
    if (!message || typeof message !== 'object') return message;

    const wrapperKeys = [
        'ephemeralMessage',
        'viewOnceMessage',
        'viewOnceMessageV2',
        'viewOnceMessageV2Extension',
        'deviceSentMessage',
        'documentWithCaptionMessage',
    ];

    for (const key of wrapperKeys) {
        if (message[key]?.message) {
            return unwrapMessage(message[key].message);
        }
    }

    return message;
};

const buildLidMap = (contacts) => {
    const lidMap = new Map();
    for (const contact of contacts.values()) {
        if (contact.lid) {
            const lidNum = contact.lid.split('@')[0];
            // 👇 NUEVO: el nombre puede estar en el registro de @lid en vez del de teléfono
            const lidContact = contacts.get(contact.lid);
            const resolvedName = contact.name || contact.notify || lidContact?.name || lidContact?.notify || null;
            lidMap.set(lidNum, {
                name: resolvedName,
                phone: contact.id,
            });
        }
    }
    return lidMap;
};

const resolveChatName = (jid, chat, contact, store) => {

    if (jid === '51930995166@s.whatsapp.net') {
        console.log('[DEBUG-NAME] jid:', jid);
        console.log('[DEBUG-NAME] chat.accountLid:', chat.accountLid);
        console.log('[DEBUG-NAME] contacto por accountLid:', JSON.stringify(store?.contacts?.get(chat.accountLid)));
        console.log('[DEBUG-NAME] contact:', JSON.stringify(contact));
        console.log('[DEBUG-NAME] lidMap tiene esa key?:', store?.lidMap?.get('180311417733349'));
    }

    if (chat.name) return chat.name;
    if (chat.notify) return chat.notify;
    if (contact?.name) return contact.name;
    if (contact?.notify) return contact.notify;

    if (chat.accountLid && store?.contacts) {
        const lidContact = store.contacts.get(chat.accountLid);
        if (lidContact?.name) return lidContact.name;
        if (lidContact?.notify) return lidContact.notify;
    }

    if (store?.lidMap) {
        for (const mapped of store.lidMap.values()) {
            if (mapped.phone === jid && mapped.name) return mapped.name;
        }
    }

    if (jid.endsWith('@lid')) {
        const lidNum = jid.split('@')[0];
        const pushName = store?.lidPushNames?.get(lidNum);
        if (pushName) return pushName;

        const phoneMapping = store?.lidToPhone?.get(lidNum);
        if (phoneMapping?.name) return phoneMapping.name;
        if (phoneMapping?.phone) {
            const contactByPhone = store?.contacts?.get(phoneMapping.phone);
            if (contactByPhone?.name) return contactByPhone.name;
            if (contactByPhone?.notify) return contactByPhone.notify;
            return phoneMapping.phone.split('@')[0];
        }

        const mapped = store?.lidMap?.get(lidNum);
        if (mapped?.name) return mapped.name;
        if (mapped?.phone) return mapped.phone.split('@')[0];
    }

    const messages = store?.messages?.get(jid) || [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.pushName && hasRealContent(m)) return m.pushName;
    }

    return jid.split('@')[0];
};

const resolveChatId = (jid, store) => {
    if (jid.endsWith('@lid')) {
        const lidNum = jid.split('@')[0];
        const phoneMapping = store?.lidToPhone?.get(lidNum);
        if (phoneMapping?.phone) return phoneMapping.phone;
        const mapped = store?.lidMap?.get(lidNum);
        if (mapped?.phone) return mapped.phone;
    }
    return jid;
};

const buildLidToPhoneFromChats = (store) => {
    let found = 0;
    for (const [jid, chat] of store.chats) {
        if (!jid.endsWith('@lid')) continue;
        const accountLid = chat.accountLid || jid;
        const lidNum = accountLid.split('@')[0];
        if (store.lidToPhone.has(lidNum)) continue;
        for (const [cJid, contact] of store.contacts) {
            if (contact.lid && contact.lid.split('@')[0] === lidNum) {
                store.lidToPhone.set(lidNum, { phone: cJid, name: contact.name || contact.notify || null });
                found++;
                break;
            }
        }
    }
    if (found > 0) console.log(`[LID] buildLidToPhoneFromChats: ${found} mapeos encontrados`);
};

const resolveLidsViaUSync = async (sock, store) => {
    const unresolvedLids = [];
    for (const [jid] of store.chats) {
        if (!jid.endsWith('@lid')) continue;
        const lidNum = jid.split('@')[0];
        if (!store.lidToPhone.has(lidNum)) {
            unresolvedLids.push(lidNum);
        }
    }
    if (unresolvedLids.length === 0) {
        console.log(`[LID] Todos los LIDs ya resueltos`);
        return;
    }
    console.log(`[LID] ${unresolvedLids.length} LIDs sin resolver, intentando USync...`);

    try {
        const { USyncQuery, USyncUser } = require('@whiskeysockets/baileys');
        const BATCH_SIZE = 5;
        let resolved = 0;

        for (let i = 0; i < unresolvedLids.length; i += BATCH_SIZE) {
            const batch = unresolvedLids.slice(i, i + BATCH_SIZE);
            try {
                const query = new USyncQuery().withContactProtocol().withLIDProtocol();
                for (const lidNum of batch) {
                    query.withUser(new USyncUser().withId(`${lidNum}@lid`));
                }
                const result = await sock.executeUSyncQuery(query);
                if (result?.list) {
                    for (const item of result.list) {
                        if (item.id && item.contact && item.lid) {
                            const lidNum = item.lid.split('@')[0];
                            store.lidToPhone.set(lidNum, { phone: item.id, name: null });
                            resolved++;
                        }
                    }
                }
            } catch (e) {
                console.error(`[LID] USync batch error (offset ${i}):`, e.message);
                break;
            }
            await new Promise(r => setTimeout(r, 1500));
        }
        console.log(`[LID] USync completado: ${resolved}/${unresolvedLids.length} resueltos`);
    } catch (e) {
        console.error(`[LID] USync no disponible:`, e.message);
    }
};

const resolveNamesViaUSync = async (sock, store) => {
    const targets = [];
    for (const [jid, chat] of store.chats) {
        if (!jid.endsWith('@s.whatsapp.net')) continue;
        if (chat.name || chat.notify) continue;

        // Si ya tenemos el nombre en contacts, saltar
        const existingContact = store.contacts.get(jid);
        if (existingContact?.name || existingContact?.notify) continue;

        targets.push({ jid });
    }

    if (targets.length === 0) {
        console.log('[NAMES] Nada que resolver vía USync');
        return;
    }
    console.log(`[NAMES] ${targets.length} chats sin nombre, consultando USync...`);

    try {
        const { USyncQuery, USyncUser } = require('@whiskeysockets/baileys');
        const BATCH_SIZE = 5;
        let resolved = 0;

        for (let i = 0; i < targets.length; i += BATCH_SIZE) {
            const batch = targets.slice(i, i + BATCH_SIZE);
            try {
                const query = new USyncQuery().withContactProtocol();
                for (const t of batch) {
                    query.withUser(new USyncUser().withId(t.jid));
                }
                const result = await sock.executeUSyncQuery(query);
                if (result?.list) {
                    for (const item of result.list) {
                        const name = item.contact?.name || item.contact?.notify;
                        if (item.id && name) {
                            const existing = store.contacts.get(item.id) || { id: item.id };
                            existing.name = name;
                            store.contacts.set(item.id, existing);
                            resolved++;
                        }
                    }
                }
            } catch (e) {
                console.error(`[NAMES] USync batch error (offset ${i}):`, e.message);
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        console.log(`[NAMES] Resueltos ${resolved}/${targets.length} nombres`);
    } catch (e) {
        console.error('[NAMES] Error general:', e.message);
    }
};

// const resolveNamesViaUSync = async (sock, store) => {
//     // Recolectar accountLids de chats por teléfono que aún no tienen nombre resuelto
//     const targets = [];
//     for (const [jid, chat] of store.chats) {
//         if (!jid.endsWith('@s.whatsapp.net')) continue;
//         if (chat.name || chat.notify) continue;
//         if (!chat.accountLid) continue;
//         const lidContact = store.contacts.get(chat.accountLid);
//         if (lidContact?.name || lidContact?.notify) continue;
//         targets.push({ jid, accountLid: chat.accountLid });
//     }

//     if (targets.length === 0) {
//         console.log('[NAMES] Nada que resolver vía USync');
//         return;
//     }
//     console.log(`[NAMES] ${targets.length} chats sin nombre, consultando USync...`);

//     try {
//         const { USyncQuery, USyncUser } = require('@whiskeysockets/baileys');
//         const BATCH_SIZE = 5;
//         let resolved = 0;

//         for (let i = 0; i < targets.length; i += BATCH_SIZE) {
//             const batch = targets.slice(i, i + BATCH_SIZE);
//             try {
//                 const query = new USyncQuery().withContactProtocol();
//                 for (const t of batch) {
//                     query.withUser(new USyncUser().withId(t.jid));
//                 }
//                 const result = await sock.executeUSyncQuery(query);
//                 if (result?.list) {
//                     for (const item of result.list) {
//                         const name = item.contact?.name || item.contact?.notify;
//                         if (item.id && name) {
//                             const existing = store.contacts.get(item.id) || { id: item.id };
//                             existing.name = name;
//                             store.contacts.set(item.id, existing);
//                             resolved++;
//                         }
//                     }
//                 }
//             } catch (e) {
//                 console.error(`[NAMES] USync batch error (offset ${i}):`, e.message);
//             }
//             await new Promise(r => setTimeout(r, 1000));
//         }
//         console.log(`[NAMES] Resueltos ${resolved}/${targets.length} nombres`);
//     } catch (e) {
//         console.error('[NAMES] Error general:', e.message);
//     }
// };

const extractLidsFromGroups = async (sock, store) => {
    try {
        const groups = await sock.groupFetchAllParticipating();
        let found = 0;
        for (const gid of Object.keys(groups)) {
            const metadata = groups[gid];
            for (const p of (metadata.participants || [])) {
                if (p.lid && p.jid && p.lid.endsWith('@lid')) {
                    const lidNum = p.lid.split('@')[0];
                    if (!store.lidToPhone.has(lidNum)) {
                        store.lidToPhone.set(lidNum, { phone: p.jid, name: null });
                        found++;
                    }
                }
            }
        }
        if (found > 0) console.log(`[LID] Grupos: ${found} mapeos extraídos, total: ${store.lidToPhone.size}`);
        else console.log(`[LID] Grupos: sin nuevos mapeos`);
    } catch (e) {
        console.error('[LID] Error extrayendo de grupos:', e.message);
    }
};

const getChatsFromStore = (session) => {
    const store = session.store;
    if (!store) return [];

    const chats = [];
    for (const [jid, chat] of store.chats) {
        const isIndividual = jid.endsWith('@s.whatsapp.net');
        const isGroup = jid.endsWith('@g.us');
        const isLid = jid.endsWith('@lid');
        if (!isIndividual && !isGroup && !isLid) continue;

        // 👇 NUEVO: excluir chats archivados (igual que WhatsApp Web los oculta de la lista principal)
        if (chat.archived === true) continue;

        const messages = store.messages.get(jid) || [];
        const hasReal = messages.some(m => hasRealContent(m));
        if (!hasReal && !isGroup) continue;
        if (!hasReal && messages.length === 0 && !chat.conversationTimestamp) continue;

        // 👇 FILTRO: solo chats donde TÚ escribiste al menos un mensaje
        // (ahora aplica también a grupos, según lo que necesitas)
        const hasSentByMe = messages.some(m => m.key?.fromMe && hasRealContent(m));
        if (!hasSentByMe) continue;

        const contact = store.contacts.get(jid);
        const realMsgs = messages.filter(m => hasRealContent(m));
        let lastMsg = null;
        if (realMsgs.length > 0) {
            lastMsg = realMsgs.reduce((latest, m) =>
                normalizeTimestamp(m.messageTimestamp) > normalizeTimestamp(latest.messageTimestamp) ? m : latest
            );
        }

        chats.push({
            id: jid,
            name: resolveChatName(jid, chat, contact, store),
            isGroup,
            unreadCount: chat.unreadCount || 0,
            timestamp: normalizeTimestamp(chat.conversationTimestamp),
            lastMessage: lastMsg?.message?.conversation
                || lastMsg?.message?.extendedTextMessage?.text
                || lastMsg?.message?.imageMessage?.caption
                || null
        });
    }

    chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return chats.slice(0, 20);
};

const createStore = (sock, sessionPath, sessionId) => {
    const store = {
        chats: new Map(),
        contacts: new Map(),
        messages: new Map(),
        lidMap: new Map(),
        lidPushNames: new Map(),
        lidToPhone: new Map()
    };

    bindStoreEvents(sock, store, sessionPath, sessionId);
    return store;
};

let persistTimers = new Map();

const schedulePersist = (store, storeFile) => {
    if (persistTimers.has(storeFile)) return;
    persistTimers.set(storeFile, setTimeout(() => {
        try {
            const data = {
                chats: [...store.chats.values()],
                contacts: [...store.contacts.values()],
                messages: Object.fromEntries(
                    [...store.messages.entries()].map(([jid, msgs]) => [jid, msgs.slice(-200)])
                ),
                lidPushNames: Object.fromEntries(store.lidPushNames.entries()),
                lidToPhone: Object.fromEntries(store.lidToPhone.entries())
            };
            fs.writeFileSync(storeFile, JSON.stringify(data));
        } catch (e) {
            console.error('[STORE] Error persistiendo:', e.message);
        }
        persistTimers.delete(storeFile);
    }, 3000));
};

const bindStoreEvents = (sock, store, sessionPath, sessionId) => {
    const storeFile = path.join(sessionPath, 'store.json');

    sock.ev.on('chats.upsert', (chats) => {
        for (const chat of chats) store.chats.set(chat.id, chat);
        console.log(`[STORE] chats.upsert: ${chats.length} (total: ${store.chats.size})`);
        schedulePersist(store, storeFile);
    });

    sock.ev.on('chats.update', (updates) => {
        for (const update of updates) {
            const chat = store.chats.get(update.id);
            if (chat) Object.assign(chat, update);
        }
        schedulePersist(store, storeFile);
    });

    sock.ev.on('contacts.upsert', (contacts) => {
        for (const contact of contacts) store.contacts.set(contact.id, contact);
        store.lidMap = buildLidMap(store.contacts);
        schedulePersist(store, storeFile);
    });

    sock.ev.on('contacts.update', (updates) => {
        for (const update of updates) {
            const contact = store.contacts.get(update.id);
            if (contact) Object.assign(contact, update);
        }
        store.lidMap = buildLidMap(store.contacts);
    });

    sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
        if (lid && jid) {
            const lidNum = lid.split('@')[0];
            store.lidToPhone.set(lidNum, { phone: jid, name: null });
            console.log(`[LID] phoneNumberShare: ${lidNum} → ${jid}`);
            schedulePersist(store, storeFile);
        }
    });

    const MAX_MSGS_PER_CHAT = 200;

    const upsertMsgToStore = (msg) => {
    const jid = msg.key.remoteJid;
    if (!store.messages.has(jid)) store.messages.set(jid, []);
    const chatMsgs = store.messages.get(jid);
    if (!chatMsgs.find(m => m.key.id === msg.key.id)) {
        chatMsgs.push(msg);
        if (chatMsgs.length > MAX_MSGS_PER_CHAT) {
            // 👇 ORDENAR por timestamp real antes de recortar, para conservar los más recientes
            const sorted = [...chatMsgs].sort(
                (a, b) => normalizeTimestamp(a.messageTimestamp) - normalizeTimestamp(b.messageTimestamp)
            );
            store.messages.set(jid, sorted.slice(-MAX_MSGS_PER_CHAT));
        }
    }
        if (jid.endsWith('@lid') && msg.pushName && !store.lidPushNames.has(jid.split('@')[0])) {
            store.lidPushNames.set(jid.split('@')[0], msg.pushName);
        }
        if (jid.endsWith('@lid') && !msg.key.fromMe && msg.key.senderPn) {
            const lidNum = jid.split('@')[0];
            if (!store.lidToPhone.has(lidNum)) {
                store.lidToPhone.set(lidNum, { phone: msg.key.senderPn, name: null });
                console.log(`[LID] lidToPhone from senderPn: ${lidNum} → ${msg.key.senderPn}`);
            }
        }
    };

    sock.ev.on('messages.upsert', ({ messages }) => {
        const s = sessions.get(sessionId);
        if (s) s.lastEventAt = Date.now();
        for (const msg of messages) {
            upsertMsgToStore(msg);
            if (msg.message?.protocolMessage?.type === 22) {
                try {
                    const syncMsg = msg.message.protocolMessage.lidMigrationMappingSyncMessage;
                    if (syncMsg?.encodedMappingPayload) {
                        const payload = proto.LIDMigrationMappingSyncPayload.decode(syncMsg.encodedMappingPayload);
                        const mappings = payload.pnToLidMappings || [];
                        let added = 0;
                        for (const mapping of mappings) {
                            const lidUser = String(mapping.assignedLid || mapping.latestLid || '');
                            const phone = String(mapping.pn || '');
                            if (lidUser && phone) {
                                if (!store.lidToPhone.has(lidUser)) {
                                    store.lidToPhone.set(lidUser, { phone: `${phone}@s.whatsapp.net`, name: null });
                                    added++;
                                }
                            }
                        }
                        if (added > 0) {
                            console.log(`[LID] MIGRATION_SYNC: ${added} nuevos mapeos de ${mappings.length}, total: ${store.lidToPhone.size}`);
                            schedulePersist(store, storeFile);
                        }
                    }
                } catch (e) {
                    console.error(`[LID] Error decodificando MIGRATION_SYNC:`, e.message);
                }
            }
        }
    });

    sock.ev.on('messages.update', (updates) => {
        for (const update of updates) {
            const jid = update.key.remoteJid;
            const chatMsgs = store.messages.get(jid) || [];
            const msg = chatMsgs.find(m => m.key.id === update.key.id);
            if (msg && update.update?.status !== undefined) {
                msg.status = update.update.status;
            }
        }
        schedulePersist(store, storeFile);
    });

    sock.ev.on('messaging-history.set', ({ chats: newChats, contacts: newContacts, messages: newMsgs }) => {
        console.log(`[HISTORY] ${newChats.length} chats, ${newContacts.length} contacts, ${newMsgs.length} messages recibidos`);
        let pnJidFound = 0;
        for (const chat of newChats) {
            store.chats.set(chat.id, chat);
            if (chat.pnJid && chat.id.endsWith('@lid')) {
                const lidNum = chat.id.split('@')[0];
                if (!store.lidToPhone.has(lidNum)) {
                    store.lidToPhone.set(lidNum, { phone: chat.pnJid, name: chat.name || null });
                    pnJidFound++;
                }
            }
        }
        if (pnJidFound > 0) console.log(`[LID] pnJid del historial: ${pnJidFound} mapeos`);
        for (const contact of newContacts) store.contacts.set(contact.id, contact);
        for (const msg of newMsgs) upsertMsgToStore(msg);
        store.lidMap = buildLidMap(store.contacts);
        buildLidToPhoneFromChats(store);
        const totalMsgs = Array.from(store.messages.values()).reduce((sum, arr) => sum + arr.length, 0);
        console.log(`[STORE] Store populado: ${store.chats.size} chats, ${store.contacts.size} contacts, ${totalMsgs} messages, lidMap: ${store.lidMap.size}, pushNames: ${store.lidPushNames.size}, lidToPhone: ${store.lidToPhone.size}`);
        schedulePersist(store, storeFile);
    });
};


const formatMessage = async (msg, sock, store) => {
    let body = '';
    let type = 'chat';
    let hasMedia = false;
    let isVoice = false;
    let media = null;

    let ack = msg.status;
    const ageMs = Date.now() - (normalizeTimestamp(msg.messageTimestamp) * 1000);

    // Si es mío, tiene 0/undefined/null y ya pasó tiempo, asumimos que se envió
    // (perdimos el ack real por una desconexión, pero seguro salió)
    if (msg.key?.fromMe && (ack === undefined || ack === null || ack === 0) && ageMs > 15000) {
    ack = 1;
    }
    if (ack === undefined || ack === null) {
    ack = 0;
    }

    const message = unwrapMessage(msg.message);

    if (message) {
        if (message.conversation) {
            body = message.conversation;
        } else if (message.extendedTextMessage) {
            body = message.extendedTextMessage.text;
        } else if (message.imageMessage) {
            body = message.imageMessage.caption || '';
            type = 'image';
            hasMedia = true;
        } else if (message.videoMessage) {
            body = message.videoMessage.caption || '';
            type = 'video';
            hasMedia = true;
        } else if (message.audioMessage) {
            type = 'audio';
            hasMedia = true;
            isVoice = !!message.audioMessage.ptt;
        } else if (message.documentMessage) {
            body = message.documentMessage.fileName || 'document';
            type = 'document';
            hasMedia = true;
        } else if (message.stickerMessage) {
            type = 'sticker';
            hasMedia = true;
        }
    }

    if (hasMedia && sock) {
        try {
            const downloadPromise = downloadMediaMessage(
                { key: msg.key, message },
                'buffer',
                {},
                { reuploadRequest: sock.updateMediaMessage, logger: pino({ level: 'silent' }) } // 👈 fix del logger conservado
            );
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000));
            const buffer = await Promise.race([downloadPromise, timeoutPromise]);

            if (buffer) {
                let mimetype = 'application/octet-stream';
                let filename = 'file';
                if (type === 'image') mimetype = message.imageMessage?.mimetype || 'image/jpeg';
                else if (type === 'video') mimetype = message.videoMessage?.mimetype || 'video/mp4';
                else if (type === 'audio') mimetype = message.audioMessage?.mimetype || 'audio/ogg';
                else if (type === 'document') {
                    mimetype = message.documentMessage?.mimetype || 'application/octet-stream';
                    filename = message.documentMessage?.fileName || 'document';
                } else if (type === 'sticker') mimetype = 'image/webp';

                media = {
                    mimetype,
                    data: buffer.toString('base64'),
                    filename
                };
            }
        } catch (e) {
            console.error(`[MEDIA] Error descargando media msg ${msg.key?.id}: ${e.message}`);
            media = null;
        }
    }

     let senderName = null;
    const jid = msg.key.remoteJid;
    if (jid?.endsWith('@g.us') && !msg.key.fromMe) {
        const participantJid = msg.key.participant || jid;
        const contact = store?.contacts?.get(participantJid);
        senderName = contact?.name || contact?.notify || msg.pushName
            || participantJid.split('@')[0];
    }


    return {
        id: msg.key?.id || '',
        body: body,
        type: type,
        timestamp: normalizeTimestamp(msg.messageTimestamp),
        from: msg.key?.remoteJid || '',
        fromMe: !!msg.key?.fromMe,
        hasMedia: hasMedia,
        media: media,
        ack: ack,
        isVoice: isVoice,
        senderName 
    };

    
};

app.get('/media/:sessionId/:chatId/:messageId', async (req, res) => {
    const { sessionId, chatId, messageId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ error: 'Sesión no lista' });
    }

    try {
        let finalId = chatId.includes('@') ? chatId : `${formatNumber(chatId)}@s.whatsapp.net`;
        if (finalId.endsWith('@lid') && session.store?.lidMap) {
            const resolved = resolveChatId(finalId, session.store);
            if (resolved !== finalId) finalId = resolved;
        }

        const storedMsgs = session.store.messages.get(finalId) || [];
        const msg = storedMsgs.find(m => m.key?.id === messageId);
        if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });

        const message = unwrapMessage(msg.message);
        const buffer = await downloadMediaMessage(
            { key: msg.key, message },
            'buffer',
            {},
            { reuploadRequest: session.sock.updateMediaMessage, logger: pino({ level: 'silent' }) }
        );

        let mimetype = 'application/octet-stream';
        let filename = 'file';
        if (message.imageMessage) mimetype = message.imageMessage.mimetype || 'image/jpeg';
        else if (message.videoMessage) mimetype = message.videoMessage.mimetype || 'video/mp4';
        else if (message.audioMessage) mimetype = message.audioMessage.mimetype || 'audio/ogg';
        else if (message.documentMessage) {
            mimetype = message.documentMessage.mimetype || 'application/octet-stream';
            filename = message.documentMessage.fileName || 'document';
        } else if (message.stickerMessage) mimetype = 'image/webp';

        res.json({
            success: true,
            mimetype,
            filename,
            data: buffer.toString('base64')
        });
    } catch (e) {
        console.error(`[MEDIA] Error descargando: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/session/reconnect/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Sesión no existe' });

    try {
        if (session.sock) {
            try { await session.sock.end(); } catch (e) {}
        }
        const sessionPath = path.join(AUTH_BASE_PATH, `session-${sessionId}`);
        const newGen = Date.now();
        session.gen = newGen;
        session.status = 'reconnecting';
        await createSessionSocket(sessionId, sessionPath, session, newGen, true);
        res.json({ success: true, message: 'Reconectando...' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
// === SOCKET FACTORY ===

const createSessionSocket = async (sessionId, sessionPath, sessionData, gen, isRetry = false) => {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();
    const hadCreds = !!state.creds?.me;
    console.log(`[DEBUG] Auth state cargado para ${sessionId}, creds existentes: ${hadCreds}, isRetry: ${isRetry}`);

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false,
        browser: ['Meerkadito', 'Desktop', '4.0.0'],
        generateHighQualityLinkPreview: false,
        syncFullHistory: true,
        markOnlineOnConnect: false,
        logger: pino({ level: 'silent' })
    });

    sessionData.sock = sock;

    const storeFile = path.join(sessionPath, 'store.json');
    if (fs.existsSync(storeFile)) {
        try {
            const saved = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
            const loadedStore = { chats: new Map(), contacts: new Map(), messages: new Map(), lidMap: new Map(), lidPushNames: new Map(), lidToPhone: new Map() };
            for (const chat of saved.chats) loadedStore.chats.set(chat.id, chat);
            for (const contact of saved.contacts) loadedStore.contacts.set(contact.id, contact);
            if (saved.messages) {
                for (const [jid, msgs] of Object.entries(saved.messages)) {
                    loadedStore.messages.set(jid, msgs);
                }
            }
            if (saved.lidPushNames) {
                for (const [lid, name] of Object.entries(saved.lidPushNames)) {
                    loadedStore.lidPushNames.set(lid, name);
                }
            }
            if (saved.lidToPhone) {
                for (const [lid, data] of Object.entries(saved.lidToPhone)) {
                    loadedStore.lidToPhone.set(lid, data);
                }
            }
            loadedStore.lidMap = buildLidMap(loadedStore.contacts);
            buildLidToPhoneFromChats(loadedStore);
            sessionData.store = loadedStore;
            const totalMsgs = Array.from(loadedStore.messages.values()).reduce((s, a) => s + a.length, 0);
            console.log(`[STORE] Cargados ${loadedStore.chats.size} chats, ${loadedStore.contacts.size} contacts, ${totalMsgs} messages, lidMap: ${loadedStore.lidMap.size}, pushNames: ${loadedStore.lidPushNames.size}, lidToPhone: ${loadedStore.lidToPhone.size} desde disco`);
            bindStoreEvents(sock, loadedStore, sessionPath, sessionId);
        } catch (e) {
            console.error('[STORE] Error cargando store desde disco:', e.message);
            sessionData.store = createStore(sock, sessionPath, sessionId);
        }
    } else {
        sessionData.store = createStore(sock, sessionPath, sessionId);
    }

    console.log(`[DEBUG] Socket creado para ${sessionId}, gen=${gen}`);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const current = sessions.get(sessionId);
        if (!current || current.gen !== gen) {
            console.log(`[DEBUG] connection.update ignorado para ${sessionId} (gen mismatch o sesión eliminada)`);
            return;
        }
        current.lastEventAt = Date.now();
        const { connection, lastDisconnect, qr } = update;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[DEBUG] connection.update para ${sessionId}: connection=${connection}, qr=${!!qr}, statusCode=${statusCode}`);

        if (qr) {
            try {
                const qrImageBase64 = await QRCode.toDataURL(qr, {
                    errorCorrectionLevel: 'H',
                    type: 'image/png',
                    width: 400,
                    margin: 1
                });
                current.qr = qr;
                current.qrBase64 = qrImageBase64.replace(/^data:image\/png;base64,/, '');
                current.status = 'qr_generated';
                console.log(' QR generado para:', sessionId);
            } catch (err) {
                console.error('Error generando QR:', err);
            }
        }

        if (connection === 'open') {
            console.log(' Cliente WhatsApp listo:', sessionId);
            console.log(`[DEBUG] connection=open para ${sessionId}: user=${sock.user?.id}, name=${sock.user?.name}, ws=${sock.ws?.readyState}`);
            current.status = 'ready';
            current.qr = null;
            current.qrBase64 = null;
            current.info = {
                wid: sock.user?.id || '',
                pushname: sock.user?.name || ''
            };
            if (current.store) {
                setTimeout(() => extractLidsFromGroups(sock, current.store), 5000);
                setTimeout(() => resolveLidsViaUSync(sock, current.store), 10000);
                setTimeout(() => resolveNamesViaUSync(sock, current.store), 15000);
            }
        }

        if (connection === 'close') {
            console.log(` Conexión cerrada. Razón: ${DisconnectReason[statusCode] || statusCode}`);

            if (statusCode === DisconnectReason.loggedOut) {
                if (hadCreds && !isRetry) {
                    console.log(' Credenciales stale detectadas, limpiando y reintentando sin auth...');
                    current.status = 'reconnecting';
                    current.qr = null;
                    current.qrBase64 = null;
                    try { await sock.end(); } catch (e) {}
                    await deleteSessionFolder(sessionPath);
                    fs.mkdirSync(sessionPath, { recursive: true });
                    const newGen = Date.now();
                    current.gen = newGen;
                    try {
                        await createSessionSocket(sessionId, sessionPath, current, newGen, true);
                    } catch (err) {
                        console.error(`[ERROR] Error reintentando con auth limpio para ${sessionId}:`, err.message);
                        current.status = 'disconnected';
                    }
                } else {
                    console.log(' Sesión cerrada desde el celular, eliminando...');
                    current.status = 'logged_out';
                    current.qr = null;
                    current.qrBase64 = null;
                    current.info = null;
                    try { await sock.end(); } catch (e) {}
                    sessions.delete(sessionId);
                    await deleteSessionFolder(sessionPath);
                    console.log(' Carpeta eliminada');
                }
            } else if (statusCode === DisconnectReason.restartRequired) {
                console.log(` 515 restartRequired - Reiniciando socket para ${sessionId}...`);
                current.status = 'reconnecting';
                current.qr = null;
                current.qrBase64 = null;
                try { await sock.end(); } catch (e) {}
                await new Promise(resolve => setTimeout(resolve, 1500));
                const newGen = Date.now();
                current.gen = newGen;
                try {
                    await createSessionSocket(sessionId, sessionPath, current, newGen, true);
                } catch (err) {
                    console.error(`[ERROR] Error reiniciando socket para ${sessionId}:`, err.message);
                    current.status = 'disconnected';
                }
            } else {
                console.log(` Conexión perdida (statusCode: ${statusCode}), reconectando en 3s...`);
                current.status = 'reconnecting';
                current.qr = null;
                current.qrBase64 = null;
                try { await sock.end(); } catch (e) {}
                await new Promise(resolve => setTimeout(resolve, 3000));
                const newGen = Date.now();
                current.gen = newGen;
                try {
                    await createSessionSocket(sessionId, sessionPath, current, newGen, true);
                } catch (err) {
                    console.error(`[ERROR] Error reconectando ${sessionId}:`, err.message);
                    current.status = 'disconnected';
                }
            }
        }
    });

    return sock;
};

// === ENDPOINTS ===

app.post('/session/start/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    console.log(' Iniciando sesión para:', sessionId);

    if (sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        if (session.status === 'initializing') {
            return res.status(429).json({ success: false, message: 'Inicializando, por favor espere...', status: 'initializing' });
        }
        if (session.status === 'ready') {
            return res.json({ success: true, message: 'Sesión activa', status: session.status, info: session.info });
        }
        try {
            if (session.sock) await session.sock.end();
        } catch (e) {}
        await new Promise(resolve => setTimeout(resolve, 1000));
        sessions.delete(sessionId);
    }

    const sessionPath = path.join(AUTH_BASE_PATH, `session-${sessionId}`);
    fs.mkdirSync(sessionPath, { recursive: true });

    const gen = Date.now();
    const sessionData = {
        gen: gen,
        sock: null,
        status: 'initializing',
        qr: null,
        qrBase64: null,
        info: null,
        lastEventAt: Date.now()
    };
    sessions.set(sessionId, sessionData);

    try {
        await createSessionSocket(sessionId, sessionPath, sessionData, gen);
        res.json({ success: true, message: 'Iniciando...', sessionId, status: 'initializing' });
    } catch (error) {
        console.error(' Error creando sesión:', error);
        sessions.delete(sessionId);
        await deleteSessionFolder(sessionPath);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/session/health/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({
            healthy: false,
            status: 'not_found',
            message: 'Sesión no existe',
            needsReconnect: true
        });
    }

    if (session.status === 'logged_out') {
        return res.json({
            healthy: false,
            status: 'logged_out',
            message: 'Sesión cerrada desde el dispositivo',
            needsReconnect: true
        });
    }

    if (session.status !== 'ready') {
        return res.json({
            healthy: false,
            status: session.status,
            message: session.status === 'reconnecting' ? 'Reconectando...' : 'Sesión no está lista',
            needsReconnect: session.status === 'disconnected'
        });
    }

    const wsState = session.sock?.ws?.readyState;
    const hasUser = !!session.sock?.user;
    console.log(`[DEBUG] Health check ${sessionId}: ws.readyState=${wsState}, hasUser=${hasUser}, status=${session.status}`);
    if (!hasUser) {
        return res.json({
            healthy: false,
            status: 'disconnected',
            message: 'WebSocket no conectado',
            needsReconnect: true
        });
    }

    return res.json({
        healthy: true,
        status: 'ready',
        message: 'Sesión activa y saludable',
        info: session.info
    });
});

app.get('/session/qr/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'No existe sesión activa' });
    res.json({
        success: true,
        qr: session.qr,
        base64: session.qrBase64,
        status: session.status,
        connected: session.status === 'ready',
        info: session.info
    });
});

app.get('/session/status/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'No existe sesión activa' });
    res.json({
        success: true,
        status: session.status,
        connected: session.status === 'ready',
        info: session.info
    });
});

app.post('/session/close/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    const sessionPath = path.join(AUTH_BASE_PATH, `session-${sessionId}`);

    sessions.delete(sessionId);

    if (session && session.sock) {
        try {
            console.log(` Cerrando sesión ${sessionId}...`);
            await session.sock.end();
        } catch (e) {
            console.error('Error al cerrar:', e.message);
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    for (let i = 0; i < 3; i++) {
        const deleted = await deleteSessionFolder(sessionPath);
        if (deleted) break;
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    res.json({ success: true, message: 'Sesión cerrada y limpiada' });
});

app.get('/chats/:sessionId', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ error: 'Sesión no lista' });
    }

    const startTime = Date.now();
    console.log(' Obteniendo chats para:', req.params.sessionId);

    try {
        let chats = getChatsFromStore(session);
        console.log(`[DEBUG] Chats en store para ${req.params.sessionId}: ${chats.length}`);

        const chatsWithPics = await Promise.all(
            chats.map(async (chat) => {
                let profilePic = null;
                if (!chat.isGroup) {
                    const picJid = chat.id.endsWith('@lid') && session.store?.lidMap
                        ? resolveChatId(chat.id, session.store)
                        : chat.id;
                    profilePic = await getProfilePicWithTimeout(session.sock, picJid);
                }
                return { ...chat, profilePic };
            })
        );

        const endTime = Date.now();
        console.log(` Chats obtenidos en ${endTime - startTime}ms`);
        res.json({ success: true, chats: chatsWithPics });
    } catch (error) {
        console.error('Error obteniendo chats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/messages/:sessionId/:chatId', async (req, res) => {
    const { sessionId, chatId } = req.params;
    const limit = parseInt(req.query.limit) || 20;

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ error: 'Sesión no lista' });
    }

    try {
        let finalId = chatId.includes('@') ? chatId : `${formatNumber(chatId)}@s.whatsapp.net`;
        if (finalId.endsWith('@lid') && session.store?.lidMap) {
            const resolved = resolveChatId(finalId, session.store);
            if (resolved !== finalId) {
                console.log(`[DEBUG] @lid ${finalId} resuelto a ${resolved}`);
                finalId = resolved;
            }
        }
        let messages = [];

            if (session.store) {
            const storedMsgs = session.store.messages.get(finalId) || [];
            const realMsgs = storedMsgs.filter(m => hasRealContent(m));
            const sortedMsgs = [...realMsgs].sort(
                (a, b) => normalizeTimestamp(a.messageTimestamp) - normalizeTimestamp(b.messageTimestamp)
            );
            messages = sortedMsgs.slice(-limit);
        }

        if (messages.length === 0 && session.sock) {
            try {
                console.log(`[DEBUG] Messages vacíos para ${finalId}, solicitando historial al teléfono...`);
                const chat = session.store?.chats.get(finalId);
                const oldestTs = chat?.conversationTimestamp
                    ? (typeof chat.conversationTimestamp === 'number' && chat.conversationTimestamp < 1e12
                        ? chat.conversationTimestamp * 1000
                        : chat.conversationTimestamp)
                    : Date.now();

                const msgsPromise = new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        session.sock.ev.off('messages.upsert', handler);
                        session.sock.ev.off('messaging-history.set', historyHandler);
                        resolve([]);
                    }, 5000);

                    const handler = ({ messages: newMsgs }) => {
                        const chatMsgs = newMsgs.filter(m => m.key.remoteJid === finalId);
                        if (chatMsgs.length > 0) {
                            clearTimeout(timeout);
                            session.sock.ev.off('messages.upsert', handler);
                            session.sock.ev.off('messaging-history.set', historyHandler);
                            resolve(chatMsgs);
                        }
                    };

                    const historyHandler = ({ messages: newMsgs }) => {
                        const chatMsgs = newMsgs.filter(m => m.key.remoteJid === finalId);
                        if (chatMsgs.length > 0) {
                            clearTimeout(timeout);
                            session.sock.ev.off('messages.upsert', handler);
                            session.sock.ev.off('messaging-history.set', historyHandler);
                            resolve(chatMsgs);
                        }
                    };

                    session.sock.ev.on('messages.upsert', handler);
                    session.sock.ev.on('messaging-history.set', historyHandler);
                });

                await session.sock.fetchMessageHistory(
                    limit,
                    { remoteJid: finalId, fromMe: false, id: '' },
                    oldestTs
                );

                messages = await msgsPromise;
                console.log(`[DEBUG] fetchMessageHistory devolvió ${messages.length} messages para ${finalId}`);
            } catch (e) {
                console.error('[DEBUG] fetchMessageHistory error:', e.message);
            }
        }

        console.log(`[DEBUG] /messages ${finalId}: ${messages.length} mensajes encontrados`);
        const formatted = await Promise.all(messages.map(msg => formatMessage(msg, session.sock, session.store)));
        res.json({ success: true, messages: formatted });

    } catch (e) {
        console.error('Error en mensajes:', e);
        res.json({ success: false, messages: [], error: e.message });
    }
});

app.post('/check-number', async (req, res) => {
    const { sessionId, phone } = req.body;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'ready') return res.status(400).json({ error: 'Sesión no lista' });

    try {
        const formatted = formatNumber(phone);
        const [result] = await session.sock.onWhatsApp(`${formatted}@s.whatsapp.net`);
        res.json({
            success: true,
            exists: result?.exists || false,
            id: result?.exists ? `${formatted}@s.whatsapp.net` : null,
            formattedNumber: formatted
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/send-message', async (req, res) => {
    const { sessionId, session: sessAlt, number, phone, message } = req.body;
    const targetSession = sessionId || sessAlt;
    const targetPhone = number || phone;

    if (!targetSession || !targetPhone || !message) {
        return res.status(400).json({ success: false, error: 'Faltan parámetros' });
    }

    const currSession = sessions.get(targetSession);
    if (!currSession || currSession.status !== 'ready') {
        return res.status(400).json({ success: false, error: 'Sesión no conectada' });
    }

    try {
        let chatId = targetPhone;
        if (!chatId.includes('@')) {
            chatId = `${formatNumber(chatId)}@s.whatsapp.net`;
        }
        if (chatId.endsWith('@lid') && currSession.store?.lidMap) {
            const resolved = resolveChatId(chatId, currSession.store);
            if (resolved !== chatId) {
                console.log(`[DEBUG] send @lid ${chatId} resuelto a ${resolved}`);
                chatId = resolved;
            }
        }

        console.log(` Enviando a ${chatId} vía ${targetSession}`);
        const sent = await currSession.sock.sendMessage(chatId, { text: message });

        res.json({
            success: true,
            message: 'Enviado correctamente',
            id: sent.key?.id || '',
            timestamp: sent.messageTimestamp || Date.now()
        });

    } catch (e) {
        console.error(' Error al enviar:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/send-media', async (req, res) => {
    const { sessionId, phone, file, mimetype, filename, caption } = req.body;

    if (!sessionId || !phone || !file || !mimetype) {
        return res.status(400).json({ success: false, error: 'Datos incompletos' });
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ success: false, error: 'Sesión no lista' });
    }

    try {
        let chatId = phone.includes('@') ? phone : `${formatNumber(phone)}@s.whatsapp.net`;
        if (chatId.endsWith('@lid') && session.store?.lidMap) {
            const resolved = resolveChatId(chatId, session.store);
            if (resolved !== chatId) chatId = resolved;
        }
        const buffer = Buffer.from(file, 'base64');
        let messageContent;

        if (mimetype.startsWith('image/')) {
            messageContent = { image: buffer, caption: caption || '' };
        } else if (mimetype.startsWith('video/')) {
            messageContent = { video: buffer, caption: caption || '' };
        } else if (mimetype.startsWith('audio/')) {
            messageContent = { audio: buffer, mimetype: mimetype };
        } else {
            messageContent = { document: buffer, mimetype: mimetype, fileName: filename || 'file' };
        }

        const sentMessage = await session.sock.sendMessage(chatId, messageContent);

        res.json({
            success: true,
            message: 'Archivo enviado',
            messageId: sentMessage.key?.id || ''
        });

    } catch (e) {
        console.error(' [SEND-MEDIA] Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

const cleanup = async () => {
    console.log('\n Cerrando servidor...');
    for (const [sessionId, session] of sessions) {
        if (session.sock) {
            console.log(` Cerrando sesión: ${sessionId}`);
            try {
                await session.sock.end();
            } catch (e) {
                console.error(`Error cerrando ${sessionId}:`, e.message);
            }
        }
    }
    process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

setInterval(() => {
    const IDLE_LIMIT = 10 * 60 * 1000; // 10 min sin ningún evento real
    for (const [sessionId, session] of sessions) {
        if (session.status !== 'ready') continue;
        const hasUser = !!session.sock?.user;
        const idleTime = Date.now() - (session.lastEventAt || 0);

        if (!hasUser || idleTime > IDLE_LIMIT) {
            console.log(`[WATCHDOG] ${sessionId} posible zombie (user:${hasUser}, idle:${Math.round(idleTime/1000)}s), forzando reconexión`);
            session.status = 'reconnecting';
            const newGen = Date.now();
            session.gen = newGen;
            try { session.sock?.end(); } catch (e) {}
            createSessionSocket(sessionId, path.join(AUTH_BASE_PATH, `session-${sessionId}`), session, newGen, true)
                .catch(e => console.error(`[WATCHDOG] reconexión falló para ${sessionId}:`, e.message));
        }
    }
}, 2 * 60 * 1000);

app.listen(PORT, () => {
    console.log(` Servidor WhatsApp corriendo en puerto: ${PORT}`);
});
