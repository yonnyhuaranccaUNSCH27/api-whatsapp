const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode'); 
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// Configurar CORS
app.use(cors({
  origin: [
    //'http://localhost:4200',  
    //'http://localhost:82',
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

console.log(`Iniciando Servidor WhatsApp Web API`);

// --- FUNCIONES AUXILIARES ---

const formatNumber = (number) => {
    let cleanNumber = number.replace(/\D/g, '');
    if (cleanNumber.length === 9 && cleanNumber.startsWith('9')) {
        cleanNumber = `51${cleanNumber}`;
    }
    return cleanNumber;
};

// Función auxiliar para obtener foto con timeout más corto
const getProfilePicWithTimeout = async (contact) => {
    try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 500));
        const picPromise = contact.getProfilePicUrl();
        return await Promise.race([picPromise, timeout]);
    } catch (e) {
        return null; 
    }
};

// --- ENDPOINTS ---

app.post('/session/start/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    console.log('Iniciando sesión para:', sessionId);
    
    if (sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        return res.json({ 
            success: true, 
            message: 'Sesión ya existe',
            status: session.status,
            qr: session.qr
        });
    }

    try {
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: sessionId }),
            puppeteer: {
                headless: true,
                protocolTimeout: 300000, 
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ],
                timeout: 120000
            }
        });

        const sessionData = {
            client: client,
            status: 'initializing',
            qr: null,
            qrBase64: null,
            info: null
        };

        sessions.set(sessionId, sessionData);

        client.on('qr', async (qr) => {
            console.log('QR generado para:', sessionId);
            qrcodeTerminal.generate(qr, { small: true });
            try {
                const qrImageBase64 = await QRCode.toDataURL(qr, {
                    errorCorrectionLevel: 'H', type: 'image/png', width: 400, margin: 1
                });
                sessionData.qr = qr;
                sessionData.qrBase64 = qrImageBase64.replace(/^data:image\/png;base64,/, '');
                sessionData.status = 'qr_generated';
            } catch (err) { console.error(' Error QR:', err); }
        });

        client.on('ready', () => {
            console.log(' Cliente WhatsApp listo:', sessionId);
            sessionData.status = 'ready';
            sessionData.qr = null;
            sessionData.qrBase64 = null;
            sessionData.info = {
                wid: client.info.wid._serialized,
                pushname: client.info.pushname
            };
        });

        client.on('authenticated', () => {
            console.log('Autenticado:', sessionId);
            sessionData.status = 'authenticated';
        });

        client.on('auth_failure', () => sessionData.status = 'auth_failure');
        client.on('disconnected', () => sessionData.status = 'disconnected');
        
        await client.initialize();

        res.json({ success: true, message: 'Iniciando...', sessionId, status: 'initializing' });

    } catch (error) {
        sessions.delete(sessionId);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/session/qr/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'No existe' });
    res.json({ success: true, qr: session.qr, base64: session.qrBase64, status: session.status, connected: session.status === 'ready', info: session.info });
});

app.get('/session/status/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'No existe' });
    res.json({ success: true, status: session.status, connected: session.status === 'ready', info: session.info });
});

app.post('/session/close/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    if (!session) return res.json({ success: true });
    
    try {
        if (session.client) {
            try { await session.client.logout(); } catch (e) {}
            try { await session.client.destroy(); } catch (e) {}
        }
        sessions.delete(sessionId);
        try {
            const p = path.join(__dirname, '.wwebjs_auth', `session-${sessionId}`);
            if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        } catch (e) {}
        res.json({ success: true });
    } catch (e) {
        sessions.delete(sessionId);
        res.json({ success: true });
    }
});

