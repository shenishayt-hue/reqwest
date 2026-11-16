// 🖥️ SHAGGY XMD dashboard API  (mounted at /code/panel)
//
// Login  : bot number + the pairing code that was shown when the bot was connected
//          (older bots: the Access Key from the "Bot Activated" inbox message also works)
// Edit   : bot name, footer, movie footer, movie caption, bot image + 4 switches
// Apply  : saved to MongoDB and pushed straight into the running bot (configPushers),
//          so the next message already uses the new values (no restart, no 5 min wait)

import express from 'express';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TRIES = 8;                 // wrong logins per number+ip
const TRY_WINDOW_MS = 10 * 60 * 1000;

const TEXT_FIELDS = {
    BOT_NAME:      { max: 40,  label: 'Bot name' },
    BOT_FOOTER:    { max: 120, label: 'Bot footer' },
    MOVIE_FOOTER:  { max: 150, label: 'Movie footer' },
    MOVIE_CAPTION: { max: 100, label: 'Movie caption' },
};
const BOOL_FIELDS = ['ALWAYS_ONLINE', 'STATUS_VIEW', 'AUTO_LIKE', 'ANTI_DELETE'];

export function createPanelRouter({ Session, loadUserConfig, updateUserConfig, configPushers, activeSockets, hashPanelPass, crypto, reqBot }) {
    const router = express.Router();

    // token secret: PANEL_SECRET (.env) - nathnam DB url eken hadanawa, restart unath login eka ain wenne na
    const SECRET = process.env.PANEL_SECRET ||
        crypto.createHash('sha256').update('shaggy-panel|' + (process.env.MONGO_URI || '') + '|' + (process.env.ADMIN_NUMBERS || '')).digest('hex');

    const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    const makeToken = (number) => {
        const body = `${number}.${Date.now() + TOKEN_TTL_MS}`;
        return `${body}.${sign(body)}`;
    };
    const readToken = (req) => {
        const h = String(req.headers.authorization || '');
        const t = h.startsWith('Bearer ') ? h.slice(7) : '';
        const parts = t.split('.');
        if (parts.length !== 3) return null;
        const body = `${parts[0]}.${parts[1]}`;
        const a = Buffer.from(sign(body)), b = Buffer.from(parts[2]);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        if (Number(parts[1]) < Date.now()) return null;
        return /^\d{6,15}$/.test(parts[0]) ? parts[0] : null;
    };
    const auth = (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const n = readToken(req);
        if (!n) return res.status(401).json({ ok: false, error: 'Session expired. Log in again.' });
        req.number = n;
        next();
    };

    const tries = new Map(); // `${ip}|${number}` -> [timestamps]
    const tooMany = (key) => {
        const now = Date.now();
        const arr = (tries.get(key) || []).filter((t) => now - t < TRY_WINDOW_MS);
        tries.set(key, arr);
        if (tries.size > 3000) tries.clear();
        return arr.length >= MAX_TRIES;
    };
    const failed = (key) => tries.set(key, [...(tries.get(key) || []), Date.now()]);

    const safeEq = (a, b) => {
        const x = Buffer.from(String(a)), y = Buffer.from(String(b));
        return x.length === y.length && crypto.timingSafeEqual(x, y);
    };

    const view = async (number) => {
        const cfg = await loadUserConfig(number);
        const live = activeSockets.get(number);
        const out = { number, online: !!(live && live.socket && live.socket.user && live.socket.ws?.isOpen !== false && live.socket.ws?.isClosed !== true), text: {}, flags: {} };
        for (const k of Object.keys(TEXT_FIELDS)) out.text[k] = String(cfg[k] ?? '');
        out.text.BOT_IMAGE = String(cfg.BOT_IMAGE ?? '');
        for (const k of BOOL_FIELDS) out.flags[k] = String(cfg[k]) === 'true';
        return out;
    };

    router.post('/login', express.json({ limit: '4kb' }), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const number = String(req.body?.number || '').replace(/\D/g, '');
            const password = String(req.body?.password || '').trim();
            const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
            const key = `${ip}|${number}`;
            if (number.length < 6 || number.length > 15 || !password) {
                return res.status(400).json({ ok: false, error: 'Enter your bot number (with country code) and your password.' });
            }
            if (tooMany(key)) return res.status(429).json({ ok: false, error: 'Too many wrong tries. Wait 10 minutes.' });

            const doc = await Session.findOne({ number }, 'config').lean();
            const c = doc?.config || {};
            let ok = false;
            if (c.panelPass?.salt && c.panelPass?.hash) {
                ok = safeEq(hashPanelPass(password, c.panelPass.salt), c.panelPass.hash);
            }
            if (!ok && c.accessKey) ok = safeEq(password.toUpperCase(), String(c.accessKey).toUpperCase());
            if (!ok) {
                failed(key);
                return res.status(401).json({ ok: false, error: 'Number or code is wrong.' });
            }
            res.json({ ok: true, token: makeToken(number), settings: await view(number) });
        } catch (e) {
            console.error('[panel] login:', e.message);
            res.status(500).json({ ok: false, error: 'Server error. Try again.' });
        }
    });

    router.get('/me', auth, async (req, res) => {
        try { res.json({ ok: true, settings: await view(req.number) }); }
        catch (e) { console.error('[panel] me:', e.message); res.status(500).json({ ok: false, error: 'Server error.' }); }
    });

    router.post('/save', auth, express.json({ limit: '8kb' }), async (req, res) => {
        try {
            const number = req.number;
            const inText = req.body?.text || {};
            const inFlags = req.body?.flags || {};
            const upd = {};
            const clean = (v) => String(v ?? '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim();

            for (const [k, meta] of Object.entries(TEXT_FIELDS)) {
                if (inText[k] === undefined) continue;
                const v = clean(inText[k]);
                if (!v) return res.status(400).json({ ok: false, error: `${meta.label} cannot be empty.` });
                if (v.length > meta.max) return res.status(400).json({ ok: false, error: `${meta.label} is too long (max ${meta.max} characters).` });
                upd[k] = v;
            }
            if (inText.BOT_IMAGE !== undefined) {
                const v = clean(inText.BOT_IMAGE);
                if (v && !/^https?:\/\/[^\s]{4,490}$/i.test(v)) return res.status(400).json({ ok: false, error: 'Bot image must be a direct http(s) link.' });
                if (v) upd.BOT_IMAGE = v;
            }
            for (const k of BOOL_FIELDS) {
                if (inFlags[k] !== undefined) upd[k] = inFlags[k] ? 'true' : 'false';
            }

            const cur = await loadUserConfig(number);
            const next = { ...cur, ...upd };
            await updateUserConfig(number, next);

            // live bot ekata ikmanata apply (5 seconds athule, mulinma)
            let applied = false;
            const push = configPushers.get(number);
            if (push) { push(next); applied = true; }
            else if (activeSockets.get(number)) { activeSockets.set(number, { ...activeSockets.get(number), config: next }); applied = true; }

            res.json({ ok: true, applied, settings: await view(number) });
        } catch (e) {
            console.error('[panel] save:', e.message);
            res.status(500).json({ ok: false, error: 'Could not save. Try again.' });
        }
    });

    // 🎬 Request bot settings (same login token)
    router.get('/req', auth, async (req, res) => {
        try { res.json({ ok: true, req: await reqBot.panelView(req.number) }); }
        catch (e) { console.error('[panel] req:', e.message); res.status(500).json({ ok: false, error: 'Server error.' }); }
    });

    router.post('/req/save', auth, express.json({ limit: '16kb' }), async (req, res) => {
        try { res.json({ ok: true, req: await reqBot.panelSave(req.number, req.body || {}) }); }
        catch (e) { res.status(400).json({ ok: false, error: String(e.message || 'Could not save.').slice(0, 200) }); }
    });

    return router;
}
