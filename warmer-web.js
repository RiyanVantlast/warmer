import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import express from 'express';
import http from 'http';
import { Server as SocketIo } from 'socket.io';
import readline from 'readline';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import makeWASocket from '@whiskeysockets/baileys';
import { useMultiFileAuthState, delay, fetchLatestBaileysVersion, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===================== KONFIGURASI =====================
const SESSIONS_DIR = './sessions';
const BACKUPS_DIR = './backups';
const ACCOUNTS_FILE = './accounts.json';
const STATS_FILE = './stats.json';
const CONVERSATION_POOLS_FILE = './conversation-pools.json';
const STATUS_IMAGES_DIR = './status_images';
const IMAGES_DIR = './images';
const VIDEOS_DIR = './videos';
const STICKERS_DIR = './stickers';
const MAX_ACCOUNTS = 10;
const MIN_ACCOUNTS = 1;
const WEB_PORT = 3000;

// Jam aktif dengan variasi per akun (rentang ±60 menit dari base)
const BASE_ACTIVE_HOURS = { start: 8, end: 22 };
const ACTIVE_HOURS_VARIATION = 60; // menit

const MAX_DAILY_MESSAGES_PER_ACCOUNT = 100;
const TYPO_CHANCE = 0.01;
const MEDIA_CHANCE = 0.15;
const STICKER_CHANCE = 0.08;
const REACTION_CHANCE = 0.15;
const DELETE_TYPO_CHANCE = 0.6;
const LONG_MESSAGE_THRESHOLD = 200;
const LONG_MESSAGE_CHANCE = 0.05;

const AI_CHANCE = 1.0;
const THEME_ROTATION_INTERVAL = 10 * 60 * 1000; // 10 menit

// Konfigurasi Grup
const ENABLE_GROUP_CHAT = true;
const GROUP_CHANCE = 0.3;
const MAX_GROUP_MESSAGES_PER_DAY = 8;
const GROUP_REPLY_CHANCE = 0.5;
const GROUP_MENTION_CHANCE = 0.3;
const MAX_MENTIONS_PER_MESSAGE = 2;
const MIN_GROUP_PARTICIPANTS = 3;
const GROUP_COOLDOWN = 120;
const GLOBAL_GROUP_COOLDOWN = 60;
const MAX_GROUP_RESPONDERS_PER_WINDOW = 2;
const GROUP_RESPONSE_WINDOW = 5 * 60 * 1000;

const PAIR_COOLDOWN_SECONDS = 10;

// Konfigurasi Mode Multi‑Target
const TARGET_INTER_ACCOUNT_DELAY_MIN = 1;   // menit
const TARGET_INTER_ACCOUNT_DELAY_MAX = 5;   // menit
const TARGET_REPLY_PHASE_DURATION = 10;     // menit

// ===================== LOGGING =====================
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

const suppressedKeywords = [
    'SessionEntry', '_chains', 'registrationId', 'currentRatchet',
    'ephemeralKeyPair', 'indexInfo', 'pendingPreKey',
    'Closing open session in favor of incoming prekey bundle'
];

console.log = (...args) => {
    const msg = args.join(' ');
    if (suppressedKeywords.some(keyword => msg.includes(keyword))) return;
    originalConsoleLog(...args);
};
console.warn = originalConsoleWarn;
console.error = originalConsoleError;

process.on('unhandledRejection', (reason) => console.error('❌ Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => console.error('❌ Uncaught Exception:', err));

// AI Groq
let groq = null;
if (process.env.GROQ_API_KEY) {
    try {
        const { Groq } = await import('groq-sdk');
        groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        console.log('🤖 AI Groq diaktifkan');
    } catch (e) {}
}
const AI_ENABLED = !!groq;

// Buat direktori jika belum ada
[SESSIONS_DIR, BACKUPS_DIR, STATUS_IMAGES_DIR, IMAGES_DIR, VIDEOS_DIR, STICKERS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

function clearAllSessions() {
    [SESSIONS_DIR, BACKUPS_DIR].forEach(dir => {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`🧹 Folder ${dir} telah dihapus.`);
        }
        fs.mkdirSync(dir, { recursive: true });
    });
    console.log('🧹 Semua sesi dan backup telah dibersihkan.');
}

const UNIX_USER_AGENTS = [
    'WhatsApp/2.24.8.78 Linux/5.10.136-android12-9-00011-gd9f4a6c6e2db-ab8935265',
    'WhatsApp/2.24.9.26 Linux/5.15.41-android13-8-00044-g3f7e1e9e3d1c-ab1234567',
    'WhatsApp/2.24.10.15 Linux/5.10.168-android12-9-00003-gd3a8b5c1e8f2-ab9876543',
    'WhatsApp/2.24.8.85 Linux/5.4.210-qgki-00003-g1a2b3c4d5e6f-ab1122334',
    'WhatsApp/2.24.9.30 Linux/5.15.94-android13-4-00001-g2b3c4d5e6f7a-ab5566778',
];
function getRandomUserAgent() {
    return UNIX_USER_AGENTS[Math.floor(Math.random() * UNIX_USER_AGENTS.length)];
}

// Baca akun
let allAccounts = [];
const possiblePaths = [ACCOUNTS_FILE, path.join(process.cwd(), ACCOUNTS_FILE), path.join(__dirname, ACCOUNTS_FILE)];
let accountsFileFound = false;
for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
        try {
            allAccounts = JSON.parse(fs.readFileSync(p, 'utf8'));
            console.log(`✅ File accounts.json ditemukan`);
            accountsFileFound = true;
            break;
        } catch (e) {}
    }
}
if (!accountsFileFound) {
    const exampleAccounts = ["Account 1", "Account 2", "Account 3"];
    fs.writeFileSync(path.join(process.cwd(), ACCOUNTS_FILE), JSON.stringify(exampleAccounts, null, 2));
    console.log(`✅ File accounts.json dibuat dengan contoh. Silakan edit dan jalankan ulang.`);
    process.exit(0);
}
allAccounts = allAccounts.slice(0, MAX_ACCOUNTS);

// Statistik
let stats = { daily: {} };
if (fs.existsSync(STATS_FILE)) {
    try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (e) {}
}
function saveStats() { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); }
function recordMessageSent(accountId) {
    const today = new Date().toISOString().split('T')[0];
    if (!stats.daily[today]) stats.daily[today] = {};
    if (!stats.daily[today][accountId]) stats.daily[today][accountId] = 0;
    stats.daily[today][accountId]++;
    saveStats();
}

function backupSession(accountId) {
    const src = path.join(SESSIONS_DIR, accountId);
    if (!fs.existsSync(src)) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUPS_DIR, `${accountId}_${timestamp}`);
    fs.cpSync(src, dest, { recursive: true });
    console.log(`💾 Backup session ${accountId}`);
}
cron.schedule('0 3 * * *', () => {
    activeAccounts.forEach(acc => backupSession(acc));
});

// Web server
const app = express();
const server = http.createServer(app);
const io = new SocketIo(server);
app.use(express.static('public'));
app.use(express.json());

app.get('/api/status', (req, res) => {
    const status = {};
    for (const id of activeAccounts) {
        status[id] = {
            ready: isReady[id] || false,
            messagesToday: dailyMessageCount[id] || 0,
            groupMessagesToday: dailyGroupMessageCount[id] || 0,
            lastActivity: lastActivity[id] || null,
            jid: clients[id]?.user?.id ? getCleanJid(clients[id].user.id) : null
        };
    }
    res.json(status);
});
app.get('/api/stats/weekly', (req, res) => {
    const weekly = {};
    const now = new Date();
    for (let i = 0; i < 7; i++) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        weekly[dateStr] = stats.daily[dateStr] || {};
    }
    res.json(weekly);
});
app.post('/api/mode/normal', (req, res) => {
    simulateOnlyMode = false;
    oneTargetMode = false;
    targetPhase = 'idle';
    res.json({ success: true, message: 'Kembali ke mode normal' });
});
app.post('/api/mode/simulate', (req, res) => {
    if (!simulateOnlyMode) {
        simulateOnlyMode = true;
        oneTargetMode = false;
        simulateOnlyLoop().catch(console.error);
    }
    res.json({ success: true, message: 'Mode simulasi saja diaktifkan' });
});

