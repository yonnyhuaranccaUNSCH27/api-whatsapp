const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode'); 
const cors = require('cors');
const axios = require('axios');

const app = express();

// Configurar CORS
app.use(cors({
  origin: [
    'http://localhost:4200',  
    'http://localhost:82',     
  ],
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const sessions = new Map();

console.log(`Iniciando Servidor WhatsApp Web API`);

// Endpoint para iniciar sesión de WhatsApp
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
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    // '--single-process',
                    '--disable-gpu'
                ],
                timeout: 60000
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

        // EVENTO: QR generado
        client.on('qr', async (qr) => {
            console.log(' QR generado para:', sessionId);
            
            // Mostrar en consola (terminal)
            qrcodeTerminal.generate(qr, { small: true });
            
            try {
                //  CONVERTIR el texto del QR a imagen PNG en base64
                const qrImageBase64 = await QRCode.toDataURL(qr, {
                    errorCorrectionLevel: 'H',
                    type: 'image/png',
                    width: 400,
                    margin: 1
                });
                
                // Extraer solo el base64 (sin el prefijo "data:image/png;base64,")
                const base64Data = qrImageBase64.replace(/^data:image\/png;base64,/, '');
                
                sessionData.qr = qr;
                sessionData.qrBase64 = base64Data;
                sessionData.status = 'qr_generated';
                
                console.log(' QR convertido a imagen PNG (base64 length:', base64Data.length, ')');
            } catch (err) {
                console.error(' Error generando imagen QR:', err);
            }
        });

        // Evento: Cliente listo
        client.on('ready', () => {
            console.log('✓ Cliente WhatsApp listo:', sessionId);
            sessionData.status = 'ready';
            sessionData.qr = null;
            sessionData.qrBase64 = null;
            sessionData.info = {
                wid: client.info.wid._serialized,
                pushname: client.info.pushname
            };
        });

        // Evento: Autenticación exitosa
        client.on('authenticated', () => {
            console.log('✓ Autenticado:', sessionId);
            sessionData.status = 'authenticated';
        });

        // Evento: Error de autenticación
        client.on('auth_failure', (msg) => {
            console.error('✗ Error de autenticación:', sessionId, msg);
            sessionData.status = 'auth_failure';
        });

        // Evento: Desconexión
        client.on('disconnected', (reason) => {
            console.log('✗ Desconectado:', sessionId, reason);
            sessionData.status = 'disconnected';
        });

        // Evento: Mensaje recibido
        client.on('message', async (message) => {
            console.log(' Mensaje recibido:', message.from, '->', message.body);
        });

        await client.initialize();

        res.json({ 
            success: true, 
            message: 'Sesión iniciada correctamente',
            sessionId: sessionId,
            status: 'initializing'
        });

    } catch (error) {
        console.error('Error al iniciar sesión:', error);
        sessions.delete(sessionId);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Endpoint para obtener el QR
app.get('/session/qr/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ 
            success: false,
            error: 'Sesión no encontrada' 
        });
    }
    
    res.json({ 
        success: true,
        qr: session.qr,
        base64: session.qrBase64,
        status: session.status,
        connected: session.status === 'ready',
        info: session.info
    });
});

// Endpoint para verificar estado de sesión
app.get('/session/status/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ 
            success: false,
            error: 'Sesión no encontrada' 
        });
    }
    
    res.json({ 
        success: true,
        status: session.status,
        connected: session.status === 'ready',
        info: session.info
    });
});

// Endpoint para cerrar sesión 
app.post('/session/close/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.json({ 
            success: true,
            message: 'La sesión ya estaba cerrada o no existía' 
        });
    }
    
    try {
        if (session.client) {
            await session.client.destroy();
        }
        sessions.delete(sessionId);
        console.log('✓ Sesión cerrada correctamente:', sessionId);
        
        res.json({ 
            success: true,
            message: 'Sesión cerrada correctamente' 
        });
    } catch (error) {
        console.error('Error al cerrar sesión:', error);
        sessions.delete(sessionId);
        
        res.json({ 
            success: true, 
            message: 'Sesión forzada a cerrar (hubo un error interno pero se limpió)' 
        });
    }
});


