// 🎬 REQUEST BOT  (.reqbot on)
//
//  .reqbot on|off|status|inbox on/off|allow <no>|unallow <no>
//  .setreq <group link>   -> request group   (members ask for a movie / cartoon / anime name here)
//  .setmv  <group link>   -> movie group     (the post + the video file is sent here)
//  .reqset footer|caption|limit|warn|limitmsg|donemsg <value>   |  .reqset reset
//
//  Flow (request group)
//    member types a name  ->  bot searches CineSubz + Dinka + SinhalaCartoons + AnimeHeaven
//    -> numbered list  ->  member replies with the number  (-> episode number for cartoons / anime)
//    -> bot sends POST + VIDEO to the movie group  ->  nice Sinhala message + post in the request group
//    daily limit per member (default 3 films), checked atomically in MongoDB
//
//  Flow (inbox)
//    stranger messages the bot inbox  ->  1st time: warning
//    messages again (after a 60s grace)  ->  removed from the groups + contact blocked
//
//  Memory safety: every Map here is TTL swept + size capped, one sweeper timer for the whole module,
//  downloads run through a small global queue and temp files are always removed in `finally`.

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL = 5 * 60 * 1000;
const PENDING_MAX = 300;
const WARN_GRACE_MS = 60 * 1000;
const SEARCH_TIMEOUT = 20000;
const MAX_FILE_MB = 1900;
const MAX_QUEUE_PER_BOT = 5;
const MAX_RUNNING = Math.max(1, parseInt(process.env.REQBOT_MAX_JOBS || '2', 10));

export const DEFAULTS = {
    enabled: false,
    footer: '✦ 𝗥𝗘𝗤𝗨𝗘𝗦𝗧 𝗕𝗢𝗧 ✦',
    caption: '🎬 𝗥𝗘𝗤𝗨𝗘𝗦𝗧𝗘𝗗 𝗠𝗢𝗩𝗜𝗘',
    dailyLimit: 3,
    inboxGuard: true,
    warnText:
        '⚠️ *අවවාදයයි!*\n\nමේ inbox එකට message දාන්න එපා. 🙏\n' +
        'Film / Cartoon / Anime *request* කරන්න ඕන නම් *request group එකට* ගිහින් නම ලියන්න.\n\n' +
        '🚫 ආයෙත් inbox එකට message කළොත් ඔයාව *group එකෙන් remove* කරලා *block* කරනවා.',
    limitText:
        '⛔ @{user} ඔයා අද දවසට ගන්න පුළුවන් film *{limit}* ම අරන් ඉවරයි. 😊\nහෙට (දවස අලුත් වුණාම) ආයෙත් request කරන්න.',
    doneText:
        '✅ @{user} ඔයා request කරපු *{title}* ලස්සනට යැව්වා! 🎉\n\n' +
        '🍿 දැන් Movie Group එකට ගිහින් බලන්න.{link}\nතව request එකක් තියෙනවා නම් නම ලියන්න 💖\n\n_අද ඉතිරි: {left}/{limit}_'
};

