const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, proto, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Client: WWJClient, LocalAuth: WWJLocalAuth, MessageMedia } = require('whatsapp-web.js');
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
    console.error(' Excepcion no capturada:', error);
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
const WWJS_AUTH_PATH = path.resolve(__dirname, '..', 'wwebjs_auth');
const CONTACTS_CACHE_DIR = path.resolve(__dirname, '..', 'contacts_cache');

console.log(' Iniciando Servidor WhatsApp Web API (Baileys + wweb.js contacts)');
console.log(' Ruta auth:', AUTH_BASE_PATH);

if (!fs.existsSync(AUTH_BASE_PATH)) {
    fs.mkdirSync(AUTH_BASE_PATH, { recursive: true });
}
if (!fs.existsSync(WWJS_AUTH_PATH)) {
    fs.mkdirSync(WWJS_AUTH_PATH, { recursive: true });
}
if (!fs.existsSync(CONTACTS_CACHE_DIR)) {
    fs.mkdirSync(CONTACTS_CACHE_DIR, { recursive: true });
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

const profilePicCache = new Map();

const getProfilePicWithTimeout = async (sock, jid) => {
    const cached = profilePicCache.get(jid);
    if (cached && Date.now() - cached.time < 300000) return cached.url;
    try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1000));
        const picPromise = sock.profilePictureUrl(jid, 'image');
        const url = await Promise.race([picPromise, timeout]);
        profilePicCache.set(jid, { url, time: Date.now() });
        return url;
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
    return Math.floor(Date.now() / 1000);
};

const hasRealContent = (msg) => {
    if (!msg?.message || typeof msg.message !== 'object') return false;
    const realMessage = unwrapMessage(msg.message);
    const keys = Object.keys(realMessage);
    if (keys.length === 0) return false;
    const ignoredTypes = [
        'reactionMessage', 'protocolMessage', 'senderKeyDistributionMessage',
        'pollUpdateMessage', 'messageContextInfo',
    ];
    const visibleKeys = keys.filter(k => !ignoredTypes.includes(k));
    return visibleKeys.length > 0;
};

const unwrapMessage = (message) => {
    if (!message || typeof message !== 'object') return message;
    const wrapperKeys = [
        'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
        'viewOnceMessageV2Extension', 'deviceSentMessage', 'documentWithCaptionMessage',
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
            const lidContact = contacts.get(contact.lid);
            const resolvedName = contact.name || contact.notify || lidContact?.name || lidContact?.notify || null;
            lidMap.set(lidNum, { name: resolvedName, phone: contact.id });
        }
    }
    return lidMap;
};

const buildPhoneToContact = (contacts, lidToPhone) => {
    const phoneToContact = new Map();
    for (const [id, contact] of contacts) {
        if (!id.endsWith('@s.whatsapp.net')) continue;
        const name = contact.name || contact.notify || contact.verifiedName || null;
        if (name) {
            phoneToContact.set(id, { ...contact, name });
        }
    }
    for (const [lidNum, data] of lidToPhone) {
        if (data.phone && !phoneToContact.has(data.phone)) {
            const existing = contacts.get(data.phone);
            const name = data.name || existing?.name || existing?.notify || existing?.verifiedName || null;
            if (name) {
                phoneToContact.set(data.phone, { id: data.phone, name });
            }
        }
    }
    return phoneToContact;
};

const searchContactByPhone = (jid, store) => {
    if (!jid.endsWith('@s.whatsapp.net')) return null;
    for (const [, contact] of store.contacts) {
        if (contact.id === jid && (contact.name || contact.notify)) {
            return contact.name || contact.notify;
        }
    }
    return null;
};

const loadContactsCache = (sessionId) => {
    const cacheFile = path.join(CONTACTS_CACHE_DIR, `${sessionId}.json`);
    if (!fs.existsSync(cacheFile)) return new Map();
    try {
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        const map = new Map();
        for (const [key, value] of Object.entries(data.contacts || {})) {
            map.set(key, value);
        }
        console.log(`[CONTACTS-CACHE] Cargado: ${map.size} contactos (${data.fetchedAt || 'sin fecha'})`);
        return map;
    } catch (e) {
        console.error('[CONTACTS-CACHE] Error cargando:', e.message);
        return new Map();
    }
};

const saveContactsCache = (sessionId, contactsMap) => {
    const cacheFile = path.join(CONTACTS_CACHE_DIR, `${sessionId}.json`);
    const data = {
        sessionId,
        fetchedAt: new Date().toISOString(),
        contacts: Object.fromEntries(contactsMap)
    };
    try {
        fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2));
        console.log(`[CONTACTS-CACHE] Guardado: ${contactsMap.size} contactos`);
    } catch (e) {
        console.error('[CONTACTS-CACHE] Error guardando:', e.message);
    }
};

