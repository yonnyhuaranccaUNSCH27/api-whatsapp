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

// Middleware de seguridad simple
app.use((req, res, next) => {
    // Puedes enviar esto en los Headers como 'x-api-key'
    const apiKey = req.headers['x-api-key'];
    const mySecretKey = 'tu_contraseña_secreta_aqui'; // Cámbiame

    // Permitir acceso sin clave solo para ver el QR o login (opcional)
    // O proteger TODO:
    if (apiKey && apiKey === mySecretKey) {
        next();
    } else {
        // Si estás probando en local y te da pereza poner headers, 
        // puedes comentar este bloque temporalmente.
        // res.status(403).json({ error: 'Acceso denegado: API Key incorrecta' });
        
        // POR AHORA (Modo desarrollo): Dejar pasar
        next(); 
    }
});

const sessions = new Map();

console.log(` Iniciando Servidor WhatsApp Web API`);



const deleteSessionFolder = async (pathStr) => {
    if (!fs.existsSync(pathStr)) return true; // Si no existe, todo bien
    
    // 1. Intentamos borrar normal
    try {
        fs.rmSync(pathStr, { recursive: true, force: true });
        console.log(`🗑️ Carpeta eliminada: ${pathStr}`);
        return true;
    } catch (error) {
        // 2. Si falla por bloqueo (EBUSY), esperamos un poco
        if (error.code === 'EBUSY' || error.code === 'EPERM') {
            console.log(`⚠️ Archivo bloqueado, intentando mover carpeta...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            try {
                // 3. ESTRATEGIA RENOMBRADO (El truco mágico)
                // Si no podemos borrarla, le cambiamos el nombre para que no estorbe
                const trashPath = `${pathStr}-trash-${Date.now()}`;
                fs.renameSync(pathStr, trashPath);
                console.log(` Carpeta movida a la papelera temporal: ${trashPath}`);
                
                // Intentamos borrar la basura asíncronamente (sin esperar) para no frenar el login
                fs.rm(trashPath, { recursive: true, force: true }, () => {}); 
                
                return true; // Para el sistema, la ruta original ya está libre
            } catch (renameError) {
                console.error(` No se pudo ni borrar ni mover: ${renameError.message}`);
                return false;
            }
        }
        return false;
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

app.post('/session/start/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    console.log('🔹 Iniciando solicitud de sesión para:', sessionId);
    
    const authPath = path.join(__dirname, '.wwebjs_auth', `session-${sessionId}`);
    
    // 1. Limpieza de memoria si existe una sesión previa colgada
    if (sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        // Si ya está lista, devolvemos éxito
        if (session.status === 'ready') {
            return res.json({ success: true, message: 'Sesión activa', status: session.status, info: session.info });
        }
        // Si está en cualquier otro estado, la destruimos para reiniciar
        try { await session.client.destroy(); } catch(e){}
        sessions.delete(sessionId);
    }

    // 2. Limpieza de disco (Usa la nueva función deleteSessionFolder)
    if (fs.existsSync(authPath)) {
        console.log(` Preparando directorio para nueva sesión: ${sessionId}`);
        const deleted = await deleteSessionFolder(authPath);
        
        if (!deleted) {
            // Si incluso el renombrado falló, ahí si damos error
            return res.status(500).json({ 
                success: false, 
                message: 'Windows ha bloqueado los archivos. Por favor espera 10 segundos e intenta de nuevo.' 
            });
        }
    }

    try {
        const client = new Client({
    authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: '/usr/src/app/.wwebjs_auth' // Aseguramos la ruta del volumen
    }),
    puppeteer: {
        // Usamos la variable de entorno o undefined si es local
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        headless: true, // En Docker SIEMPRE debe ser true
        args: [
            '--no-sandbox', // CRÍTICO para Docker
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Evita errores de memoria compartida
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
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
            console.log(' QR nuevo generado para:', sessionId);
            try {
                const qrImageBase64 = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'H', type: 'image/png', width: 400, margin: 1 });
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
            sessionData.info = { wid: client.info.wid._serialized, pushname: client.info.pushname };
        });

        client.on('authenticated', () => {
            console.log(' Autenticado:', sessionId);
            sessionData.status = 'authenticated';
        });

        client.on('auth_failure', async (msg) => {
            console.error(' Fallo de autenticación:', sessionId);
            sessionData.status = 'auth_failure';
            // IMPORTANTE: Si falla la autenticación, limpiamos todo inmediatamente
            try { await client.destroy(); } catch (e) {}
            sessions.delete(sessionId);
            // Intentamos borrar la carpeta corrupta en segundo plano
            deleteSessionFolder(path.join(__dirname, '.wwebjs_auth', `session-${sessionId}`));
        });

        client.on('disconnected', async (reason) => {
            console.log('Cliente desconectado:', reason);
            
            // Actualizamos el estado en memoria
            if (sessions.has(sessionId)) {
                const session = sessions.get(sessionId);
                session.status = 'disconnected';
                session.qr = null;
                session.qrBase64 = null;
                session.info = null; // Limpiamos info del usuario
            }

            if (reason === 'LOGOUT') {
                console.log(' LOGOUT detectado desde el celular');
                
                // 1. Marcamos el estado como 'logged_out'
                if (sessions.has(sessionId)) {
                    sessions.get(sessionId).status = 'logged_out';
                    sessions.get(sessionId).disconnectedReason = 'LOGOUT';
                }

                // 2. Destruimos el cliente de Puppeteer para liberar RAM y archivos
                try { 
                    await client.destroy(); 
                    console.log(' Cliente destruido correctamente tras logout');
                } catch (e) {
                    console.error('Error al destruir cliente:', e.message);
                }

            }
        });

        client.on('change_state', state => {
            console.log(' CAMBIO DE ESTADO DE CONEXIÓN:', state);
            // Si el estado es 'CONFLICT' o 'UNPAIRED', podría significar que
            // abrieron WhatsApp Web en otro lado o se cerró la sesión.
        });

        client.on('change_battery', (batteryInfo) => {
            const { battery, plugging } = batteryInfo;
            // Esto es útil para saber si el celular "servidor" se va a apagar
            console.log(` Batería del celular: ${battery}% - ¿Cargando?: ${plugging}`);
        });

        client.initialize().catch(err => {
            console.error('Error en initialize:', err);
            sessions.delete(sessionId);
        });

        res.json({ success: true, message: 'Iniciando...', sessionId, status: 'initializing' });

    } catch (error) {
        sessions.delete(sessionId);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- HEALTH CHECK: Verificar si la sesión está realmente activa ---
app.get('/session/health/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    
    // Si no existe en memoria (nunca se inició)
    if (!session) {
        return res.status(404).json({ 
            healthy: false, 
            status: 'not_found',
            message: 'Sesión no existe',
            needsReconnect: true
        });
    }
    
    // CASO CRÍTICO: Si fue cerrado desde el celular
    if (session.status === 'logged_out') {
        return res.json({
            healthy: false,
            status: 'logged_out', // El frontend debe detectar esto
            message: 'Sesión cerrada desde el dispositivo',
            needsReconnect: true, // Esto activa tu botón de reconectar correctamente
            qr: null // Aseguramos que no muestre QR viejo
        });
    }
    
    // Verificar si está desvinculado
    if (session.status === 'unpaired') {
        return res.json({
            healthy: false,
            status: 'unpaired',
            message: 'Dispositivo desvinculado',
            needsReconnect: true
        });
    }
    
    // Verificar estado general
    if (session.status !== 'ready') {
        return res.json({
            healthy: false,
            status: session.status,
            message: 'Sesión no está lista',
            needsReconnect: session.status === 'disconnected'
        });
    }
    
    // Verificar que el cliente realmente funcione
    try {
        const state = await session.client.getState();
        
        if (state !== 'CONNECTED') {
            return res.json({
                healthy: false,
                status: 'disconnected',
                clientState: state,
                message: 'Cliente no conectado',
                needsReconnect: true
            });
        }
        
        return res.json({
            healthy: true,
            status: 'ready',
            clientState: state,
            message: 'Sesión activa y saludable',
            info: session.info
        });
        
    } catch (error) {
        console.error('Error verificando salud:', error.message);
        return res.json({
            healthy: false,
            status: 'error',
            message: 'Error al verificar estado',
            error: error.message,
            needsReconnect: true
        });
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
                    //lastMessage: chat.lastReceivedKey ? chat.msgs.get(chat.lastReceivedKey)?.body : null
                    lastMessage: (chat.lastReceivedKey && chat.msgs && chat.msgs.get) 
                    ? chat.msgs.get(chat.lastReceivedKey)?.body : null
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


// --- OBTENER MENSAJES 
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

const cleanup = async () => {
    console.log('\n Cerrando servidor...');
    for (const [sessionId, session] of sessions) {
        if (session.client) {
            console.log(`🔌 Cerrando sesión: ${sessionId}`);
            try {
                await session.client.destroy();
            } catch (e) {
                console.error(`Error cerrando cliente ${sessionId}:`, e.message);
            }
        }
    }
    process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

app.listen(PORT, () => {
    console.log(` Servidor WhatsApp corriendo en puerto: ${PORT}`);
});