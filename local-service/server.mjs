import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./database.mjs";
import { parseCctvFilename } from "./filename.mjs";
import { recognizeRegion, stopOcr } from "./ocr.mjs";
import { visionMode, setVisionMode, VISION_MODES } from "./vision.mjs";
import { analyzeImage } from "./analysis.mjs";

const execFileAsync = promisify(execFile);
const serviceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataRoot = join(serviceRoot, ".local-data");
const databasePath = join(dataRoot, "eve-cctv.sqlite");
const port = Number(process.env.EVE_CCTV_SERVICE_PORT || 8765);
const store = openDatabase(databasePath);
const clients = new Set();
let scanning = false;
let processing = false;
let lastError = null;

const json = (response, status, payload) => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(payload));
};

const empty = (response, status = 204) => {
  response.writeHead(status, { "Access-Control-Allow-Origin": "*" });
  response.end();
};

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("요청 데이터가 너무 큽니다.");
  }
  return raw ? JSON.parse(raw) : {};
}

function validateRegion(region) {
  return region && ["overview", "probe", "dock"].includes(region.kind)
    && [region.x, region.y, region.w, region.h].every((value) => Number.isFinite(value))
    && region.w > 0 && region.h > 0;
}

function validateWatcher(watcher) {
  if (!watcher || typeof watcher.id !== "string" || !watcher.id.trim()) throw new Error("눈깔 ID가 필요합니다.");
  if (typeof watcher.label !== "string" || !watcher.label.trim()) throw new Error("감지 이름이 필요합니다.");
  if (typeof watcher.character !== "string" || !watcher.character.trim()) throw new Error("캐릭터가 필요합니다.");
  if (!["structure", "gate"].includes(watcher.watchType)) throw new Error("감시 타입이 올바르지 않습니다.");
  if (!Array.isArray(watcher.regions) || !watcher.regions.every(validateRegion)) throw new Error("인식 영역이 올바르지 않습니다.");
}

