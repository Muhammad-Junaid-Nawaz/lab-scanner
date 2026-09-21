# Lab Scanner — Project Brief

Living context doc for this project. Paste the "Claude Project instructions"
section below into a Claude Project if you set one up; either way, this file
is the source of truth in the repo.

## What this is

A phone-browser PWA experiment: use a phone's camera to photograph a
handwritten lab datasheet, run OCR on it, let the user review/edit the
transcribed text, then export it to Excel. The goal right now is purely to
validate OCR accuracy on real handwriting before investing in a native
mobile app or any template-mapping / database features.

## Architecture (current)

* **Hosting**: Cloudflare Pages, deployed via Git integration from this repo
  (root directory: `web/`). Live at `https://lab-scanner-web.pages.dev`.
* **Backend**: a single Cloudflare Worker (`worker/`), deployed via Git
  integration (root directory: `worker/`, deploy command
  `npx wrangler deploy`). Live at `https://lab-scanner.mjn97631.workers.dev`.
* **OCR engine**: currently Cloudflare Workers AI
  (`@cf/meta/llama-3.2-11b-vision-instruct`), bound to the Worker via the
  `[ai]` section in `wrangler.toml` — no API key needed. **Known issue**:
  general vision-language model, not a dedicated OCR engine — real-world
  test showed ~90% accuracy on letters but only ~60% on digits (40% of
  numbers misread), which is a problem since datasheet content is mostly
  numeric measurements.
* **No Azure anywhere.** The project started on Azure Static Web Apps +
  Azure AI Vision + Azure Functions, but Azure's subscription kept blocking
  resource creation with `RequestDisallowedByAzure` region-policy errors
  across every region tried. Fully rebuilt on GitHub + Cloudflare instead.

## Decision in progress: swap OCR engine to Google Cloud Vision

Because digit accuracy is the priority (lab measurements), the plan is to
replace the Workers AI call in `worker/src/index.js` with a call to Google
Cloud Vision's `DOCUMENT_TEXT_DETECTION`, which is a purpose-built OCR
engine with much stronger character/digit-level accuracy than a
general-purpose vision-language model.

Setup requires (must be done by the account owner, not by Claude):
1. A Google Cloud project with billing enabled (Vision API free tier is
   ~1,000 units/month).
2. The Vision API enabled on that project.
3. An API key, ideally restricted to the Vision API only.
4. The key stored as a Cloudflare Worker secret (`wrangler secret put`, or
   via the Cloudflare dashboard's encrypted environment variables) — never
   committed to the repo or pasted into chat.

Once the key exists, the Worker code change is small and isolated: swap the
`env.AI.run(...)` call for a `fetch()` to
`https://vision.googleapis.com/v1/images:annotate`, keep everything else
(CORS, form handling, response shape) the same so the frontend doesn't need
to change.

## Repo layout

```
web/index.html        — the whole frontend (single file, no build step)
worker/src/index.js   — the backend proxy (receives photo, calls OCR, returns lines)
worker/wrangler.toml  — Worker config incl. the Workers AI binding
README.md             — setup instructions
docs/project-brief.md — this file
```

## What's deliberately not built yet

* Template mapping (OCR result is raw lines, not mapped to labeled fields)
* Local storage / database (each scan's Excel file downloads directly)
* Confidence-based auto-save/review logic
* Any real styling / UI polish

## Working across multiple chats

This project spans more than one concern (backend/OCR pipeline, frontend
UI/UX, deployment). When starting a new chat for one slice of the work:

1. Point it at this file (`docs/project-brief.md`) and the repo:
   `https://github.com/Muhammad-Junaid-Nawaz/lab-scanner`
2. Say which slice it owns (e.g. "this chat is for UI/UX only — don't touch
   the Worker backend logic").
3. Update this file when a real architectural decision is made (new OCR
   engine, new hosting choice, template-mapping design, etc.) so other
   chats stay in sync — it's the single source of truth, not any one chat's
   memory.

## Status log

* Rebuilt from Azure to GitHub + Cloudflare (Pages + Workers + Workers AI).
* Deployed and confirmed working end-to-end.
* Resolved a one-time Meta/Llama license-acceptance gate that was causing
  500 errors on every OCR request.
* Real handwriting test: ~90% letter accuracy, ~60% overall / ~60% digit
  accuracy (40% of numbers misread) — not good enough for numeric lab data.
* Next: swap OCR engine to Google Cloud Vision for better digit accuracy.
