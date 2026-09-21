// Cloudflare Worker — receives an image from the PWA, sends it to a Workers AI
// vision-language model, and returns the transcribed text as lines.
//
// No third-party OCR account needed: Workers AI runs inside your own
// Cloudflare account, bound to this Worker via the [ai] binding in
// wrangler.toml. The image never touches Azure, Google, or anyone else.
//
// Setup:
//   1. wrangler.toml already binds the AI runtime (see [ai] section).
//   2. Deploy with: wrangler deploy
//   3. Note the deployed URL, e.g. https://lab-scanner-ocr.<you>.workers.dev
//
// Model notes:
//   @cf/meta/llama-3.2-11b-vision-instruct reads an image + a text prompt
//   and returns a text response. We prompt it to transcribe handwriting
//   line by line rather than to "describe" the image.

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    try {
      const form = await request.formData();
      const file = form.get("image");
      if (!file) {
        return json({ error: "No image field in form data" }, 400);
      }

      const imageBuffer = await file.arrayBuffer();
      const imageArray = [...new Uint8Array(imageBuffer)];

      const prompt =
        "Transcribe every handwritten and printed line of text visible in " +
        "this lab datasheet image, exactly as written, one line per line of " +
        "output. Do not summarize, interpret, or add commentary — output " +
        "only the transcribed lines, in the order they appear on the page.";

      const result = await env.AI.run(MODEL, {
        image: imageArray,
        prompt,
        max_tokens: 1024,
      });

      const text = (result && result.response) || "";
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      return json({ lines, raw: text });
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
