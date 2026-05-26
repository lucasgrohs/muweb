# MuAze Landing Page

Static landing page for the MuAze server (see `D:\dev\Mu` for the server stack).

## Stack
- Static HTML + CSS + vanilla JS — no build pipeline.
- Hosted on **Cloudflare Pages** (free, unlimited bandwidth, edge CDN).
- Dynamic content (`content.json`) fetched at runtime from the GCP VM, where
  the AdminPanel can edit it without rebuilding the site.

See [**DEPLOY.md**](DEPLOY.md) for the full deploy walkthrough.

## Layout

```
MuWebpage/
├── index.html
├── features.html
├── how-to-play.html
├── server-info.html
├── community.html
├── changelog.html
├── assets/
│   ├── css/
│   ├── js/
│   ├── img/
│   │   ├── raw/         # OZJ-decoded JPEGs (gitignored, intermediate only)
│   │   └── screenshots/
│   └── audio/
├── robots.txt
└── README.md
```

## Asset pipeline

Source art is in `D:\dev\MuMain\src\bin\Data\Logo\*.OZJ` (and other Data subfolders).
Decode with the converter in the Mu repo:

```powershell
python D:\dev\Mu\tools\ozj_decode.py --batch D:\dev\MuMain\src\bin\Data\Logo D:\dev\MuWebpage\assets\img\raw
```

Then optimize raw JPEGs into `assets/img/` (target ~100KB each, WebP preferred).

## Deploy

Hosted at `site.muaze.duckdns.org` behind Cloudflare proxy. See
`D:\dev\Mu\deploy\all-in-one\nginx\` for the server config (separate server block).
