// 🎬 CineSubz API client (api.chamindu.site)
//   search   : GET /api/v1/movies/cinesubz/search?q=<name>
//   infodl   : GET /api/v1/movies/cinesubz/infodl?q=<movie url>        -> details + downloads[]
//   resolve  : GET /api/v1/movies/cinesubz/resolve?url=<zt-link>       -> live direct links
//   tv/info  : GET /api/v1/movies/cinesubz/tv/info?q=<series url>      -> episodes (shape not verified, parsed defensively)
//   tv/dl    : GET /api/v1/movies/cinesubz/tv/dl?q=<episode url>       -> episode links (shape not verified, parsed defensively)
//
// createCineApi({ get, base, key }): `get(url)` must return an axios-like response ({ data }).

const isTelegram = (u, name = '') => /t\.me|telegram/i.test(`${u} ${name}`);

export function cleanTitle(t) {
    return String(t || '')
        .replace(/\s*(Sinhala Subtitles|සිංහල උපසිරැසි).*$/i, '')
        .replace(/\s*\|.*$/, '')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function createCineApi({ get, base, key }) {
    const root = String(base || '').replace(/\/+$/, '');
    const url = (path, params, prefix = 'movies') =>
        `${root}/api/v1/${prefix}/cinesubz/${path}?${new URLSearchParams({ ...params, api_key: key }).toString()}`;

    // new path (/movies/) first, then the older one (/movie/)
    const getAny = async (path, params) => {
        let lastErr;
        for (const prefix of ['movies', 'movie']) {
            try {
                const r = await get(url(path, params, prefix));
                if (r?.data?.status) return r.data;
                lastErr = new Error(r?.data?.message || r?.data?.error || 'API status false');
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('API failed');
    };

    async function search(query) {
        const d = await getAny('search', { q: query });
        const list = Array.isArray(d.data) ? d.data : Array.isArray(d.results) ? d.results : [];
        return list.filter(x => x && x.link && x.title).map(x => ({
            title: x.title, image: x.image || '', quality: x.quality || '', rating: x.rating || 'N/A', year: x.year || '',
            link: x.link, isTv: x.type === 'tvshows' || /\/tvshows\//.test(x.link)
        }));
    }

    async function movieInfo(movieUrl) {
        const d = await getAny('infodl', { q: movieUrl });
        const m = d.data;
        if (!m) throw new Error('Movie details hamu una na');
        return {
            title: m.title || 'Movie',
            poster: m.image || (m.gallery && m.gallery[0]) || '',
            imdb: m.imdb || m.rating || 'N/A',
            director: m.director || m.directors || 'N/A',
            language: m.language || m.tag || 'N/A',
            story: String(m.story || m.description || ''),
            cast: Array.isArray(m.cast) ? m.cast.map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean) : [],
            year: m.year || 'N/A',
            duration: m.duration || m.runtime || 'N/A',
            country: m.country || 'N/A',
            downloads: (Array.isArray(m.downloads) ? m.downloads : [])
                .filter(x => x && x.quality && (x.link || x.pay_link))
                .map(x => ({ quality: x.quality, size: x.size || '', language: x.language || '', link: x.link || '', payLink: x.pay_link || '' }))
        };
    }

    async function resolve(ztUrl) {
        const d = await getAny('resolve', { url: ztUrl });
        const links = (Array.isArray(d.links) ? d.links : []).filter(l => l && l.url && !isTelegram(l.url, l.provider));
        if (!links.length) throw new Error('Resolve API eken direct link ekak hamu una na');
        return links;
    }

    // zt-link -> resolve; resolve fail unoth pay_link (direct) eka use karanawa
    async function finalLink({ link, payLink }) {
        if (link) {
            try { return (await resolve(link))[0].url; }
            catch (e) { if (!payLink) throw e; console.error('[cinesubz] resolve failed, using pay_link:', e.message); }
        }
        if (payLink) return payLink;
        throw new Error('Download link ekak na');
    }

    // 🔁 Try-list: resolve karapu okkoma direct links + pay_link + (direct nam) link eka. Ekak fail unoth adutha ekata yanna.
    async function allLinks({ link, payLink }) {
        const out = [];
        if (link) {
            try { for (const l of await resolve(link)) out.push(l.url); }
            catch (e) { console.error('[cinesubz] resolve failed:', e.message); }
        }
        if (payLink) out.push(payLink);
        if (link && !/zt-links/i.test(link)) out.push(link);   // zt-link ekak nemei nam direct file ekak wenna puluwan
        const uniq = [...new Set(out.filter(Boolean))];
        if (!uniq.length) throw new Error('Download link ekak hamu une na (resolve fail)');
        return uniq;
    }

    async function tvInfo(showUrl) {
        const d = await getAny('tv/info', { q: showUrl });
        const t = d.data || {};
        const raw = Array.isArray(t.episodes) ? t.episodes : Array.isArray(t.episodes?.list) ? t.episodes.list : [];
        const episodes = raw.map((e, i) => {
            const title = String(e.episode_name || e.title || e.name || `Episode ${i + 1}`);
            const epUrl = e.episode_url || e.url || e.link || '';
            const sm = String(e.season ?? '').match(/\d+/) || title.match(/S(?:eason)?\s*0*(\d+)/i) || epUrl.match(/season-0*(\d+)/i);
            const em = String(e.episode ?? e.number ?? '').match(/\d+/) || title.match(/E(?:p(?:isode)?)?\s*0*(\d+)/i) || epUrl.match(/episode-0*(\d+)/i);
            return { season: sm ? parseInt(sm[1] || sm[0], 10) : 1, number: em ? parseInt(em[1] || em[0], 10) : i + 1, title, url: epUrl };
        }).filter(e => e.url);
        if (!episodes.length) throw new Error('Episodes hamu una na');
        return {
            title: t.title || 'Series',
            poster: t.image || t.poster || '',
            year: t.year || 'N/A',
            rating: (t.rating && t.rating.score) || t.rating || t.imdb || 'N/A',
            description: String(t.story || t.description || ''),
            episodes
        };
    }

    async function tvEpisodeLinks(episodeUrl) {
        const d = await getAny('tv/dl', { q: episodeUrl });
        const arr = Array.isArray(d.data) ? d.data : Array.isArray(d.data?.downloads) ? d.data.downloads : Array.isArray(d.links) ? d.links : [];
        const out = arr
            .map(l => ({ label: l.quality || l.name || l.meta || l.provider || l.size || 'Download', size: l.size || '', link: l.link || l.url || '', payLink: l.pay_link || '' }))
            .filter(l => (l.link || l.payLink) && !isTelegram(l.link, l.label));
        if (!out.length) throw new Error('Episode download links hamu una na');
        return out;
    }

    // series episode link: zt-link nam resolve karanawa, nathnam direct link eka
    async function tvFinalLink(l) {
        if (/zt-links/.test(l.link)) return finalLink({ link: l.link, payLink: l.payLink });
        return l.link || l.payLink;
    }

    return { search, movieInfo, resolve, finalLink, allLinks, tvInfo, tvEpisodeLinks, tvFinalLink };
}