// ENDPOINT OPTIMIZADO PARA CHATS - LA CLAVE ESTÁ AQUÍ
app.get('/chats/:sessionId', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ error: 'Sesión no lista' });
    }
    
    const startTime = Date.now();
    console.log(' Obteniendo chats para:', req.params.sessionId);

    try {
        // Usar puppeeter.page directamente es más rápido
        const chats = await session.client.pupPage.evaluate(() => {
            const Store = window.require('WAWebCollections');
            return Store.Chat.getModelsArray()
                .slice(0, 20) // Solo los primeros 20
                .map(chat => ({
                    id: chat.id._serialized,
                    name: chat.formattedTitle || chat.name,
                    isGroup: chat.isGroup,
                    unreadCount: chat.unreadCount,
                    timestamp: chat.t,
                    lastMessage: chat.lastReceivedKey ? chat.msgs.get(chat.lastReceivedKey)?.body : null
                }));
        });

        // SOLUCIÓN 2: Obtener fotos de perfil en paralelo pero con límite
        const chatsWithPics = await Promise.all(
            chats.map(async (chat) => {
                let profilePic = null;
                
                // Solo obtener foto si no es grupo (más rápido)
                if (!chat.isGroup) {
                    try {
                        const contact = await session.client.getContactById(chat.id);
                        profilePic = await getProfilePicWithTimeout(contact);
                    } catch (err) {
                        // Ignorar errores
                    }
                }
                
                return {
                    ...chat,
                    profilePic
                };
            })
        );
        
        const endTime = Date.now();
        console.log(` Chats obtenidos en ${endTime - startTime}ms`);
        
        res.json({ success: true, chats: chatsWithPics });
    } catch (error) {
        console.error(' Error obteniendo chats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ENDPOINT MEJORADO PARA MENSAJES CON SOPORTE DE AUDIO
app.get('/messages/:sessionId/:chatId', async (req, res) => {
    const { sessionId, chatId } = req.params;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ error: 'No ready' });
    }
    
    try {
        const finalId = chatId.includes('@') ? chatId : `${chatId}@c.us`;
        const chat = await session.client.getChatById(finalId);
        
        const messages = await chat.fetchMessages({ limit: 15 });
        
        const formatted = await Promise.all(messages.map(async (msg) => {
            let media = null;
            
            //  Detectar y descargar audios correctamente
            if (msg.hasMedia) {
                try {
                    const mediaData = await msg.downloadMedia();
                    if (mediaData) {
                        media = { 
                            mimetype: mediaData.mimetype, 
                            data: mediaData.data, 
                            filename: mediaData.filename || 'audio.ogg'
                        };
                    }
                } catch (e) {
                    console.error('Error descargando media:', e);
                }
            }
            
            return {
                id: msg.id._serialized,
                body: msg.body,
                type: msg.type, 
                timestamp: msg.timestamp,
                from: msg.from,
                fromMe: msg.fromMe,
                hasMedia: msg.hasMedia,
                media: media,
                ack: msg.ack,
                // Agregar flag específico para audios
                isVoice: msg.type === 'ptt' || msg.type === 'audio'
            };
        }));
        
        res.json({ success: true, messages: formatted });
    } catch (e) { 
        console.error('Error en mensajes:', e);
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/check-number', async (req, res) => {
    const { sessionId, phone } = req.body;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'ready') return res.status(400).json({ error: 'No ready' });

    try {
        const formatted = formatNumber(phone);
        const contact = await session.client.getNumberId(formatted);
        res.json({ 
            success: true, 
            exists: !!contact, 
            id: contact ? contact._serialized : null,
            formattedNumber: formatted 
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/send-message', async (req, res) => {
    const { sessionId, session: sessAlt, number, phone, message } = req.body;
    const targetSession = sessionId || sessAlt;
    const targetPhone = number || phone;
    
    const currSession = sessions.get(targetSession);
    if (!currSession || currSession.status !== 'ready') return res.status(400).json({ error: 'Error sesión' });

    try {
        let chatId = targetPhone;
        if (!targetPhone.includes('@')) {
            const formatted = formatNumber(targetPhone);
            const idObj = await currSession.client.getNumberId(formatted);
            chatId = idObj ? idObj._serialized : `${formatted}@c.us`;
        }
        const sent = await currSession.client.sendMessage(chatId, message);
        res.json({ success: true, message: 'Enviado', id: sent.id._serialized });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/send-media', async (req, res) => {
    const startTime = Date.now();
    console.log(' [SEND-MEDIA] Recibiendo solicitud...');
    
    const { sessionId, phone, file, mimetype, filename, caption } = req.body;
    
    // Validación de datos
    if (!sessionId || !phone || !file || !mimetype) {
        console.error(' [SEND-MEDIA] Datos incompletos:', { 
            hasSessionId: !!sessionId, 
            hasPhone: !!phone, 
            hasMime: !!mimetype, 
            hasFile: !!file 
        });
        return res.status(400).json({ 
            success: false, 
            error: 'Faltan datos requeridos',
            message: 'Datos incompletos'
        });
    }
    
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'ready') {
        console.error(' [SEND-MEDIA] Sesión no lista:', sessionId);
        return res.status(400).json({ 
            success: false,
            error: 'Sesión no lista',
            message: 'La sesión de WhatsApp no está conectada'
        });
    }

    try {
        const chatId = phone.includes('@') ? phone : `${formatNumber(phone)}@c.us`;
        
        console.log(' [SEND-MEDIA] Enviando archivo:', {
            chatId,
            mimetype,
            filename,
            fileSize: Math.round(file.length / 1024) + ' KB'
        });
        
        const media = new MessageMedia(mimetype, file, filename);
        const sentMessage = await session.client.sendMessage(chatId, media, { 
            caption: caption || '' 
        });
        
        const elapsed = Date.now() - startTime;
        console.log(` [SEND-MEDIA] Archivo enviado en ${elapsed}ms`);
        
        //  RESPUESTA EXITOSA
        res.json({ 
            success: true, 
            message: 'Archivo enviado',
            messageId: sentMessage.id._serialized,
            timestamp: Date.now()
        });
        
    } catch (e) { 
        console.error(' [SEND-MEDIA] Error:', e.message);
        res.status(500).json({ 
            success: false, 
            error: e.message,
            message: 'Error al enviar el archivo'
        }); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(` Servidor WhatsApp Web API → Puerto: ${PORT}`);
});