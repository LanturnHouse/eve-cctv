import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { recognizeWithVision, shapeVisionFields, visionMode, normalizeProbeId } from "./vision.mjs";
import { parseOverviewSpeed } from "./numbers.mjs";

const require = createRequire(import.meta.url);
const { createWorker, OEM, PSM } = Tesseract;
let workerPromise = null;

async function prepareTessdata(dataRoot) {
  const tessdata = join(dataRoot, "tessdata");
  await mkdir(tessdata, { recursive: true });
  for (const language of ["eng", "kor"]) {
    const packageRoot = dirname(require.resolve(`@tesseract.js-data/${language}`));
    await copyFile(join(packageRoot, "4.0.0", `${language}.traineddata.gz`), join(tessdata, `${language}.traineddata.gz`));
  }
  return tessdata;
}

async function getWorker(dataRoot) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const langPath = await prepareTessdata(dataRoot);
      return createWorker(["eng", "kor"], OEM.LSTM_ONLY, {
        langPath,
        cachePath: join(dataRoot, "tesseract-cache"),
        gzip: true,
        logger: () => undefined,
      });
    })();
  }
  return workerPromise;
}

function clampRegion(region, width, height) {
  const left = Math.max(0, Math.min(width - 1, Math.floor(width * region.x / 100)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(height * region.y / 100)));
  const cropWidth = Math.max(1, Math.min(width - left, Math.ceil(width * region.w / 100)));
  const cropHeight = Math.max(1, Math.min(height - top, Math.ceil(height * region.h / 100)));
  return { left, top, width: cropWidth, height: cropHeight };
}

function recognizedLines(blocks) {
  return (blocks || []).flatMap(block =>
    (block.paragraphs || []).flatMap(paragraph => paragraph.lines || [])
  );
}

// EVE fades an overview row's whole background+text toward black for the last
// couple of frames before an entity leaves warp/the loaded range — the speed
// reading during that fade is stale garbage (usually 0), not a real value.
// Sampling mean pixel brightness over the row's own text line (padded a bit to
// also catch its background) gives a reliable, cheap signal for that fade;
// sharp's own .stats() didn't reflect the extract() region reliably in testing,
// so this reads raw pixels directly instead.
async function measureRowBrightness(imageBuffer, bbox, imageWidth, imageHeight) {
  if (!bbox) return null;
  const padY = Math.round((bbox.y1 - bbox.y0) * 0.2);
  const left = Math.max(0, Math.round(bbox.x0));
  const top = Math.max(0, Math.round(bbox.y0) - padY);
  const width = Math.min(imageWidth - left, Math.max(1, Math.round(bbox.x1 - bbox.x0)));
  const height = Math.min(imageHeight - top, Math.max(1, Math.round(bbox.y1 - bbox.y0) + padY * 2));
  if (width <= 0 || height <= 0 || left >= imageWidth || top >= imageHeight) return null;
  const { data, info } = await sharp(imageBuffer).extract({ left, top, width, height }).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    count += 1;
  }
  return count ? sum / count : null;
}

function parseOverviewRows(blocks, imageWidth) {
  const allLines = recognizedLines(blocks);
  const headerIndex = allLines.findIndex(line => {
    const header = (line.words || []).map(word => word.text).join(" ");
    return /이름|name/i.test(header) && /종류|type/i.test(header);
  });
  if (headerIndex < 0) return [];
  const headerWords = allLines[headerIndex].words || [];
  const centerOf = (matcher) => {
    const matches = headerWords.filter(word => matcher.test(word.text));
    if (!matches.length) return null;
    return matches.reduce((sum, word) => sum + (word.bbox.x0 + word.bbox.x1) / 2, 0) / matches.length;
  };
  const anchors = [
    ["distance", centerOf(/^(거리|distance)$/i)],
    ["name", centerOf(/^(이름|name)$/i)],
    ["ship", centerOf(/^(종류|type)$/i)],
    ["corporation", centerOf(/코퍼|corporation|ticker|티커/i)],
    ["speed", centerOf(/^(속도|speed)$/i)],
    ["angular", centerOf(/각속도|angular/i)],
  ].filter((entry) => Number.isFinite(entry[1])).sort((a, b) => a[1] - b[1]);
  if (anchors.length < 3) return [];
  const ranges = anchors.map((entry, index) => ({
    key: entry[0],
    left: index === 0 ? 0 : (anchors[index - 1][1] + entry[1]) / 2,
    right: index === anchors.length - 1 ? imageWidth : (entry[1] + anchors[index + 1][1]) / 2,
  }));

  return allLines.slice(headerIndex + 1).flatMap(line => {
    const buckets = { distance: [], name: [], ship: [], corporation: [], speed: [] };
    for (const word of line.words || []) {
      const center = (word.bbox.x0 + word.bbox.x1) / 2;
      const range = ranges.find(item => center >= item.left && center < item.right);
      if (range && range.key in buckets) buckets[range.key].push(word.text);
    }
    const rawDistance = buckets.distance.join(" ").trim();
    const distance = (rawDistance.match(/\d[\d,.]*\s*(?:AU|km|k|m)\b/i)?.[0] || rawDistance).replace(/(\d)k$/i, "$1 km");
    const name = buckets.name.join(" ").trim();
    if (!name || !/\d/.test(distance) || !/(?:AU|km|k|m)\b/i.test(distance)) return [];
    while (buckets.speed.length && /[A-Za-z가-힣]/.test(buckets.speed[0])) buckets.ship.push(buckets.speed.shift());
    const speedText = buckets.speed.join(" ").trim();
    return [{
      distance,
      name,
      ship: buckets.ship.join(" ").trim(),
      corporation: buckets.corporation.join(" ").trim(),
      speed: parseOverviewSpeed(speedText),
      raw: line.text.trim(),
      confidence: Math.max(0, Math.min(1, Number(line.confidence || 0) / 100)),
      bbox: line.bbox,
    }];
  });
}

