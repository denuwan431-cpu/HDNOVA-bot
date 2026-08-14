const express = require('express');
const mongoose = require('mongoose');
const { default: makeWASocket, initAuthCreds, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

// --- 1. Express Server Setup ---
const app = express();
const PORT = process.env.PORT || 7860;

app.get('/', (req, res) => {
    res.send('⚡ HDNOVA WhatsApp Bot is Running Successfully!');
});

app.listen(PORT, () => {
    console.log(`Express server is running on port ${PORT}`);
});

// Store එකක් හදා ගැනීම සඳහා Map එකක් (Anti-Delete සඳහා)
const messageStore = new Map();

// --- 2. MongoDB Atlas Connection ---
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
    console.error('Please set MONGO_URI in Environment Variables!');
    process.exit(1);
}

mongoose.connect(mongoURI).then(() => {
    console.log('Connected to MongoDB Atlas successfully!');
    connectToWhatsApp();
}).catch(err => {
    console.error('MongoDB connection error:', err);
});

// Mongoose Schema for Baileys Session Storage
const AuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    data: { type: Object, required: true }
});
const AuthModel = mongoose.models.AuthState || mongoose.model('AuthState', AuthSchema);

const useMongoAuthState = async () => {
    const writeData = async (data, id) => {
        const jsonString = JSON.stringify(data, (k, v) => Buffer.isBuffer(v) ? { type: 'Buffer', data: Array.from(v) } : v);
        await AuthModel.findByIdAndUpdate(
            id,
            { data: JSON.parse(jsonString) },
            { upsert: true, returnDocument: 'after' }
        );
    };

    const readData = async (id) => {
        try {
            const doc = await AuthModel.findById(id);
            if (doc) {
                return JSON.parse(JSON.stringify(doc.data), (k, v) => {
                    if (v !== null && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) {
                        return Buffer.from(v.data);
                    }
                    return v;
                });
            }
            return null;
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await AuthModel.findByIdAndDelete(id);
        } catch (error) {}
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    let value = await readData(`${type}-${id}`);
                    data[id] = value;
                }
                return data;
            },
            set: async (data) => {
                const tasks = [];
                for (const category of Object.keys(data)) {
                    for (const id of Object.keys(data[category])) {
                        const value = data[category][id];
                        const key = `${category}-${id}`;
                        if (value) {
                            tasks.push(writeData(value, key));
                        } else {
                            tasks.push(removeData(key));
                        }
                    }
                }
                await Promise.all(tasks);
            }
        }
    };

    return {
        state,
        saveCreds: async () => {
            return await writeData(state.creds, 'creds');
        }
    };
};

// --- 3. WhatsApp Bot Main Logic ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMongoAuthState();

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    const phoneNumber = "94706647016"; // ඔබේ අංකය
    const ownerJid = `${phoneNumber}@s.whatsapp.net`;

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n========================================`);
                console.log(`YOUR WHATSAPP PAIRING CODE IS: ${code}`);
                console.log(`========================================\n`);
            } catch (error) {
                console.error("Error requesting pairing code:", error);
            }
        }, 5000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('⚡ HDNOVA Bot Successfully Connected via Pairing Code!');
            try {
                await sock.sendPresenceUpdate('unavailable');
            } catch (e) {}
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // --- Helper function for Date and Time ---
    function getDateTime() {
        const now = new Date();
        const date = now.toLocaleDateString('en-GB'); 
        const time = now.toLocaleTimeString('en-GB', { hour12: false }); 
        return { date, time };
    }

    // --- 4. Core Features & Command Handlers ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        // මැසේජ් එක ස්ටෝර් කරගැනීම (Anti-Delete සඳහා)
        if (m.key && m.key.id) {
            let messageContent = m.message.conversation || m.message.extendedTextMessage?.text || "";
            if (messageContent) {
                messageStore.set(m.key.id, {
                    text: messageContent,
                    sender: m.key.participant || m.key.remoteJid
                });
            }
        }

        // Auto Status Seen (ටීචර්ස්ලා හෝ යාළුවෝ දාන ස්ටේටස් ස්වයංක්‍රීයව බැලීම සඳහා)
        if (m.key && m.key.remoteJid === 'status@broadcast') {
            try {
                await sock.readMessages([m.key]);
            } catch (error) {}
            return;
        }

        const from = m.key.remoteJid;
        const body = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const isOwner = m.key.fromMe || (m.key.participant === ownerJid) || (from === ownerJid);

        const isCommand = body.startsWith('.') || body.startsWith('!') || body.startsWith('/');
        if (isCommand && !isOwner) return;

        const react = async (emoji) => {
            try {
                await sock.sendMessage(from, { react: { text: emoji, key: m.key } });
            } catch (e) {}
        };

        // .ping Command
        if (body === '.ping') {
            await react('⚡');
            const start = Date.now();
            const sentMsg = await sock.sendMessage(from, { text: '_Pinging..._ 🏓' }, { quoted: m });
            const latency = Date.now() - start;
            await sock.sendMessage(from, { text: `> ⚡ *HDNOVA PONG!* Speed: *_${latency}ms_*` }, { quoted: sentMsg });
        }

        // .alive Command
        if (body === '.alive') {
            await react('🔥');
            const { date, time } = getDateTime();
            
            const aliveText = `
