// MuAze landing — content loader + scroll-reveal.
// Content is fetched from a JSON file so the AdminPanel can edit it without
// rebuilding the static site.
//
// Two deployment scenarios:
//   - Local dev (localhost / 127.0.0.1): fetch relative ./data/content.json
//     (file bundled alongside the page).
//   - Production (Cloudflare Pages or any other origin): fetch from the
//     GCP VM, which is where the AdminPanel writes edits. CORS must be
//     enabled on the nginx serving that endpoint.

const VM_CONTENT_URL = 'https://api.muaze.online/data/content.json';
const VM_NEWS_URL    = 'https://api.muaze.online/api/news/posts';
const VM_STATS_URL   = 'https://api.muaze.online/api/stats/summary';
const isLocal = location.hostname === 'localhost'
             || location.hostname === '127.0.0.1'
             || location.hostname === '';
const CONTENT_URL = isLocal ? '/data/content.json'   : VM_CONTENT_URL;
const NEWS_URL    = isLocal ? '/api/news/posts'      : VM_NEWS_URL;
const STATS_URL   = isLocal ? '/api/stats/summary'   : VM_STATS_URL;
const NEWS_MAX = 4;

// NewsCategory enum -> display label + badge css class. Mirrors the int values
// from src/DataModel/Entities/NewsPost.cs on the server side.
const NEWS_CATEGORIES = {
    0: { label: 'Anúncio',     cls: 'cat-announce' },
    1: { label: 'Atualização', cls: 'cat-update'   },
    2: { label: 'Evento',      cls: 'cat-event'    },
};

// ---------------------------------------------------------------------------
// Content templating
// ---------------------------------------------------------------------------

function getNested(obj, path) {
    return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function applyValue(el, value, useHtml) {
    if (value == null) return;
    if (useHtml) el.innerHTML = value;
    else el.textContent = value;
}

function fillScalars(scope, data) {
    // data-content="path.to.field"           → textContent
    // data-content-html="path.to.field"      → innerHTML
    // data-content-attr="href:path.to.field" → setAttribute(href, value)
    scope.querySelectorAll('[data-content]').forEach(el => {
        applyValue(el, getNested(data, el.dataset.content), false);
    });
    scope.querySelectorAll('[data-content-html]').forEach(el => {
        applyValue(el, getNested(data, el.dataset.contentHtml), true);
    });
    scope.querySelectorAll('[data-content-attr]').forEach(el => {
        // Supports multiple pairs separated by ";", e.g. "src:imgUrl;alt:name"
        el.dataset.contentAttr.split(';').forEach(spec => {
            const colon = spec.indexOf(':');
            if (colon < 0) return;
            const attr = spec.slice(0, colon).trim();
            const key = spec.slice(colon + 1).trim();
            const value = getNested(data, key);
            if (value != null) el.setAttribute(attr, value);
        });
    });
}

function fillLists(scope, data) {
    // <container data-content-list="path.to.array">
    //   <child data-content-template>
    //     <span data-content-item="title"></span>
    //     <a    data-content-item-attr="href:linkUrl"></a>
    //   </child>
    // </container>
    scope.querySelectorAll('[data-content-list]').forEach(container => {
        const items = getNested(data, container.dataset.contentList);
        const template = container.querySelector('[data-content-template]');
        if (!Array.isArray(items) || !template) return;

        // Strip any previously rendered children except the template
        Array.from(container.children).forEach(child => {
            if (child !== template) child.remove();
        });

        items.forEach(item => {
            const clone = template.cloneNode(true);
            clone.removeAttribute('data-content-template');
            clone.style.display = '';

            clone.querySelectorAll('[data-content-item]').forEach(el => {
                applyValue(el, getNested(item, el.dataset.contentItem), false);
            });
            clone.querySelectorAll('[data-content-item-html]').forEach(el => {
                applyValue(el, getNested(item, el.dataset.contentItemHtml), true);
            });
            clone.querySelectorAll('[data-content-item-attr]').forEach(el => {
                // Supports multiple pairs separated by ";", e.g. "src:imgUrl;alt:name"
                el.dataset.contentItemAttr.split(';').forEach(spec => {
                    const colon = spec.indexOf(':');
                    if (colon < 0) return;
                    const attr = spec.slice(0, colon).trim();
                    const key = spec.slice(colon + 1).trim();
                    const value = getNested(item, key);
                    if (value != null) el.setAttribute(attr, value);
                });
            });
            // Conditionally hide elements when an item field is missing/empty
            clone.querySelectorAll('[data-content-item-if]').forEach(el => {
                const key = el.dataset.contentItemIf;
                const value = getNested(item, key);
                if (value == null || value === '') el.style.display = 'none';
            });

            container.appendChild(clone);
        });

        template.remove();
    });
}

async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.json();
}