// ===================== VARIASI JAM AKTIF PER AKUN =====================
const accountActiveHours = new Map();

function generateActiveHours() {
    const variationMinutes = ACTIVE_HOURS_VARIATION;
    const startBase = BASE_ACTIVE_HOURS.start * 60;
    const endBase = BASE_ACTIVE_HOURS.end * 60;
    const startOffset = Math.floor(Math.random() * (variationMinutes * 2 + 1)) - variationMinutes;
    const endOffset = Math.floor(Math.random() * (variationMinutes * 2 + 1)) - variationMinutes;
    let start = startBase + startOffset;
    let end = endBase + endOffset;
    start = Math.max(0, Math.min(23*60, start));
    end = Math.max(0, Math.min(23*60, end));
    return { start: Math.floor(start / 60), end: Math.floor(end / 60) };
}

function isActiveHoursForAccount(accountId) {
    if (modeOperasi !== 'weekday') return true;
    let hours = accountActiveHours.get(accountId);
    if (!hours) {
        hours = generateActiveHours();
        accountActiveHours.set(accountId, hours);
    }
    const now = new Date();
    const hour = now.getHours();
    return hour >= hours.start && hour < hours.end;
}

// ===================== FITUR STATUS (NONAKTIF UNTUK SIMULASI) =====================
const lastStatusSent = {};
const weekendStatusCount = {};

async function sendStatus(accountId) {
    // Tidak digunakan dalam mode simulasi saja, hanya untuk weekday/weekend normal
    const sock = clients[accountId];
    if (!sock || !isReady[accountId]) return false;
    const today = new Date().toISOString().split('T')[0];
    const isWeekendNow = isWeekend();
    if (!isWeekendNow) {
        if (lastStatusSent[accountId] === today) return false;
    } else {
        if (!weekendStatusCount[accountId]) weekendStatusCount[accountId] = 0;
        if (weekendStatusCount[accountId] >= 3) return false;
    }
    try {
        let imageUrl;
        const imageFiles = fs.readdirSync(STATUS_IMAGES_DIR).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
        if (imageFiles.length > 0) {
            imageUrl = path.join(STATUS_IMAGES_DIR, randomItem(imageFiles));
        } else {
            imageUrl = 'https://picsum.photos/1080/1920';
        }
        const caption = `Hari ini ${new Date().toLocaleDateString('id-ID')}`;
        await sock.sendMessage('status@broadcast', { image: { url: imageUrl }, caption });
        if (!isWeekendNow) lastStatusSent[accountId] = today;
        else weekendStatusCount[accountId]++;
        io.emit('log', { account: accountId, message: `📱 Mengirim status: "${caption}"` });
        return true;
    } catch (err) {
        console.error(`❌ [${accountId}] Gagal kirim status:`, err.message);
        return false;
    }
}

cron.schedule('0 8 * * *', async () => {
    if (modeOperasi === 'weekday' && !oneTargetMode && !simulateOnlyMode) {
        for (const id of activeAccounts) {
            await sendStatus(id);
            await delay(5000);
        }
    }
});

async function scheduleRandomWeekendStatus() {
    if (modeOperasi !== 'weekend') return;
    for (const id of activeAccounts) {
        if (!weekendStatusCount[id]) weekendStatusCount[id] = 0;
        if (weekendStatusCount[id] < 3) {
            setTimeout(async () => { await sendStatus(id); }, Math.random() * 7200000);
        }
    }
}

// ===================== AI GENERATION =====================
const AI_PROMPTS = {
    greeting: [
        `Buatkan pesan sapaan singkat dalam bahasa Indonesia yang natural dan berbeda-beda. Jangan terlalu formal. Maksimal 12 kata.`,
        `Tulis sapaan santai untuk teman, seperti orang Indonesia biasa ngobrol. Maksimal 10 kata.`,
        `Buat kalimat pembuka percakapan yang casual, tidak kaku. Contoh: "Eh, lagi ngapain?" atau sejenisnya. Maksimal 10 kata.`
    ],
    reply: [
        `Buatkan balasan singkat dalam bahasa Indonesia yang sesuai dengan konteks santai. Hindari kalimat klise. Maksimal 12 kata.`,
        `Respon untuk percakapan biasa, seperti "Oh gitu ya" atau "Wah serius?". Maksimal 10 kata.`,
        `Balasan yang alami untuk teman ngobrol, tidak perlu terlalu panjang. Maksimal 12 kata.`
    ],
    closing: [
        `Buatkan pesan perpisahan singkat dalam bahasa Indonesia yang natural. Contoh: "Ok deh, aku off dulu ya". Maksimal 8 kata.`,
        `Kalimat penutup percakapan yang santai, tidak terkesan mendadak. Maksimal 8 kata.`
    ],
    fallback: [
        `Buatkan balasan netral singkat dalam bahasa Indonesia untuk situasi tidak jelas. Maksimal 8 kata.`,
        `Respon umum seperti "Maaf, lagi sibuk" atau "Bentar ya". Maksimal 8 kata.`
    ]
};

async function generateAIMessage(context = 'greeting') {
    if (!groq) return null;
    const prompts = AI_PROMPTS[context] || AI_PROMPTS.fallback;
    const prompt = randomItem(prompts);
    try {
        const completion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.9,
            max_tokens: 40,
        });
        let msg = completion.choices[0]?.message?.content?.trim();
        if (msg && msg.length > 2 && msg.length < 60) return msg.replace(/["']/g, '');
    } catch (e) {}
    return null;
}

async function generateContextualReply(receivedText) {
    if (!groq) return null;
    const prompt = `Balas pesan berikut dalam bahasa Indonesia dengan singkat, santai, dan relevan. Maksimal 15 kata.\nPesan: "${receivedText}"\nBalasan:`;
    try {
        const completion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama-3.3-70b-versatile',
            temperature: 0.9,
            max_tokens: 40,
        });
        let msg = completion.choices[0]?.message?.content?.trim();
        if (msg && msg.length > 2 && msg.length < 60) return msg.replace(/["']/g, '');
    } catch (e) {}
    return null;
}

// ===================== PESAN POOL =====================
const defaultMessagePools = {
    greeting: ["Hai, lagi ngapain?", "Halo! Gimana kabarnya?", "Eh, lama gak denger kabar nih", "Wah, tumben online 😄"],
    reply: ["Oh gitu ya.. menarik juga", "Wah serius?", "Hmm iya juga sih", "Boleh juga tuh idenya"],
    closing: ["Ok deh, aku off dulu ya. Ada kerjaan", "Sip, nanti disambung lagi. Dadah!", "Wah maaf lagi buru-buru"],
    fallback: ["Maaf, lagi rame nih. Bisa diulang?", "Waduh aku kurang paham maksudnya 😅", "Bentar ya, lagi di luar"],
    mediaCaptions: ["Lihat nih", "Keren ya?", "Random aja", "🤔", "Lagi jalan-jalan nih", "Abis hunting foto"],
    image_replies: ["Wah gambarnya keren!", "Lucu banget!", "Mantap nih", "Apa nih?", "Bagus gambarnya", "Haha kreatif", "Mana dapat gambar ini?", "😄", "👍"]
};
let messagePools = { ...defaultMessagePools };
if (fs.existsSync(CONVERSATION_POOLS_FILE)) {
    try {
        const externalPools = JSON.parse(fs.readFileSync(CONVERSATION_POOLS_FILE, 'utf8'));
        for (const [key, messages] of Object.entries(externalPools)) {
            if (messagePools[key]) messagePools[key] = [...new Set([...messagePools[key], ...messages])];
            else messagePools[key] = messages;
        }
        console.log(`📚 Loaded conversation pools`);
    } catch (e) {}
}
const availableThemes = Object.keys(messagePools).filter(key => 
    Array.isArray(messagePools[key]) && messagePools[key].length > 0 &&
    !['greeting', 'reply', 'closing', 'fallback', 'mediaCaptions', 'image_replies'].includes(key)
);
console.log(`📌 ${availableThemes.length} tema siap.`);