⚡ *HDNOVA-OFC IS ONLINE* 💖

─────── 🤍🔘🔘🔘🤍───────
🔥 *Hey... I'm HDNOVA-OFC 🤖*, your ultimate anime assistant — alive and sparkling now!
─────── 🤍🔘🔘🔘🤍───────

📅 *DATE:* ${date}
⏰ *TIME:* ${time}
───────────────────
📞 *NUMBER:* +${phoneNumber}
💬 *PREFIX:* .
───────────────────
🌐 *CONTACT HDNOVA*
http://wa.me/+${phoneNumber}?text=*Hey__HDNOVA*

┃ ® *POWERED BY HDNOVA*
> _HDNOVA-OFC - Cyber System_`.trim();

            try {
                await sock.sendMessage(from, { 
                    image: { url: 'https://i.ibb.co/3Q986uW.jpeg' }, 
                    caption: aliveText 
                }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: aliveText }, { quoted: m });
            }
        }

        // .menu Command
        if (body === '.menu' || body === '.help') {
            await react('📜');
            const { date, time } = getDateTime();

            const menuText = `
⚡ *HDNOVA - CONTROL PANEL* 🚀

─────── 💫⚪⚪⚪💫───────
✨ *Hello Master*, here is your main menu dashboard!
─────── 💫⚪⚪⚪💫───────

📅 *DATE:* ${date}
⏰ *TIME:* ${time}
───────────────────
📌 *OWNER COMMANDS:*
┃ ⚡ _*.ping*_ - Check speed
┃ 🔥 _*.alive*_ - Check system status
┃ 📢 _*.tagall*_ - Tag all group members
───────────────────
🛡️ *SECURITY SYSTEMS:*
┃ 👁️ _*Auto Status*_  ⟡ [ACTIVE]
┃ 📵 _*Call Shield*_  ⟡ [ACTIVE]
┃ 🛡️ _*Anti-Delete*_ ⟡ [ACTIVE]
───────────────────
🌐 *CONTACT MASTER*
http://wa.me/+${phoneNumber}?text=*Hey__HDNOVA*

┃ ® *POWERED BY HDNOVA*
> _HDNOVA-OFC - Cyber System_`.trim();

            try {
                await sock.sendMessage(from, { 
                    image: { url: 'https://i.ibb.co/3Q986uW.jpeg' }, 
                    caption: menuText 
                }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: menuText }, { quoted: m });
            }
        }

        // .tagall Command
        if (body.startsWith('.tagall')) {
            if (!from.endsWith('@g.us')) {
                await react('❌');
                await sock.sendMessage(from, { text: '❌ *This command can only be used inside groups!*' }, { quoted: m });
                return;
            }
            await react('📢');
            try {
                const chat = await sock.groupMetadata(from);
                const participants = chat.participants;
                let teks = `╔═══ 📣 *__HDNOVA TAG ALL__* 📣 ═══╗\n\n`;
                let mentions = [];
                for (let mem of participants) {
                    teks += `│ 👤 @${mem.id.split('@')[0]}\n`;
                    mentions.push(mem.id);
                }
                teks += `╚════════════════════════════╝`;
                await sock.sendMessage(from, { text: teks, mentions: mentions }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: '❌ *Error fetching group members!*' }, { quoted: m });
            }
        }
    });

    // --- 5. Anti-Delete Listener ---
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update && update.update.message === null) {
                const messageId = update.key.id;
                const remoteJid = update.key.remoteJid;
                const cachedMessage = messageStore.get(messageId);

                let deletedText = cachedMessage ? cachedMessage.text : "_Text not found or it was media!_";
                let sender = cachedMessage ? cachedMessage.sender : remoteJid;

                try {
                    await sock.sendMessage(ownerJid, { 
                        text: `🛡️ *__HDNOVA ANTI-DELETE SYSTEM__*\n\n📌 *From Chat:* @${remoteJid.split('@')[0]}\n👤 *Sender:* @${sender.split('@')[0]}\n💬 *Deleted Message:* ${deletedText}\n\n_Someone deleted a message!_ 🗑️` 
                    }, { mentions: [remoteJid, sender] });
                } catch (e) {}
            }
        }
    });

    // --- 6. Call Shield Listener ---
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status === 'offer') {
                try {
                    await sock.sendMessage(call.from, { 
                        text: '📵 *__HDNOVA CALL SHIELD__*\n\n_Calls are not allowed! Please send a text message only._ 💬' 
                    });
                } catch (error) {}
            }
        }
    });
}
