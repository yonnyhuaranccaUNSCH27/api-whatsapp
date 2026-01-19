const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode'); 
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURACIÓN BÁSICA ---

// Evitar que el servidor se apague por errores inesperados
process.on('unhandledRejection', (reason, promise) => {
    console.error(' Error no manejado (Unhandled Rejection):', reason);
});

process.on('uncaughtException', (error) => {
    console.error(' Excepción no capturada:', error);
});

// Configurar CORS
app.use(cors({
  origin: [
    'https://meerkadito.com/bk',
    'https://home.meerkadito.com',  
    'http://localhost:4200',  
    'http://localhost:82', 
  ],
  credentials: true
}));

// Aumentar límite para envío de archivos grandes
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const sessions = new Map();

console.log(` Iniciando Servidor WhatsApp Web API`);

// --- 2. FUNCIONES AUXILIARES ---

// Función robusta para borrar carpetas en Windows (SOLUCIÓN EBUSY)
const deleteSessionFolder = async (pathStr) => {
    if (!fs.existsSync(pathStr)) return;
    
    try {
        // Intento 1: Borrado normal
        fs.rmSync(pathStr, { recursive: true, force: true });
        console.log(` Carpeta eliminada: ${pathStr}`);
    } catch (error) {
        if (error.code === 'EBUSY' || error.code === 'EPERM') {
            console.log(` Archivo bloqueado por Windows, reintentando en 2 segundos...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            try {
                // Intento 2: Reintento con delay
                fs.rmSync(pathStr, { recursive: true, force: true });
                console.log(` Carpeta eliminada (intento 2): ${pathStr}`);
            } catch (retryError) {
                console.error(` No se pudo borrar la carpeta automáticamente: ${retryError.message}`);
            }
        }
    }
};

const formatNumber = (number) => {
    let cleanNumber = number.replace(/\D/g, '');
    if (cleanNumber.length === 9 && cleanNumber.startsWith('9')) {
        cleanNumber = `51${cleanNumber}`;
    }
    return cleanNumber;
};

// Obtener foto con timeout para no bloquear la carga de chats
const getProfilePicWithTimeout = async (contact) => {
    try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 500));
        const picPromise = contact.getProfilePicUrl();
        return await Promise.race([picPromise, timeout]);
    } catch (e) {
        return null; 
    }
};

// --- 3. ENDPOINTS ---

app.post('/session/start/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    console.log('🔹 Iniciando solicitud de sesión para:', sessionId);
    
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
                // --- AGREGA ESTA LÍNEA ---
                // Usa la variable de entorno que definimos en el Dockerfile, 
                // o usa la ruta por defecto de Linux si la variable no existe.
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
                
                headless: true, 
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', // Vital para Docker
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
            console.log(' QR generado para:', sessionId);
            // qrcodeTerminal.generate(qr, { small: true }); //verlo en consola
            try {
                const qrImageBase64 = await QRCode.toDataURL(qr, {
                    errorCorrectionLevel: 'H', type: 'image/png', width: 400, margin: 1
                });
                sessionData.qr = qr;
                sessionData.qrBase64 = qrImageBase64.replace(/^data:image\/png;base64,/, '');
                sessionData.status = 'qr_generated';
            } catch (err) { console.error('Error generando QR imagen:', err); }
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
            console.log(' Autenticado:', sessionId);
            sessionData.status = 'authenticated';
        });

        client.on('auth_failure', () => {
            console.error('Fallo de autenticación:', sessionId);
            sessionData.status = 'auth_failure';
        });

        client.on('disconnected', async (reason) => {
            console.log(' Cliente desconectado:', reason);
            sessionData.status = 'disconnected';
            sessions.delete(sessionId);
        });
        
        // Inicializar sin await bloqueante (opcional, pero recomendado)
        client.initialize().catch(err => {
            console.error('Error en initialize:', err);
            sessions.delete(sessionId);
        });

        res.json({ success: true, message: 'Iniciando...', sessionId, status: 'initializing' });

    } catch (error) {
        sessions.delete(sessionId);
        const p = path.join(__dirname, '.wwebjs_auth', `session-${sessionId}`);
        await deleteSessionFolder(p);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/session/qr/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'No existe sesión activa' });
    res.json({ success: true, qr: session.qr, base64: session.qrBase64, status: session.status, connected: session.status === 'ready', info: session.info });
});

app.get('/session/status/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'No existe sesión activa' });
    res.json({ success: true, status: session.status, connected: session.status === 'ready', info: session.info });
});

// --- ENDPOINT CRÍTICO: CIERRE DE SESIÓN SEGURO ---
app.post('/session/close/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    
    // Eliminamos la referencia en memoria primero
    sessions.delete(sessionId);
    
    const authPath = path.join(__dirname, '.wwebjs_auth', `session-${sessionId}`);

    if (session && session.client) {
        try {
            console.log(` Cerrando navegador para ${sessionId}...`);
            // IMPORTANTE: NO usamos logout(), solo destroy() para evitar EBUSY
            await session.client.destroy(); 
        } catch (e) { 
            console.error('Error no crítico al destruir cliente:', e.message); 
        }
        
        // Esperamos 3 segundos para que Windows libere el archivo lock
        console.log(' Esperando a que Windows libere archivos...');
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // Ahora sí borramos la carpeta de forma segura
    await deleteSessionFolder(authPath);
    
    res.json({ success: true, message: 'Sesión cerrada y limpiada' });
});

// --- CHATS OPTIMIZADOS ---
app.get('/chats/:sessionId', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ error: 'Sesión no lista' });
    }
    
    const startTime = Date.now();
    console.log(' Obteniendo chats para:', req.params.sessionId);

    try {
        // Inyección directa en navegador
        const chats = await session.client.pupPage.evaluate(() => {
            const Store = window.require('WAWebCollections');
            return Store.Chat.getModelsArray()
                .slice(0, 20) // Límite de 20 chats para velocidad
                .map(chat => ({
                    id: chat.id._serialized,
                    name: chat.formattedTitle || chat.name,
                    isGroup: chat.isGroup,
                    unreadCount: chat.unreadCount,
                    timestamp: chat.t,
                    lastMessage: chat.lastReceivedKey ? chat.msgs.get(chat.lastReceivedKey)?.body : null
                }));
        });

        // Obtener fotos en paralelo
        const chatsWithPics = await Promise.all(
            chats.map(async (chat) => {
                let profilePic = null;
                if (!chat.isGroup) {
                    try {
                        const contact = await session.client.getContactById(chat.id);
                        profilePic = await getProfilePicWithTimeout(contact);
                    } catch (err) {}
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

// --- MENSAJES (Con soporte de audio) ---
// app.get('/messages/:sessionId/:chatId', async (req, res) => {
//     const { sessionId, chatId } = req.params;
//     const session = sessions.get(sessionId);
//     if (!session || session.status !== 'ready') {
//         return res.status(400).json({ error: 'Sesión no lista' });
//     }
    
//     try {
//         const finalId = chatId.includes('@') ? chatId : `${chatId}@c.us`;
//         const chat = await session.client.getChatById(finalId);
        
//         const messages = await chat.fetchMessages({ limit: 15 });
        
//         const formatted = await Promise.all(messages.map(async (msg) => {
//             let media = null;
//             if (msg.hasMedia) {
//                 try {
//                     const mediaData = await msg.downloadMedia();
//                     if (mediaData) {
//                         media = { 
//                             mimetype: mediaData.mimetype, 
//                             data: mediaData.data, 
//                             filename: mediaData.filename || 'audio.ogg'
//                         };
//                     }
//                 } catch (e) { console.error('Error descargando media:', e.message); }
//             }
            
//             return {
//                 id: msg.id._serialized,
//                 body: msg.body,
//                 type: msg.type, 
//                 timestamp: msg.timestamp,
//                 from: msg.from,
//                 fromMe: msg.fromMe,
//                 hasMedia: msg.hasMedia,
//                 media: media,
//                 ack: msg.ack,
//                 isVoice: msg.type === 'ptt' || msg.type === 'audio'
//             };
//         }));
        
//         res.json({ success: true, messages: formatted });
//     } catch (e) { 
//         console.error('Error en mensajes:', e);
//         res.status(500).json({ error: e.message }); 
//     }
// });

// --- OBTENER MENSAJES (OPTIMIZADO PARA DOCKER) ---
app.get('/messages/:sessionId/:chatId', async (req, res) => {
    const { sessionId, chatId } = req.params;
    const limit = parseInt(req.query.limit) || 50; 

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ error: 'Sesión no lista' });
    }
    
    try {
        const finalId = chatId.includes('@') ? chatId : `${formatNumber(chatId)}@c.us`;
        const chat = await session.client.getChatById(finalId);
        
        // Obtenemos mensajes
        const messages = await chat.fetchMessages({ limit: limit });
        
        // Procesamos los mensajes en paralelo pero con protección
        const formatted = await Promise.all(messages.map(async (msg) => {
            let media = null;
            
            // INTENTO DE DESCARGA DE MEDIA SEGURO
            // Solo descargamos si es audio o imagen, y ponemos un try/catch estricto
            if (msg.hasMedia) {
                try {
                    // Timeout de 2 segundos para descargar media. Si tarda más, se ignora.
                    const downloadPromise = msg.downloadMedia();
                    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000));
                    
                    const mediaData = await Promise.race([downloadPromise, timeoutPromise]);
                    
                    if (mediaData) {
                        media = { 
                            mimetype: mediaData.mimetype, 
                            data: mediaData.data, 
                            filename: mediaData.filename || 'file'
                        };
                    }
                } catch (e) { 
                    // Si falla la descarga, simplemente enviamos el mensaje sin media (para no romper el chat)
                    console.error(` Error descarga media msg ${msg.id._serialized}: ${e.message}`);
                    media = null; 
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
                media: media, // Puede ser null si falló la descarga
                ack: msg.ack,
                isVoice: msg.type === 'ptt' || msg.type === 'audio'
            };
        }));
        
        res.json({ success: true, messages: formatted });

    } catch (e) { 
        console.error('Error FATAL en mensajes:', e);
        // Devolvemos array vacío en vez de error 500 para que el chat al menos abra
        res.json({ success: false, messages: [], error: e.message }); 
    }
});

// --- VERIFICAR NÚMERO ---
app.post('/check-number', async (req, res) => {
    const { sessionId, phone } = req.body;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'ready') return res.status(400).json({ error: 'Sesión no lista' });

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

// --- ENVIAR MENSAJE ---
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
            const formatted = formatNumber(chatId); 
            chatId = `${formatted}@c.us`;
        }

        console.log(` Enviando a ${chatId} vía ${targetSession}`);
        const sent = await currSession.client.sendMessage(chatId, message, { sendSeen: false });

        res.json({ 
            success: true, 
            message: 'Enviado correctamente', 
            id: sent.id._serialized,
            timestamp: sent.timestamp 
        });

    } catch (e) {
        console.error(' Error al enviar:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- ENVIAR MEDIA (FOTOS/ARCHIVOS) ---
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
        const chatId = phone.includes('@') ? phone : `${formatNumber(phone)}@c.us`;
        const media = new MessageMedia(mimetype, file, filename);
        
        const sentMessage = await session.client.sendMessage(chatId, media, { 
            caption: caption || '',
            sendSeen: false 
        });
        
        res.json({ 
            success: true, 
            message: 'Archivo enviado',
            messageId: sentMessage.id._serialized
        });
        
    } catch (e) { 
        console.error(' [SEND-MEDIA] Error:', e.message);
        res.status(500).json({ success: false, error: e.message }); 
    }
});

app.listen(PORT, () => {
    console.log(` Servidor WhatsApp corriendo en puerto: ${PORT}`);
});