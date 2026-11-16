// 🎞️ Chithrapata API client (supunofc.site)
//   search  : GET /api/movie/chithrapata/search?query=<name>&page=1&apikey=<key>
//   details : GET /api/movie/chithrapata/details?url=<movie url>&apikey=<key>   -> info + downloads[]
//   dl      : GET /api/movie/chithrapata/dl?url=<links url>&apikey=<key>        -> finalUrl (pixeldrain etc.)
//
// createChithApi({ get, base, key }): `get(url)` must return an axios-like response ({ data }).

const isTelegramHost = (h = '') => /(^|\.)t\.me$|telegram/i.test(String(h));

// pixeldrain.com/u/ID  ->  direct file link
export function toDirectLink(u) {
    const s = String(u || '');
    const pd = s.match(/^https?:\/\/(?:www\.)?pixeldrain\.(?:com|net)\/u\/([A-Za-z0-9]+)/i);
    return pd ? `https://pixeldrain.com/api/file/${pd[1]}?download` : s;
}

// chithrapata.lk <-> chithrapata.com (API eka dewanama accept karanawada kiyala nodannawa nisa dekama try karanawa)
const swapDomain = (u) => {
    if (/chithrapata\.lk/i.test(u)) return u.replace(/chithrapata\.lk/i, 'chithrapata.com');
    if (/chithrapata\.com/i.test(u)) return u.replace(/chithrapata\.com/i, 'chithrapata.lk');
    return null;
};

export function createChithApi({ get, base, key }) {
    const root = String(base || '').replace(/\/+$/, '');
    const build = (path, params) =>
        `${root}/api/movie/chithrapata/${path}?${new URLSearchParams({ ...params, apikey: key }).toString()}`;

    async function call(path, params) {
        const r = await get(build(path, params));
        const d = r?.data;
        if (!d || d.success !== true || !d.result) {
            throw new Error(d?.error || d?.message || 'Chithrapata API eken data awe na');
        }
        return d.result;
    }

    // url param ekak thiyena calls walata: given url, ita passe domain swap karapu url eka
    async function callWithUrl(path, url) {
        let lastErr;
        for (const u of [url, swapDomain(url)].filter(Boolean)) {
            try { return await call(path, { url: u }); } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('API failed');
    }

    async function search(query, page = 1) {
        const r = await call('search', { query, page });
        return (Array.isArray(r.results) ? r.results : [])
            .filter(x => x && x.url && (x.cleanTitle || x.title))
            .map(x => ({
                title: x.cleanTitle || x.title, year: x.year || '', url: x.url, thumbnail: x.thumbnail || '',
                quality: x.quality || '', language: x.language || '', type: x.type || 'movies'
            }));
    }

    async function details(movieUrl) {
        const r = await callWithUrl('details', movieUrl);
        const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
        return {
            title: r.title || r.cleanTitle || 'Movie',
            cleanTitle: r.cleanTitle || String(r.title || 'Movie').replace(/\s*Sinhala Subtitles.*$/i, '').trim(),
            year: r.year || 'N/A',
            poster: String(r.poster || (r.gallery && r.gallery[0]) || '').replace('/w185/', '/w500/'),
            quality: r.quality || '',
            language: r.language || 'N/A',
            imdb: r.imdb || 'N/A',
            runtime: r.runtime || 'N/A',
            genres: arr(r.genres),
            description: String(r.description || r.tagline || ''),
            directors: arr(r.directors),
            cast: arr(r.cast),
            country: arr(r.country),
            // Telegram links WhatsApp group ekata yawanna bari nisa ain karanawa
            downloads: arr(r.downloads)
                .filter(d => d && d.url && !isTelegramHost(d.host))
                .map(d => ({ url: d.url, host: d.host || '', quality: d.quality || 'Download', size: d.size || '' })),
            telegramOnly: arr(r.downloads).length > 0 && arr(r.downloads).every(d => isTelegramHost(d?.host))
        };
    }

    // links url -> real file link
    async function finalLink(download) {
        const r = await callWithUrl('dl', download.url);
        const u = r.finalUrl || r.link;
        if (!u) throw new Error('Final download link eka hamu una na');
        if (isTelegramHost(r.host) || /^https?:\/\/t\.me\//i.test(u)) throw new Error('Meka Telegram link ekak, group ekata yawanna baha');
        return toDirectLink(u);
    }

    return { search, details, finalLink };
}
