// TEMPORARY DEBUG VERSION — returns raw word bounding boxes so column/row
// gap thresholds can be tuned against real data. Not for production use.

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
      return json({ error: "Use POST" }, 405);
    }
    try {
      if (!env.GOOGLE_VISION_API_KEY) {
        return json({ error: "GOOGLE_VISION_API_KEY is not configured" }, 500);
      }
      const form = await request.formData();
      const file = form.get("image");
      if (!file) return json({ error: "No image field in form data" }, 400);

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
        return json({ error: `Vision API error ${visionRes.status}: ${errText}` }, 502);
      }

      const visionData = await visionRes.json();
      const result = visionData.responses && visionData.responses[0];
      if (result && result.error) {
        return json({ error: `Vision API error: ${result.error.message}` }, 502);
      }

      const words = extractWords(result);
      return json({ words });
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  },
};

function extractWords(result) {
  const words = [];
  const pages = (result && result.fullTextAnnotation && result.fullTextAnnotation.pages) || [];
  for (const page of pages) {
    for (const block of page.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const word of paragraph.words || []) {
          const text = (word.symbols || []).map((s) => s.text).join("");
          if (!text) continue;
          const vertices = (word.boundingBox && word.boundingBox.vertices) || [];
          if (vertices.length === 0) continue;
          const xs = vertices.map((v) => v.x || 0);
          const ys = vertices.map((v) => v.y || 0);
          const left = Math.min(...xs);
          const right = Math.max(...xs);
          const top = Math.min(...ys);
          const bottom = Math.max(...ys);
          words.push({
            text,
            cx: (left + right) / 2,
            cy: (top + bottom) / 2,
            left,
            right,
            width: right - left,
            height: bottom - top,
          });
        }
      }
    }
  }
  return words;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