// EVE's bold UI font makes the "ID" column header read as "10"/"1D"/"I0" almost
// as often as it reads correctly, since the glyphs for I/1 and D/0 are near-identical
// at this weight, so the header/anchor matches below accept those misreads too.
const PROBE_ID_TOKEN = /^(?:ID|1D|I0|10)$/i;
const PROBE_ID_WORD = /\b(?:ID|1D|I0|10)\b/i;

function parseProbeRows(blocks, imageWidth) {
  const allLines = recognizedLines(blocks);
  const headerIndex = allLines.findIndex(line => {
    const header = (line.words || []).map(word => word.text).join(" ");
    return PROBE_ID_WORD.test(header) && /이름|name/i.test(header);
  });
  if (headerIndex < 0) return [];
  const headerWords = allLines[headerIndex].words || [];
  const centerOf = (matcher) => {
    const matches = headerWords.filter(word => matcher.test(word.text));
    if (!matches.length) return null;
    return matches.reduce((sum, word) => sum + (word.bbox.x0 + word.bbox.x1) / 2, 0) / matches.length;
  };
  const anchors = [
    ["distance", centerOf(/^(거리|distance)$/i)],
    ["id", centerOf(PROBE_ID_TOKEN)],
    ["name", centerOf(/^(이름|name)$/i)],
    ["group", centerOf(/^(그룹|group)$/i)],
    ["signal", centerOf(/^(신호|signal)$/i)],
  ].filter(entry => Number.isFinite(entry[1])).sort((a, b) => a[1] - b[1]);
  if (anchors.length < 3) return [];
  const ranges = anchors.map((entry, index) => ({
    key: entry[0],
    left: index === 0 ? 0 : (anchors[index - 1][1] + entry[1]) / 2,
    right: index === anchors.length - 1 ? imageWidth : (entry[1] + anchors[index + 1][1]) / 2,
  }));
  return allLines.slice(headerIndex + 1).flatMap(line => {
    const buckets = { distance: [], id: [], name: [], group: [] };
    for (const word of line.words || []) {
      const center = (word.bbox.x0 + word.bbox.x1) / 2;
      const range = ranges.find(item => center >= item.left && center < item.right);
      if (range && range.key in buckets) buckets[range.key].push(word.text);
    }
    const id = normalizeProbeId(buckets.id.join(""));
    if (!id) return [];
    const rawDistance = buckets.distance.join(" ");
    const distance = rawDistance.match(/\d[\d,.]*\s*(?:AU|km|k|m)\b/i)?.[0] || rawDistance.trim();
    return [{
      id,
      distance,
      name: buckets.name.join(" ").trim(),
      group: buckets.group.join(" ").trim(),
      raw: line.text.trim(),
      confidence: Math.max(0, Math.min(1, Number(line.confidence || 0) / 100)),
    }];
  });
}

