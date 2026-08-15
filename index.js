const express = require('express');
const mongoose = require('mongoose');
const { default: makeWASocket, initAuthCreds, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');

// --- 1. Express Server Setup ---
const app = express();
const PORT = process.env.PORT || 7860;

app.get('/', (req, res) => {
    res.send('⚡ HDNOVA WhatsApp Bot with Advanced Features is Running Successfully!');
});

app.listen(PORT, () => {
    console.log(`Express server is running on port ${PORT}`);
});

const messageStore = new Map();

// --- Feature Toggle States ---
const botSettings = {
    autoStatusSeen: true,
    antiDelete: true,
    callShield: true
};

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

const AuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    data: { type: Object, required: true }
});
const AuthModel = mongoose.models.AuthState || mongoose.model('AuthState', AuthSchema);

const useMongoAuthState = async () => {
    const writeData = async (data, id) => {
        const jsonString = JSON.stringify(data, (k, v) => Buffer.isBuffer(v) ? { type: 'Buffer', data: Array.from(v) } : v);
        await AuthModel.findByIdAndUpdate(id, { data: JSON.parse(jsonString) }, { upsert: true, returnDocument: 'after' });
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
        } catch (error) { return null; }
    };

    const removeData = async (id) => {
        try { await AuthModel.findByIdAndDelete(id); } catch (error) {}
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
                    data[id] = await readData(`${type}-${id}`);
                }
                return data;
            },
            set: async (data) => {
                const tasks = [];
                for (const category of Object.keys(data)) {
                    for (const id of Object.keys(data[category])) {
                        const value = data[category][id];
                        const key = `${category}-${id}`;
                        if (value) { tasks.push(writeData(value, key)); } 
                        else { tasks.push(removeData(key)); }
                    }
                }
                await Promise.all(tasks);
            }
        }
    };

    return { state, saveCreds: async () => await writeData(state.creds, 'creds') };
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
            if (shouldReconnect) { connectToWhatsApp(); }
        } else if (connection === 'open') {
            console.log('⚡ HDNOVA Bot Successfully Connected via Pairing Code!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    function getDateTime() {
        const now = new Date();
        return { date: now.toLocaleDateString('en-GB'), time: now.toLocaleTimeString('en-GB', { hour12: false }) };
    }

    // --- 4. Message Upsert Listener ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        const from = m.key.remoteJid;
        const body = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const isOwner = m.key.fromMe || (m.key.participant === ownerJid) || (from === ownerJid);

        // Store messages for Anti-Delete
        if (botSettings.antiDelete && m.key && m.key.id && from !== 'status@broadcast') {
            messageStore.set(m.key.id, {
                message: m.message,
                sender: m.key.participant || m.key.remoteJid,
                pushName: m.pushName || "Unknown",
                remoteJid: from
            });
        }

        // Auto Status Seen & React
        if (botSettings.autoStatusSeen && from === 'status@broadcast') {
            try {
                await sock.readMessages([m.key]);
                const participant = m.key.participant || m.participant;
                if (participant) {
                    await sock.sendMessage('status@broadcast', { react: { text: '💚', key: m.key } }, { statusJidList: [participant] });
                }
            } catch (error) {}
            return;
        }

        const react = async (emoji) => {
            try { await sock.sendMessage(from, { react: { text: emoji, key: m.key } }); } catch (e) {}
        };

        // .ping Command
        if (body === '.ping') {
            await react('⚡');
            const start = Date.now();
            const sentMsg = await sock.sendMessage(from, { text: '_Pinging..._ 🏓' }, { quoted: m });
            const latency = Date.now() - start;
            await sock.sendMessage(from, { text: `> ⚡ *HDNOVA PONG!* Speed: *_${latency}ms_*` }, { quoted: sentMsg });
        }

        // Settings Toggle Commands (Owner Only)
        if (isOwner) {
            if (body === '.autostatus on') { botSettings.autoStatusSeen = true; await sock.sendMessage(from, { text: '✅ *Auto Status Seen ENABLED!*' }, { quoted: m }); }
            if (body === '.autostatus off') { botSettings.autoStatusSeen = false; await sock.sendMessage(from, { text: '❌ *Auto Status Seen DISABLED!*' }, { quoted: m }); }
            if (body === '.antidelete on') { botSettings.antiDelete = true; await sock.sendMessage(from, { text: '✅ *Anti-Delete ENABLED!*' }, { quoted: m }); }
            if (body === '.antidelete off') { botSettings.antiDelete = false; await sock.sendMessage(from, { text: '❌ *Anti-Delete DISABLED!*' }, { quoted: m }); }
            if (body === '.callshield on') { botSettings.callShield = true; await sock.sendMessage(from, { text: '✅ *Call Shield ENABLED!*' }, { quoted: m }); }
            if (body === '.callshield off') { botSettings.callShield = false; await sock.sendMessage(from, { text: '❌ *Call Shield DISABLED!*' }, { quoted: m }); }
        }

        // --- AI Chat (.ai / .gpt) ---
        if (body.startsWith('.ai ') || body.startsWith('.gpt ')) {
            const query = body.slice(body.indexOf(' ') + 1).trim();
            if (!query) { await sock.sendMessage(from, { text: '❌ *Provide a question!* Example: `.ai What is anime?`' }, { quoted: m }); return; }
            await react('🤖');
            try {
                const res = await axios.get(`https://apis.davidcyriltech.my.id/ai/gemini?query=${encodeURIComponent(query)}`);
                const answer = res.data.result || "Sorry, I couldn't get a response.";
                await sock.sendMessage(from, { text: `🤖 *HDNOVA AI*\n\n${answer}` }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: '❌ *AI Service Error!*' }, { quoted: m });
            }
            return;
        }

        // --- Wikipedia Search (.wiki / .search) ---
        if (body.startsWith('.wiki ') || body.startsWith('.search ')) {
            const query = body.slice(body.indexOf(' ') + 1).trim();
            if (!query) { await sock.sendMessage(from, { text: '❌ *Provide a term!* Example: `.wiki Python`' }, { quoted: m }); return; }
            await react('🔍');
            try {
                const wikiRes = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {
                    headers: { 'User-Agent': 'HDNOVABot/1.0' }
                });
                if (wikiRes.data && wikiRes.data.extract) {
                    const wikiText = `🔍 *WIKIPEDIA RESULT* 📖\n\n📌 *Title:* ${wikiRes.data.title}\n📝 *Summary:* ${wikiRes.data.extract}\n\n🔗 *Read more:* ${wikiRes.data.content_urls.desktop.page}\n\n> *Powered by HDNOVA*`;
                    await sock.sendMessage(from, { text: wikiText }, { quoted: m });
                } else {
                    await sock.sendMessage(from, { text: '❌ *No results found!*' }, { quoted: m });
                }
            } catch (e) {
                await sock.sendMessage(from, { text: '❌ *Error searching Wikipedia!*' }, { quoted: m });
            }
            return;
        }

        // --- Weather (.weather) ---
        if (body.startsWith('.weather ')) {
            const city = body.slice(9).trim();
            if (!city) { await sock.sendMessage(from, { text: '❌ *Provide city!* Example: `.weather Colombo`' }, { quoted: m }); return; }
            await react('🌤️');
            try {
                const weatherRes = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
                const current = weatherRes.data.current_condition[0];
                const area = weatherRes.data.nearest_area[0];
                const weatherText = `🌤️ *WEATHER* 🌡️\n\n📍 *Location:* ${area.areaName[0].value}, ${area.country[0].value}\n🌡️ *Temp:* ${current.temp_C}°C\n☁️ *Condition:* ${current.weatherDesc[0].value}\n💧 *Humidity:* ${current.humidity}%\n\n> *Powered by HDNOVA*`;
                await sock.sendMessage(from, { text: weatherText }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: '❌ *Could not fetch weather!*' }, { quoted: m });
            }
            return;
        }

        // --- Sticker Maker (.s / .sticker) - Fixed for Menu Issue ---
        if (body === '.sticker' || body === '.s' || m.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
            const isCmd = body === '.sticker' || body === '.s';
            const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            
            if (isCmd || (quotedMsg && quotedMsg.imageMessage)) {
                await react('🎨');
                try {
                    let target = quotedMsg?.imageMessage ? { key: { remoteJid: from, id: m.message.extendedTextMessage.contextInfo.stanzaId }, message: quotedMsg } : m;
                    
                    if (!target.message.imageMessage && !target.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
                        return;
                    }

                    const buffer = await downloadMediaMessage(target, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                    await sock.sendMessage(from, { sticker: buffer }, { quoted: m });
                } catch (e) {
                    await sock.sendMessage(from, { text: '❌ *Failed to create sticker! Send/Reply an image with .s*' }, { quoted: m });
                }
            }
            return;
        }

        // .alive Command
        if (body === '.alive') {
            await react('🔥');
            const { date, time } = getDateTime();
            const aliveText = `⚡ *HDNOVA-OFC IS ONLINE* 💖\n\n📅 *DATE:* ${date}\n⏰ *TIME:* ${time}\n\n> _HDNOVA-OFC - Cyber System_`;
            try {
                const imgBuffer = await axios.get('https://i.ibb.co/Fb4QgTdR/image.jpg', { responseType: 'arraybuffer' }).then(res => res.data);
                await sock.sendMessage(from, { image: imgBuffer, caption: aliveText }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: aliveText }, { quoted: m });
            }
        }

        // .menu Command
        if (body === '.menu' || body === '.help') {
            await react('📜');
            const { date, time } = getDateTime();
            const menuText = `⚡ *HDNOVA - CONTROL PANEL* 🚀\n\n📅 *DATE:* ${date}\n⏰ *TIME:* ${time}\n\n📌 *COMMANDS:*\n┃ ⚡ _*.ping*_ - Speed\n┃ 🔥 _*.alive*_ - Status\n┃ 🤖 _*.ai [query]*_ - Chat AI\n┃ 🌤️ _*.weather [city]*_ - Weather\n┃ 🔍 _*.wiki [term]*_ - Wiki\n┃ 🎨 _*.s / .sticker*_ - Sticker\n\n🛡️ *SETTINGS:*\n┃ 👁️ _Auto Status_ [${botSettings.autoStatusSeen ? 'ON' : 'OFF'}]\n┃ 📵 _Call Shield_ [${botSettings.callShield ? 'ON' : 'OFF'}]\n┃ 🛡️ _Anti-Delete_ [${botSettings.antiDelete ? 'ON' : 'OFF'}]\n\n> _HDNOVA-OFC_`;
            try {
                const imgBuffer = await axios.get('https://i.ibb.co/Fb4QgTdR/image.jpg', { responseType: 'arraybuffer' }).then(res => res.data);
                await sock.sendMessage(from, { image: imgBuffer, caption: menuText }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: menuText }, { quoted: m });
            }
        }
    });

    // --- 5. Anti-Delete Listener ---
    sock.ev.on('messages.update', async (updates) => {
        if (!botSettings.antiDelete) return;
        for (const update of updates) {
            if (update.update && update.update.message === null) {
                const messageId = update.key.id;
                const cached = messageStore.get(messageId);
                if (!cached) return;

                const { remoteJid, sender, pushName, message } = cached;
                const msgType = Object.keys(message)[0];

                try {
                    await sock.sendMessage(ownerJid, {
                        text: `🛡️ *__HDNOVA ANTI-DELETE__*\n\n📌 *Chat:* @${remoteJid.split('@')[0]}\n👤 *Sender:* ${pushName}\n🗑️ *Deleted: ${msgType.replace('Message', '')}*`,
                        mentions: [remoteJid, sender]
                    });

                    if (['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'].includes(msgType)) {
                        await sock.sendMessage(ownerJid, { forward: { key: { remoteJid, id: messageId }, message: message } });
                    } else {
                        let deletedText = message.conversation || message.extendedTextMessage?.text || "Empty Text";
                        await sock.sendMessage(ownerJid, { text: `💬 *Message:* ${deletedText}` });
                    }
                } catch (e) {
                    console.log("Anti-delete error:", e);
                }
            }
        }
    });

    // --- 6. Call Shield Listener ---
    sock.ev.on('call', async (calls) => {
        if (!botSettings.callShield) return;
        for (const call of calls) {
            if (call.status === 'offer') {
                try {
                    await sock.sendMessage(call.from, { text: '📵 *__HDNOVA CALL SHIELD__*\n\n_Calls are not allowed! Please send text only._ 💬' });
                } catch (error) {}
            }
        }
    });
}