async function loadContent() {
    let data = null;

    // Primary: configured CONTENT_URL (VM in prod, relative in dev).
    try {
        data = await fetchJson(CONTENT_URL);
    } catch (err) {
        console.warn('[muaze] primary content fetch failed:', err);
    }

    // Fallback: bundled /data/content.json. Only attempted when (a) primary
    // failed AND (b) we weren't already trying the bundled file. Ensures the
    // list templates render correctly even when CORS / VM endpoint isn't up
    // yet — Cloudflare Pages ships the JSON alongside the rest of the site.
    if (!data && CONTENT_URL !== '/data/content.json') {
        try {
            data = await fetchJson('/data/content.json');
            console.info('[muaze] loaded fallback content.json (bundled)');
        } catch (err) {
            console.warn('[muaze] fallback content.json also failed:', err);
        }
    }

    if (data) {
        fillScalars(document, data);
        fillLists(document, data);
    }

    // Stats + News loaded independently from content.json — both DB-backed.
    // Fetch in parallel so news doesn't wait on the (slower, cached) stats call.
    initNewsModal();
    await Promise.all([loadStats(), loadNews()]);

    // Auto-refresh stats every 60s while the tab is visible — matches the
    // server-side cache TTL so we never refetch faster than the snapshot rebuilds.
    // News doesn't auto-refresh (posts arrive infrequently; a page reload is fine).
    setInterval(() => {
        if (document.visibilityState !== 'hidden') loadStats(true);
    }, 60_000);

    // Reveal-able elements get observed AFTER content is filled so
    // template-cloned items also fade in.
    initScrollReveal();
}

// ---------------------------------------------------------------------------
// Stats summary — players-online + leaderboards. Server caches for 60s; this
// runs once on page load. Each value falls back gracefully (em-dash) if the
// endpoint is unreachable so the section never looks broken.
// ---------------------------------------------------------------------------

const NUMBER_FORMATTER = new Intl.NumberFormat('pt-BR');

function formatNumber(n) {
    if (n == null || isNaN(n)) return '—';
    return NUMBER_FORMATTER.format(n);
}

