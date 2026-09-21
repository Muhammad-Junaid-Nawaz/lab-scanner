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
      const rows = wordsToGrid(words);
      const lines = rows.map((row) => row.join("\t"));
      const raw =
        (result && result.fullTextAnnotation && result.fullTextAnnotation.text) || "";

      return json({ rows, lines, raw });
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

// Reconstructs a 2D grid (rows of cells) from raw OCR word bounding boxes.
//
// Strategy (column-first):
//   1. Detect vertical column bands from an x-axis coverage histogram: bin
//      every word's horizontal span, and treat any run of bins whose word
//      coverage count is at least ~25% of the busiest bin as "inside a
//      column". This is robust to a handful of wide title/heading words
//      that would otherwise bridge two real columns, because those title
//      rows only contribute a couple of words versus dozens for a real
//      data column.
//   2. Assign every word to its column band by horizontal center.
//   3. Within each column independently, cluster words into cells by
//      vertical position. Because this clustering happens per-column
//      rather than across the whole page, a value that drifts vertically
//      off its row line can no longer drag words from OTHER columns into
//      the wrong row — the failure mode that corrupted whole rows before.
//   4. Pick the column with the most cells as the anchor for row order,
//      then greedily match each other column's nearest not-yet-used cell
//      to each anchor row (within a tolerance), leaving a blank when no
//      match is found so columns stay aligned even with missing values.
function wordsToGrid(words) {
  if (words.length === 0) return [];

  const bands = detectColumnBands(words);
  if (bands.length === 0) return [];

  const medianHeight = median(words.map((w) => w.height)) || 20;
  const rowTolerance = medianHeight * 0.7;

  // Assign words to columns by horizontal center; anything that falls
  // outside every band (shouldn't normally happen) goes to the nearest one.
  const columns = bands.map(([lo, hi]) => words.filter((w) => w.cx >= lo && w.cx < hi));
  const assigned = new Set();
  columns.forEach((col) => col.forEach((w) => assigned.add(w)));
  for (const w of words) {
    if (assigned.has(w)) continue;
    let bestIndex = 0;
    let bestDist = Infinity;
    bands.forEach(([lo, hi], idx) => {
      const center = (lo + hi) / 2;
      const dist = Math.abs(w.cx - center);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = idx;
      }
    });
    columns[bestIndex].push(w);
  }

  // Within each column, group words into cells by vertical gaps (this also
  // merges multi-word cells that share a line, e.g. a two-word header).
  const columnCells = columns.map((colWords) => {
    const sortedByCy = [...colWords].sort((a, b) => a.cy - b.cy);
    const cellGroups = [];
    let current = [];
    for (const w of sortedByCy) {
      if (current.length > 0 && w.cy - current[current.length - 1].cy > rowTolerance) {
        cellGroups.push(current);
        current = [];
      }
      current.push(w);
    }
    if (current.length > 0) cellGroups.push(current);

    return cellGroups.map((cellWords) => ({
      text: [...cellWords].sort((a, b) => a.left - b.left).map((w) => w.text).join(" "),
      cy: avg(cellWords.map((w) => w.cy)),
    }));
  });

  // Pick the column with the most cells as the anchor row order — normally
  // the most completely-filled column on the page.
  let anchorIndex = 0;
  for (let i = 1; i < columnCells.length; i++) {
    if (columnCells[i].length > columnCells[anchorIndex].length) anchorIndex = i;
  }
  const anchorRows = [...columnCells[anchorIndex]].sort((a, b) => a.cy - b.cy);
  const rowMatchTolerance = rowTolerance * 2.5;

  const rows = anchorRows.map((anchorCell) => {
    return columnCells.map((cellsInColumn, colIndex) => {
      if (colIndex === anchorIndex) return anchorCell.text;
      let bestIndex = -1;
      let bestDist = Infinity;
      for (let i = 0; i < cellsInColumn.length; i++) {
        const cell = cellsInColumn[i];
        if (cell.used) continue;
        const dist = Math.abs(cell.cy - anchorCell.cy);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = i;
        }
      }
      if (bestIndex !== -1 && bestDist <= rowMatchTolerance) {
        cellsInColumn[bestIndex].used = true;
        return cellsInColumn[bestIndex].text;
      }
      return "";
    });
  });

  return rows;
}

// Builds column bands from a horizontal coverage histogram of word spans.
function detectColumnBands(words) {
  const maxRight = Math.max(...words.map((w) => w.right));
  const binSize = 5;
  const numBins = Math.ceil(maxRight / binSize) + 1;
  const coverage = new Array(numBins).fill(0);
  for (const w of words) {
    const b0 = Math.floor(w.left / binSize);
    const b1 = Math.floor(w.right / binSize);
    for (let b = b0; b <= b1; b++) coverage[b] = (coverage[b] || 0) + 1;
  }
  const maxCoverage = Math.max(...coverage);
  const threshold = Math.max(3, maxCoverage * 0.25);

  const rawBands = [];
  let start = null;
  for (let i = 0; i < numBins; i++) {
    if (coverage[i] >= threshold) {
      if (start === null) start = i;
    } else if (start !== null) {
      rawBands.push([start * binSize, i * binSize]);
      start = null;
    }
  }
  if (start !== null) rawBands.push([start * binSize, numBins * binSize]);

  // Merge bands separated by a small dip (noise within the same column).
  const merged = [];
  for (const band of rawBands) {
    if (merged.length > 0 && band[0] - merged[merged.length - 1][1] < 12) {
      merged[merged.length - 1][1] = band[1];
    } else {
      merged.push([...band]);
    }
  }
  return merged;
}

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avg(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
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
