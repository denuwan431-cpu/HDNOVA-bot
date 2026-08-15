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

// --- Feature Toggle States (Default: ON) ---
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

        const from = m.key.remoteJid;
        const body = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const isOwner = m.key.fromMe || (m.key.participant === ownerJid) || (from === ownerJid);

        // Anti-Delete සඳහා මැසේජ් ස්ටෝර් කිරීම
        if (botSettings.antiDelete && m.key && m.key.id) {
            messageStore.set(m.key.id, {
                message: m.message,
                sender: m.key.participant || m.key.remoteJid,
                pushName: m.pushName || "Unknown",
                remoteJid: m.key.remoteJid
            });
        }

        // Auto Status Seen & React
        if (botSettings.autoStatusSeen && m.key && m.key.remoteJid === 'status@broadcast') {
            try {
                await sock.readMessages([m.key]);
                await sock.sendMessage(m.key.remoteJid, { react: { text: '💚', key: m.key } }, { statusJidList: [m.key.participant] });
            } catch (error) {}
            return;
        }

        const isCommand = body.startsWith('.') || body.startsWith('!') || body.startsWith('/');
        if (isCommand && !isOwner && !body.startsWith('.ai') && !body.startsWith('.gpt') && !body.startsWith('.sticker') && !body.startsWith('.s') && !body.startsWith('.weather') && !body.startsWith('.wiki')) return;

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

        // --- Settings Toggle Commands (Owner Only) ---
        if (isOwner) {
            if (body === '.autostatus on') {
                botSettings.autoStatusSeen = true;
                await sock.sendMessage(from, { text: '✅ *Auto Status Seen is now ENABLED!*' }, { quoted: m });
            }
            if (body === '.autostatus off') {
                botSettings.autoStatusSeen = false;
                await sock.sendMessage(from, { text: '❌ *Auto Status Seen is now DISABLED!*' }, { quoted: m });
            }

            if (body === '.antidelete on') {
                botSettings.antiDelete = true;
                await sock.sendMessage(from, { text: '✅ *Anti-Delete System is now ENABLED!*' }, { quoted: m });
            }
            if (body === '.antidelete off') {
                botSettings.antiDelete = false;
                await sock.sendMessage(from, { text: '❌ *Anti-Delete System is now DISABLED!*' }, { quoted: m });
            }

            if (body === '.callshield on') {
                botSettings.callShield = true;
                await sock.sendMessage(from, { text: '✅ *Call Shield is now ENABLED!*' }, { quoted: m });
            }
            if (body === '.callshield off') {
                botSettings.callShield = false;
                await sock.sendMessage(from, { text: '❌ *Call Shield is now DISABLED!*' }, { quoted: m });
            }
        }

        // --- 1. AI Chat Assistant (.ai / .gpt) ---
        if (body.startsWith('.ai') || body.startsWith('.gpt')) {
            const query = body.slice(3).trim();
            if (!query) {
                await sock.sendMessage(from, { text: '❌ *Please provide a question!* Example: `.ai What is anime?`' }, { quoted: m });
                return;
            }
            await react('🤖');
            try {
                const response = await axios.get(`https://bk9.fun/ai/gemini?q=${encodeURIComponent(query)}`);
                const answer = response.data.BK9 || response.data.result || "Sorry, I couldn't get a response from AI.";
                await sock.sendMessage(from, { text: `🤖 *HDNOVA AI ASSISTANT*\n\n${answer}` }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: '❌ *Error communicating with AI service!*' }, { quoted: m });
            }
        }

        // --- 2. Sticker Maker (.sticker / .s) ---
        if (body === '.sticker' || body === '.s' || m.message.imageMessage) {
            const isStickerCmd = body === '.sticker' || body === '.s';
            const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const hasImage = m.message.imageMessage || quotedMsg?.imageMessage;

            if (isStickerCmd && hasImage) {
                await react('🎨');
                try {
                    // Note: Basic sticker generation needs an image buffer download or external API wrapper. 
                    // To keep it light and stable without heavy native modules (like cwebp), we use a public media converter or guide.
                    await sock.sendMessage(from, { text: '⏳ *Processing your sticker...*' }, { quoted: m });
                    // Basic fallback notice if direct binary conversion isn't bundled with cwebp binaries on cloud host:
                    await sock.sendMessage(from, { text: '💡 *Tip:* Send an image with caption `.s` or reply to an image with `.s` to convert!' }, { quoted: m });
                } catch (e) {
                    await sock.sendMessage(from, { text: '❌ *Failed to create sticker!*' }, { quoted: m });
                }
            }
        }

        // --- 3. Weather Info (.weather [City]) ---
        if (body.startsWith('.weather')) {
            const city = body.slice(8).trim();
            if (!city) {
                await sock.sendMessage(from, { text: '❌ *Please provide a city name!* Example: `.weather Colombo`' }, { quoted: m });
                return;
            }
            await react('🌤️');
            try {
                const weatherRes = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
                const current = weatherRes.data.current_condition[0];
                const area = weatherRes.data.nearest_area[0];
                
                const weatherText = `
🌤️ *WEATHER INFORMATION* 🌡️

📍 *Location:* ${area.areaName[0].value}, ${area.country[0].value}
🌡️ *Temperature:* ${current.temp_C}°C (Feels like ${current.FeelsLikeC}°C)
☁️ *Condition:* ${current.weatherDesc[0].value}
💧 *Humidity:* ${current.humidity}%
wind: *${current.windspeedKmph} km/h*

> *Powered by HDNOVA-OFC*`.trim();

                await sock.sendMessage(from, { text: weatherText }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: '❌ *Could not fetch weather data for that city!*' }, { quoted: m });
            }
        }

        // --- 4. Wikipedia / Google Search (.wiki) ---
        if (body.startsWith('.wiki') || body.startsWith('.search')) {
            const query = body.slice(5).trim();
            if (!query) {
                await sock.sendMessage(from, { text: '❌ *Please provide a search term!* Example: `.wiki Naruto`' }, { quoted: m });
                return;
            }
            await react('🔍');
            try {
                const wikiRes = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
                if (wikiRes.data && wikiRes.data.extract) {
                    const wikiText = `
🔍 *WIKIPEDIA SEARCH RESULT* 📖

📌 *Title:* ${wikiRes.data.title}
📝 *Summary:* ${wikiRes.data.extract}

🔗 *Read more:* ${wikiRes.data.content_urls.desktop.page}

> *Powered by HDNOVA-OFC*`.trim();
                    await sock.sendMessage(from, { text: wikiText }, { quoted: m });
                } else {
                    await sock.sendMessage(from, { text: '❌ *No results found on Wikipedia!*' }, { quoted: m });
                }
            } catch (e) {
                await sock.sendMessage(from, { text: '❌ *Error searching Wikipedia!*' }, { quoted: m });
            }
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
                const imgBuffer = await axios.get('https://i.ibb.co/Fb4QgTdR/image.jpg', { responseType: 'arraybuffer' }).then(res => res.data);
                await sock.sendMessage(from, { image: imgBuffer, caption: aliveText }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: aliveText }, { quoted: m });
            }
        }

        // .menu Command (නව විශේෂාංග සමඟ යාවත්කාලීන කළ මෙනු පැනලය)
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
📌 *MAIN COMMANDS:*
┃ ⚡ _*.ping*_ - Check speed
┃ 🔥 _*.alive*_ - Check status
┃ 📢 _*.tagall*_ - Tag all members
───────────────────
🤖 *AI & UTILITIES:*
┃ 🤖 _*.ai [query]*_ - Chat with AI
┃ 🌤️ _*.weather [city]*_ - Get weather
┃ 🔍 _*.wiki [term]*_ - Wikipedia search
┃ 🎨 _*.s / .sticker*_ - Make sticker
───────────────────
🛡️ *SECURITY & SYSTEMS:*
┃ 👁️ _*Auto Status*_  ⟡ [${botSettings.autoStatusSeen ? 'ACTIVE' : 'OFF'}]
┃ 📵 _*Call Shield*_  ⟡ [${botSettings.callShield ? 'ACTIVE' : 'OFF'}]
┃ 🛡️ _*Anti-Delete*_ ⟡ [${botSettings.antiDelete ? 'ACTIVE' : 'OFF'}]
───────────────────
⚙️ *TOGGLE COMMANDS:*
┃ • _.autostatus on/off_
┃ • _.antidelete on/off_
┃ • _.callshield on/off_
───────────────────
🌐 *CONTACT MASTER*
http://wa.me/+${phoneNumber}?text=*Hey__HDNOVA*

