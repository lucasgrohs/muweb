# Deploy — MuAze Landing Page

Architecture:

```
┌──────────────────────────┐     ┌─────────────────────────────┐
│ Cloudflare Pages         │     │ GCP VM (35.199.91.159)      │
│ ─ HTML / CSS / JS / IMG  │     │ ─ AdminPanel (Blazor)       │
│ ─ Auto-deploy on git push│     │ ─ nginx + Let's Encrypt     │
│ ─ Unlimited bandwidth    │     │ ─ /data/content.json (CORS) │
│ ─ Edge CDN, free TLS     │     │ ─ Game server               │
└─────────┬────────────────┘     └─────────────┬───────────────┘
          │                                    │
          │  page load                         │  main.js fetches
          ▼                                    ▼
       Browser  ───────  fetch  ────────► content.json (fresh)
```

The static site lives on Cloudflare (free, edge-cached). The dynamic content
(`content.json`) lives on the VM and is updated via the AdminPanel. Visitors
get the site instantly from the edge; main.js then pulls the latest content
from the VM. Public read-only, CORS-enabled — no auth on that endpoint.

---

## Part 1 — Push MuWebpage to GitHub

```powershell
cd D:\dev\MuWebpage
git add .
git commit -m "Initial commit: data-driven landing page"
```

Then on GitHub:
1. Create a new repo (private OK — Cloudflare Pages supports both).
2. Don't add README / .gitignore / license (we already have them).
3. Copy the remote URL.

Back in PowerShell:

```powershell
git remote add origin https://github.com/<YOUR_USER>/MuWebpage.git
git branch -M master
git push -u origin master
```

---

## Part 2 — Cloudflare Pages

1. Sign up / log in at https://dash.cloudflare.com (free tier).
2. Sidebar: **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
3. Authorize Cloudflare's GitHub app, pick the `MuWebpage` repo.
4. Configure build:
   - **Production branch**: `master`
   - **Framework preset**: None
   - **Build command**: *(leave empty)*
   - **Build output directory**: `/` *(or leave empty — same thing)*
5. **Save and Deploy**. First deploy takes ~30 seconds.
6. Cloudflare assigns a URL like `https://muaze-webpage-xyz.pages.dev` — that's your site, live.

Every `git push` to `master` triggers a redeploy automatically. PRs get
preview deployments at their own URL.

### Custom domain (optional, recommended)

If you bought `muaze.gg` / `.com` / `.com.br`:
1. In Cloudflare Pages project → **Custom domains** → **Set up a custom domain**.
2. Enter the domain. Cloudflare gives DNS instructions.
3. Point the domain's nameservers at Cloudflare (one-time setup).
4. Cert provisions automatically; HTTPS live within minutes.

If staying on DuckDNS for now: skip this — the `.pages.dev` URL is fine.

---

## Part 3 — Expose content.json on the VM (CORS + no-auth)

Edit [deploy/all-in-one/nginx/nginx.prod443.conf](../Mu/deploy/all-in-one/nginx/nginx.prod443.conf)
on the VM (or commit + redeploy). Add this `location` block alongside the
existing `/launcher/` and `/api/auth/` ones:

```nginx
# Landing-page content (read by the public site on Cloudflare Pages).
# AdminPanel writes it; nginx serves with CORS so any origin can fetch.
location = /data/content.json {
    auth_basic off;
    alias /landing-data/content.json;
    default_type application/json;

    # Any origin can fetch — the JSON is public marketing copy.
    add_header Access-Control-Allow-Origin "*" always;
    add_header Cache-Control "no-cache, max-age=60" always;

    # 200 OK on preflight OPTIONS — needed if a tool sends one.
    if ($request_method = 'OPTIONS') {
        add_header Access-Control-Allow-Origin "*";
        add_header Access-Control-Allow-Methods "GET, OPTIONS";
        add_header Access-Control-Max-Age 86400;
        return 204;
    }
}
```

Then mount the shared volume so nginx sees the file the AdminPanel writes.
Edit [docker-compose.yml](../Mu/deploy/all-in-one/docker-compose.yml):

```yaml
services:
  nginx-80:                       # (the prod nginx — same name in dev)
    volumes:
      - ./nginx/nginx.prod443.conf:/etc/nginx/nginx.conf:ro
      - ./.htpasswd:/etc/nginx/.htpasswd
      - ./landing-data:/landing-data:ro     # ← NEW: read-only mount
      - <existing volumes...>

  openmu-startup:
    environment:
      MUAZE_LANDING_CONTENT_PATH: /landing-data/content.json   # ← NEW
    volumes:
      - <existing volumes...>
      - ./landing-data:/landing-data       # ← NEW: read-write mount
```

Then on the VM:

```bash
cd /opt/muaze/deploy/all-in-one     # or wherever the stack lives
mkdir -p landing-data
# Seed it with the current dev JSON (one-time):
scp D:/dev/MuWebpage/data/content.json user@35.199.91.159:/opt/muaze/deploy/all-in-one/landing-data/content.json
docker-compose up -d --force-recreate nginx-80 openmu-startup
```

Verify:

```bash
curl -i https://muaze.duckdns.org/data/content.json
# Expect: HTTP/2 200, Content-Type: application/json, Access-Control-Allow-Origin: *
```

---

## Part 4 — Test end-to-end

1. Open the Cloudflare Pages URL (e.g., `https://muaze-webpage-xyz.pages.dev`).
2. DevTools Network tab should show:
   - HTML/CSS/JS/IMG → **served from Cloudflare** (response header `cf-ray:`).
   - `/data/content.json` → **fetched from muaze.duckdns.org** with CORS headers.
3. Open AdminPanel (`https://muaze.duckdns.org/admin/landing-page`), edit a
   field, Save.
4. Reload the Cloudflare URL — change appears within 60s (nginx cache window).

---

## How the host-detect logic works

[assets/js/main.js](assets/js/main.js) at boot time:

```javascript
const VM_CONTENT_URL = 'https://muaze.duckdns.org/data/content.json';
const isLocal = location.hostname === 'localhost'
             || location.hostname === '127.0.0.1'
             || location.hostname === '';
const CONTENT_URL = isLocal ? '/data/content.json' : VM_CONTENT_URL;
```

- Local dev (`python -m http.server 8765`): fetches the bundled JSON.
- Anywhere else (Cloudflare / staging / preview deploys): fetches the live
  one from the VM.

If you switch DNS to a different VM, update the `VM_CONTENT_URL` constant
and push — Cloudflare redeploys automatically.

---

## Forwards-compatible: turning off the VM dependency

If you ever want the site to be FULLY static (no VM), set `VM_CONTENT_URL`
to a same-origin path like `'/data/content.json'`. The file will deploy with
the site (Cloudflare Pages serves it). The trade-off: every content edit
needs a `git push` to redeploy. Right now we have the live-edit panel, so
the VM dependency is intentional.

---

## Limits & costs (Cloudflare free tier)

| Resource | Limit |
|---|---|
| Bandwidth | **Unlimited** |
| Builds | 500/month (≈16/day) |
| Build minutes | 20 min max per build |
| Files per site | 20,000 |
| File size | 25 MiB each |
| Custom domains | 100 per project |

For this site (≈15 files, ≤500KB each), only the build cap is a soft
constraint — but each `git push` is one build, so 16/day is plenty for
manual edits. Live content edits don't trigger builds (they only touch
the VM).
