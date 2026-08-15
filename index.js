// --- 1. Anti-Delete (Text, Media & Stickers) ---
sock.ev.on('messages.update', async (updates) => {
    if (!botSettings.antiDelete) return;
    for (const update of updates) {
        if (update.update && update.update.message === null) {
            const messageId = update.key.id;
            const cached = messageStore.get(messageId);
            if (!cached) return;

            const { remoteJid, sender, pushName, message } = cached;
            const msgType = Object.keys(message)[0];

            let text = `🛡️ *HDNOVA ANTI-DELETE*\n\n📌 *Chat:* @${remoteJid.split('@')[0]}\n👤 *Sender:* ${pushName || 'Unknown'}\n🗑️ *Deleted: ${msgType.replace('Message', '')}*`;
            
            await sock.sendMessage(ownerJid, { text, mentions: [remoteJid, sender] });
            
            // Media හෝ Sticker නම් ෆෝවර්ඩ් කිරීම
            if (['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage'].includes(msgType)) {
                await sock.sendMessage(ownerJid, { forward: { key: { remoteJid, id: messageId }, message: message } });
            } else {
                await sock.sendMessage(ownerJid, { text: `💬 *Content:* ${message.conversation || message.extendedTextMessage?.text || 'Empty'}` });
            }
        }
    }
});

// --- 2. Auto Status Seen & React ---
sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message) return;
    if (m.key.remoteJid === 'status@broadcast' && botSettings.autoStatusSeen) {
        await sock.readMessages([m.key]);
        const participant = m.key.participant || m.participant;
        if (participant) {
            await sock.sendMessage('status@broadcast', { react: { text: '💚', key: m.key } }, { statusJidList: [participant] });
        }
    }

    // --- 3. Commands Handling (AI, Wiki, Sticker) ---
    const from = m.key.remoteJid;
    const body = m.message.conversation || m.message.extendedTextMessage?.text || "";
    const isOwner = m.key.fromMe || ownerJid.includes(m.key.participant);

    if (body.startsWith('.ai ') || body.startsWith('.gpt ')) {
        await react('🤖');
        const query = body.slice(body.indexOf(' ') + 1);
        try {
            const res = await axios.get(`https://apis.davidcyriltech.my.id/ai/gemini?query=${encodeURIComponent(query)}`);
            await sock.sendMessage(from, { text: `🤖 *AI:* ${res.data.result}` }, { quoted: m });
        } catch { await sock.sendMessage(from, { text: '❌ *AI Error!*' }, { quoted: m }); }
    }

    if (body.startsWith('.wiki ') || body.startsWith('.search ')) {
        await react('🔍');
        const query = body.slice(body.indexOf(' ') + 1);
        try {
            const res = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
            await sock.sendMessage(from, { text: `📖 *${res.data.title}*\n\n${res.data.extract}` }, { quoted: m });
        } catch { await sock.sendMessage(from, { text: '❌ *Not found!*' }, { quoted: m }); }
    }

    if (body === '.s' || body === '.sticker' || m.message.imageMessage || m.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
        await react('🎨');
        try {
            let target = m.message.extendedTextMessage?.contextInfo?.quotedMessage ? { key: { remoteJid: from, id: m.message.extendedTextMessage.contextInfo.stanzaId }, message: m.message.extendedTextMessage.contextInfo.quotedMessage } : m;
            const buffer = await downloadMediaMessage(target, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
            await sock.sendMessage(from, { sticker: buffer }, { quoted: m });
        } catch (e) { await sock.sendMessage(from, { text: '❌ *Send/Reply image with .s*' }, { quoted: m }); }
    }
});