function formatUptime(seconds) {
    if (seconds == null || seconds < 60) return '< 1m';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function renderRankingTable(tableId, entries, columns) {
    const table = document.getElementById(tableId);
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    const headerCols = table.querySelectorAll('thead th').length;
    if (!Array.isArray(entries) || entries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${headerCols}" class="ranking-empty">Sem entradas ainda.</td></tr>`;
        return;
    }

    tbody.replaceChildren(...entries.map((entry, index) => {
        const tr = document.createElement('tr');
        if (index < 3) tr.classList.add('ranking-podium');
        columns.forEach(col => {
            const td = document.createElement('td');
            if (col.dom) {
                // Column delegates DOM construction (used by columns that need mixed
                // markup, e.g. Level + Master Level suffix).
                td.appendChild(col.dom(entry));
            } else {
                const value = entry[col.key];
                td.textContent = col.format ? col.format(value) : String(value ?? '');
            }
            if (col.cls) td.className = col.cls;
            tr.appendChild(td);
        });
        return tr;
    }));
}

// Events ticker --------------------------------------------------------------
// Each `events-row` entry carries a `data-target-epoch` attribute set when the
// server snapshot lands; a single setInterval ticks the visible countdown each
// second so the user sees a live timer without re-fetching every second.

let eventsTickerHandle = null;

function formatCountdown(seconds) {
    if (seconds == null || seconds < 0) return '0s';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m ${String(r).padStart(2, '0')}s`;
    return `${r}s`;
}

function renderEvents(events) {
    const row = document.getElementById('events-row');
    if (!row) return;
    if (!Array.isArray(events) || events.length === 0) {
        row.innerHTML = '<div class="events-empty">Sem eventos agendados.</div>';
        return;
    }

    const now = Date.now();
    row.replaceChildren(...events.map(evt => {
        const card = document.createElement('article');
        card.className = 'event-card ' + (evt.status === 'Running' ? 'event-running' : 'event-soon');
        card.dataset.targetEpoch = String(now + (evt.remainingSeconds || 0) * 1000);
        card.dataset.status = evt.status;

        const status = document.createElement('span');
        status.className = 'event-status';
        status.textContent = evt.status === 'Running' ? 'AGORA' : 'EM BREVE';

        const name = document.createElement('h4');
        name.className = 'event-name';
        name.textContent = evt.name;

        const countdown = document.createElement('div');
        countdown.className = 'event-countdown';
        countdown.textContent = formatCountdown(evt.remainingSeconds);

        const meta = document.createElement('div');
        meta.className = 'event-meta';
        if (evt.status === 'Running') {
            meta.textContent = evt.playerCount > 0
                ? `${evt.playerCount} jogador${evt.playerCount > 1 ? 'es' : ''}`
                : 'Em andamento';
        } else {
            meta.textContent = 'Próximo início';
        }

        card.append(status, name, countdown, meta);
        return card;
    }));

    if (eventsTickerHandle) clearInterval(eventsTickerHandle);
    eventsTickerHandle = setInterval(tickEvents, 1000);
    tickEvents();
}

function tickEvents() {
    const row = document.getElementById('events-row');
    if (!row) return;
    const now = Date.now();
    row.querySelectorAll('.event-card').forEach(card => {
        const target = Number(card.dataset.targetEpoch) || 0;
        const seconds = Math.max(0, Math.round((target - now) / 1000));
        const countdown = card.querySelector('.event-countdown');
        if (countdown) countdown.textContent = formatCountdown(seconds);
        if (seconds === 0 && card.dataset.status === 'OpensIn') {
            // Visually flip OpensIn → Running while we wait for the next 60s
            // snapshot to confirm; status pill swap is enough, name/meta stay.
            card.classList.remove('event-soon');
            card.classList.add('event-running');
            const pill = card.querySelector('.event-status');
            if (pill) pill.textContent = 'AGORA';
            card.dataset.status = 'Running';
        }
    });
}

function buildLevelCell(entry) {
    // Level + optional Master Level suffix. Renders as "400" for base chars and
    // "400 + ML 50" for characters that have transitioned, so the public table
    // surfaces master progression without breaking the existing column layout.
    const wrap = document.createElement('span');
    wrap.textContent = formatNumber(entry.level);
    if (entry.masterLevel > 0) {
        const ml = document.createElement('small');
        ml.className = 'ranking-ml';
        ml.textContent = ` + ML ${formatNumber(entry.masterLevel)}`;
        wrap.appendChild(ml);
    }
    return wrap;
}

function renderSparkline(containerId, points) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!Array.isArray(points) || points.length < 2) {
        container.innerHTML = '';
        return;
    }

    // Project the count series onto a viewBox-relative path. preserveAspectRatio="none"
    // stretches it to the container's width while keeping the stroke crisp.
    const width = 100;
    const height = 28;
    const counts = points.map(p => p.count ?? 0);
    const max = Math.max(...counts, 1);
    const step = width / Math.max(1, points.length - 1);

    let d = '';
    points.forEach((p, i) => {
        const x = (i * step).toFixed(1);
        const y = (height - (p.count / max) * height).toFixed(1);
        d += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
    });

    // Closing the path with a baseline gives us a soft fill under the line.
    const fillPath = d + `L${width},${height} L0,${height} Z`;

    container.innerHTML = `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="sparkline">
            <path class="sparkline-fill" d="${fillPath}"/>
            <path class="sparkline-line" d="${d.trim()}"/>
        </svg>`;
}

function renderUptimeSubtitle(bestSeconds, totalBoots) {
    const sub = document.getElementById('stat-uptime-sub');
    if (!sub) return;
    if (!bestSeconds || !totalBoots) {
        sub.textContent = '';
        return;
    }
    sub.textContent = `Best: ${formatUptime(bestSeconds)} · ${formatNumber(totalBoots)} boot${totalBoots > 1 ? 's' : ''}`;
}

function flashRefreshIndicator() {
    const dot = document.getElementById('stats-refresh-dot');
    if (!dot) return;
    // Restart the animation by removing the class and forcing a reflow before re-adding.
    dot.classList.remove('flash');
    void dot.offsetWidth;
    dot.classList.add('flash');
}

async function loadStats(isRefresh = false) {
    const playersEl  = document.getElementById('stat-players');
    const uptimeEl   = document.getElementById('stat-uptime');
    const accountsEl = document.getElementById('stat-accounts');
    const guildsEl   = document.getElementById('stat-guilds');
    if (!playersEl) return;

    let stats = null;
    try {
        stats = await fetchJson(STATS_URL);
    } catch (err) {
        console.warn('[muaze] stats fetch failed:', err);
    }
    if (!stats) return;

    // textContent replaces the skeleton span on first paint and any subsequent value.
    playersEl.textContent  = formatNumber(stats.playersOnline);
    uptimeEl.textContent   = formatUptime(stats.uptimeSeconds);
    accountsEl.textContent = formatNumber(stats.totalAccounts);
    guildsEl.textContent   = formatNumber(stats.totalGuilds);

    renderSparkline('sparkline-players', stats.onlineHistory);
    renderUptimeSubtitle(stats.bestUptimeSeconds, stats.totalBoots);

    renderEvents(stats.events);

    renderRankingTable('ranking-guilds', stats.topGuilds, [
        { key: 'rank' },
        { key: 'name' },
        { key: 'score', format: formatNumber, cls: 'ranking-num' },
    ]);

    renderRankingTable('ranking-players', stats.topPlayers, [
        { key: 'rank' },
        { key: 'name' },
        { key: 'class' },
        { dom: buildLevelCell, cls: 'ranking-num' },
    ]);

    if (isRefresh) flashRefreshIndicator();
}

// ---------------------------------------------------------------------------
// News feed (separate from content.json — fetched from /api/news/posts which
// the AdminPanel writes to a DB-backed table; the launcher consumes the same
// endpoint). Empty state is graceful: if the fetch fails or the feed is empty
// we render a muted "no news yet" message instead of leaving a broken section.
// ---------------------------------------------------------------------------

function formatNewsDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function htmlToPlainText(html) {
    // Card excerpt should never render markup — strip tags via temporary node so
    // the preview can't accidentally inject styles from the admin's HTML body.
    const tmp = document.createElement('div');
    tmp.innerHTML = html ?? '';
    return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
}

function renderNewsCard(post) {
    const cat = NEWS_CATEGORIES[post.category] || NEWS_CATEGORIES[0];
    const card = document.createElement('article');
    card.className = 'news-card' + (post.pinned ? ' is-pinned' : '');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Ler notícia: ${post.title}`);

    const fullText = htmlToPlainText(post.body);
    const excerpt = fullText.length > 180 ? fullText.slice(0, 180).trimEnd() + '…' : fullText;

    const badge = document.createElement('span');
    badge.className = `news-cat-badge ${cat.cls}`;
    badge.textContent = cat.label;

    const heading = document.createElement('h3');
    heading.textContent = post.title;

    const excerptEl = document.createElement('p');
    excerptEl.className = 'news-excerpt';
    excerptEl.textContent = excerpt;

    const dateEl = document.createElement('time');
    dateEl.dateTime = post.postDate;
    dateEl.textContent = formatNewsDate(post.postDate);

    const readMore = document.createElement('span');
    readMore.className = 'news-read-more';
    readMore.textContent = 'Ler mais →';

    const meta = document.createElement('div');
    meta.className = 'news-meta';
    meta.append(dateEl, readMore);

    card.append(badge, heading, excerptEl, meta);

    const open = () => openNewsModal(post);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
        }
    });
    return card;
}