const startContactsSync = async (sessionId) => {
    console.log(`[WWJS-CONTACTS] Iniciando cliente whatsapp-web.js para obtener contactos...`);

    const session = sessions.get(sessionId);
    if (!session) throw new Error('Sesion no existe');

    if (session.wwjsClient) {
        try { await session.wwjsClient.destroy(); } catch (e) {}
        session.wwjsClient = null;
    }

    const isDocker = fs.existsSync('/.dockerenv');
    const defaultChromePath = isDocker
        ? '/usr/bin/chromium'
        : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

    const client = new WWJClient({
        authStrategy: new WWJLocalAuth({
            clientId: `${sessionId}_contacts`,
            dataPath: WWJS_AUTH_PATH
        }),
        webVersionCache: {
            type: 'none',
        },
        puppeteer: {
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || defaultChromePath,
            args: isDocker
                ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--disable-gpu']
                : ['--disable-gpu', '--disable-dev-shm-usage', '--no-first-run']
        }
    });

    session.wwjsClient = client;
    session.contactsSyncStatus = 'qr_ready';
    session.contactsQr = null;

    let syncTimeout = setTimeout(() => {
        console.log('[WWJS-CONTACTS] Timeout 5min, limpiando...');
        session.contactsSyncStatus = 'timeout';
        try { client.destroy(); } catch (e) {}
    }, 5 * 60 * 1000);

    client.on('qr', async (qr) => {
        try {
            const qrBase64 = await QRCode.toDataURL(qr, {
                errorCorrectionLevel: 'M', type: 'image/png', width: 300, margin: 1
            });
            const qrData = qrBase64.replace(/^data:image\/png;base64,/, '');
            console.log(`[WWJS-CONTACTS] QR actualizado. Escanealo para sincronizar contactos.`);
            session.contactsQr = qrData;
            session.contactsSyncStatus = 'qr_ready';
        } catch (err) {
            console.error('[WWJS-CONTACTS] Error generando QR:', err.message);
        }
    });

    client.on('ready', async () => {
        console.log('[WWJS-CONTACTS] Cliente listo, obteniendo contactos...');
        session.contactsSyncStatus = 'fetching';
        clearTimeout(syncTimeout);
        try {
            const contacts = await client.getContacts();
            const contactsMap = new Map();
            for (const c of contacts) {
                const id = c.id?._serialized || c.id || '';
                const name = c.name || c.pushname || null;
                if (id && name) {
                    const entry = {
                        id,
                        name,
                        pushname: c.pushname || null,
                        isBusiness: c.isBusiness || false,
                        isMyContact: c.isMyContact || false
                    };
                    contactsMap.set(id, entry);
                    if (id.endsWith('@c.us')) {
                        const sWid = id.replace('@c.us', '@s.whatsapp.net');
                        contactsMap.set(sWid, entry);
                        const phone = id.replace('@c.us', '');
                        contactsMap.set(phone, entry);
                    }
                }
            }
            console.log(`[WWJS-CONTACTS] ${contactsMap.size} contactos con nombre de ${contacts.length} total`);

            saveContactsCache(sessionId, contactsMap);

            if (sessions.has(sessionId)) {
                sessions.get(sessionId).contactsSyncStatus = 'completed';
                sessions.get(sessionId).contactsQr = null;
                sessions.get(sessionId).contactsCache = contactsMap;
                if (sessions.get(sessionId).store) {
                    sessions.get(sessionId).store.contactsWwebjs = contactsMap;
                }
            }
        } catch (e) {
            console.error('[WWJS-CONTACTS] Error obteniendo contactos:', e.message);
            if (sessions.has(sessionId)) {
                sessions.get(sessionId).contactsSyncStatus = 'error';
            }
        } finally {
            clearTimeout(syncTimeout);
            try { await client.destroy(); } catch (e) {}
            session.wwjsClient = null;
        }
    });

    client.on('auth_failure', (msg) => {
        console.error('[WWJS-CONTACTS] Auth failure:', msg);
        clearTimeout(syncTimeout);
        session.contactsSyncStatus = 'auth_failure';
        session.wwjsClient = null;
    });

    client.on('disconnected', (reason) => {
        console.log('[WWJS-CONTACTS] Desconectado:', reason);
        clearTimeout(syncTimeout);
        if (session.contactsSyncStatus !== 'completed') {
            session.contactsSyncStatus = 'disconnected';
        }
        session.wwjsClient = null;
    });

    client.initialize().catch(e => {
        console.error('[WWJS-CONTACTS] Error inicializando:', e.message);
        clearTimeout(syncTimeout);
        session.contactsSyncStatus = 'error';
        session.wwjsClient = null;
    });

    return null;
};