let currentTheme = availableThemes.length > 0 ? randomItem(availableThemes) : 'greeting';
let globalThemeInterval = null;

function resetConversationState() {
    pendingReplies.clear();
    pairCooldown.clear();
    pairLocks.clear();
    for (let key in accountLastSendTime) delete accountLastSendTime[key];
    for (let key in groupLastMessageTime) delete groupLastMessageTime[key];
    groupResponseTracker.clear();
    console.log('🔄 State percakapan direset untuk tema baru');
}

const messageLocks = new Map();

async function claimMessage(pool, accountId, lockDurationMs = 15000) {
    if (!pool || pool.length === 0) return null;
    let available = pool.filter(msg => !messageLocks.has(msg));
    if (available.length === 0) {
        await delay(500);
        available = pool;
    }
    const chosen = randomItem(available);
    messageLocks.set(chosen, accountId);
    setTimeout(() => messageLocks.delete(chosen), lockDurationMs);
    return chosen;
}

async function getMessageFromPool(poolName, accountId) {
    if (AI_ENABLED && Math.random() < AI_CHANCE) {
        const aiMsg = await generateAIMessage(poolName);
        if (aiMsg && !messageLocks.has(aiMsg)) {
            messageLocks.set(aiMsg, accountId);
            setTimeout(() => messageLocks.delete(aiMsg), 15000);
            return aiMsg;
        }
    }
    const pool = messagePools[poolName] || messagePools.fallback;
    return await claimMessage(pool, accountId);
}

// Global state
const clients = {};
const isReady = {};
const dailyMessageCount = {};
const dailyGroupMessageCount = {};
const lastActivity = {};
let lastStoryCheck = {};
let activeAccounts = [];
let modeOperasi = 'weekday';
const groupCache = {};
const groupLastMessageTime = {};
const accountLastSendTime = {};
const pairCooldown = new Map();
const pairLocks = new Map();
const pendingReplies = new Map();
const groupResponseTracker = new Map();

// ===================== MODE TARGET & SIMULASI SAJA =====================
let oneTargetMode = false;          // mode target aktif (multi target)
let simulateOnlyMode = false;       // mode hanya simulasi (non‑chat)
let targetNumbers = [];             // daftar nomor target (array)
let currentTargetIndex = 0;         // indeks target yang sedang diproses
let targetPhase = 'idle';           // 'sending', 'replying', 'completed'
let targetModeQueue = [];
let targetModeCompleted = new Set();
let allowedReplyNumbers = new Set(); // nomor yang boleh dibalas (target yang sudah selesai fase sending)

// ===================== FUNGSI SIMULASI MANDIRI (scroll saja) =====================
async function performSoloSimulation(accountId) {
    if (!isReady[accountId]) return;
    try {
        // Hanya lakukan simulasi scroll (presence update)
        await clients[accountId].sendPresenceUpdate('available');
        await delay(4000 + Math.random() * 6000);
        await clients[accountId].sendPresenceUpdate('unavailable');
        io.emit('log', { account: accountId, message: '📱 Simulasi scroll' });
    } catch (err) {
        // ignore
    }
}

async function simulateOnlyLoop() {
    console.log('🎭 Memulai mode Simulasi Saja (tidak ada chat).');
    io.emit('log', { account: 'SYSTEM', message: '🎭 Mode Simulasi Saja aktif. Akun hanya akan melakukan aktivitas scroll.' });

    while (simulateOnlyMode) {
        const readyAccounts = activeAccounts.filter(id => isReady[id]);
        for (const acc of readyAccounts) {
            await performSoloSimulation(acc);
            await delay(2000 + Math.random() * 5000);
        }
        const waitMinutes = 3 + Math.floor(Math.random() * 6);
        const waitMs = waitMinutes * 60 * 1000;
        console.log(`⏳ Mode simulasi: menunggu ${waitMinutes} menit sebelum siklus berikutnya.`);
        await delay(waitMs);
    }
    
    console.log('🛑 Mode Simulasi Saja dihentikan.');
    io.emit('log', { account: 'SYSTEM', message: '🛑 Mode Simulasi Saja dihentikan.' });
}

// ===================== FUNGSI TARGET MULTI =====================
async function sendOneTargetMessage(accountId, targetJid) {
    const sock = clients[accountId];
    if (!sock || !isReady[accountId]) return false;

    const themeMessages = messagePools[currentTheme] || messagePools.greeting;
    let rawMessage = await claimMessage(themeMessages, accountId, 30000);
    if (!rawMessage) rawMessage = "Halo, ini pesan otomatis.";

    try {
        await sock.sendPresenceUpdate('composing', targetJid);
        await delay(2000 + Math.random() * 3000);
        const sent = await sock.sendMessage(targetJid, { text: rawMessage });
        if (sent) {
            dailyMessageCount[accountId] = (dailyMessageCount[accountId] || 0) + 1;
            recordMessageSent(accountId);
            lastActivity[accountId] = new Date().toLocaleTimeString();
            io.emit('log', { account: accountId, message: `🎯 [SELESAI] Kirim ke target: "${rawMessage}"` });
            broadcastStatus();
            return true;
        }
    } catch (err) {
        console.error(`❌ [${accountId}] Gagal kirim ke target:`, err.message);
        io.emit('log', { account: accountId, message: `❌ Gagal kirim: ${err.message}` });
    }
    return false;
}