function openNewsModal(post) {
    const modal = document.getElementById('news-modal');
    if (!modal) return;
    const cat = NEWS_CATEGORIES[post.category] || NEWS_CATEGORIES[0];
    const badge = modal.querySelector('.news-cat-badge');
    badge.className = `news-cat-badge ${cat.cls}`;
    badge.textContent = cat.label;
    modal.querySelector('#news-modal-title').textContent = post.title;
    const t = modal.querySelector('time');
    t.dateTime = post.postDate;
    t.textContent = formatNewsDate(post.postDate);
    modal.querySelector('.news-modal-body').innerHTML = post.body || '';
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    modal.querySelector('.news-modal-close').focus();
}

function closeNewsModal() {
    const modal = document.getElementById('news-modal');
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
}

function initNewsModal() {
    const modal = document.getElementById('news-modal');
    if (!modal) return;
    modal.querySelector('.news-modal-backdrop').addEventListener('click', closeNewsModal);
    modal.querySelector('.news-modal-close').addEventListener('click', closeNewsModal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hidden) closeNewsModal();
    });
}

async function loadNews() {
    const grid = document.getElementById('news-grid');
    if (!grid) return;

    let posts = null;
    try {
        posts = await fetchJson(NEWS_URL);
    } catch (err) {
        console.warn('[muaze] news fetch failed:', err);
    }

    if (!Array.isArray(posts) || posts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'news-empty';
        empty.textContent = grid.dataset.emptyState || 'Sem notícias.';
        grid.replaceChildren(empty);
        return;
    }

    // /api/news/posts already orders pinned-first then by PostDate desc.
    grid.replaceChildren(...posts.slice(0, NEWS_MAX).map(renderNewsCard));
}

// ---------------------------------------------------------------------------
// Scroll-reveal (IntersectionObserver)
// ---------------------------------------------------------------------------

function initScrollReveal() {
    if (!('IntersectionObserver' in window)) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const selectors = ['.card', '.class-card', '.step', '.rate-table', '.news-card'];
    const targets = document.querySelectorAll(selectors.join(','));
    if (!targets.length) return;

    targets.forEach((el, i) => {
        el.classList.add('reveal');
        el.style.setProperty('--reveal-delay', `${(i % 4) * 60}ms`);
    });

    const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-revealed');
                io.unobserve(entry.target);
            }
        }
    }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });

    targets.forEach(el => io.observe(el));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadContent);
} else {
    loadContent();
}
