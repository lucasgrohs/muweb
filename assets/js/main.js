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

const VM_CONTENT_URL = 'https://muaze.duckdns.org/data/content.json';
const isLocal = location.hostname === 'localhost'
             || location.hostname === '127.0.0.1'
             || location.hostname === '';
const CONTENT_URL = isLocal ? '/data/content.json' : VM_CONTENT_URL;

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

async function loadContent() {
    try {
        const res = await fetch(CONTENT_URL, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        fillScalars(document, data);
        fillLists(document, data);
    } catch (err) {
        // Fail silently — the HTML defaults remain visible so the site still
        // works if content.json is missing.
        console.warn('[muaze] content.json failed to load:', err);
    } finally {
        // Reveal-able elements get observed AFTER content is filled so
        // template-cloned items also fade in.
        initScrollReveal();
    }
}

// ---------------------------------------------------------------------------
// Scroll-reveal (IntersectionObserver)
// ---------------------------------------------------------------------------

function initScrollReveal() {
    if (!('IntersectionObserver' in window)) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const selectors = ['.card', '.class-card', '.step', '.rate-table'];
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