// Endpoint para obtener chats
app.get('/chats/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);
    
    // 1. Validaciones básicas
    if (!session) {
        return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
    }
    if (session.status !== 'ready' || !session.client) {
        return res.status(400).json({ success: false, error: 'Sesión no lista (Client not ready)' });
    }
    
    try {
        console.log(` Obteniendo chats para sesión: ${sessionId}...`);
        
        // 2. Obtener lista de chats
        const chats = await session.client.getChats();
        const LIMIT_PROFILE_PICS = 50; 
        const formattedChats = [];
        
        console.log(`✓ Se encontraron ${chats.length} chats. Procesando primeros ${LIMIT_PROFILE_PICS} con fotos...`);

        for (let i = 0; i < chats.length; i++) {
            const chat = chats[i];
            let profilePicBase64 = null;

            // Solo intentamos descargar foto para los primeros N chats para velocidad
            if (i < LIMIT_PROFILE_PICS) {
                try {
                    let profilePicUrl = null;
                    
                    const contact = await chat.getContact();
                    
                    // Verificamos si el método existe antes de ejecutarlo
                    if (contact && typeof contact.getProfilePicUrl === 'function') {
                        profilePicUrl = await contact.getProfilePicUrl();
                    }

                    // Si conseguimos URL, descargamos la imagen
                    if (profilePicUrl) {
                        const response = await axios.get(profilePicUrl, {
                            responseType: 'arraybuffer',
                            timeout: 4000, 
                            headers: { 
                                'User-Agent': 'Mozilla/5.0' 
                            }
                        });

                        const buffer = Buffer.from(response.data);
                        profilePicBase64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
                    } 
                } catch (picErr) {

                }

                // Pequeña pausa para no bloquear el event loop de Node
                if (i < LIMIT_PROFILE_PICS - 1) {
                    await new Promise(resolve => setTimeout(resolve, 100)); 
                }
            }

            // 3. Formatear el objeto final
            formattedChats.push({
                id: chat.id._serialized,
                name: chat.name || chat.id.user || 'Desconocido',
                isGroup: chat.isGroup,
                unreadCount: chat.unreadCount,
                timestamp: chat.timestamp,
                lastMessage: chat.lastMessage ? chat.lastMessage.body : null,
                profilePic: profilePicBase64 
            });
        }
        
        const conFotos = formattedChats.filter(c => c.profilePic).length;
        console.log(`✓ Chats procesados exitosamente: ${formattedChats.length} (Fotos cargadas: ${conFotos})`);
        
        res.json({ 
            success: true, 
            chats: formattedChats
        });

    } catch (error) {
        console.error('✗ Error fatal al obtener chats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint para obtener mensajes de un chat (CON SOPORTE PARA IMÁGENES)
app.get('/messages/:sessionId/:chatId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const chatId = req.params.chatId;
    const session = sessions.get(sessionId);
    
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ success: false, error: 'Sesión no lista' });
    }
    
    try {
        let finalChatId = chatId.includes('@') ? chatId : `${chatId}@c.us`;
        console.log(` Buscando chat con ID: ${finalChatId}`);

        const chat = await session.client.getChatById(finalChatId);
        const messages = await chat.fetchMessages({ limit: 20 });
        
        const formattedMessages = await Promise.all(messages.map(async (msg) => {
            let mediaData = null;

            if (msg.hasMedia) {
                try {
                    const media = await msg.downloadMedia();
                    if (media) {
                        mediaData = {
                            mimetype: media.mimetype,
                            data: media.data, 
                            filename: media.filename
                        };
                    }
                } catch (err) {
                    console.log(`No se pudo descargar media del mensaje ${msg.id._serialized}`);
                }
            }

            return {
                id: msg.id._serialized,
                body: msg.body,
                type: msg.type,
                timestamp: msg.timestamp,
                from: msg.from,
                to: msg.to,
                fromMe: msg.fromMe,
                hasMedia: msg.hasMedia,
                media: mediaData, 
                ack: msg.ack,
                author: msg.author
            };
        }));
        
        res.json({ 
            success: true, 
            messages: formattedMessages
        });

    } catch (error) {
        console.error('Error al obtener mensajes:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/send-message', async (req, res) => {
    const { sessionId, session, number, phone, message } = req.body;
    
    const targetSession = sessionId || session;
    const targetPhone = number || phone;
    
    if (!targetSession || !targetPhone || !message) {
        return res.status(400).json({ 
            success: false, 
            error: 'Faltan datos requeridos (session, phone, message)' 
        });
    }

    const currentSession = sessions.get(targetSession);
    
    if (!currentSession) {
        return res.status(404).json({ 
            success: false, 
            error: 'Sesión no encontrada' 
        });
    }
    
    if (currentSession.status !== 'ready') {
        return res.status(400).json({ 
            success: false, 
            error: 'Sesión no está lista. Estado actual: ' + currentSession.status 
        });
    }
    
    try {
        // Detectar si es un grupo o contacto individual
        let chatId;
        
        if (targetPhone.includes('@g.us')) {
            // Ya es un ID de grupo completo
            chatId = targetPhone;
        } else if (targetPhone.includes('@c.us')) {
            // Ya es un ID de contacto completo
            chatId = targetPhone;
        } else {
            // Es solo el número, asumir contacto individual
            chatId = `${targetPhone}@c.us`;
        }
        
        console.log('📤 Enviando mensaje a:', chatId);
        
        const sentMessage = await currentSession.client.sendMessage(chatId, message);
        
        console.log('✓ Mensaje enviado correctamente');
        
        res.json({ 
            success: true, 
            message: 'Mensaje enviado correctamente',
            messageId: sentMessage.id._serialized
        });
    } catch (error) {
        console.error('Error al enviar mensaje:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Endpoint para enviar archivos
app.post('/send-media', async (req, res) => {
    const { sessionId, phone, file, mimetype, filename, caption } = req.body;

    if (!sessionId || !phone || !file) {
        return res.status(400).json({ success: false, error: 'Faltan datos' });
    }

    const session = sessions.get(sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).json({ success: false, error: 'Sesión no lista' });
    }

    try {
        const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
        const media = new MessageMedia(mimetype, file, filename);
        const sentMessage = await session.client.sendMessage(chatId, media, { caption: caption || '' });

        res.json({ 
            success: true, 
            message: 'Archivo enviado', 
            messageId: sentMessage.id._serialized 
        });

    } catch (error) {
        console.error('Error enviando archivo:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        success: true,
        message: 'Servidor WhatsApp funcionando',
        sessions: sessions.size,
        activeSessions: Array.from(sessions.keys())
    });
});

// Manejador de errores global
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    res.status(500).json({ 
        success: false,
        error: 'Error interno del servidor' 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(` Servidor WhatsApp Web API → Puerto: ${PORT} → Listo para recibir conexiones`);
});