function extractFields(kind, text, blocks, imageWidth) {
  const lines = text.split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (kind === "dock") {
    // The in-game counter reads "[0]" (brackets included) — prefer the digits
    // inside the brackets so a stray nearby number (e.g. a distance figure
    // bleeding into the crop) never gets mistaken for the dock count.
    const bracketed = text.match(/\[\s*(\d[\d,]*)\s*\]/);
    const digits = bracketed?.[1] ?? text.match(/\d[\d,]*/)?.[0];
    const number = digits?.replaceAll(",", "");
    return { lines, dockCount: number ? Number(number) : null };
  }
  if (kind === "probe") {
    const signatures = parseProbeRows(blocks, imageWidth);
    const probeDetected = recognizedLines(blocks).some(line => {
      const header = (line.words || []).map(word => word.text).join(" ");
      return PROBE_ID_WORD.test(header) && /이름|name/i.test(header);
    });
    return { lines, signatures, probeDetected };
  }
  const overviewDetected = recognizedLines(blocks).some(line => {
    const header = (line.words || []).map(word => word.text).join(" ");
    return /이름|name/i.test(header) && /종류|type/i.test(header);
  });
  return { lines, overviewRows: parseOverviewRows(blocks, imageWidth), overviewDetected };
}

export async function recognizeRegion({ image, region, imageId, regionIndex, dataRoot }) {
  const metadata = await sharp(image.filePath).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`이미지 크기를 읽을 수 없습니다: ${image.filename}`);
  const box = clampRegion(region, metadata.width, metadata.height);
  const cropRoot = join(dataRoot, "crops", String(imageId));
  await mkdir(cropRoot, { recursive: true });
  const rawCropPath = join(cropRoot, `${regionIndex}-${region.kind}-source.png`);
  const ocrCropPath = join(cropRoot, `${regionIndex}-${region.kind}-ocr.png`);

  const rawCrop = await sharp(image.filePath).extract(box).png().toBuffer();
  await writeFile(rawCropPath, rawCrop);
  const scale = region.kind === "dock" ? 5 : 3;
  const processedCrop = await sharp(rawCrop)
    .resize({ width: box.width * scale, height: box.height * scale, kernel: sharp.kernel.lanczos3 })
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
  await writeFile(ocrCropPath, processedCrop);

  const worker = await getWorker(dataRoot);
  await worker.setParameters({
    // SINGLE_LINE assumes the crop is densely packed with text; the dock badge
    // is small text surrounded by a lot of empty space, which SINGLE_LINE
    // consistently misreads or drops. SPARSE_TEXT (look for isolated text
    // anywhere in the image) reads it reliably instead.
    tessedit_pageseg_mode: region.kind === "dock" ? PSM.SPARSE_TEXT : PSM.SINGLE_BLOCK,
    tessedit_char_whitelist: region.kind === "dock" ? "0123456789,[]" : "",
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const { data } = await worker.recognize(processedCrop, {}, { text: true, blocks: true });
  const rawText = data.text.trim();
  let fields = extractFields(region.kind, rawText, data.blocks, box.width * scale);
  let confidence = Number.isFinite(data.confidence) ? data.confidence / 100 : null;

  if (region.kind === "overview" && fields.overviewRows?.length) {
    const cropWidth = box.width * scale;
    const cropHeight = box.height * scale;
    for (const row of fields.overviewRows) {
      row.brightness = await measureRowBrightness(processedCrop, row.bbox, cropWidth, cropHeight);
      delete row.bbox;
    }
  }

  const tesseractFailed = region.kind === "probe" ? fields.probeDetected === false
    : region.kind === "overview" ? fields.overviewDetected === false
    : region.kind === "dock" ? !Number.isFinite(fields.dockCount)
    : false;
  const mode = visionMode();
  if (mode === "always" || (mode === "fallback" && tesseractFailed)) {
    // Vision models don't need Tesseract's artificial upscale — sending it anyway
    // roughly triples the pixel count the model has to encode for no accuracy gain,
    // and directly drives up latency (measured ~2x slower on the 3x-scaled crop).
    const vision = await recognizeWithVision(region.kind, rawCrop);
    const shaped = shapeVisionFields(region.kind, vision, fields, rawText);
    if (shaped !== fields) { fields = shaped; confidence = Math.max(confidence ?? 0, 0.9); }
  }

  return {
    watcherId: region.watcherId,
    kind: region.kind,
    confidence,
    payload: {
      rawText,
      fields,
      regionIndex,
      sourceBox: box,
      sourceCropPath: resolve(rawCropPath),
      ocrCropPath: resolve(ocrCropPath),
    },
  };
}

export async function stopOcr() {
  if (!workerPromise) return;
  const worker = await workerPromise;
  workerPromise = null;
  await worker.terminate();
}