async function targetModeCoordinator() {
    console.log(`🎯 Koordinator multi-target dimulai. ${targetNumbers.length} target, ${targetModeQueue.length} akun.`);
    io.emit('log', { account: 'SYSTEM', message: `🎯 Mode Multi-Target dimulai. ${targetNumbers.length} target akan diproses.` });

    for (let idx = 0; idx < targetNumbers.length; idx++) {
        currentTargetIndex = idx;
        const currentTarget = targetNumbers[idx];
        const targetJid = `${currentTarget}@s.whatsapp.net`;
        console.log(`\n📌 Memproses target ${idx+1}/${targetNumbers.length}: ${currentTarget}`);
        io.emit('log', { account: 'SYSTEM', message: `📌 Target ${idx+1}: ${currentTarget}` });

        // Fase pengiriman (sending)
        targetPhase = 'sending';
        const queue = [...targetModeQueue].filter(id => !targetModeCompleted.has(id));
        if (queue.length === 0) {
            console.log('⚠️ Tidak ada akun tersisa untuk mengirim.');
            break;
        }

        for (let i = 0; i < queue.length; i++) {
            const accountId = queue[i];
            if (!isReady[accountId] || !clients[accountId]) {
                console.log(`⚠️ Akun ${accountId} tidak siap, dilewati.`);
                continue;
            }

            io.emit('log', { account: accountId, message: `📢 Giliran mengirim ke ${currentTarget}...` });
            
            // Pemanasan singkat
            await performSoloSimulation(accountId);
            await delay(10000 + Math.random() * 20000); // 10-30 detik

            const success = await sendOneTargetMessage(accountId, targetJid);
            if (success) {
                targetModeCompleted.add(accountId);
            }

            // Jeda antar akun (1-5 menit)
            if (i < queue.length - 1) {
                const waitMinutes = TARGET_INTER_ACCOUNT_DELAY_MIN + 
                                    Math.floor(Math.random() * (TARGET_INTER_ACCOUNT_DELAY_MAX - TARGET_INTER_ACCOUNT_DELAY_MIN + 1));
                const waitMs = waitMinutes * 60 * 1000;
                console.log(`⏳ Menunggu ${waitMinutes} menit sebelum akun berikutnya...`);
                io.emit('log', { account: 'SYSTEM', message: `⏳ Jeda ${waitMinutes} menit sebelum giliran berikutnya.` });
                
                const remainingAccounts = queue.slice(i + 1).filter(id => !targetModeCompleted.has(id));
                const startWait = Date.now();
                while (Date.now() - startWait < waitMs) {
                    for (const acc of remainingAccounts) {
                        if (isReady[acc]) await performSoloSimulation(acc);
                    }
                    await delay(60000); // cek tiap 1 menit
                }
            }
        }

        console.log(`✅ Semua akun selesai mengirim ke target ${currentTarget}.`);
        io.emit('log', { account: 'SYSTEM', message: `✅ Fase kirim target ${idx+1} selesai.` });

        // Fase balasan (replying) - hanya izinkan reply dari nomor ini
        targetPhase = 'replying';
        allowedReplyNumbers.add(currentTarget);
        console.log(`💬 Fase balasan untuk ${currentTarget} dimulai (${TARGET_REPLY_PHASE_DURATION} menit).`);
        io.emit('log', { account: 'SYSTEM', message: `💬 Selama ${TARGET_REPLY_PHASE_DURATION} menit, akun boleh membalas pesan dari ${currentTarget}.` });

        // Tunggu selama durasi balasan
        await delay(TARGET_REPLY_PHASE_DURATION * 60 * 1000);

        // Hapus izin balas untuk nomor ini
        allowedReplyNumbers.delete(currentTarget);
        console.log(`🔒 Fase balasan untuk ${currentTarget} berakhir.`);
        io.emit('log', { account: 'SYSTEM', message: `🔒 Fase balasan target ${idx+1} berakhir.` });

        // Reset completed set untuk target berikutnya (semua akun bisa kirim lagi)
        targetModeCompleted.clear();
    }

    // Semua target selesai
    console.log('🎉 Semua target telah diproses. Beralih ke mode simulasi saja.');
    io.emit('log', { account: 'SYSTEM', message: '🎉 Semua target selesai. Masuk mode simulasi (tanpa chat).' });
    
    oneTargetMode = false;
    targetPhase = 'completed';
    allowedReplyNumbers.clear();
    
    simulateOnlyMode = true;
    simulateOnlyLoop().catch(err => {
        console.error('❌ Error pada loop simulasi:', err);
        simulateOnlyMode = false;
    });
}

function startTargetMode(targetNumbersInput) {
    if (!targetNumbersInput || targetNumbersInput.length === 0) {
        console.error('❌ Daftar nomor target kosong.');
        return;
    }

    const readyAccounts = activeAccounts.filter(id => isReady[id] && clients[id]);
    if (readyAccounts.length === 0) {
        console.error('❌ Tidak ada akun yang siap untuk mode target.');
        return;
    }

    targetNumbers = targetNumbersInput.map(num => num.replace(/\D/g, ''));
    targetModeQueue = [...readyAccounts];
    targetModeCompleted.clear();
    allowedReplyNumbers.clear();
    oneTargetMode = true;
    simulateOnlyMode = false;
    currentTargetIndex = 0;
    targetPhase = 'idle';

    if (globalThemeInterval) {
        clearInterval(globalThemeInterval);
        globalThemeInterval = null;
    }

    targetModeCoordinator().catch(err => {
        console.error('❌ Error pada koordinator target:', err);
        oneTargetMode = false;
    });
}

// ===================== FUNGSI GRUP & LAINNYA =====================
function canReplyToGroup(groupJid, accountId) {
    const now = Date.now();
    const record = groupResponseTracker.get(groupJid);
    if (!record || (now - record.timestamp) > GROUP_RESPONSE_WINDOW) {
        groupResponseTracker.set(groupJid, { accounts: new Set([accountId]), timestamp: now });
        return true;
    }
    if (record.accounts.size >= MAX_GROUP_RESPONDERS_PER_WINDOW) return false;
    if (record.accounts.has(accountId)) return false;
    record.accounts.add(accountId);
    return true;
}

function resetDailyCounts() {
    Object.keys(clients).forEach(id => {
        dailyMessageCount[id] = 0;
        dailyGroupMessageCount[id] = 0;
    });
}
resetDailyCounts();
setInterval(resetDailyCounts, 24 * 60 * 60 * 1000);

function isWeekend() { const day = new Date().getDay(); return day === 0 || day === 6; }

function broadcastStatus() {
    const status = {};
    for (const id of activeAccounts) {
        status[id] = {
            ready: isReady[id] || false,
            messagesToday: dailyMessageCount[id] || 0,
            groupMessagesToday: dailyGroupMessageCount[id] || 0,
            lastActivity: lastActivity[id] || null,
            jid: clients[id]?.user?.id ? getCleanJid(clients[id].user.id) : null
        };
    }
    io.emit('status-update', status);
}

function getCleanJid(jid) { if (!jid) return jid; return jid.replace(/:\d+(?=@)/, ''); }
function randomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ===================== FUNGSI MEDIA & STIKER =====================
function getRandomMediaFromFolder(folder, extensions) {
    if (!fs.existsSync(folder)) return null;
    const files = fs.readdirSync(folder).filter(f => extensions.some(ext => f.toLowerCase().endsWith(ext)));
    if (files.length === 0) return null;
    return path.join(folder, randomItem(files));
}

async function sendMedia(sock, jid, type, caption = '') {
    let mediaPath = null;
    if (type === 'image') mediaPath = getRandomMediaFromFolder(IMAGES_DIR, ['.jpg', '.jpeg', '.png', '.webp']);
    else if (type === 'video') mediaPath = getRandomMediaFromFolder(VIDEOS_DIR, ['.mp4', '.mov', '.webm']);
    if (!mediaPath) {
        if (type === 'image') return await sock.sendMessage(jid, { image: { url: 'https://picsum.photos/300/300' }, caption });
        else return null;
    }
    const mediaBuffer = fs.readFileSync(mediaPath);
    const message = type === 'image' 
        ? { image: mediaBuffer, caption }
        : { video: mediaBuffer, caption };
    return await sock.sendMessage(jid, message);
}

async function sendSticker(sock, jid) {
    let stickerPath = getRandomMediaFromFolder(STICKERS_DIR, ['.webp']);
    if (!stickerPath) return null;
    const stickerBuffer = fs.readFileSync(stickerPath);
    return await sock.sendMessage(jid, { sticker: stickerBuffer });
}

async function sendReaction(sock, messageKey, emoji) {
    const reactionEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉', '💯', '😎'];
    const chosenEmoji = emoji || randomItem(reactionEmojis);
    try {
        await sock.sendMessage(messageKey.remoteJid, { react: { text: chosenEmoji, key: messageKey } });
        return true;
    } catch (e) { return false; }
}