const formatPhoneDisplay = (jidOrNumber) => {
    let num = jidOrNumber;
    if (num.includes('@')) num = num.split('@')[0];
    if (!num.startsWith('+')) num = '+' + num;
    const digits = num.substring(1);
    let result = '+';
    for (let i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0) result += ' ';
        result += digits[i];
    }
    return result;
};

const resolveChatName = (jid, chat, contact, store) => {
    if (chat.name) return chat.name;
    if (chat.notify) return chat.notify;
    if (contact?.name) return contact.name;
    if (contact?.notify) return contact.notify;

    if (jid.endsWith('@s.whatsapp.net') && store?.phoneToContact) {
        const phoneContact = store.phoneToContact.get(jid);
        if (phoneContact?.name) return phoneContact.name;
        if (phoneContact?.notify) return phoneContact.notify;
    }

    if (store?.contactsWwebjs) {
        const wwebContact = store.contactsWwebjs.get(jid);
        if (wwebContact?.name) return wwebContact.name;
        if (wwebContact?.pushname) return wwebContact.pushname;
    }

    if (jid.endsWith('@s.whatsapp.net') && store?.contactsWwebjs) {
        const num = jid.split('@')[0];
        const byPhone = store.contactsWwebjs.get(num);
        if (byPhone?.name) return byPhone.name;
    }

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
            return formatPhoneDisplay(phoneMapping.phone);
        }
        if (store?.lidMap) {
            for (const mapped of store.lidMap.values()) {
                if (mapped.phone && mapped.lid === lidNum) return formatPhoneDisplay(mapped.phone);
            }
        }
        return '+' + lidNum;
    }

    if (jid.endsWith('@s.whatsapp.net')) {
        const num = jid.split('@')[0];
        const pushName = store?.lidPushNames?.get(num);
        if (pushName) return pushName;
        const directContact = store?.contacts?.get(jid);
        if (directContact?.name) return directContact.name;
        if (directContact?.notify) return directContact.notify;
        if (directContact?.verifiedName) return directContact.verifiedName;
        const searched = searchContactByPhone(jid, store);
        if (searched) return searched;
    }

    const messages = store?.messages?.get(jid) || [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.pushName && hasRealContent(m)) return m.pushName;
    }

    if (jid.endsWith('@s.whatsapp.net')) {
        const num = jid.split('@')[0];
        return formatPhoneDisplay(num);
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
    if (unresolvedLids.length === 0) return;
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
                            const name = item.contact?.name || item.contact?.notify || null;
                            store.lidToPhone.set(lidNum, { phone: item.id, name });
                            if (name && store.contacts.has(item.id)) {
                                const c = store.contacts.get(item.id);
                                if (!c.name) c.name = name;
                            }
                            if (name && store.phoneToContact) {
                                store.phoneToContact.set(item.id, { id: item.id, name });
                            }
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

const resolveMissingNames = async (sock, store) => {
    const missing = [];
    for (const [jid, chat] of store.chats) {
        if (!jid.endsWith('@s.whatsapp.net')) continue;
        const contact = store.contacts.get(jid);
        const resolved = resolveChatName(jid, chat, contact, store);
        if (/^\+?\d+$/.test(resolved) || resolved === 'Desconocido') {
            missing.push(jid);
        }
    }
    if (missing.length === 0) {
        console.log('[NAMES] Todos los contactos tienen nombre');
        return;
    }
    console.log(`[NAMES] Buscando nombres de ${missing.length} contactos via fetchProfile...`);

    for (const jid of missing) {
        try {
            const profile = await sock.fetchProfile(jid);
            const name = profile?.pushName || profile?.verifiedName || null;
            if (name) {
                const entry = { id: jid, name, notify: name };
                store.contacts.set(jid, { ...store.contacts.get(jid), name, notify: name });
                if (store.phoneToContact) {
                    store.phoneToContact.set(jid, entry);
                }
                if (store.contactsWwebjs) {
                    store.contactsWwebjs.set(jid, entry);
                    const phone = jid.replace('@s.whatsapp.net', '');
                    store.contactsWwebjs.set(phone, entry);
                }
                console.log(`[NAMES] ${jid} -> ${name}`);
            } else {
                console.log(`[NAMES] ${jid} -> sin nombre en perfil`);
            }
        } catch (e) {
            console.log(`[NAMES] ${jid} -> error: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    const stillMissing = store.chats.size > 0
        ? [...store.chats.keys()].filter(j => {
            if (!j.endsWith('@s.whatsapp.net')) return false;
            const r = resolveChatName(j, store.chats.get(j), store.contacts.get(j), store);
            return /^\+?\d+$/.test(r);
        }).length
        : 0;
    console.log(`[NAMES] Completado. Sin nombre: ${stillMissing}`);
};

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
        if (found > 0) console.log(`[LID] Grupos: ${found} mapeos extraidos`);
    } catch (e) {
        console.error('[LID] Error extrayendo de grupos:', e.message);
    }
};

const getChatsFromStore = (session, limit = 30, offset = 0) => {
    const store = session.store;
    if (!store) return { chats: [], total: 0 };

    const chats = [];
    for (const [jid, chat] of store.chats) {
        const isIndividual = jid.endsWith('@s.whatsapp.net');
        const isGroup = jid.endsWith('@g.us');
        const isLid = jid.endsWith('@lid');
        if (!isIndividual && !isGroup && !isLid) continue;
        if (chat.archived === true) continue;

        const messages = store.messages.get(jid) || [];
        const hasReal = messages.some(m => hasRealContent(m));
        if (!hasReal && !isGroup) continue;
        if (!hasReal && messages.length === 0 && !chat.conversationTimestamp) continue;

        const contact = store.contacts.get(jid);
        const realMsgs = messages.filter(m => hasRealContent(m));
        let lastMsg = null;
        if (realMsgs.length > 0) {
            lastMsg = realMsgs.reduce((latest, m) =>
                normalizeTimestamp(m.messageTimestamp) > normalizeTimestamp(latest.messageTimestamp) ? m : latest
            );
        }

        const resolvedName = resolveChatName(jid, chat, contact, store);
        chats.push({
            id: jid,
            name: resolvedName,
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
    const total = chats.length;

    if (chats.length > 0) {
        const named = chats.filter(c => !c.name.match(/^\+?\d+$/) && c.name !== 'Desconocido').length;
        const numeric = chats.length - named;
        console.log(`[NAMES-DEBUG] ${named} con nombre, ${numeric} como numero de ${total} total, contactsWwebjs: ${store.contactsWwebjs?.size || 0}`);
    }

    return { chats: chats.slice(offset, offset + limit), total };
};

const createStore = (sock, sessionPath, sessionId) => {
    const store = {
        chats: new Map(),
        contacts: new Map(),
        messages: new Map(),
        lidMap: new Map(),
        lidPushNames: new Map(),
        lidToPhone: new Map(),
        phoneToContact: new Map(),
        contactsWwebjs: loadContactsCache(sessionId)
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
        store.phoneToContact = buildPhoneToContact(store.contacts, store.lidToPhone);
        schedulePersist(store, storeFile);
    });

    sock.ev.on('contacts.update', (updates) => {
        for (const update of updates) {
            const contact = store.contacts.get(update.id);
            if (contact) {
                const merged = { ...contact, ...update };
                if (!update.name && contact.name) merged.name = contact.name;
                if (!update.notify && contact.notify) merged.notify = contact.notify;
                if (!update.verifiedName && contact.verifiedName) merged.verifiedName = contact.verifiedName;
                store.contacts.set(update.id, merged);
            } else {
                store.contacts.set(update.id, update);
            }
        }
        store.lidMap = buildLidMap(store.contacts);
        store.phoneToContact = buildPhoneToContact(store.contacts, store.lidToPhone);
    });

    sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
        if (lid && jid) {
            const lidNum = lid.split('@')[0];
            store.lidToPhone.set(lidNum, { phone: jid, name: null });
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
                const sorted = [...chatMsgs].sort(
                    (a, b) => normalizeTimestamp(a.messageTimestamp) - normalizeTimestamp(b.messageTimestamp)
                );
                store.messages.set(jid, sorted.slice(-MAX_MSGS_PER_CHAT));
            }
        }
        if (msg.pushName) {
            const num = jid.split('@')[0];
            if (!store.lidPushNames.has(num)) {
                store.lidPushNames.set(num, msg.pushName);
            }
        }
        if (jid.endsWith('@lid') && !msg.key.fromMe && msg.key.senderPn) {
            const lidNum = jid.split('@')[0];
            if (!store.lidToPhone.has(lidNum)) {
                store.lidToPhone.set(lidNum, { phone: msg.key.senderPn, name: null });
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
                            console.log(`[LID] MIGRATION_SYNC: ${added} nuevos mapeos`);
                            schedulePersist(store, storeFile);
                        }
                    }
                } catch (e) {}
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
        console.log(`[HISTORY] ${newChats.length} chats, ${newContacts.length} contacts, ${newMsgs.length} messages`);
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
        store.phoneToContact = buildPhoneToContact(store.contacts, store.lidToPhone);
        buildLidToPhoneFromChats(store);

        const totalMsgs = Array.from(store.messages.values()).reduce((sum, arr) => sum + arr.length, 0);
        console.log(`[STORE] ${store.chats.size} chats, ${store.contacts.size} contacts, ${totalMsgs} messages, phoneToContact: ${store.phoneToContact.size}, contactsWwebjs: ${store.contactsWwebjs?.size || 0}`);

        schedulePersist(store, storeFile);
    });
};

const statusToAck = (status) => {
    if (status === undefined || status === null) return 0;
    if (typeof status === 'number') return status;
    switch (status) {
        case 'PENDING': return 0;
        case 'SENT': return 1;
        case 'DELIVERED': return 2;
        case 'READ': return 3;
        default: return 0;
    }
};

const formatMessage = async (msg, sock, store) => {
    let body = '';
    let type = 'chat';
    let hasMedia = false;
    let isVoice = false;
    let media = null;

    let ack = statusToAck(msg.status);
    const ageMs = Date.now() - (normalizeTimestamp(msg.messageTimestamp) * 1000);

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
                { reuploadRequest: sock.updateMediaMessage, logger: pino({ level: 'silent' }) }
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
                media = { mimetype, data: buffer.toString('base64'), filename };
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
        senderName = contact?.name || contact?.notify || msg.pushName || participantJid.split('@')[0];
    }

    return {
        id: msg.key?.id || '',
        body, type,
        timestamp: normalizeTimestamp(msg.messageTimestamp),
        from: msg.key?.remoteJid || '',
        fromMe: !!msg.key?.fromMe,
        hasMedia, media, ack, isVoice, senderName
    };
};

const createSessionSocket = async (sessionId, sessionPath, sessionData, gen, isRetry = false) => {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();
    const hadCreds = !!state.creds?.me;

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
            const loadedStore = { chats: new Map(), contacts: new Map(), messages: new Map(), lidMap: new Map(), lidPushNames: new Map(), lidToPhone: new Map(), phoneToContact: new Map(), contactsWwebjs: loadContactsCache(sessionId) };
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
            loadedStore.phoneToContact = buildPhoneToContact(loadedStore.contacts, loadedStore.lidToPhone);
            buildLidToPhoneFromChats(loadedStore);
            sessionData.store = loadedStore;
            const totalMsgs = Array.from(loadedStore.messages.values()).reduce((s, a) => s + a.length, 0);
            console.log(`[STORE] ${loadedStore.chats.size} chats, ${loadedStore.contacts.size} contacts, ${totalMsgs} messages, contactsWwebjs: ${loadedStore.contactsWwebjs.size}`);
            bindStoreEvents(sock, loadedStore, sessionPath, sessionId);
        } catch (e) {
            console.error('[STORE] Error cargando store:', e.message);
            sessionData.store = createStore(sock, sessionPath, sessionId);
        }
    } else {
        sessionData.store = createStore(sock, sessionPath, sessionId);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const current = sessions.get(sessionId);
        if (!current || current.gen !== gen) return;
        current.lastEventAt = Date.now();
        const { connection, lastDisconnect, qr } = update;
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        if (qr) {
            try {
                const qrImageBase64 = await QRCode.toDataURL(qr, {
                    errorCorrectionLevel: 'H', type: 'image/png', width: 400, margin: 1
                });
                current.qr = qr;
                current.qrBase64 = qrImageBase64.replace(/^data:image\/png;base64,/, '');
                current.status = 'qr_generated';
                console.log(' QR generado para:', sessionId);
            } catch (err) {}
        }

        if (connection === 'open') {
            console.log(' Cliente WhatsApp listo:', sessionId);
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
                setTimeout(() => resolveMissingNames(sock, current.store), 15000);
                setTimeout(async () => {
                    const s = sessions.get(sessionId);
                    if (!s || s.status !== 'ready') return;
                    if (s.contactsSyncStatus === 'completed') {
                        console.log('[AUTO-SYNC] Contactos ya sincronizados, saltando');
                        return;
                    }
                    if (s.store && s.store.contactsWwebjs && s.store.contactsWwebjs.size > 0) {
                        console.log('[AUTO-SYNC] Contactos ya en cache (' + s.store.contactsWwebjs.size + '), saltando');
                        s.contactsSyncStatus = 'completed';
                        return;
                    }
                    console.log('[AUTO-SYNC] Iniciando sincronizacion automatica de contactos...');
                    try {
                        await startContactsSync(sessionId);
                        console.log('[AUTO-SYNC] Sincronizacion de contactos iniciada');
                    } catch (e) {
                        console.error('[AUTO-SYNC] Error:', e.message);
                    }
                }, 20000);
            }
        }

        if (connection === 'close') {
            if (statusCode === DisconnectReason.loggedOut) {
                if (hadCreds && !isRetry) {
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
                        current.status = 'disconnected';
                    }
                } else {
                    current.status = 'logged_out';
                    current.qr = null;
                    current.qrBase64 = null;
                    current.info = null;
                    try { await sock.end(); } catch (e) {}
                    sessions.delete(sessionId);
                    await deleteSessionFolder(sessionPath);
                }
            } else if (statusCode === DisconnectReason.restartRequired) {
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
                    current.status = 'disconnected';
                }
            } else {
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
                    current.status = 'disconnected';
                }
            }
        }
    });

    return sock;
};

app.post('/session/start/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    console.log(' Iniciando sesion para:', sessionId);

    if (sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        if (session.status === 'initializing') {
            return res.status(429).json({ success: false, message: 'Inicializando, por favor espere...', status: 'initializing' });
        }
        if (session.status === 'ready') {
            return res.json({ success: true, message: 'Sesion activa', status: session.status, info: session.info });
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
        gen, sock: null, status: 'initializing',
        qr: null, qrBase64: null, info: null,
        lastEventAt: Date.now(),
        contactsSyncStatus: null,
        contactsQr: null,
        contactsCache: loadContactsCache(sessionId)
    };
    sessions.set(sessionId, sessionData);

    try {
        await createSessionSocket(sessionId, sessionPath, sessionData, gen);
        res.json({ success: true, message: 'Iniciando...', sessionId, status: 'initializing' });
    } catch (error) {
        console.error(' Error creando sesion:', error);
        sessions.delete(sessionId);
        await deleteSessionFolder(sessionPath);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/session/health/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ healthy: false, status: 'not_found', message: 'Sesion no existe', needsReconnect: true });
    }

    if (session.status === 'logged_out') {
        return res.json({ healthy: false, status: 'logged_out', message: 'Sesion cerrada desde el dispositivo', needsReconnect: true });
    }

    if (session.status !== 'ready') {
        return res.json({
            healthy: false, status: session.status,
            message: session.status === 'reconnecting' ? 'Reconectando...' : 'Sesion no esta lista',
            needsReconnect: session.status === 'disconnected',
            isTransient: session.status === 'reconnecting'
        });
    }

    const wsState = session.sock?.ws?.readyState;
    const hasUser = !!session.sock?.user;
    if (!hasUser) {
        return res.json({ healthy: false, status: 'warming_up', message: 'WebSocket no conectado', needsReconnect: false, isTransient: true });
    }

    return res.json({ healthy: true, status: 'ready', message: 'Sesion activa y saludable', info: session.info });
});

app.get('/session/qr/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'No existe sesion activa' });
    res.json({
        success: true,
        qr: session.qr,
        base64: session.qrBase64,
        status: session.status,
        connected: session.status === 'ready',
        info: session.info,
        contactsSyncStatus: session.contactsSyncStatus || null,
        contactsQr: session.contactsQr || null
    });
});

app.get('/session/status/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'No existe sesion activa' });
    res.json({ success: true, status: session.status, connected: session.status === 'ready', info: session.info });
});

app.post('/session/close/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    const sessionPath = path.join(AUTH_BASE_PATH, `session-${sessionId}`);

    sessions.delete(sessionId);

    if (session && session.sock) {
        try { await session.sock.end(); } catch (e) {}
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    for (let i = 0; i < 3; i++) {
        const deleted = await deleteSessionFolder(sessionPath);
        if (deleted) break;
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    res.json({ success: true, message: 'Sesion cerrada y limpiada' });
});

app.post('/session/reconnect/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Sesion no existe' });

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

app.post('/session/sync-contacts/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Sesion no existe' });

    if (session.contactsSyncStatus === 'syncing' || session.contactsSyncStatus === 'qr_ready') {
        return res.json({ success: true, message: 'Sincronizacion en curso, escanea el QR', status: session.contactsSyncStatus, contactsQr: session.contactsQr || null });
    }

    if (session.contactsSyncStatus === 'completed') {
        return res.json({ success: true, message: 'Contactos ya sincronizados', status: 'completed', contactsCount: session.contactsCache?.size || 0 });
    }

    console.log(`[CONTACTS] Iniciando sincronizacion de contactos para ${sessionId}...`);
    session.contactsSyncStatus = 'syncing';

    try {
        await startContactsSync(sessionId);
        res.json({
            success: true,
            message: 'Sincronizacion iniciada. Usa GET /contacts/qr/:sessionId para obtener el QR actualizado',
            status: session.contactsSyncStatus,
            contactsQr: session.contactsQr || null
        });
    } catch (e) {
        console.error('[CONTACTS] Error en sync:', e.message);
        session.contactsSyncStatus = 'error';
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/contacts/qr/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Sesion no existe' });
    res.json({
        success: true,
        status: session.contactsSyncStatus || 'idle',
        contactsQr: session.contactsQr || null,
        contactsCount: session.contactsCache?.size || 0
    });
});

app.get('/contacts/status/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Sesion no existe' });
    const cacheFile = path.join(CONTACTS_CACHE_DIR, `${req.params.sessionId}.json`);
    let cachedCount = 0;
    let fetchedAt = null;
    if (fs.existsSync(cacheFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
            cachedCount = Object.keys(data.contacts || {}).length;
            fetchedAt = data.fetchedAt;
        } catch (e) {}
    }
    res.json({
        success: true,
        syncStatus: session.contactsSyncStatus || 'idle',
        cachedCount,
        fetchedAt,
        inMemoryCount: session.store?.contactsWwebjs?.size || 0
    });
});

app.get('/debug/names/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ error: 'Sesion no lista' });
    }
    const store = session.store;
    if (!store) return res.status(400).json({ error: 'Store no disponible' });

    const chatsWithoutName = [];
    const chatsWithName = [];
    const allChats = [];

    for (const [jid, chat] of store.chats) {
        const isIndividual = jid.endsWith('@s.whatsapp.net');
        const isGroup = jid.endsWith('@g.us');
        const isLid = jid.endsWith('@lid');
        if (!isIndividual && !isGroup && !isLid) continue;
        if (chat.archived === true) continue;

        const messages = store.messages.get(jid) || [];
        const hasReal = messages.some(m => hasRealContent(m));
        if (!hasReal && !isGroup) continue;

        const contact = store.contacts.get(jid);
        const resolvedName = resolveChatName(jid, chat, contact, store);
        const isNumber = /^\+?\d+$/.test(resolvedName);
        const isUnknown = resolvedName === 'Desconocido';

        const entry = {
            jid,
            resolvedName,
            isNumber,
            isUnknown,
            type: isGroup ? 'group' : isLid ? 'lid' : 'individual',
            chatName: chat.name || null,
            chatNotify: chat.notify || null,
            contactName: contact?.name || null,
            contactNotify: contact?.notify || null,
            accountLid: chat.accountLid || null,
        };

        if (isNumber || isUnknown) {
            const num = jid.split('@')[0];
            entry.debug = {};

            entry.debug.phoneToContact_byJid = store.phoneToContact?.get(jid)?.name || null;
            entry.debug.phoneToContact_byNum = store.phoneToContact?.get(num)?.name || null;
            entry.debug.phoneToContact_exists = store.phoneToContact?.has(jid) || store.phoneToContact?.has(num);

            entry.debug.contactsWwebjs_byJid = store.contactsWwebjs?.get(jid)?.name || null;
            entry.debug.contactsWwebjs_byNum = store.contactsWwebjs?.get(num)?.name || null;
            entry.debug.contactsWwebjs_exists = store.contactsWwebjs?.has(jid) || store.contactsWwebjs?.has(num);

            entry.debug.lidToPhone = null;
            entry.debug.lidMapEntry = null;
            if (isLid) {
                const lidNum = num;
                entry.debug.lidToPhone = store.lidToPhone?.get(lidNum) || null;
                entry.debug.lidMapEntry = store.lidMap?.get(lidNum) || null;
            }

            entry.debug.lidPushName = store.lidPushNames?.get(num) || null;

            const msgs = store.messages.get(jid) || [];
            const lastPushName = (() => {
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].pushName && hasRealContent(msgs[i])) return msgs[i].pushName;
                }
                return null;
            })();
            entry.debug.lastMsgPushName = lastPushName;
            entry.debug.totalMessages = msgs.length;

            if (jid.endsWith('@s.whatsapp.net')) {
                const phoneOnly = num;
                entry.debug.contactsStore_hasPhoneJid = store.contacts?.has(jid) || false;
                const foundInStore = searchContactByPhone(jid, store);
                entry.debug.searchContactByPhone = foundInStore;
            }

            chatsWithoutName.push(entry);
        } else {
            chatsWithName.push(entry);
        }

        allChats.push({ jid, name: resolvedName, isNumber, isUnknown });
    }

    const phoneToContactSample = [];
    let i = 0;
    for (const [key, val] of store.phoneToContact || []) {
        if (i++ >= 15) break;
        phoneToContactSample.push({ key, name: val.name, id: val.id || null });
    }

    const contactsSample = [];
    i = 0;
    for (const [key, val] of store.contacts || {}) {
        if (i++ >= 15) break;
        contactsSample.push({ key, name: val.name || null, notify: val.notify || null, lid: val.lid || null });
    }

    const lidToPhoneSample = [];
    i = 0;
    for (const [key, val] of store.lidToPhone || {}) {
        if (i++ >= 15) break;
        lidToPhoneSample.push({ lid: key, phone: val.phone, name: val.name });
    }

    res.json({
        summary: {
            totalChats: allChats.length,
            withName: chatsWithName.length,
            withoutName: chatsWithoutName.length,
            phoneToContactSize: store.phoneToContact?.size || 0,
            contactsWwebjsSize: store.contactsWwebjs?.size || 0,
            contactsStoreSize: store.contacts?.size || 0,
            lidToPhoneSize: store.lidToPhone?.size || 0,
            lidPushNamesSize: store.lidPushNames?.size || 0,
        },
        chatsWithoutName,
        chatsWithName: chatsWithName.map(c => ({ jid: c.jid, name: c.resolvedName, type: c.type })),
        phoneToContactSample,
        contactsSample,
        lidToPhoneSample,
    });
});

app.get('/media/:sessionId/:chatId/:messageId', async (req, res) => {
    const { sessionId, chatId, messageId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ error: 'Sesion no lista' });
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

        res.json({ success: true, mimetype, filename, data: buffer.toString('base64') });
    } catch (e) {
        console.error(`[MEDIA] Error descargando: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/chats/:sessionId', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ error: 'Sesion no lista' });
    }

    const limit = parseInt(req.query.limit) || 30;
    const offset = parseInt(req.query.offset) || 0;
    const startTime = Date.now();
    console.log(` Obteniendo chats para: ${req.params.sessionId} (limit=${limit}, offset=${offset})`);

    try {
        const { chats, total } = getChatsFromStore(session, limit, offset);
        console.log(`[DEBUG] Chats: ${chats.length} (total: ${total})`);

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
        res.json({ success: true, chats: chatsWithPics, total, hasMore: (offset + limit) < total });
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
        return res.status(400).json({ error: 'Sesion no lista' });
    }

    try {
        let finalId = chatId.includes('@') ? chatId : `${formatNumber(chatId)}@s.whatsapp.net`;
        if (finalId.endsWith('@lid') && session.store?.lidMap) {
            const resolved = resolveChatId(finalId, session.store);
            if (resolved !== finalId) finalId = resolved;
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
                console.log(`[DEBUG] Messages vacios para ${finalId}, solicitando historial...`);
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
            } catch (e) {
                console.error('[DEBUG] fetchMessageHistory error:', e.message);
            }
        }

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
    if (!session || session.status !== 'ready') return res.status(400).json({ error: 'Sesion no lista' });

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
        return res.status(400).json({ success: false, error: 'Faltan parametros' });
    }

    const currSession = sessions.get(targetSession);
    if (!currSession || currSession.status !== 'ready') {
        return res.status(400).json({ success: false, error: 'Sesion no conectada' });
    }

    try {
        let chatId = targetPhone;
        if (!chatId.includes('@')) {
            chatId = `${formatNumber(chatId)}@s.whatsapp.net`;
        }
        if (chatId.endsWith('@lid') && currSession.store?.lidMap) {
            const resolved = resolveChatId(chatId, currSession.store);
            if (resolved !== chatId) chatId = resolved;
        }

        console.log(` Enviando a ${chatId} via ${targetSession}`);
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
        return res.json({ success: true, messages: [] });
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

        res.json({ success: true, message: 'Archivo enviado', messageId: sentMessage.key?.id || '' });
    } catch (e) {
        console.error('[SEND-MEDIA] Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

const cleanup = async () => {
    console.log('\n Cerrando servidor...');
    for (const [sessionId, session] of sessions) {
        if (session.sock) {
            console.log(` Cerrando sesion: ${sessionId}`);
            try { await session.sock.end(); } catch (e) {}
        }
    }
    process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

setInterval(() => {
    const IDLE_LIMIT = 10 * 60 * 1000;
    for (const [sessionId, session] of sessions) {
        if (session.status !== 'ready') continue;
        const hasUser = !!session.sock?.user;
        const idleTime = Date.now() - (session.lastEventAt || 0);

        if (!hasUser || idleTime > IDLE_LIMIT) {
            console.log(`[WATCHDOG] ${sessionId} zombie (user:${hasUser}, idle:${Math.round(idleTime/1000)}s), reconectando`);
            session.status = 'reconnecting';
            const newGen = Date.now();
            session.gen = newGen;
            try { session.sock?.end(); } catch (e) {}
            createSessionSocket(sessionId, path.join(AUTH_BASE_PATH, `session-${sessionId}`), session, newGen, true)
                .catch(e => console.error(`[WATCHDOG] reconexion fallida:`, e.message));
        }
    }
}, 2 * 60 * 1000);

app.listen(PORT, () => {
    console.log(` Servidor WhatsApp corriendo en puerto: ${PORT}`);
});