async function scanFolder() {
  if (scanning) return false;
  const folderPath = store.getSetting("cctvFolder", "");
  if (!folderPath) return false;
  scanning = true;
  let changed = false;
  try {
    const entries = await readdir(folderPath, { withFileTypes: true });
    const currentPaths = new Set();
    const insert = store.db.prepare(`
      INSERT OR IGNORE INTO images
        (folder_path, file_path, filename, character_name, capture_key, captured_at, size_bytes, modified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parsed = parseCctvFilename(entry.name);
      if (!parsed) continue;
      const filePath = join(folderPath, entry.name);
      currentPaths.add(filePath);
      const details = await stat(filePath);
      const result = insert.run(folderPath, filePath, entry.name, parsed.character, parsed.captureKey, parsed.capturedAt, details.size, Math.trunc(details.mtimeMs));
      if (result.changes > 0) changed = true;
    }
    const storedPaths = store.db.prepare("SELECT id, file_path AS filePath FROM images WHERE folder_path = ?").all(folderPath);
    const deleteEvents = store.db.prepare("DELETE FROM events WHERE image_id = ?");
    const deleteImage = store.db.prepare("DELETE FROM images WHERE id = ?");
    for (const stored of storedPaths) {
      if (currentPaths.has(stored.filePath)) continue;
      deleteEvents.run(stored.id);
      deleteImage.run(stored.id);
      changed = true;
    }
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  } finally {
    scanning = false;
  }
  if (changed) broadcast(await getStatus());
  return changed;
}

async function getStatus() {
  const folderPath = store.getSetting("cctvFolder", "");
  const folderName = folderPath ? basename(folderPath) : "";
  // A character with no enabled/configured watcher never gets its images processed
  // (see getNextPendingImage's own EXISTS check below) — counting those images in
  // the headline totals makes the counters look stuck, so both the total and the
  // per-status breakdown only count images for characters that are actually watched.
  const watchedImageFilter = `EXISTS (
    SELECT 1 FROM watchers w
    WHERE w.character_name = i.character_name AND w.enabled = 1 AND w.region_version >= 2
  )`;
  const countRow = folderPath
    ? store.db.prepare(`SELECT COUNT(*) AS count FROM images i WHERE i.folder_path = ? AND ${watchedImageFilter}`).get(folderPath)
    : { count: 0 };
  const characters = folderPath
    ? store.db.prepare("SELECT DISTINCT character_name AS name FROM images WHERE folder_path = ? ORDER BY character_name").all(folderPath).map((row) => row.name)
    : [];
  const characterStats = folderPath
    ? Object.fromEntries(store.db.prepare(`
        SELECT i.character_name AS name, COUNT(*) AS imageCount, MAX(i.captured_at) AS latestCaptureAt,
          (SELECT i2.id FROM images i2
           WHERE i2.folder_path = i.folder_path AND i2.character_name = i.character_name
           ORDER BY i2.capture_key DESC LIMIT 1) AS latestImageId
        FROM images i WHERE i.folder_path = ? GROUP BY i.character_name ORDER BY i.character_name
      `).all(folderPath).map(row => [row.name,{imageCount:Number(row.imageCount),latestCaptureAt:row.latestCaptureAt,latestImageId:Number(row.latestImageId)}]))
    : {};
  const recentImages = folderPath
    ? store.db.prepare(`
        SELECT id, filename, character_name AS character, captured_at AS capturedAt, processing_status AS status
        FROM images WHERE folder_path = ? ORDER BY capture_key DESC LIMIT 8
      `).all(folderPath)
    : [];
  const processingRows = store.db.prepare(`
    SELECT processing_status AS status, COUNT(*) AS count
    FROM images i WHERE ${watchedImageFilter} GROUP BY processing_status
  `).all();
  const processingCounts = Object.fromEntries(processingRows.map(row => [row.status, Number(row.count)]));
  const latestRegionRows = store.db.prepare(`
    SELECT o.watcher_id AS watcherId, w.label AS watcherLabel, o.region_kind AS kind,
           o.payload_json AS payload, o.confidence, i.filename
    FROM observations o
    JOIN watchers w ON w.id = o.watcher_id
    JOIN images i ON i.id = o.image_id
    WHERE o.id = (
      SELECT o2.id FROM observations o2 JOIN images i2 ON i2.id = o2.image_id
      WHERE o2.watcher_id = o.watcher_id AND o2.region_kind = o.region_kind
      ORDER BY i2.capture_key DESC, o2.id DESC LIMIT 1
    )
  `).all();
  const regionWarnings = latestRegionRows.flatMap(row => {
    let fields = {};
    try { fields = JSON.parse(row.payload).fields || {}; } catch { /* malformed observation */ }
    if (row.kind === "overview" && fields.overviewDetected === false) return [{watcherId:row.watcherId,watcherLabel:row.watcherLabel,kind:row.kind,message:"오버뷰 헤더를 찾지 못했습니다.",filename:row.filename}];
    if (row.kind === "probe" && fields.probeDetected === false) return [{watcherId:row.watcherId,watcherLabel:row.watcherLabel,kind:row.kind,message:"프로빙 창의 ID·이름 헤더를 찾지 못했습니다.",filename:row.filename}];
    if (row.kind === "dock" && !Number.isFinite(fields.dockCount)) return [{watcherId:row.watcherId,watcherLabel:row.watcherLabel,kind:row.kind,message:"도킹 숫자를 읽지 못했습니다.",filename:row.filename}];
    return [];
  });
  return {
    online: true,
    folder: { path: folderPath, name: folderName, imageCount: Number(countRow.count || 0) },
    detectedCharacters: characters,
    characterStats,
    watchers: store.listWatchers(),
    dockPeaks: store.listDockPeaks(),
    recentImages,
    processing: {
      pending: processingCounts.pending || 0,
      processing: processingCounts.processing || 0,
      processed: processingCounts.processed || 0,
      failed: processingCounts.failed || 0,
    },
    regionWarnings,
    scanIntervalMs: 2000,
    lastError,
    visionMode: visionMode(),
  };
}

async function processNextImage() {
  if (processing) return;
  const image = store.getNextPendingImage();
  if (!image) return;
  const regions = store.getWatcherRegions(image.character);
  if (!regions.length) return;
  processing = true;
  store.db.prepare("UPDATE images SET processing_status = 'processing' WHERE id = ?").run(image.id);
  broadcast(await getStatus());
  try {
    const observations = [];
    for (let index = 0; index < regions.length; index += 1) {
      observations.push(await recognizeRegion({ image, region: regions[index], imageId: image.id, regionIndex: index, dataRoot }));
    }
    const currentState = store.db.prepare("SELECT processing_status AS status FROM images WHERE id = ?").get(image.id);
    if (currentState?.status !== "processing") return;
    const activeObservations = observations.filter(observation => store.db.prepare("SELECT 1 FROM watchers WHERE id = ? AND enabled = 1").get(observation.watcherId));
    store.completeImage(image.id, activeObservations);
    analyzeImage(store, image, activeObservations);
    lastError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.failImage(image.id, message);
    lastError = `OCR 실패: ${image.filename} · ${message}`;
  } finally {
    processing = false;
    broadcast(await getStatus());
  }
}

function broadcast(payload) {
  const message = `event: status\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(message);
}

async function setFolder(folderPath) {
  if (typeof folderPath !== "string" || !folderPath.trim()) throw new Error("폴더 경로가 필요합니다.");
  const normalized = resolve(folderPath.trim());
  if (!isAbsolute(normalized)) throw new Error("절대 경로를 선택해주세요.");
  const details = await stat(normalized);
  if (!details.isDirectory()) throw new Error("선택한 경로가 폴더가 아닙니다.");
  store.setSetting("cctvFolder", normalized);
  store.resetDerivedData();
  await scanFolder();
  const status = await getStatus();
  broadcast(status);
  return status;
}

async function pickWindowsFolder() {
  if (process.platform !== "win32") throw new Error("현재 자동 폴더 선택은 Windows에서만 지원합니다.");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'EVE CCTV 스크린샷 폴더 선택'",
    "$dialog.ShowNewFolderButton = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "  Write-Output $dialog.SelectedPath",
    "}",
  ].join("\r\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encoded], { windowsHide: true, timeout: 120_000 });
  return stdout.trim();
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return response.end();
  }
  try {
    if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { online: true });
    if (request.method === "GET" && url.pathname === "/api/status") return json(response, 200, await getStatus());
    if (request.method === "GET" && url.pathname === "/api/events") {
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 100)));
      const events = store.db.prepare(`
        SELECT e.id, e.event_time AS time, e.event_type AS type, e.character_name AS character,
               e.corporation_ticker AS corporation, e.ship_name AS ship, e.speed_mps AS speed,
               e.confidence, e.image_id AS imageId, e.previous_image_id AS previousImageId,
               e.details_json AS details,
               w.id AS watcherId, w.label AS watcherLabel, i.filename, pi.filename AS previousFilename
        FROM events e
        LEFT JOIN watchers w ON w.id = e.watcher_id
        LEFT JOIN images i ON i.id = e.image_id
        LEFT JOIN images pi ON pi.id = e.previous_image_id
        ORDER BY e.event_time DESC, e.id DESC LIMIT ?
      `).all(limit).map(row => ({ ...row, details: row.details ? JSON.parse(row.details) : {} }));
      return json(response, 200, { events });
    }
    if (request.method === "GET" && url.pathname === "/api/signatures/current") {
      const signatures = store.db.prepare(`
        SELECT s.signature_id AS id, s.name, s.group_name AS groupName, s.distance_text AS distance,
               s.confidence, s.first_seen_at AS firstSeenAt, s.last_seen_at AS lastSeenAt,
               s.image_id AS imageId, w.id AS watcherId, w.label AS watcherLabel
        FROM current_signatures s JOIN watchers w ON w.id = s.watcher_id
        ORDER BY w.label, s.signature_id
      `).all();
      return json(response, 200, { signatures });
    }
    if (request.method === "GET" && url.pathname === "/api/overview/current") {
      const objects = store.db.prepare(`
        SELECT o.character_name AS character, o.ship_name AS ship, o.corporation_ticker AS corporation,
               o.distance_text AS distance, o.speed_mps AS speed, o.confidence,
               o.last_seen_at AS lastSeenAt, o.image_id AS imageId,
               o.entry_type AS entryType, o.first_seen_at AS firstSeenAt,
               w.id AS watcherId, w.label AS watcherLabel
        FROM current_objects o JOIN watchers w ON w.id = o.watcher_id
        ORDER BY w.label, o.character_name
      `).all();
      return json(response, 200, { objects });
    }
    const sourceMatch = url.pathname.match(/^\/api\/images\/(\d+)\/source$/);
    if (request.method === "GET" && sourceMatch) {
      const image = store.db.prepare("SELECT file_path AS filePath FROM images WHERE id = ?").get(Number(sourceMatch[1]));
      if (!image) return json(response, 404, { error: "이미지를 찾을 수 없습니다." });
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      return createReadStream(image.filePath).pipe(response);
    }
    const cropMatch = url.pathname.match(/^\/api\/observations\/(\d+)\/crop$/);
    if (request.method === "GET" && cropMatch) {
      const observation = store.db.prepare("SELECT payload_json AS payload FROM observations WHERE id = ?").get(Number(cropMatch[1]));
      if (!observation) return json(response, 404, { error: "인식 영역을 찾을 수 없습니다." });
      const payload = JSON.parse(observation.payload);
      const cropPath = url.searchParams.get("type") === "ocr" ? payload.ocrCropPath : payload.sourceCropPath;
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      return createReadStream(cropPath).pipe(response);
    }
    const detailMatch = url.pathname.match(/^\/api\/images\/(\d+)$/);
    if (request.method === "GET" && detailMatch) {
      const image = store.db.prepare(`
        SELECT id, filename, character_name AS character, captured_at AS capturedAt,
               processing_status AS status FROM images WHERE id = ?
      `).get(Number(detailMatch[1]));
      if (!image) return json(response, 404, { error: "이미지를 찾을 수 없습니다." });
      const observations = store.db.prepare(`
        SELECT id, watcher_id AS watcherId, region_kind AS kind, payload_json AS payload, confidence
        FROM observations WHERE image_id = ? ORDER BY id
      `).all(image.id).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
      return json(response, 200, { image, observations });
    }
    if (request.method === "GET" && url.pathname === "/api/stream") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      response.write(`event: status\ndata: ${JSON.stringify(await getStatus())}\n\n`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/folder/select") {
      const folderPath = await pickWindowsFolder();
      if (!folderPath) return empty(response);
      return json(response, 200, await setFolder(folderPath));
    }
    if (request.method === "POST" && url.pathname === "/api/config/folder") {
      const body = await readJson(request);
      return json(response, 200, await setFolder(body.path));
    }
    if (request.method === "POST" && url.pathname === "/api/watchers") {
      const watcher = await readJson(request);
      validateWatcher(watcher);
      store.saveWatcher(watcher);
      const status = await getStatus();
      broadcast(status);
      return json(response, 200, status);
    }
    if (request.method === "POST" && url.pathname === "/api/settings/vision-mode") {
      const body = await readJson(request);
      if (!VISION_MODES.includes(body.mode)) throw new Error(`인식 모드는 ${VISION_MODES.join("/")} 중 하나여야 합니다.`);
      setVisionMode(body.mode);
      store.setSetting("visionMode", body.mode);
      const status = await getStatus();
      broadcast(status);
      return json(response, 200, status);
    }
    const watcherDeleteMatch = url.pathname.match(/^\/api\/watchers\/([^/]+)$/);
    if (request.method === "DELETE" && watcherDeleteMatch) {
      store.deleteWatcher(decodeURIComponent(watcherDeleteMatch[1]));
      const status = await getStatus();
      broadcast(status);
      return json(response, 200, status);
    }
    return json(response, 404, { error: "요청한 API를 찾을 수 없습니다." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(response, 400, { error: message });
  }
});

const savedVisionMode = store.getSetting("visionMode", null);
if (VISION_MODES.includes(savedVisionMode)) setVisionMode(savedVisionMode);

server.listen(port, "127.0.0.1", async () => {
  store.resetDerivedData();
  await scanFolder();
  console.log(`[EVE CCTV] local service: http://127.0.0.1:${port}`);
  const folder = store.getSetting("cctvFolder", "");
  console.log(folder ? `[EVE CCTV] watching: ${folder}` : "[EVE CCTV] waiting for a CCTV folder");
});

const scanInterval = setInterval(() => void scanFolder(), 2000);
const processingInterval = setInterval(() => void processNextImage(), 750);
const shutdown = async () => {
  clearInterval(scanInterval);
  clearInterval(processingInterval);
  for (const client of clients) client.end();
  await stopOcr().catch(() => undefined);
  store.db.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