// ===================== FUNGSI GRUP =====================
async function fetchGroupsForAccount(accountId) {
    const sock = clients[accountId];
    if (!sock || !isReady[accountId]) return [];
    try {
        if (groupCache[accountId] && groupCache[accountId].timestamp > Date.now() - 3600000) {
            return groupCache[accountId].groups;
        }
        const result = await sock.groupFetchAllParticipating();
        const groups = Object.values(result).filter(g => g.participants && g.participants.length >= MIN_GROUP_PARTICIPANTS);
        groupCache[accountId] = { groups, timestamp: Date.now() };
        return groups;
    } catch (err) {
        console.error(`❌ [${accountId}] Gagal fetch grup:`, err.message);
        return [];
    }
}
async function getRandomGroup(accountId) {
    const groups = await fetchGroupsForAccount(accountId);
    if (groups.length === 0) return null;
    return randomItem(groups);
}
function canSendToGroup(accountId, groupJid) {
    const key = `${accountId}|${groupJid}`;
    const lastTime = groupLastMessageTime[key] || 0;
    return (Date.now() - lastTime) >= GROUP_COOLDOWN * 1000;
}
function markGroupMessageSent(accountId, groupJid) {
    groupLastMessageTime[`${accountId}|${groupJid}`] = Date.now();
}
function getRandomParticipants(metadata, count) {
    if (!metadata || !metadata.participants) return [];
    const participants = metadata.participants.map(p => p.id).filter(Boolean);
    if (participants.length === 0) return [];
    const shuffled = [...participants].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, participants.length));
}

const typoVariations = [
    (s) => s.replace(/a/g, 's'),
    (s) => s.replace(/i/g, 'o'),
    (s) => s.replace(/e/g, 'r'),
    (s) => s.slice(0, -1) + s.slice(-1).repeat(2),
    (s) => s.replace(/ /g, ''),
    (s) => s.split('').reverse().join(''),
];
function applyTypo(text) {
    if (Math.random() > TYPO_CHANCE) return text;
    const typoFunc = randomItem(typoVariations);
    return typoFunc(text);
}

async function sendGroupMessage(senderId, groupMetadata, isReply = false, replyContext = '') {
    const sender = clients[senderId];
    if (!sender || !isReady[senderId]) return false;
    const groupJid = groupMetadata.id;
    if (!canSendToGroup(senderId, groupJid)) return false;
    const globalKey = `global|${groupJid}`;
    if (Date.now() - (groupLastMessageTime[globalKey] || 0) < GLOBAL_GROUP_COOLDOWN * 1000) return false;
    if ((dailyGroupMessageCount[senderId] || 0) >= MAX_GROUP_MESSAGES_PER_DAY) return false;
    
    let rawMessage;
    if (isReply) {
        rawMessage = await getMessageFromPool(replyContext || 'fallback', senderId);
    } else {
        const themeMessages = getCurrentThemeMessages();
        rawMessage = await claimMessage(themeMessages, senderId, 30000);
        if (!rawMessage) rawMessage = await getMessageFromPool('greeting', senderId);
    }
    if (!rawMessage) return false;
    
    if (!isReply && Math.random() < LONG_MESSAGE_CHANCE) {
        const longMessages = [
            "Sebenernya aku udah lama mikir tentang hal ini. Menurutku pribadi, ini agak rumit sih. Tapi ya gimana ya, namanya juga hidup. Yang penting kita saling mengerti aja. 😅",
            "Wah, topik yang menarik nih. Aku jadi kepikiran beberapa hal. Mungkin nanti kita bahas lebih lanjut ya. Sekarang lagi agak sibuk soalnya.",
            "Maaf baru balas, tadi lagi meeting. Jadi gini, intinya sih... ah sudahlah, nanti aku cerita lengkapnya kalau sudah ada waktu luang."
        ];
        rawMessage = randomItem(longMessages);
    }
    if (!isReply && Math.random() < 0.4) {
        const suffixes = [" hehe", " 😅", " btw", " sih", " ya", " nih", " loh", " guys", " semuanya", " juga", " deh"];
        rawMessage += randomItem(suffixes);
    }
    
    let mentions = [];
    let mentionText = rawMessage;
    if (!isReply && Math.random() < GROUP_MENTION_CHANCE) {
        const participantsToMention = getRandomParticipants(groupMetadata, MAX_MENTIONS_PER_MESSAGE);
        if (participantsToMention.length > 0) {
            mentions = participantsToMention;
            const mentionNames = participantsToMention.map(jid => `@${jid.split('@')[0]}`).filter(Boolean);
            if (mentionNames.length > 0) mentionText = `${mentionNames.join(' ')} ${rawMessage}`;
        }
    }
    const finalText = applyTypo(mentionText);
    try {
        if (isReply) await delay(2000 + Math.random() * 6000);
        else await delay(1500 + Math.random() * 3000);
        await sender.sendPresenceUpdate('composing', groupJid);
        await delay(2000 + Math.random() * 3000);
        const messageOptions = { text: finalText };
        if (mentions.length > 0) messageOptions.mentions = mentions;
        const sent = await sender.sendMessage(groupJid, messageOptions);
        if (!sent) return false;
        
        if (finalText !== mentionText && Math.random() < DELETE_TYPO_CHANCE) {
            await delay(2500);
            await sender.sendMessage(groupJid, { delete: sent.key });
            await delay(2000);
            const correctOptions = { text: mentionText };
            if (mentions.length > 0) correctOptions.mentions = mentions;
            await sender.sendMessage(groupJid, correctOptions);
            io.emit('log', { account: senderId, message: `✏️ Typo dikoreksi di grup ${groupMetadata.subject}` });
        }
        dailyGroupMessageCount[senderId] = (dailyGroupMessageCount[senderId] || 0) + 1;
        dailyMessageCount[senderId] = (dailyMessageCount[senderId] || 0) + 1;
        lastActivity[senderId] = new Date().toLocaleTimeString();
        recordMessageSent(senderId);
        markGroupMessageSent(senderId, groupJid);
        groupLastMessageTime[globalKey] = Date.now();
        io.emit('log', { account: senderId, message: `💬 Grup: "${rawMessage}" ke ${groupMetadata.subject}` });
        broadcastStatus();
        return true;
    } catch (err) {
        console.error(`❌ [${senderId}] Error kirim pesan grup:`, err.message);
        if (err.message?.includes('No sessions')) isReady[senderId] = false;
        return false;
    }
}

// ===================== FUNGSI PENGIRIMAN PESAN 1-1 =====================
function getCurrentThemeMessages() {
    if (messagePools[currentTheme]?.length) return messagePools[currentTheme];
    const themesWithMessages = availableThemes.filter(t => messagePools[t]?.length);
    if (themesWithMessages.length) {
        currentTheme = randomItem(themesWithMessages);
        return messagePools[currentTheme];
    }
    return messagePools.greeting;
}

function getPairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
function isPairInCooldown(senderId, receiverId) {
    const key = getPairKey(senderId, receiverId);
    return (Date.now() - (pairCooldown.get(key) || 0)) < PAIR_COOLDOWN_SECONDS * 1000;
}
function setPairCooldown(senderId, receiverId) {
    pairCooldown.set(getPairKey(senderId, receiverId), Date.now());
}
async function acquirePairLock(senderId, receiverId) {
    const key = getPairKey(senderId, receiverId);
    while (pairLocks.get(key)) await delay(100);
    pairLocks.set(key, true);
}
function releasePairLock(senderId, receiverId) {
    pairLocks.delete(getPairKey(senderId, receiverId));
}
function canSendMessage(senderId, receiverId) {
    const key = getPairKey(senderId, receiverId);
    const lastSender = pendingReplies.get(key);
    return !lastSender || lastSender === receiverId;
}
function markMessageSent(senderId, receiverId) { pendingReplies.set(getPairKey(senderId, receiverId), senderId); }
function markReplyReceived(senderId, receiverId) { pendingReplies.delete(getPairKey(senderId, receiverId)); }

