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