const digits = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const fill = (t, o) => String(t).replace(/\{(\w+)\}/g, (_, k) => (o[k] ?? ''));
const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const lkDay = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);   // Sri Lanka day
const withTimeout = (p, ms, label = 'timeout') => {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} (${Math.round(ms / 1000)}s)`)), ms); })]).finally(() => clearTimeout(t));
};

// ───────────────────────── storage (MongoDB) ─────────────────────────
export function makeStore(mongoose) {
    const S = mongoose.Schema;
    const Settings = mongoose.models.ReqBotSettings || mongoose.model('ReqBotSettings', new S({
        number: { type: String, unique: true, required: true },
        data: { type: Object, default: {} },
        updatedAt: { type: Date, default: Date.now }
    }));
    const usageSchema = new S({
        number: String, user: String, day: String, count: { type: Number, default: 0 },
        createdAt: { type: Date, default: Date.now }
    });
    usageSchema.index({ number: 1, user: 1, day: 1 }, { unique: true });
    usageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 86400 });      // old days clean themselves
    const Usage = mongoose.models.ReqBotUsage || mongoose.model('ReqBotUsage', usageSchema);
    const warnSchema = new S({
        number: String, user: String, count: { type: Number, default: 0 }, lastAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now }
    });
    warnSchema.index({ number: 1, user: 1 }, { unique: true });
    warnSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 86400 });
    const Warn = mongoose.models.ReqBotWarn || mongoose.model('ReqBotWarn', warnSchema);

    return {
        async getSettings(number) {
            const d = await Settings.findOne({ number }).lean();
            return d?.data || {};
        },
        async patchSettings(number, patch) {
            const cur = await this.getSettings(number);
            const data = { ...cur, ...patch };
            await Settings.findOneAndUpdate({ number }, { data, updatedAt: new Date() }, { upsert: true });
            return data;
        },
        async getUsed(number, user) {
            const d = await Usage.findOne({ number, user, day: lkDay() }).lean();
            return d?.count || 0;
        },
        // atomic: only increments while count < limit. Returns new count, or 0 when the limit is reached
        async tryConsume(number, user, limit) {
            try {
                const d = await Usage.findOneAndUpdate(
                    { number, user, day: lkDay(), count: { $lt: limit } },
                    { $inc: { count: 1 }, $setOnInsert: { createdAt: new Date() } },
                    { upsert: true, new: true }
                ).lean();
                return d?.count || 0;
            } catch (e) {
                if (e?.code === 11000) return 0;      // doc exists and count >= limit
                throw e;
            }
        },
        async refund(number, user) {
            await Usage.updateOne({ number, user, day: lkDay(), count: { $gt: 0 } }, { $inc: { count: -1 } });
        },
        async getWarn(number, user) {
            return (await Warn.findOne({ number, user }).lean()) || null;
        },
        async setWarn(number, user, count) {
            await Warn.findOneAndUpdate({ number, user }, { count, lastAt: new Date(), updatedAt: new Date() }, { upsert: true });
        },
        async clearWarn(number, user) { await Warn.deleteOne({ number, user }); }
    };
}

// ───────────────────────── helpers: quality pick ─────────────────────────
export function pickBest(downloads, parseSizeMB) {
    const rank = (q) => (/720/.test(q) ? 0 : /480/.test(q) ? 1 : /1080/.test(q) ? 2 : 3);
    const list = (downloads || []).map((d) => ({ d, mb: parseSizeMB(d.size), r: rank(String(d.quality || d.title || '')) }))
        .filter((x) => x.mb === 0 || x.mb <= MAX_FILE_MB);
    if (!list.length) return null;
    list.sort((a, b) => a.r - b.r || (a.mb || 9e9) - (b.mb || 9e9));
    return list[0].d;
}

// ───────────────────────── factory ─────────────────────────
export function createReqBot(deps) {
    const {
        axios, fs, path, os, cineApi, CH_BASE, CH_KEY, robustDownload, resolveTargetGroup, groupAdminSet,
        jidNormalizedUser, getSocket, extractIncoming, parseSizeMB, gmCacheDrop, config
    } = deps;
    const store = deps.store || makeStore(deps.mongoose);
    const OWNERS = () => (config?.OWNER_NUMBERS || []).map(digits);

    // settings cache: tiny (one entry per bot number), refreshed every 30s or on save
    const sCache = new Map();
    async function getSettings(number) {
        const c = sCache.get(number);
        if (c && Date.now() - c.t < 30000) return c.v;
        const raw = await store.getSettings(number);
        const v = { ...DEFAULTS, ...raw };
        sCache.set(number, { t: Date.now(), v });
        if (sCache.size > 100) sCache.delete(sCache.keys().next().value);
        return v;
    }
    async function patchSettings(number, patch) {
        await store.patchSettings(number, patch);
        sCache.delete(number);
        return getSettings(number);
    }

    // pending lists / episode lists  key: `${number}|${msgId}`
    const pending = new Map();
    const lastReq = new Map();      // `${number}|${user}` -> ts   (search cooldown)
    const limitNoticed = new Map(); // `${number}|${user}` -> ts   (limit message throttle)
    const searching = new Set();    // `${number}|${user}`         (one search at a time per user)

    const sweeper = setInterval(() => {
        const now = Date.now();
        for (const [k, v] of pending) if (now - v.ts > PENDING_TTL) pending.delete(k);
        for (const [k, t] of lastReq) if (now - t > 5 * 60 * 1000) lastReq.delete(k);
        for (const [k, t] of limitNoticed) if (now - t > 30 * 60 * 1000) limitNoticed.delete(k);
        for (const [k, c] of sCache) if (now - c.t > 10 * 60 * 1000) sCache.delete(k);
    }, 60 * 1000);
    sweeper.unref?.();

    const addPending = (key, val) => {
        pending.set(key, { ...val, ts: Date.now() });
        while (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value);
    };

    // safe send: timeout + retry without quote
    const send = async (socket, jid, content, opts) => {
        try { return await withTimeout(socket.sendMessage(jid, content, opts), 45000, 'WhatsApp send'); }
        catch (e) {
            if (!opts?.quoted) throw e;
            return await withTimeout(socket.sendMessage(jid, content), 45000, 'WhatsApp send (retry)');
        }
    };
    const sendPost = async (socket, jid, image, caption, opts) => {
        if (image) { try { return await send(socket, jid, { image: { url: image }, caption, ...(opts?.mentions ? { mentions: opts.mentions } : {}) }, opts?.quoted ? { quoted: opts.quoted } : undefined); } catch (_) { /* fall through to text */ } }
        return send(socket, jid, { text: caption, ...(opts?.mentions ? { mentions: opts.mentions } : {}) }, opts?.quoted ? { quoted: opts.quoted } : undefined);
    };
    const foot = (s) => `> ${s.footer}`;

    // ───────────── search adapters (same APIs the normal commands use) ─────────────
    const chGet = async (p, params, ms = SEARCH_TIMEOUT) => (await axios.get(`${CH_BASE}${p}`, { params: { ...params, api_key: CH_KEY }, timeout: ms })).data;

    const SOURCES = [
        {
            id: 'cine', icon: '🎬',
            async search(q) {
                const r = await cineApi.search(q);
                return r.filter((x) => !x.isTv).map((x) => ({ src: 'cine', icon: '🎬', title: x.title, year: x.year, image: x.image, link: x.link, rating: x.rating }));
            }
        },
        {
            id: 'dinka', icon: '🎞️',
            async search(q) {
                const d = await chGet('/api/v1/movie/dinkamovies/search', { q });
                return (d?.status && Array.isArray(d.data) ? d.data : []).filter((x) => x?.link && x?.title)
                    .map((x) => ({ src: 'dinka', icon: '🎞️', title: x.title, year: x.year, image: x.poster || x.image, link: x.link }));
            }
        },
        {
            id: 'cartoon', icon: '🧸',
            async search(q) {
                const d = await chGet('/api/v1/cartoons/sinhalacartoons/search', { q });
                return (d?.status && Array.isArray(d.data) ? d.data : []).filter((x) => x?.link && x?.title)
                    .map((x) => ({ src: 'cartoon', icon: '🧸', title: x.title, year: '', image: x.image, link: x.link, rating: x.rating }));
            }
        },
        {
            id: 'anime', icon: '🎌',
            async search(q) {
                const d = await chGet('/api/v1/anime/animeheaven/search', { q });
                return (d?.status && Array.isArray(d.data) ? d.data : []).filter((x) => x?.link && x?.title)
                    .map((x) => ({ src: 'anime', icon: '🎌', title: x.title, year: '', image: x.image || x.poster, link: x.link }));
            }
        }
    ];

    async function searchAll(q) {
        const res = await Promise.allSettled(SOURCES.map((s) => withTimeout(s.search(q), SEARCH_TIMEOUT, `${s.id} search`)));
        const lists = res.map((r, i) => {
            if (r.status === 'rejected') console.error(`[ReqBot] ${SOURCES[i].id} search failed:`, r.reason?.message);
            return r.status === 'fulfilled' ? r.value : [];
        });
        // interleave so every source gets a place in the first 12 rows, drop duplicate titles
        const out = []; const seen = new Set();
        for (let i = 0; out.length < 12 && i < 6; i++) {
            for (const l of lists) {
                const it = l[i]; if (!it) continue;
                const k = it.title.toLowerCase().replace(/[^a-z0-9\u0d80-\u0dff]+/g, '');
                if (seen.has(k)) continue;
                seen.add(k); out.push(it);
                if (out.length >= 12) break;
            }
        }
        return out;
    }

    // item -> { title, poster, year, rating, language, genres, story, kind:'movie'|'episodes', downloads|episodes }
    async function loadItem(item) {
        if (item.src === 'cine') {
            const m = await cineApi.movieInfo(item.link);
            if (!m.downloads.length) throw new Error('Download links හමු නොවීය');
            return { kind: 'movie', title: m.title, poster: m.poster || item.image, year: m.year, rating: m.imdb, language: m.language, story: m.story,
                downloads: m.downloads.map((d) => ({ quality: d.quality, size: d.size, language: d.language, link: d.link, payLink: d.payLink })) };
        }
        if (item.src === 'dinka') {
            const d = (await chGet('/api/v1/movie/dinkamovies/infodl', { q: item.link }, 60000))?.data;
            const dl = d?.downloads || [];
            if (!d || !dl.length) throw new Error('Download links හමු නොවීය');
            const tv = d.type === 'tv_series' || dl[0].episode !== undefined;
            const norm = dl.map((x, i) => ({ quality: x.quality || x.title || `Part ${i + 1}`, name: x.title || x.quality || `Episode ${i + 1}`, size: x.size,
                urls: [x.direct_link, x.download_link, x.link].filter(Boolean) })).filter((x) => x.urls.length);
            if (!norm.length) throw new Error('Direct link හමු නොවීය');
            return tv
                ? { kind: 'episodes', title: d.title || item.title, poster: d.poster || item.image, year: d.year, rating: d.rating, story: d.story, episodes: norm }
                : { kind: 'movie', title: d.title || item.title, poster: d.poster || item.image, year: d.year, rating: d.rating, language: d.language, story: d.story, downloads: norm };
        }
        if (item.src === 'cartoon') {
            const d = (await chGet('/api/v1/cartoons/sinhalacartoons/infodl', { q: item.link }, 30000))?.data;
            const dl = d?.downloads || [];
            if (!d || !dl.length) throw new Error('Episodes හමු නොවීය');
            const direct = dl.filter((x) => x.link?.endsWith('.mp4') || !String(x.name || '').includes('Telegram'));
            const eps = (direct.length ? direct : dl).filter((x) => x.link).map((x, i) => ({ name: x.name || `Episode ${i + 1}`, quality: 'HD', size: x.size, urls: [x.link] }));
            return { kind: 'episodes', title: d.title || item.title, poster: d.image || item.image, rating: d.imdb, language: d.language || 'Sinhala', story: d.story, episodes: eps };
        }
        // anime
        const d = (await chGet('/api/v1/anime/animeheaven/info', { q: item.link }, 60000))?.data;
        const eps = (d?.downloads?.length ? d.downloads : d?.episodes) || [];
        if (!d || !eps.length) throw new Error('Episodes හමු නොවීය');
        return { kind: 'episodes', title: d.title || item.title, poster: d.image || item.image, year: d.year, rating: d.imdb, story: d.story,
            episodes: eps.map((e, i) => ({ name: e.episode_name || e.title || e.name || `Episode ${i + 1}`, quality: 'HD', size: e.size,
                urls: [...new Set([e.direct_link, e.link, e.download_link, e.proxy_link].filter(Boolean))].slice(0, 2), referer: e.headers?.Referer || 'https://animeheaven.me/' })) };
    }

    // ───────────── delivery queue ─────────────
    const queue = []; let running = 0;
    function enqueue(job) {
        if (queue.filter((j) => j.number === job.number).length >= MAX_QUEUE_PER_BOT) return -1;
        queue.push(job);
        const pos = queue.length + running;
        setImmediate(pump);
        return pos;
    }
    function pump() {
        while (running < MAX_RUNNING && queue.length) {
            const job = queue.shift();
            running++;
            runJob(job).catch((e) => console.error('[ReqBot] job crashed:', e?.message)).finally(() => { running--; pump(); });
        }
    }

    async function runJob(job) {
        const { number, groupJid, requester, userKey, info, pick, s, quotedMsg } = job;
        const socket = getSocket(number);
        if (!socket) { await store.refund(number, userKey).catch(() => {}); return; }
        const title = info.kind === 'episodes' ? `${info.title} - ${pick.name}` : info.title;
        const tmp = path.join(os.tmpdir(), `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp4`);
        const mention = [requester];
        const tag = `@${digits(requester)}`;
        const st = { msg: null };
        const setStatus = async (t) => {
            try {
                if (!st.msg) st.msg = await send(socket, groupJid, { text: t, mentions: mention }, { quoted: quotedMsg });
                else await send(socket, groupJid, { text: t, mentions: mention, edit: st.msg.key });
            } catch (e) { console.error('[ReqBot] status:', e.message); }
        };
        const t0 = Date.now();
        try {
            await setStatus(`⏳ ${tag} ඔයාගේ *${clip(title, 60)}* request එක process වෙනවා...\n_ටිකක් රැඳී ඉන්න_`);

            // 1) POST -> movie group
            const q = pick.quality ? String(pick.quality).replace(/\[.*?\]/g, '').trim() : '';
            const post =
                `\`❚█═${s.caption}═█❚\`\n\n🎬 *${title}*\n━━━━━━━━━━━━━━━━━━━━\n` +
                (info.rating && info.rating !== 'N/A' ? `⭐ *Rating:* ${info.rating}\n` : '') +
                (info.year && info.year !== 'N/A' ? `📅 *Year:* ${info.year}\n` : '') +
                (q ? `🎞️ *Quality:* ${q}\n` : '') + (pick.size ? `📦 *Size:* ${pick.size}\n` : '') +
                (info.language && info.language !== 'N/A' ? `🗣️ *Language:* ${info.language}\n` : '') +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                (info.story ? `\n📝 ${clip(String(info.story).replace(/\s+/g, ' '), 250)}\n` : '') +
                `\n🍿 *Enjoy!*\n${foot(s)}`;
            await sendPost(socket, s.mvGroup.jid, info.poster, post);

            // 2) download
            let urls = pick.urls;
            if (!urls) urls = await cineApi.allLinks({ link: pick.link, payLink: pick.payLink });
            let dlErr = null;
            for (const u of urls) {
                try {
                    await robustDownload(u, tmp, pick.referer || (job.src === 'cine' ? 'https://cinesubz.net/' : ''));
                    dlErr = null; break;
                } catch (e) { dlErr = e; console.error('[ReqBot] link failed:', e.message); if (/disk|ENOSPC/i.test(String(e.message))) break; }
            }
            if (dlErr) throw dlErr;
            const bytes = (await fs.stat(tmp)).size;
            if (bytes < 100 * 1024) throw new Error('File එක ගොඩක් පොඩියි (link එක අවුල් වෙන්න ඇති)');
            if (bytes > MAX_FILE_MB * 1048576) throw new Error('File එක 2GB ට වැඩියි, WhatsApp එකට යවන්න බෑ');

            // 3) video -> movie group (fresh stream per attempt, destroyed on failure)
            const fileName = `${safeName(title)} ${safeName(q)}`.trim() + '.mp4';
            let sendErr = null;
            for (let a = 1; a <= 2; a++) {
                const stream = fs.createReadStream(tmp);
                try {
                    await withTimeout(socket.sendMessage(s.mvGroup.jid, {
                        document: { stream }, mimetype: 'video/mp4', fileName,
                        caption: `🎬 *${title}*${q ? `\n🎞️ ${q}` : ''}${pick.size ? ` | 📦 ${pick.size}` : ''}\n${foot(s)}`
                    }), 30 * 60 * 1000, 'Group upload');
                    sendErr = null; break;
                } catch (e) { sendErr = e; stream.destroy(); console.error(`[ReqBot] upload ${a} failed:`, e.message); if (/Daily free limit/i.test(e.message)) break; }
            }
            if (sendErr) throw sendErr;

            // 4) nice Sinhala message + post in the request group
            const left = Math.max(0, s.dailyLimit - (job.used || 0));
            const done = fill(s.doneText, { user: digits(requester), title, limit: s.dailyLimit, left, link: s.mvGroup.link ? `\n🔗 ${s.mvGroup.link}` : '' });
            await sendPost(socket, groupJid, info.poster, `${done}\n\n${foot(s)}`, { mentions: mention, quoted: quotedMsg }).catch((e) => console.error('[ReqBot] done msg:', e.message));
            console.log(`[ReqBot] ${number} sent "${title}" in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        } catch (err) {
            console.error('[ReqBot] job failed:', err?.message);
            await store.refund(number, userKey).catch(() => {});      // failed request must not eat the daily quota
            await send(socket, groupJid, {
                text: `❌ ${tag} *${clip(title, 50)}* යවන්න බැරි වුණා.\n_${clip(err?.message, 120)}_\n\nඔයාගේ දවසේ limit එකෙන් මේක අඩු කළේ නෑ. පස්සේ ආයෙ try කරන්න.\n${foot(s)}`,
                mentions: mention
            }, { quoted: quotedMsg }).catch(() => {});
        } finally {
            fs.remove(tmp).catch(() => {});
        }
    }

    // pick -> (limit check) -> queue
    async function confirmAndQueue({ socket, number, s, groupJid, requester, userKey, isOwner, info, pick, src, quotedMsg }) {
        const tag = `@${digits(requester)}`;
        let used = 0;
        if (!isOwner) {
            used = await store.tryConsume(number, userKey, s.dailyLimit);
            if (!used) {
                await send(socket, groupJid, { text: `${fill(s.limitText, { user: digits(requester), limit: s.dailyLimit })}\n\n${foot(s)}`, mentions: [requester] }, { quoted: quotedMsg }).catch(() => {});
                return;
            }
        }
        const pos = enqueue({ number, groupJid, requester, userKey, isOwner, info, pick, src, s, used, quotedMsg });
        if (pos === -1) {
            if (!isOwner) await store.refund(number, userKey).catch(() => {});
            await send(socket, groupJid, { text: `⏳ ${tag} දැන් request ගොඩක් පෝලිමේ ඉන්නවා. ටිකකින් ආයෙ try කරන්න.\n${foot(s)}`, mentions: [requester] }, { quoted: quotedMsg }).catch(() => {});
            return;
        }
        if (pos > 1) await send(socket, groupJid, { text: `🕐 ${tag} ඔයාගේ request එක පෝලිමේ *${pos}* වෙනි තැන.`, mentions: [requester] }, { quoted: quotedMsg }).catch(() => {});
    }

    // ───────────── group: request / selection ─────────────
    const looksLikeRequest = (t) => {
        if (!t || t.length < 2 || t.length > 70) return false;
        if (/(https?:\/\/|www\.|chat\.whatsapp\.com|wa\.me)/i.test(t)) return false;
        if (/^[\d\s]+$/.test(t)) return false;
        if (t.split(/\s+/).length > 9) return false;
        return /[a-z\u0d80-\u0dff]/i.test(t);
    };

    async function handleGroup(ctx, s) {
        const { socket, number, msg, text, from, senderJid, isOwner } = ctx;
        if (!s.reqGroup?.jid || from !== s.reqGroup.jid || !s.mvGroup?.jid) return false;
        if (ctx.isCmd) return false;
        const requester = senderJid;
        const userKey = digits(requester);
        const inc = extractIncoming ? extractIncoming(msg) : {};
        const quotedId = inc.stanzaId;

        // --- selection ---
        const asNumber = /^\d{1,2}$/.test(String(text).trim()) ? parseInt(text, 10) : 0;
        if (asNumber) {
            let key = quotedId ? `${number}|${quotedId}` : null;
            if (!key || !pending.has(key)) {
                if (quotedId) return true;                        // quoting some other message: not ours
                const mine = [...pending.entries()].filter(([k, v]) => k.startsWith(`${number}|`) && v.userKey === userKey && v.groupJid === from);
                if (mine.length !== 1) return true;               // bare number but ambiguous / nothing pending
                key = mine[0][0];
            }
            const p = pending.get(key);
            if (p.userKey !== userKey) return true;               // someone else's list
            if (asNumber < 1 || asNumber > p.items.length) {
                await send(socket, from, { text: `❌ 1 - ${p.items.length} අතර number එකක් දෙන්න.` }, { quoted: msg }).catch(() => {});
                return true;
            }
            pending.delete(key);                                   // consume (double-tap safe)
            socket.sendMessage(from, { react: { text: '⏳', key: msg.key } }).catch(() => {});

            if (p.kind === 'list') {
                const item = p.items[asNumber - 1];
                if (!isOwner) {
                    const used = await store.getUsed(number, userKey);
                    if (used >= s.dailyLimit) {
                        await send(socket, from, { text: `${fill(s.limitText, { user: digits(requester), limit: s.dailyLimit })}\n\n${foot(s)}`, mentions: [requester] }, { quoted: msg }).catch(() => {});
                        return true;
                    }
                }
                let info;
                try { info = await withTimeout(loadItem(item), 70000, 'details'); }
                catch (e) {
                    await send(socket, from, { text: `❌ *${clip(item.title, 50)}* details ගන්න බැරි වුණා.\n_${clip(e.message, 100)}_` }, { quoted: msg }).catch(() => {});
                    return true;
                }
                if (info.kind === 'movie') {
                    const pick = pickBest(info.downloads, parseSizeMB);
                    if (!pick) {
                        await send(socket, from, { text: '❌ මේකට යවන්න පුළුවන් file size එකක් (2GB ට අඩු) නෑ.' }, { quoted: msg }).catch(() => {});
                        return true;
                    }
                    await confirmAndQueue({ socket, number, s, groupJid: from, requester, userKey, isOwner, info, pick, src: item.src, quotedMsg: msg });
                    return true;
                }
                // series / anime -> ask episode
                const shown = info.episodes.slice(0, 40);
                const body = `${item.icon} *${clip(info.title, 60)}*\n\n${shown.map((e, i) => `*${i + 1}.* ${clip(e.name, 50)}`).join('\n')}` +
                    `${info.episodes.length > 40 ? `\n_...තව ${info.episodes.length - 40}ක් තියෙනවා (පළමු 40 පමණයි පෙන්නන්නේ)_` : ''}\n\n👉 *Episode number එක මේ message එකට reply කරන්න*\n${foot(s)}`;
                const sent = await sendPost(socket, from, info.poster, body, { quoted: msg }).catch(() => null);
                if (sent?.key?.id) addPending(`${number}|${sent.key.id}`, { kind: 'eps', userKey, groupJid: from, items: shown, info, src: item.src });
                return true;
            }

            // episode picked
            const ep = p.items[asNumber - 1];
            await confirmAndQueue({ socket, number, s, groupJid: from, requester, userKey, isOwner, info: p.info, pick: ep, src: p.src, quotedMsg: msg });
            return true;
        }

        // --- new request ---
        let name = String(text).trim().replace(/^(?:req(?:uest)?|please|pls|plz)\b[:\s-]*/i, '').trim();
        if (!looksLikeRequest(name)) return false;
        const ck = `${number}|${userKey}`;
        if (searching.has(ck)) return true;
        if (Date.now() - (lastReq.get(ck) || 0) < 8000) return true;
        lastReq.set(ck, Date.now());

        if (!isOwner) {
            const used = await store.getUsed(number, userKey);
            if (used >= s.dailyLimit) {
                if (Date.now() - (limitNoticed.get(ck) || 0) > 10 * 60 * 1000) {
                    limitNoticed.set(ck, Date.now());
                    await send(socket, from, { text: `${fill(s.limitText, { user: digits(requester), limit: s.dailyLimit })}\n\n${foot(s)}`, mentions: [requester] }, { quoted: msg }).catch(() => {});
                }
                return true;
            }
        }
        searching.add(ck);
        try {
            socket.sendMessage(from, { react: { text: '🔎', key: msg.key } }).catch(() => {});
            const items = await searchAll(name);
            if (!items.length) {
                await send(socket, from, { text: `❌ *"${clip(name, 40)}"* කියලා එකක් හොයාගන්න බැරි වුණා.\n_නම හරියටම (English වලින්) ලියලා ආයෙ try කරන්න._\n\n${foot(s)}` }, { quoted: msg }).catch(() => {});
                return true;
            }
            const body =
                `🔎 *SEARCH RESULTS*  _${clip(name, 40)}_\n╭──────●➤\n` +
                items.map((it, i) => `*${i + 1}* ${it.icon} ${clip(it.title, 55)}${it.year ? ` (${it.year})` : ''}`).join('\n') +
                `\n╰──────●➤\n\n👉 ඔයාට ඕන එකේ *number එක මේ message එකට reply* කරන්න\n🎬 Movie  🎞️ Dinka  🧸 Cartoon  🎌 Anime\n\n${foot(s)}`;
            const sent = await sendPost(socket, from, items[0].image, body, { quoted: msg }).catch(() => null);
            if (sent?.key?.id) addPending(`${number}|${sent.key.id}`, { kind: 'list', userKey, groupJid: from, items });
        } finally {
            searching.delete(ck);
        }
        return true;
    }

    // ───────────── inbox guard ─────────────
    async function removeFromGroups(socket, s, ids) {
        const out = [];
        for (const g of [s.reqGroup?.jid, s.mvGroup?.jid].filter(Boolean)) {
            try {
                const gm = await socket.groupMetadata(g);
                const me = [socket.user?.id, socket.user?.lid].filter(Boolean).map((j) => jidNormalizedUser(j));
                const admins = groupAdminSet(gm);
                if (!me.some((j) => admins.has(j))) { out.push(`⚠️ ${gm.subject}: bot admin නෑ`); continue; }
                const hit = (gm.participants || []).filter((p) => !p.admin && [p.id, p.jid, p.phoneNumber, p.lid].some((x) => x && ids.has(digits(x))));
                if (!hit.length) continue;
                await socket.groupParticipantsUpdate(g, hit.map((p) => p.id), 'remove');
                gmCacheDrop?.(g);
                out.push(`✅ ${gm.subject}: remove කළා`);
            } catch (e) { out.push(`⚠️ group remove fail: ${clip(e.message, 60)}`); }
        }
        return out;
    }

    async function handleInbox(ctx, s) {
        const { socket, number, msg, from, isOwner } = ctx;
        if (!s.inboxGuard || isOwner || msg.key.fromMe) return false;
        if (!/@(s\.whatsapp\.net|lid)$/.test(from)) return false;
        const ids = new Set([from, msg.key.remoteJidAlt, msg.key.participantPn, msg.key.senderPn].filter(Boolean).map(digits).filter(Boolean));
        const userKey = digits(msg.key.remoteJidAlt?.endsWith('@s.whatsapp.net') ? msg.key.remoteJidAlt : from);
        if ([...ids].some((i) => OWNERS().includes(i) || i === number || (s.allow || []).includes(i))) return false;

        const w = await store.getWarn(number, userKey);
        if (!w || !w.count) {
            await store.setWarn(number, userKey, 1);
            await send(socket, from, { text: `${s.warnText}\n\n${foot(s)}` }, { quoted: msg }).catch(() => {});
            return true;
        }
        if (Date.now() - new Date(w.lastAt).getTime() < WARN_GRACE_MS) return true;     // still inside grace window
        if (w.count >= 2) return true;                                                     // already actioned
        await store.setWarn(number, userKey, 2);
        const log = await removeFromGroups(socket, s, ids);
        let blocked = false;
        try { await socket.updateBlockStatus(from, 'block'); blocked = true; } catch (e) { log.push(`⚠️ block fail: ${clip(e.message, 60)}`); }
        try {
            const me = jidNormalizedUser(socket.user.id);
            await socket.sendMessage(me, { text: `🚫 *REQUEST BOT - AUTO BAN*\n\n👤 wa.me/${userKey}${msg.pushName ? ` (${clip(msg.pushName, 30)})` : ''}\n📩 Inbox එකට ආයෙත් message කළා\n${log.join('\n')}\n${blocked ? '🔒 Contact block කළා' : ''}` });
        } catch (_) { /* ignore */ }
        return true;
    }

    // ───────────── public: message hook ─────────────
    async function onMessage(ctx) {
        const s = await getSettings(ctx.number);
        if (!s.enabled) return false;
        return ctx.isGroup ? handleGroup(ctx, s) : handleInbox(ctx, s);
    }

    // ───────────── public: commands ─────────────
    const HELP = (p) =>
        `🎬 *REQUEST BOT*\n\n` +
        `*${p}reqbot on* / *off*\n*${p}reqbot status*\n*${p}setreq* <request group link>\n*${p}setmv* <movie group link>\n` +
        `*${p}reqbot inbox on|off*\n*${p}reqbot allow* <number> / *unallow* <number>\n` +
        `*${p}reqset footer|caption|limit|warn|limitmsg|donemsg* <value>\n*${p}reqset reset*`;
    const LINK_RE = /chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})/i;

    async function adminState(socket, jid) {
        try {
            const gm = await socket.groupMetadata(jid);
            const me = [socket.user?.id, socket.user?.lid].filter(Boolean).map((j) => jidNormalizedUser(j));
            return groupAdminSet(gm).size && me.some((j) => groupAdminSet(gm).has(j)) ? 'admin ✅' : 'admin නෑ ⚠️ (remove/ban වැඩ කරන්නේ නෑ)';
        } catch { return '?'; }
    }

    const setupText = (s, p) => {
        const miss = [];
        if (!s.mvGroup?.jid) miss.push(`🎬 *Movie group* set කරන්න:\n   \`${p}setmv https://chat.whatsapp.com/xxxx\``);
        if (!s.reqGroup?.jid) miss.push(`📝 *Request group* set කරන්න:\n   \`${p}setreq https://chat.whatsapp.com/xxxx\``);
        return miss;
    };

    async function setGroup(number, kind, link) {
        const socket = getSocket(number);
        if (!socket) throw new Error('Bot offline');
        const m = String(link || '').match(LINK_RE);
        if (!m) throw new Error('Group invite link එක වැරදියි');
        const tg = await resolveTargetGroup(socket, `https://chat.whatsapp.com/${m[1]}`);
        const s = await getSettings(number);
        const other = kind === 'req' ? s.mvGroup : s.reqGroup;
        if (other?.jid === tg.jid) throw new Error('Request group එකයි Movie group එකයි එකම group එක වෙන්න බෑ');
        const val = { jid: tg.jid, name: tg.name, link: `https://chat.whatsapp.com/${m[1]}` };
        return { saved: await patchSettings(number, kind === 'req' ? { reqGroup: val } : { mvGroup: val }), group: val };
    }

    async function onCommand(ctx) {
        const { socket, number, msg, command, args, sender, isOwner, prefix: p = '.' } = ctx;
        const reply = (t) => send(socket, sender, { text: t }, { quoted: msg }).catch(() => {});
        if (!isOwner) return reply('❌ *Owner witharai meka use karanna puluwan.*');
        const s = await getSettings(number);

        if (command === 'setreq' || command === 'setmv') {
            const kind = command === 'setreq' ? 'req' : 'mv';
            if (!args.length) return reply(`📌 Usage: *${p}${command}* https://chat.whatsapp.com/xxxx`);
            try {
                const { saved, group } = await setGroup(number, kind, args.join(' '));
                const st = await adminState(socket, group.jid);
                const miss = setupText(saved, p);
                return reply(
                    (kind === 'req'
                        ? `✅ *Request group set!*\n📝 ${group.name}\n_මේ group එකේ ඕනම කෙනෙකුට film / cartoon / anime නමක් ලියලා request කරන්න පුළුවන්._`
                        : `✅ *Movie group set!*\n🎬 ${group.name}\n_Request කරපු film එකේ post එකයි video එකයි මෙතනට එනවා._`) +
                    `\n🛡️ Bot: ${st}` +
                    (miss.length ? `\n\n⚠️ තව set කරන්න තියෙනවා:\n${miss.join('\n')}` : saved.enabled ? '\n\n🟢 Request Bot ready!' : `\n\n▶️ දැන් *${p}reqbot on* කරන්න.`));
            } catch (e) { return reply(`❌ ${e.message}`); }
        }

        if (command === 'reqset') {
            const key = String(args[0] || '').toLowerCase();
            const val = args.slice(1).join(' ').trim();
            if (key === 'reset') { await store.patchSettings(number, { footer: DEFAULTS.footer, caption: DEFAULTS.caption, dailyLimit: DEFAULTS.dailyLimit, warnText: DEFAULTS.warnText, limitText: DEFAULTS.limitText, doneText: DEFAULTS.doneText }); sCache.delete(number); return reply('♻️ Footer / caption / limit / messages ඔක්කොම default වලට දැම්මා.'); }
            const map = { footer: 'footer', caption: 'caption', warn: 'warnText', limitmsg: 'limitText', donemsg: 'doneText' };
            if (key === 'limit') {
                const n = parseInt(val, 10);
                if (!(n >= 1 && n <= 50)) return reply(`📌 Usage: *${p}reqset limit 3*  (1 - 50)`);
                await patchSettings(number, { dailyLimit: n });
                return reply(`✅ Daily limit = *${n}* films`);
            }
            if (!map[key] || !val) return reply(HELP(p));
            await patchSettings(number, { [map[key]]: clip(val.replace(/\\n/g, '\n'), 900) });
            return reply(`✅ *${key}* update කළා.`);
        }

        // .reqbot ...
        const sub = String(args[0] || '').toLowerCase();
        if (sub === 'on') {
            const saved = await patchSettings(number, { enabled: true });
            const miss = setupText(saved, p);
            if (miss.length) {
                return reply(`🟢 *Request Bot ON* කළා!\n\n⚠️ *Warning:* Bot වැඩ කරන්න කලින් groups දෙක set කරන්න ඕන:\n\n${miss.join('\n\n')}\n\n_Request group එකට join වෙන ඕනම කෙනෙකුට request කරන්න පුළුවන්. Movie group එකට තමයි post එකයි video එකයි එන්නේ._`);
            }
            return reply(`🟢 *Request Bot ON!*\n\n📝 Request: ${saved.reqGroup.name}\n🎬 Movie: ${saved.mvGroup.name}\n🎫 Daily limit: ${saved.dailyLimit}`);
        }
        if (sub === 'off') { await patchSettings(number, { enabled: false }); return reply('🔴 *Request Bot OFF*'); }
        if (sub === 'inbox') {
            const on = String(args[1] || '').toLowerCase() === 'on';
            if (!['on', 'off'].includes(String(args[1] || '').toLowerCase())) return reply(`📌 Usage: *${p}reqbot inbox on|off*`);
            await patchSettings(number, { inboxGuard: on });
            return reply(`📥 Inbox guard: *${on ? 'ON' : 'OFF'}*`);
        }
        if (sub === 'allow' || sub === 'unallow') {
            const n = digits(args[1]);
            if (n.length < 6) return reply(`📌 Usage: *${p}reqbot ${sub} 94712345678*`);
            const set = new Set(s.allow || []);
            if (sub === 'allow') set.add(n); else set.delete(n);
            await patchSettings(number, { allow: [...set].slice(0, 200) });
            await store.clearWarn(number, n).catch(() => {});
            return reply(`✅ ${n} ${sub === 'allow' ? 'inbox guard එකෙන් බැහැර කළා' : 'ආයෙ guard එකට දැම්මා'}`);
        }
        if (sub === 'status') {
            const rs = s.reqGroup?.jid ? await adminState(socket, s.reqGroup.jid) : '-';
            return reply(
                `🎬 *REQUEST BOT STATUS*\n\n${s.enabled ? '🟢 ON' : '🔴 OFF'}\n📝 Request group: ${s.reqGroup?.name || '❌ not set'}  (${rs})\n🎬 Movie group: ${s.mvGroup?.name || '❌ not set'}\n` +
                `🎫 Daily limit: ${s.dailyLimit}\n📥 Inbox guard: ${s.inboxGuard ? 'ON' : 'OFF'}\n✅ Allowed numbers: ${(s.allow || []).length}\n🔄 Queue: ${queue.length} waiting, ${running} running\n\n🖋️ Footer: ${s.footer}\n🏷️ Caption: ${s.caption}`);
        }
        return reply(HELP(p));
    }

    // ───────────── public: web panel helpers ─────────────
    const PANEL_TEXT = { footer: 100, caption: 100, warnText: 900, limitText: 600, doneText: 900 };
    async function panelView(number) {
        const s = await getSettings(number);
        return {
            enabled: !!s.enabled, inboxGuard: !!s.inboxGuard, dailyLimit: s.dailyLimit,
            reqGroup: s.reqGroup ? { name: s.reqGroup.name, link: s.reqGroup.link } : null,
            mvGroup: s.mvGroup ? { name: s.mvGroup.name, link: s.mvGroup.link } : null,
            allow: s.allow || [],
            text: Object.fromEntries(Object.keys(PANEL_TEXT).map((k) => [k, String(s[k] ?? '')]))
        };
    }
    async function panelSave(number, body) {
        const patch = {};
        for (const [k, max] of Object.entries(PANEL_TEXT)) {
            if (body?.text?.[k] === undefined) continue;
            const v = String(body.text[k]).replace(/\u0000/g, '').trim();
            if (!v) throw new Error(`${k} හිස් වෙන්න බෑ`);
            if (v.length > max) throw new Error(`${k} දිග වැඩියි (max ${max})`);
            patch[k] = v;
        }
        if (body?.dailyLimit !== undefined) {
            const n = parseInt(body.dailyLimit, 10);
            if (!(n >= 1 && n <= 50)) throw new Error('Daily limit 1 - 50 අතර වෙන්න ඕන');
            patch.dailyLimit = n;
        }
        if (body?.enabled !== undefined) patch.enabled = !!body.enabled;
        if (body?.inboxGuard !== undefined) patch.inboxGuard = !!body.inboxGuard;
        if (Array.isArray(body?.allow)) patch.allow = [...new Set(body.allow.map(digits).filter((x) => x.length >= 6))].slice(0, 200);
        if (body?.reqLink) await setGroup(number, 'req', body.reqLink);
        if (body?.mvLink) await setGroup(number, 'mv', body.mvLink);
        if (Object.keys(patch).length) await patchSettings(number, patch);
        return panelView(number);
    }

    function detach(number) {
        for (const k of [...pending.keys()]) if (k.startsWith(`${number}|`)) pending.delete(k);
        for (const m of [lastReq, limitNoticed]) for (const k of [...m.keys()]) if (k.startsWith(`${number}|`)) m.delete(k);
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].number === number) queue.splice(i, 1);
        sCache.delete(number);
    }

    return {
        onMessage, onCommand, detach, panelView, panelSave, getSettings,
        COMMANDS: new Set(['reqbot', 'setreq', 'setmv', 'reqset']),
        stats: () => ({ pending: pending.size, queue: queue.length, running, lastReq: lastReq.size, searching: searching.size })
    };
}