async function sendHumanLikeMessage(senderId, receiverId, isReply = false, replyContext = '', receivedText = '', isMediaReply = false) {
    const sender = clients[senderId];
    const receiver = clients[receiverId];
    if (!sender || !receiver || !isReady[senderId] || !isReady[receiverId] || !receiver.user?.id) return false;
    if (modeOperasi === 'weekday' && !isActiveHoursForAccount(senderId)) return false;
    if ((dailyMessageCount[senderId] || 0) >= MAX_DAILY_MESSAGES_PER_ACCOUNT) return false;
    if (!isReply) {
        const now = Date.now();
        if (accountLastSendTime[senderId] && now - accountLastSendTime[senderId] < 20000) return false;
        accountLastSendTime[senderId] = now;
    }
    if (!isReply && isPairInCooldown(senderId, receiverId)) return false;
    if (!isReply && !canSendMessage(senderId, receiverId)) return false;
    
    await acquirePairLock(senderId, receiverId);
    try {
        const receiverJid = getCleanJid(receiver.user.id);
        console.log(`📤 [${senderId}] -> ${receiverId} | Tema: ${currentTheme}`);
        
        if (isReply && Math.random() < REACTION_CHANCE && !isMediaReply) {
            setTimeout(() => sendReaction(sender, { remoteJid: receiverJid, id: 'temp' }, null), 1000);
        }
        
        if (isMediaReply) {
            let replyMessage = await getMessageFromPool('image_replies', senderId);
            if (!replyMessage) replyMessage = "Wah menarik!";
            await delay(1500 + Math.random() * 3000);
            await sender.sendPresenceUpdate('composing', receiverJid);
            await delay(2000 + Math.random() * 3000);
            const sent = await sender.sendMessage(receiverJid, { text: replyMessage });
            if (sent) {
                dailyMessageCount[senderId] = (dailyMessageCount[senderId] || 0) + 1;
                lastActivity[senderId] = new Date().toLocaleTimeString();
                recordMessageSent(senderId);
                markReplyReceived(senderId, receiverId);
                setPairCooldown(senderId, receiverId);
                io.emit('log', { account: senderId, message: `🖼️ Balas media: "${replyMessage}" ke ${receiverId}` });
                broadcastStatus();
                return true;
            }
            return false;
        }
        
        if (!isReply && Math.random() < STICKER_CHANCE) {
            const stickerSent = await sendSticker(sender, receiverJid);
            if (stickerSent) {
                dailyMessageCount[senderId] = (dailyMessageCount[senderId] || 0) + 1;
                lastActivity[senderId] = new Date().toLocaleTimeString();
                recordMessageSent(senderId);
                markMessageSent(senderId, receiverId);
                setPairCooldown(senderId, receiverId);
                io.emit('log', { account: senderId, message: `🎨 Kirim stiker ke ${receiverId}` });
                broadcastStatus();
                return true;
            }
        }
        
        const useMedia = !isReply && Math.random() < MEDIA_CHANCE;
        if (useMedia) {
            const caption = await getMessageFromPool('mediaCaptions', senderId);
            await delay(2500 + Math.random() * 3000);
            await sender.sendPresenceUpdate('composing', receiverJid);
            await delay(1500 + Math.random() * 2000);
            const result = await sendMedia(sender, receiverJid, 'image', caption || '');
            if (result) {
                dailyMessageCount[senderId] = (dailyMessageCount[senderId] || 0) + 1;
                lastActivity[senderId] = new Date().toLocaleTimeString();
                recordMessageSent(senderId);
                if (!isReply) markMessageSent(senderId, receiverId);
                else markReplyReceived(senderId, receiverId);
                setPairCooldown(senderId, receiverId);
                io.emit('log', { account: senderId, message: `📸 Kirim media ke ${receiverId}` });
                broadcastStatus();
                return true;
            }
            return false;
        }
        
        let rawMessage;
        const isReceivedTypo = receivedText && (receivedText.includes('ss') || receivedText.includes('oo') || (receivedText.length > 5 && Math.random() < 0.3));
        if (isReply && !isReceivedTypo && AI_ENABLED && Math.random() < AI_CHANCE) {
            const aiReply = await generateContextualReply(receivedText);
            if (aiReply && !messageLocks.has(aiReply)) {
                rawMessage = aiReply;
                messageLocks.set(aiReply, senderId);
                setTimeout(() => messageLocks.delete(aiReply), 15000);
            }
        }
        if (!rawMessage) {
            if (isReply) rawMessage = await getMessageFromPool(replyContext || 'fallback', senderId);
            else {
                const themeMessages = getCurrentThemeMessages();
                rawMessage = await claimMessage(themeMessages, senderId);
                if (!rawMessage) rawMessage = await getMessageFromPool('greeting', senderId);
            }
        }
        if (!rawMessage) return false;
        
        if (!isReply && Math.random() < LONG_MESSAGE_CHANCE) {
            const longMessages = [
                "Sebenernya aku udah lama mikir tentang hal ini. Menurutku pribadi, ini agak rumit sih. Tapi ya gimana ya, namanya juga hidup. Yang penting kita saling mengerti aja. 😅",
                "Wah, topik yang menarik nih. Aku jadi kepikiran beberapa hal. Mungkin nanti kita bahas lebih lanjut ya. Sekarang lagi agak sibuk soalnya.",
                "Maaf baru balas, tadi lagi meeting. Jadi gini, intinya sih... ah sudahlah, nanti aku cerita lengkapnya kalau sudah ada waktu luang."
            ];
            rawMessage = randomItem(longMessages);
        }
        const finalText = applyTypo(rawMessage);
        const messageParts = rawMessage.length > LONG_MESSAGE_THRESHOLD ? [rawMessage.slice(0, rawMessage.length/2), rawMessage.slice(rawMessage.length/2)] : [rawMessage];
        try {
            if (isReply) await delay(2000 + Math.random() * 6000);
            else await delay(1500 + Math.random() * 4000);
            await sender.sendPresenceUpdate('composing', receiverJid);
            await delay(2000 + Math.random() * 5000);
            const firstPart = (finalText !== rawMessage) ? finalText : messageParts[0];
            const sent = await sender.sendMessage(receiverJid, { text: firstPart });
            if (!sent) return false;
            const isTypo = (finalText !== rawMessage);
            if (isTypo && Math.random() < DELETE_TYPO_CHANCE) {
                await delay(2500 + Math.random() * 2000);
                await sender.sendMessage(receiverJid, { delete: sent.key });
                await delay(2000 + Math.random() * 2000);
                for (let part of messageParts) { await sender.sendMessage(receiverJid, { text: part }); await delay(800 + Math.random() * 1000); }
                io.emit('log', { account: senderId, message: `✏️ Typo dikoreksi: "${rawMessage}"` });
            } else {
                for (let i = 1; i < messageParts.length; i++) { await sender.sendMessage(receiverJid, { text: messageParts[i] }); await delay(1000 + Math.random() * 1500); }
                io.emit('log', { account: senderId, message: isReply ? `💬 Balas: "${rawMessage}" ke ${receiverId}` : `💬 Kirim teks ke ${receiverId}` });
            }
            dailyMessageCount[senderId] = (dailyMessageCount[senderId] || 0) + 1;
            lastActivity[senderId] = new Date().toLocaleTimeString();
            recordMessageSent(senderId);
            if (!isReply) markMessageSent(senderId, receiverId);
            else markReplyReceived(senderId, receiverId);
            setPairCooldown(senderId, receiverId);
            broadcastStatus();
            return true;
        } catch (err) {
            console.error(`❌ [${senderId}] Error kirim teks:`, err.message);
            return false;
        }
    } finally {
        releasePairLock(senderId, receiverId);
    }
}

