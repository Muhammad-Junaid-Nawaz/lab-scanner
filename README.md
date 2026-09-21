# Lab Scanner — experiment (GitHub + Cloudflare)

Phone browser camera to OCR to editable text to Excel download. No app install, no native build, no Azure. Purpose is to validate OCR accuracy on real lab datasheets before investing further.

## Stack

• GitHub holds this code.
• Cloudflare Pages hosts the frontend (web/), connected directly to this repo.
• Cloudflare Worker (worker/) is the backend proxy, calls Workers AI for OCR.
• Cloudflare Workers AI: a vision-language model does the transcription, no third-party OCR account needed.

## What's here

• web/index.html: the whole frontend. One file, no build step.
• worker/src/index.js: the backend proxy Worker.
• worker/wrangler.toml: Worker config, binds Workers AI as env.AI.

## Setup (roughly 10-15 minutes)

### 1. Deploy the Worker

Easiest path: Cloudflare dashboard, Workers and Pages, Create, Worker, connect to Git, point it at this repo's worker/ folder. Or from your own machine:

cd worker
npm install -g wrangler
wrangler login
wrangler deploy


Note the deployed URL, e.g. https://lab-scanner-ocr.<you>.workers.dev. If prompted to enable Workers AI, that's a one-click toggle in your existing Cloudflare account, no new signup.

### 2. Point the frontend at the Worker

Edit web/index.html, replace the OCR_ENDPOINT placeholder with the real Worker URL from step 1. Commit the change.

### 3. Deploy the frontend on Cloudflare Pages

Cloudflare dashboard, Workers and Pages, Create, Pages, Connect to Git, pick this repo, set build output directory to web (no build command needed, it's static). Deploy. You'll get a URL like lab-scanner.pages.dev, HTTPS by default.

### 4. Test on your phone

Open the .pages.dev URL in Chrome (Android) or Safari (iOS), allow camera access, capture a real datasheet, and see how clean the transcription comes back.

## On OCR accuracy

Workers AI's vision model is general-purpose, not a dedicated OCR engine. It's free and stays entirely in your Cloudflare account, but handwriting accuracy is unproven until tested. If it's too rough on real datasheets, two fallback options (not built here) are Google Cloud Vision (strong at handwriting, requires a new Google Cloud project plus billing) or the OCR.space free API (instant key, weaker on handwriting). Swapping the OCR call in worker/src/index.js later is a small, isolated change.

## What this deliberately skips (for now)

• Template mapping: OCR result is raw lines of text, not mapped to labeled fields.
• Local storage/database: each scan's Excel file downloads directly.
• Confidence-based auto-save/review logic.
• Any styling.

Once OCR accuracy looks good enough on real sheets, next steps are template mapping and local storage via IndexedDB.