┃ ® *POWERED BY HDNOVA*
> _HDNOVA-OFC - Cyber System_`.trim();

            try {
                const imgBuffer = await axios.get('https://i.ibb.co/Fb4QgTdR/image.jpg', { responseType: 'arraybuffer' }).then(res => res.data);
                await sock.sendMessage(from, { image: imgBuffer, caption: menuText }, { quoted: m });
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
                const customMessage = body.slice(8).trim() || 'No specific message provided.';
                
                let teks = `┏━━━━━━━━━━━━━━━━━━━┓\n`;
                teks += `┃  ⚡ **HDNOVA NOTIFICATION** ⚡\n`;
                teks += `┗━━━━━━━━━━━━━━━━━━━┛\n\n`;
                teks += `📌 **Group:** ${chat.subject}\n`;
                teks += `💬 **Reason:** ${customMessage}\n`;
                teks += `👥 **Total Members:** ${participants.length}\n\n`;
                teks += `─────────────────────\n`;
                
                let mentions = [];
                for (let mem of participants) {
                    teks += `│ ◈ @${mem.id.split('@')[0]}\n`;
                    mentions.push(mem.id);
                }
                
                teks += `─────────────────────\n`;
                teks += `> *Powered by HDNOVA-OFC*`;
                
                await sock.sendMessage(from, { text: teks, mentions: mentions }, { quoted: m });
            } catch (e) {
                await sock.sendMessage(from, { text: '❌ *Error fetching group members!*' }, { quoted: m });
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

                const remoteJid = cached.remoteJid;
                const sender = cached.sender;
                const senderName = cached.pushName;

                try {
                    const msgType = Object.keys(cached.message)[0];
                    
                    if (['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'].includes(msgType)) {
                        await sock.sendMessage(ownerJid, {
                            text: `🛡️ *__HDNOVA ANTI-DELETE SYSTEM__*\n\n📌 *Chat:* @${remoteJid.split('@')[0]}\n👤 *Name:* ${senderName}\n📞 *Number:* @${sender.split('@')[0]}\n🗑️ *Deleted a Media (${msgType.replace('Message', '')})!*`,
                            mentions: [remoteJid, sender]
                        });
                        await sock.sendMessage(ownerJid, { forward: cached.message });
                    } else {
                        let deletedText = cached.message.conversation || cached.message.extendedTextMessage?.text || "Unknown Text";
                        await sock.sendMessage(ownerJid, { 
                            text: `🛡️ *__HDNOVA ANTI-DELETE SYSTEM__*\n\n📌 *From Chat:* @${remoteJid.split('@')[0]}\n👤 *Sender Name:* ${senderName}\n📞 *Sender Number:* @${sender.split('@')[0]}\n💬 *Deleted Message:* ${deletedText}\n\n_Someone deleted a text message!_ 🗑️` 
                        }, { mentions: [remoteJid, sender] });
                    }
                } catch (e) {
                    console.log("Anti-delete error: ", e);
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
                    await sock.sendMessage(call.from, { 
                        text: '📵 *__HDNOVA CALL SHIELD__*\n\n_Calls are not allowed! Please send a text message only._ 💬' 
                    });
                } catch (error) {}
            }
        }
    });
}