// ===================== KONEKSI WHATSAPP =====================
async function connectAccount(accountId, usePairingCode = false, phoneNumber = null) {
    return new Promise(async (resolve) => {
        let isResolved = false;
        let pingInterval;
        const createSocket = async () => {
            const sessionPath = path.join(SESSIONS_DIR, accountId);
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();
            const sock = makeWASocket({
                version,
                auth: state,
                logger: P({ level: 'silent' }),
                qrTimeout: 20000,
                browser: Browsers.ubuntu('Chrome'),
                userAgent: getRandomUserAgent(),
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 25000,
            });
            if (usePairingCode && !sock.authState.creds.registered) {
                if (!phoneNumber) { console.error(`❌ [${accountId}] Nomor telepon diperlukan`); resolve(); return; }
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n🔢 [${accountId}] Pairing Code: ${code}`);
                } catch (err) { console.error(`❌ [${accountId}] Gagal pairing code`); }
            }
            pingInterval = setInterval(async () => {
                if (sock.user && isReady[accountId]) {
                    try { await sock.sendPresenceUpdate('available'); } catch (e) {}
                }
            }, 30000);
            const handleConnectionUpdate = (update) => {
                const { connection, lastDisconnect, qr } = update;
                if (qr && !isResolved && !usePairingCode) {
                    console.log(`\n🔐 [${accountId}] Scan QR:`);
                    qrcode.generate(qr, { small: true });
                }
                if (connection === 'open' && !isResolved) {
                    clearInterval(pingInterval);
                    if (sock.user?.id) {
                        console.log(`✅ [${accountId}] Terhubung`);
                        isReady[accountId] = true;
                        lastActivity[accountId] = new Date().toLocaleTimeString();
                        broadcastStatus();
                        isResolved = true;
                        resolve();
                    } else { setTimeout(() => handleConnectionUpdate(update), 1000); }
                }
                if (connection === 'close' && !isResolved) {
                    clearInterval(pingInterval);
                    const isLoggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
                    console.log(`❌ [${accountId}] Koneksi terputus. Logout: ${isLoggedOut}`);
                    isReady[accountId] = false;
                    broadcastStatus();
                    if (isLoggedOut) {
                        delete clients[accountId];
                        if (!isResolved) { isResolved = true; resolve(); }
                    } else {
                        setTimeout(() => createSocket().catch(console.error), 5000);
                    }
                }
            };
            sock.ev.on('connection.update', handleConnectionUpdate);
            sock.ev.on('creds.update', async (creds) => { await saveCreds(); backupSession(accountId); });
            
            sock.ev.on('messages.upsert', async (msg) => {
                // Jika mode simulasi saja aktif, abaikan semua
                if (simulateOnlyMode) return;

                const m = msg.messages[0];
                if (!m.message || m.key.fromMe) return;
                const senderJid = m.key.remoteJid;
                const cleanSenderJid = getCleanJid(senderJid);
                
                // Jika sedang mode target
                if (oneTargetMode) {
                    // Jika fase sending, abaikan semua pesan masuk
                    if (targetPhase === 'sending') {
                        return;
                    }
                    // Jika fase replying, hanya proses jika pengirim termasuk allowedReplyNumbers
                    if (targetPhase === 'replying') {
                        const senderNumber = cleanSenderJid.split('@')[0];
                        if (!allowedReplyNumbers.has(senderNumber)) {
                            return; // abaikan pesan dari nomor lain
                        }
                        // Lanjutkan ke pemrosesan normal (balasan diperbolehkan)
                    } else {
                        return; // fase lain, amannya abaikan
                    }
                }
                
                // ====== KODE NORMAL UNTUK MODE WEEKDAY/WEEKEND ======
                const isGroup = senderJid.endsWith('@g.us');
                
                if (isGroup && ENABLE_GROUP_CHAT) {
                    if (!isReady[accountId] || !clients[accountId]?.user) return;
                    let text = '';
                    if (m.message.conversation) text = m.message.conversation;
                    else if (m.message.extendedTextMessage?.text) text = m.message.extendedTextMessage.text;
                    else return;
                    const mentions = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    const myJid = clients[accountId].user?.id;
                    if (!myJid) return;
                    const isMentioned = mentions.some(jid => getCleanJid(jid) === getCleanJid(myJid));
                    const shouldReply = (isMentioned || Math.random() < GROUP_REPLY_CHANCE) && canReplyToGroup(cleanSenderJid, accountId);
                    if (shouldReply) {
                        io.emit('log', { account: accountId, message: `📩 Grup: "${text}"` });
                        await delay(3000 + Math.random() * 7000);
                        await sock.readMessages([m.key]);
                        try {
                            const groupMetadata = await sock.groupMetadata(cleanSenderJid);
                            let replyPool = 'fallback';
                            const lower = text.toLowerCase();
                            if (lower.includes('hai') || lower.includes('halo')) replyPool = 'reply';
                            else if (lower.includes('bye')) replyPool = 'closing';
                            await sendGroupMessage(accountId, groupMetadata, true, replyPool);
                        } catch (err) { console.error(`❌ [${accountId}] Gagal fetch metadata grup:`, err.message); }
                    }
                    return;
                }
                
                const senderAccount = Object.keys(clients).find(id => clients[id]?.user?.id && getCleanJid(clients[id].user.id) === cleanSenderJid);
                if (!senderAccount) return;
                
                let isMedia = false, mediaType = '', captionText = '', receivedText = '';
                if (m.message.imageMessage) { isMedia = true; mediaType = 'image'; captionText = m.message.imageMessage.caption || ''; }
                else if (m.message.videoMessage) { isMedia = true; mediaType = 'video'; captionText = m.message.videoMessage.caption || ''; }
                else if (m.message.stickerMessage) { isMedia = true; mediaType = 'sticker'; }
                else if (m.message.conversation) receivedText = m.message.conversation;
                else if (m.message.extendedTextMessage?.text) receivedText = m.message.extendedTextMessage.text;
                else return;
                
                io.emit('log', { account: accountId, message: isMedia ? `📩 Media ${mediaType} dari ${senderAccount}` : `📩 Pesan dari ${senderAccount}: "${receivedText}"` });
                await delay(3000 + Math.random() * 7000);
                await sock.readMessages([m.key]);
                if (isMedia) {
                    await sendHumanLikeMessage(accountId, senderAccount, true, '', captionText, true);
                } else {
                    let replyPool = 'fallback';
                    const lower = receivedText.toLowerCase();
                    if (lower.includes('hai') || lower.includes('halo')) replyPool = 'reply';
                    else if (lower.includes('bye')) replyPool = 'closing';
                    await sendHumanLikeMessage(accountId, senderAccount, true, replyPool, receivedText, false);
                }
            });
            
            clients[accountId] = sock;
        };
        await createSocket().catch((err) => { if (!isResolved) { isResolved = true; resolve(); } });
    });
}

// ===================== SIKLUS PEMANASAN =====================
function getRandomPairs() {
    const ready = Object.keys(isReady).filter(id => isReady[id] && clients[id]?.user?.id);
    if (ready.length < 2) return [];
    const shuffled = [...ready].sort(() => Math.random() - 0.5);
    const pairs = [];
    for (let i = 0; i < shuffled.length; i += 2) if (i + 1 < shuffled.length) pairs.push([shuffled[i], shuffled[i + 1]]);
    return pairs;
}

async function runWarmUpCycle() {
    if (oneTargetMode || simulateOnlyMode) return;
    if (modeOperasi === 'weekday' && !isActiveHoursForAccount(activeAccounts[0])) return;
    console.log(`🔥 Memulai siklus pemanasan (Tema: ${currentTheme})`);
    io.emit('log', { account: 'SYSTEM', message: `🔥 Siklus pemanasan (${currentTheme})` });
    const readyIds = Object.keys(isReady).filter(id => isReady[id]);
    for (let id of readyIds) {
        if (Math.random() < 0.3) await performSoloSimulation(id);
        if (Math.random() < 0.2) await simulateViewingStatus(id);
    }
    if (ENABLE_GROUP_CHAT && Math.random() < GROUP_CHANCE) {
        for (const id of readyIds) {
            if ((dailyGroupMessageCount[id] || 0) >= MAX_GROUP_MESSAGES_PER_DAY) continue;
            const randomGroup = await getRandomGroup(id);
            if (randomGroup) {
                await sendGroupMessage(id, randomGroup, false);
                await delay(45000 + Math.random() * 30000);
            }
        }
    }
    const pairs = getRandomPairs();
    if (pairs.length === 0) return;
    for (const [accA, accB] of pairs) {
        if (canSendMessage(accA, accB)) {
            await sendHumanLikeMessage(accA, accB, false);
            await delay(15000 + Math.random() * 25000);
        } else if (canSendMessage(accB, accA)) {
            await sendHumanLikeMessage(accB, accA, false);
            await delay(15000 + Math.random() * 25000);
        }
    }
    console.log(`✅ Siklus selesai`);
    io.emit('log', { account: 'SYSTEM', message: '✅ Siklus selesai' });
}

let weekendActive = false;
async function weekendLoop() {
    if (weekendActive) return;
    weekendActive = true;
    console.log('🎉 Mode Hari Libur aktif');
    setInterval(() => {
        if (modeOperasi === 'weekend') {
            for (const id of activeAccounts) weekendStatusCount[id] = 0;
        }
    }, 24 * 60 * 60 * 1000);
    while (modeOperasi === 'weekend') {
        if (Object.values(isReady).filter(v => v).length >= 2) {
            await runWarmUpCycle();
            await scheduleRandomWeekendStatus();
        }
        await delay(15000 + Math.random() * 30000);
    }
    weekendActive = false;
}

// ===================== INTERAKSI PENGGUNA =====================
async function askUser() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (q) => new Promise(resolve => rl.question(q, resolve));
    console.log('\n📱 === WhatsApp Warmer Spark ===');
    const clearChoice = await question('Hapus semua sesi sebelumnya? (y/n): ');
    if (clearChoice.toLowerCase() === 'y') clearAllSessions();
    console.log(`\nAkun tersedia:`);
    allAccounts.forEach((acc, i) => console.log(`  ${i+1}. ${acc}`));
    let count;
    while (true) {
        const ans = await question(`\nBerapa akun? (${MIN_ACCOUNTS}-${MAX_ACCOUNTS}): `);
        count = parseInt(ans);
        if (!isNaN(count) && count >= MIN_ACCOUNTS && count <= MAX_ACCOUNTS) break;
    }
    const selectedAccounts = allAccounts.slice(0, count);
    let usePairingCode = false;
    const phoneNumbers = {};
    const modeAns = await question('\nMetode pairing:\n  1. QR Code\n  2. Pairing Code\nPilihan (1/2): ');
    if (modeAns === '2') {
        usePairingCode = true;
        console.log('\nMasukkan nomor telepon (format: 62812xxx):');
        for (const acc of selectedAccounts) {
            phoneNumbers[acc] = (await question(`  ${acc}: `)).replace(/\D/g, '');
        }
    }
    
    console.log('\nPilih Mode Operasi:');
    console.log('  1. Mode Normal (interaksi antar akun & grup)');
    console.log('  2. Mode Kirim ke Banyak Nomor Target (multi‑target)');
    const modeChoice = await question('Pilihan (1/2): ');
    let selectedMode = 'weekday';
    let targetModeActive = false;
    let targetPhone = [];
    
    if (modeChoice === '2') {
        targetModeActive = true;
        console.log('\n=== Mode Kirim ke Banyak Nomor Target ===');
        const targetListInput = await question('Masukkan nomor tujuan (pisahkan dengan koma, contoh: 62812xxx,62813xxx): ');
        targetPhone = targetListInput.split(',').map(s => s.trim()).filter(s => s);
        if (targetPhone.length === 0) {
            console.log('❌ Tidak ada nomor valid. Keluar.');
            process.exit(0);
        }
        selectedMode = 'weekday';
    } else {
        let modeOperasiPilih;
        while (true) {
            const ans = await question('\nMode operasi:\n  1. Hari Kerja\n  2. Hari Libur\nPilihan (1/2): ');
            if (ans === '1') { modeOperasiPilih = 'weekday'; break; }
            else if (ans === '2') { modeOperasiPilih = 'weekend'; break; }
        }
        selectedMode = modeOperasiPilih;
    }
    
    rl.close();
    return { 
        accounts: selectedAccounts, 
        usePairingCode, 
        phoneNumbers, 
        modeOperasi: selectedMode,
        oneTargetMode: targetModeActive,
        targetNumbers: targetPhone
    };
}

async function startAll() {
    const { accounts, usePairingCode, phoneNumbers, modeOperasi: selectedMode, oneTargetMode: targetActive, targetNumbers: targetPhones } = await askUser();
    activeAccounts = accounts;
    modeOperasi = selectedMode;
    simulateOnlyMode = false;
    
    console.log(`\n🚀 Menghubungkan ${activeAccounts.length} akun...`);
    for (let i = 0; i < activeAccounts.length; i++) {
        const acc = activeAccounts[i];
        console.log(`\n🔌 [${i+1}/${activeAccounts.length}] ${acc}`);
        await connectAccount(acc, usePairingCode, phoneNumbers[acc] || null);
        if (i < activeAccounts.length - 1) await delay(3000);
    }
    const readyCount = Object.values(isReady).filter(v => v).length;
    console.log(`\n📊 Akun siap: ${readyCount}/${activeAccounts.length}`);
    
    if (targetActive && targetPhones.length > 0) {
        startTargetMode(targetPhones);
        console.log('\n📢 Mode Multi‑Target aktif.');
        console.log(`   ${targetModeQueue.length} akun siap, ${targetPhones.length} target akan diproses.`);
        console.log('   Jeda antar akun 1-5 menit, fase balasan 10 menit per target.');
        console.log('   Setelah semua target selesai, sistem masuk ke mode simulasi saja.\n');
    } else if (readyCount >= 2 && !targetActive) {
        if (globalThemeInterval) clearInterval(globalThemeInterval);
        globalThemeInterval = setInterval(() => {
            if (availableThemes.length > 0) {
                const newTheme = randomItem(availableThemes);
                if (newTheme !== currentTheme) {
                    currentTheme = newTheme;
                    console.log(`🔄 Tema dirotasi ke: "${currentTheme}"`);
                    resetConversationState();
                    runWarmUpCycle().catch(console.error);
                }
            }
        }, THEME_ROTATION_INTERVAL);
        console.log(`⏲️ Rotasi tema dijadwalkan setiap ${THEME_ROTATION_INTERVAL/60000} menit.`);
        
        if (modeOperasi === 'weekend') {
            weekendLoop().catch(console.error);
        } else {
            cron.schedule('0 9,12,15,18,21 * * *', () => {
                if (!oneTargetMode && !simulateOnlyMode) runWarmUpCycle().catch(console.error);
            });
            console.log('⏲️ Jadwal Hari Kerja diatur (09,12,15,18,21).');
            await runWarmUpCycle();
        }
    }
    
    console.log('\n🎉 Sistem siap. Dashboard: http://localhost:3000');
    exec(`${process.platform === 'win32' ? 'start' : 'open'} http://localhost:${WEB_PORT}`);
}

server.listen(WEB_PORT, () => {
    console.log(`🌐 Dashboard: http://localhost:${WEB_PORT}`);
    startAll().catch(console.error);
});