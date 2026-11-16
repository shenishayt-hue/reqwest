// 🕒 Scheduled WhatsApp Status
//  - parseSchedInput : "18:30 | caption"  /  "+30m caption"  /  "tomorrow 8am | text"  /  "2026-11-10 07:00 | text"
//  - createAudienceTracker : status eka balanna puluwan contacts (statusJidList) mathaka thiyaganna
//  - createStatusScheduler : due wela thiyena statuses post karana runner (store eka Mongo / test walata in-memory)
// Timezone: Asia/Colombo (UTC+5:30, DST nathi) - moment-timezone one na.

const LK_OFFSET_MIN = 330;
const pad = (n) => String(n).padStart(2, '0');

const toLocal = (ms, off = LK_OFFSET_MIN) => new Date(ms + off * 60000);          // getUTC* = local clock
const fromLocal = (y, mo, d, h, mi, off = LK_OFFSET_MIN) => Date.UTC(y, mo - 1, d, h, mi, 0) - off * 60000;

export function formatWhen(ms, off = LK_OFFSET_MIN) {
    const l = toLocal(ms, off);
    const h = l.getUTCHours();
    return `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())} ${pad(h % 12 || 12)}:${pad(l.getUTCMinutes())} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function formatLeft(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ') || '<1m';
}

const MAX_AHEAD_MS = 30 * 24 * 3600 * 1000;

// "18:30", "6.30pm", "8am", "tomorrow 8am", "2026-11-10 07:00", "+30m", "+2h", "+1d"  ->  { runAt } | { error }
export function parseWhen(str, now = Date.now(), off = LK_OFFSET_MIN) {
    const s = String(str || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return { error: 'time eka denna' };

    let m = s.match(/^\+(\d+)\s*(m|min|mins|h|hr|hrs|d)$/);
    if (m) {
        const n = parseInt(m[1], 10);
        const ms = n * (m[2][0] === 'm' ? 60000 : m[2][0] === 'h' ? 3600000 : 86400000);
        const runAt = now + ms;
        return runAt - now > MAX_AHEAD_MS ? { error: 'Dawas 30kata wada ihala schedule karanna baha' } : { runAt };
    }

    m = s.match(/^(?:(\d{4})-(\d{2})-(\d{2})|(today|tomorrow|heta))?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/);
    if (!m) return { error: 'time format eka therune na' };
    const [, yy, mo, dd, word, hStr, miStr, ap] = m;
    if (miStr === undefined && !ap) return { error: 'time format eka therune na (18:30 / 6pm wage denna)' };
    let h = parseInt(hStr, 10);
    const mi = miStr === undefined ? 0 : parseInt(miStr, 10);
    if (mi > 59) return { error: 'minutes wrong' };
    if (ap) {
        if (h < 1 || h > 12) return { error: 'hour wrong' };
        h = (h % 12) + (ap === 'pm' ? 12 : 0);
    } else if (h > 23) return { error: 'hour wrong' };

    const nl = toLocal(now, off);
    let y = nl.getUTCFullYear(), mon = nl.getUTCMonth() + 1, day = nl.getUTCDate();
    let explicitDay = false;
    if (yy) { y = +yy; mon = +mo; day = +dd; explicitDay = true; }
    else if (word === 'tomorrow' || word === 'heta') { const t = toLocal(now + 86400000, off); y = t.getUTCFullYear(); mon = t.getUTCMonth() + 1; day = t.getUTCDate(); explicitDay = true; }
    else if (word === 'today') explicitDay = true;

    let runAt = fromLocal(y, mon, day, h, mi, off);
    // date eka valid da (2026-02-31 wage)
    const chk = toLocal(runAt, off);
    if (chk.getUTCMonth() + 1 !== mon || chk.getUTCDate() !== day) return { error: 'Date eka waradi' };
    if (runAt <= now) {
        if (explicitDay) return { error: 'Me time eka ikmawila giya. Anagathayen ekak denna.' };
        runAt += 86400000;      // time witharak dunnoth ilaga ewa
    }
    if (runAt - now > MAX_AHEAD_MS) return { error: 'Dawas 30kata wada ihala schedule karanna baha' };
    return { runAt };
}

// "<when> | <text>"  /  "<when>, <text>"  /  "<when> <text>"
export function parseSchedInput(raw, now = Date.now(), off = LK_OFFSET_MIN) {
    raw = String(raw || '').trim();
    if (!raw) return { error: 'time eka denna' };
    const sep = raw.search(/[|,]/);
    if (sep !== -1) {
        const w = parseWhen(raw.slice(0, sep), now, off);
        return w.error ? w : { runAt: w.runAt, text: raw.slice(sep + 1).trim() };
    }
    const tokens = raw.split(/\s+/);
    let specific = null;                                              // format eka hari, namuth time eka waradi (ikmawila / 30d / date wrong)
    for (let n = Math.min(3, tokens.length); n >= 1; n--) {           // longest time prefix eka
        const w = parseWhen(tokens.slice(0, n).join(' '), now, off);
        if (w.runAt) return { runAt: w.runAt, text: tokens.slice(n).join(' ').trim() };
        if (!specific && w.error && !/^time format/.test(w.error)) specific = w.error;
    }
    return { error: specific || 'time format eka therune na (18:30 / 6pm / +30m / tomorrow 8am wage denna)' };
}

// ───────────────────────── audience ─────────────────────────
const PHONE_JID = /^\d+(?::\d+)?@s\.whatsapp\.net$/;
const normJid = (j) => String(j).replace(/:\d+@/, '@');

export function createAudienceTracker({ load, save, saveDelayMs = 30000, max = 5000 }) {
    const sets = new Map();
    const timers = new Map();
    const dirty = new Set();

    const flush = async (number) => {
        timers.delete(number);
        if (!dirty.delete(number)) return;
        try { await save(number, [...(sets.get(number) || [])]); } catch (e) { console.error('[statusAudience] save:', e.message); }
    };
    const add = (number, jid) => {
        if (!PHONE_JID.test(String(jid || ''))) return;
        const set = sets.get(number) || sets.set(number, new Set()).get(number);
        const j = normJid(jid);
        if (set.has(j) || set.size >= max) return;
        set.add(j);
        dirty.add(number);
        if (!timers.has(number)) {
            const t = setTimeout(() => flush(number), saveDelayMs);
            t.unref?.();
            timers.set(number, t);
        }
    };

    async function attach(socket, number) {
        if (!sets.has(number)) {
            let saved = [];
            try { saved = (await load(number)) || []; } catch (e) { console.error('[statusAudience] load:', e.message); }
            sets.set(number, new Set(saved.filter(j => PHONE_JID.test(j)).map(normJid)));
        }
        const safe = (fn) => (...a) => { try { fn(...a); } catch { /* audience tracking message flow ekata baadhaa karanna epa */ } };
        const addAll = (arr) => (Array.isArray(arr) ? arr : []).forEach(c => add(number, c?.id || c?.jid || c?.remoteJid));
        socket.ev.on('contacts.upsert', safe(addAll));
        socket.ev.on('contacts.update', safe(addAll));
        socket.ev.on('chats.upsert', safe(addAll));
        socket.ev.on('messaging-history.set', safe((h) => { addAll(h?.contacts); addAll(h?.chats); }));
        socket.ev.on('messages.upsert', safe(({ messages }) => {
            for (const m of messages || []) {
                const j = m?.key?.remoteJid;
                if (j && !/@(g\.us|broadcast|newsletter)$/.test(j)) add(number, j);
            }
        }));
    }

    return { attach, add, get: (number) => [...(sets.get(number) || [])], flush };
}

// ───────────────────────── scheduler ─────────────────────────
const BG_COLORS = ['#1B2A3A', '#3B1E54', '#0B6E4F', '#7A1F3D', '#1F3A93', '#B35C00'];

export function createStatusScheduler({
    store, getSocket, audience, ownJid, now = () => Date.now(), log = console,
    maxLateMs = 3 * 3600 * 1000, maxAttempts = 3, retryMs = 2 * 60 * 1000
}) {
    let timer = null;
    let busy = false;

    const buildContent = (item, data) => {
        if (item.kind === 'text') return { text: item.text, backgroundColor: BG_COLORS[Math.floor(Math.random() * BG_COLORS.length)], font: 2 };
        if (item.kind === 'image') return { image: data, ...(item.text ? { caption: item.text } : {}) };
        return { video: data, mimetype: item.mime || 'video/mp4', ...(item.text ? { caption: item.text } : {}) };
    };

    async function sendOne(item) {
        const entry = getSocket(item.number);
        const socket = entry?.socket;
        if (!socket?.user) return 'offline';

        if (now() - new Date(item.runAt).getTime() > maxLateMs) {
            await store.finish(item.id, { state: 'missed', error: 'Bot eka offline wela time eka ikmawila giya' });
            return 'missed';
        }
        if (!(await store.claim(item.id))) return 'taken';

        const me = ownJid(socket);
        try {
            const data = item.kind === 'text' ? null : await store.loadData(item.id);
            if (item.kind !== 'text' && !data) throw new Error('Media data eka DB eke na');
            const list = [...new Set([...(audience?.get(item.number) || []), me])];
            await socket.sendMessage('status@broadcast', buildContent(item, data), { statusJidList: list });
            await store.finish(item.id, { state: 'sent', sentAt: new Date(now()), data: null });
            try { await socket.sendMessage(me, { text: `✅ *Scheduled status posted!*\n🆔 ${item.sid} · 👥 ${list.length - 1} contacts` }); } catch { /* notify fail wuna nam harak na */ }
            return 'sent';
        } catch (e) {
            const attempts = (item.attempts || 0) + 1;
            log.error?.(`[statusSched] ${item.sid} failed (${attempts}/${maxAttempts}):`, e.message);
            if (attempts < maxAttempts) {
                await store.finish(item.id, { state: 'pending', attempts, runAt: new Date(now() + retryMs), error: String(e.message).slice(0, 200) });
                return 'retry';
            }
            await store.finish(item.id, { state: 'failed', attempts, error: String(e.message).slice(0, 200), data: null });
            try { await socket.sendMessage(me, { text: `❌ *Scheduled status fail una* (🆔 ${item.sid})\n${e.message}` }); } catch { /* ignore */ }
            return 'failed';
        }
    }

    async function tick() {
        if (busy) return [];
        busy = true;
        const out = [];
        try {
            const due = await store.due(now(), 10);
            for (const item of due) out.push(await sendOne(item));
        } catch (e) {
            log.error?.('[statusSched] tick:', e.message);
        } finally { busy = false; }
        return out;
    }

    return {
        tick,
        start(ms = 20000) {
            if (timer) return;
            timer = setInterval(tick, ms);
            timer.unref?.();
        },
        stop() { if (timer) clearInterval(timer); timer = null; }
    };
}
