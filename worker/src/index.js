// Cloudflare Worker — receives an image from the PWA, sends it to Google
// Cloud Vision's DOCUMENT_TEXT_DETECTION (a purpose-built OCR engine, not a
// general vision-language model), and returns the transcribed text as lines.
//
// Setup:
//   1. A Google Cloud project with Vision API enabled and billing on.
//   2. An API key restricted to the Vision API only.
//   3. That key stored as a Cloudflare secret named GOOGLE_VISION_API_KEY
//      (Settings -> Build -> Variables and secrets, type "Secret", for a
//      Worker deployed via Git integration).
//   4. Deploy (push to main, or trigger a rebuild) so the secret is picked
//      up by the running Worker.
//
// Why the swap from Workers AI: @cf/meta/llama-3.2-11b-vision-instruct is a
// general vision-language model, not a dedicated OCR engine. Real-world
// testing showed only ~60% digit accuracy (40% of numbers misread), which
// isn't good enough for datasheets that are mostly numeric measurements.
// Google Cloud Vision's OCR is purpose-built and much stronger on digits.

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
      if (!env.GOOGLE_VISION_API_KEY) {
        return json({ error: "GOOGLE_VISION_API_KEY is not configured" }, 500);
      }

      const form = await request.formData();
      const file = form.get("image");
      if (!file) {
        return json({ error: "No image field in form data" }, 400);
      }

      const imageBuffer = await file.arrayBuffer();
      const base64Image = arrayBufferToBase64(imageBuffer);

      const visionRes = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: [
              {
                image: { content: base64Image },
                features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
              },
            ],
          }),
        }
      );

      if (!visionRes.ok) {
        const errText = await visionRes.text();
        return json(
          { error: `Vision API error ${visionRes.status}: ${errText}` },
          502
        );
      }

      const visionData = await visionRes.json();
      const result = visionData.responses && visionData.responses[0];
      if (result && result.error) {
        return json({ error: `Vision API error: ${result.error.message}` }, 502);
      }

      const text =
        (result && result.fullTextAnnotation && result.fullTextAnnotation.text) ||
        "";
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

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunkSize)
    );
  }
  return btoa(binary);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
