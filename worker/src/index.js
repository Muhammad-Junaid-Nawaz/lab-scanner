// Cloudflare Worker — receives an image from the PWA, sends it to Google
// Cloud Vision's DOCUMENT_TEXT_DETECTION, then reconstructs the page's
// table/grid structure from word bounding boxes (Vision returns text in
// reading order only — it has no idea the page is a table — so we rebuild
// rows/columns ourselves from each word's x/y position).
//
// Setup:
//   1. A Google Cloud project with Vision API enabled and billing on.
//   2. An API key restricted to the Vision API only.
//   3. That key stored as a Cloudflare secret named GOOGLE_VISION_API_KEY
//      under Settings -> "Runtime variables and secrets" (NOT the "Variables
//      and secrets" under Settings -> Build, which only applies at
//      build/deploy time, not to the running Worker).
//   4. Deploy (push to main) so the secret is picked up.
//
// Response shape:
//   { rows: [["Trial","Weight (g)","pH"], ["1","152.3","5.8"], ...],
//     lines: ["Trial\tWeight (g)\tpH", "1\t152.3\t5.8", ...],  // tab-joined, for the editable textarea
//     raw: "<Vision's own plain-text output, for reference>" }

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

      const rawText =
        (result && result.fullTextAnnotation && result.fullTextAnnotation.text) ||
        "";

      const words = extractWords(result);
      const rows = wordsToGrid(words);
      const lines = rows.map((row) => row.join("\t"));

      return json({ rows, lines, raw: rawText });
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  },
};

// Flatten every word on the page into { text, cx, cy, left, right, width, height }
// using the average of its bounding-box vertices, ignoring Vision's own
// block/paragraph/line grouping (that grouping is tuned for prose, not
// tables, and reordering by raw coordinates works better for grids).
function extractWords(result) {
  const words = [];
  const pages = (result && result.fullTextAnnotation && result.fullTextAnnotation.pages) || [];
  for (const page of pages) {
    for (const block of page.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const word of paragraph.words || []) {
          const text = (word.symbols || []).map((s) => s.text).join("");
          if (!text) continue;
          const vertices =
            (word.boundingBox && word.boundingBox.vertices) || [];
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

// Cluster words into rows by vertical center, then split each row into
// cells wherever the horizontal gap between consecutive words is large
// relative to typical word width (a column boundary) rather than small
// (just a space within the same cell/word run).
function wordsToGrid(words) {
  if (words.length === 0) return [];

  const medianHeight = median(words.map((w) => w.height)) || 20;
  const rowTolerance = medianHeight * 0.6;

  // Sort by vertical position, then greedily group into rows.
  const sorted = [...words].sort((a, b) => a.cy - b.cy);
  const rowGroups = [];
  for (const w of sorted) {
    let placed = false;
    for (const group of rowGroups) {
      if (Math.abs(group.avgCy - w.cy) <= rowTolerance) {
        group.words.push(w);
        group.avgCy =
          group.words.reduce((sum, x) => sum + x.cy, 0) / group.words.length;
        placed = true;
        break;
      }
    }
    if (!placed) {
      rowGroups.push({ avgCy: w.cy, words: [w] });
    }
  }
  rowGroups.sort((a, b) => a.avgCy - b.avgCy);

  const medianWidth = median(words.map((w) => w.width)) || 20;
  const columnGapThreshold = medianWidth * 1.8;

  const rows = rowGroups.map((group) => {
    const rowWords = [...group.words].sort((a, b) => a.left - b.left);
    const cells = [];
    let currentCellWords = [];
    let prevRight = null;
    for (const w of rowWords) {
      if (prevRight !== null && w.left - prevRight > columnGapThreshold) {
        cells.push(currentCellWords.join(" "));
        currentCellWords = [];
      }
      currentCellWords.push(w.text);
      prevRight = w.right;
    }
    if (currentCellWords.length > 0) {
      cells.push(currentCellWords.join(" "));
    }
    return cells;
  });

  return rows;
}

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

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
