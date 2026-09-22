// Local vision-model fallback for cases where Tesseract can't read the EVE UI
// (e.g. its bold font makes "ID" look like "10"). Talks to a local Ollama
// server running a vision-capable model (default: qwen2.5vl:7b) — no network
// calls leave the machine, no per-request cost.

import { parseOverviewSpeed } from "./numbers.mjs";

const VISION_HOST = process.env.EVE_CCTV_VISION_HOST || "http://127.0.0.1:11434";
const VISION_MODEL = process.env.EVE_CCTV_VISION_MODEL || "qwen2.5vl:7b";
const REQUEST_TIMEOUT_MS = 25_000;

// "off": never call the vision model. "fallback": only when Tesseract failed to
// find the header/value for that region kind. "always": call it for every region.
// Settable at runtime (see setVisionMode) so the UI can flip this without a
// service restart; starts from the env var if it's a valid mode, else "fallback".
export const VISION_MODES = ["fallback", "always", "off"];
const envMode = (process.env.EVE_CCTV_VISION_MODE || "").toLowerCase();
let visionModeState = VISION_MODES.includes(envMode) ? envMode : "fallback";

const PROMPTS = {
  probe: `당신은 EVE Online 스크린샷을 분석하는 OCR 도우미입니다.
이 이미지는 '탐사 스캐너(Probe Scanner)' 창의 결과 목록입니다. 컬럼은 순서대로 상태 아이콘, 거리, ID, 이름, 그룹, 신호(%)입니다.
표 헤더(ID/이름 등)와 최소 한 개의 데이터 행이 보이면 visible을 true로, 표 자체가 안 보이거나 완전히 비어 있으면 false로 설정하세요.
ID는 항상 "영문 대문자 3글자-영숫자 1~3글자" 형식입니다 (예: AHQ-5, DZC-4). 실제로 화면에 표시된 글자를 그대로 옮기고, 다른 글자로 추측해서 바꾸지 마세요.
다음 JSON 형식으로만 응답하세요. 설명이나 다른 텍스트는 절대 포함하지 마세요:
{"visible": boolean, "rows": [{"id": string, "distance": string, "name": string, "group": string}]}`,

  overview: `당신은 EVE Online 스크린샷을 분석하는 OCR 도우미입니다.
이 이미지는 '오버뷰(Overview)' 창의 목록입니다. 컬럼은 거리, 이름, 종류(함선), 코퍼레이션 티커, 속도(m/s) 등입니다.
표 헤더와 최소 한 개의 데이터 행이 보이면 visible을 true로, 표 자체가 안 보이거나 완전히 비어 있으면 false로 설정하세요.
실제로 화면에 표시된 글자를 그대로 옮기고, 다른 글자로 추측해서 바꾸지 마세요.
속도는 숫자로 계산하지 말고 화면에 보이는 쉼표와 점을 포함한 문자열로 옮기세요. 쉼표는 천 단위 구분자입니다. 예: 1,775,962는 "1,775,962", 126.5는 "126.5". 읽을 수 없으면 빈 문자열을 쓰세요.
다음 JSON 형식으로만 응답하세요. 설명이나 다른 텍스트는 절대 포함하지 마세요:
{"visible": boolean, "rows": [{"name": string, "ship": string, "corporation": string, "distance": string, "speed": string}]}`,

  dock: `당신은 EVE Online 스크린샷을 분석하는 OCR 도우미입니다.
이 이미지는 스트럭쳐/스테이션의 도킹 인원 숫자 하나만 표시된 작은 영역입니다.
화면에 보이는 숫자를 그대로 읽으세요. 숫자가 보이지 않으면 null을 반환하세요.
다음 JSON 형식으로만 응답하세요. 설명이나 다른 텍스트는 절대 포함하지 마세요:
{"count": number}`,
};

export function visionMode() {
  return visionModeState;
}

export function setVisionMode(mode) {
  if (!VISION_MODES.includes(mode)) throw new Error(`알 수 없는 인식 모드입니다: ${mode}`);
  visionModeState = mode;
}

export async function recognizeWithVision(kind, imageBuffer) {
  const prompt = PROMPTS[kind];
  if (visionModeState === "off" || !prompt) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${VISION_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt,
        images: [imageBuffer.toString("base64")],
        format: "json",
        stream: false,
        keep_alive: "30m",
        options: { temperature: 0, num_predict: 800 },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return JSON.parse(data.response);
  } catch {
    // Ollama not running / model not pulled / bad response — silently skip,
    // the caller keeps whatever Tesseract already produced.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function speedFromOcrLine(rawText, name) {
  const parts = cleanText(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const escaped = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const namePattern = new RegExp(escaped.join("\\s*"), "i");
  for (const line of String(rawText || "").split(/\r?\n/)) {
    const match = namePattern.exec(line);
    if (!match) continue;
    const suffix = line.slice(match.index + match[0].length);
    const candidates = [...suffix.matchAll(/-?\d+(?:[,.]\d+)*/g)]
      .filter(token => /[,.]/.test(token[0]))
      .map(token => parseOverviewSpeed(token[0]))
      .filter(Number.isFinite);
    if (candidates.length) return Math.max(...candidates);
  }
  return null;
}

// Signature IDs are shown as "AHQ-5" (3-letter prefix + a 1-3 char suffix), but
// the suffix is the part that OCR (and the vision model) gets wrong most often —
// it's small, at the edge of the crop, and digits/letters there get swapped
// (e.g. "0" vs "C") inconsistently between frames, which breaks identity matching.
// The 3-letter prefix is far more stable, and is unique enough within one
// system's signature list for our purposes, so that's all we keep as the id.
// The suffix is matched loosely (any 1-3 non-space glyphs) purely as an anchor
// to confirm this really is an "XXX-###" id and not some other 3-letter word —
// its actual characters are discarded either way.
const PROBE_ID_PATTERN = /([A-Z0-9]{3})-\S{1,3}/i;

export function normalizeProbeId(rawText) {
  const match = String(rawText || "").toUpperCase().match(PROBE_ID_PATTERN);
  if (!match) return null;
  // Prefixes are always letters in-game, so undo common digit misreads.
  return match[1].replace(/0/g,"O").replace(/1/g,"I").replace(/5/g,"S").replace(/8/g,"B");
}

export function shapeVisionFields(kind, vision, fallbackFields, rawText = "") {
  if (!vision || typeof vision !== "object") return fallbackFields;

  if (kind === "probe") {
    if (!Array.isArray(vision.rows)) return fallbackFields;
    const signatures = vision.rows.map(row => ({
      id: normalizeProbeId(row.id),
      distance: cleanText(row.distance),
      name: cleanText(row.name),
      group: cleanText(row.group),
      raw: "",
      confidence: 0.9,
    })).filter(row => row.id);
    return { ...fallbackFields, signatures, probeDetected: vision.visible === true || signatures.length > 0 };
  }

  if (kind === "overview") {
    if (!Array.isArray(vision.rows)) return fallbackFields;
    const overviewRows = vision.rows.map(row => {
      const modelSpeed = parseOverviewSpeed(row.speed);
      const ocrSpeed = speedFromOcrLine(rawText, row.name);
      return {
        distance: cleanText(row.distance),
        name: cleanText(row.name),
        ship: cleanText(row.ship),
        corporation: cleanText(row.corporation),
        speed: ocrSpeed >= 10_000 && (modelSpeed === null || modelSpeed < 10_000) ? ocrSpeed : modelSpeed,
        raw: "",
        confidence: 0.9,
      };
    }).filter(row => row.name);
    return { ...fallbackFields, overviewRows, overviewDetected: vision.visible === true || overviewRows.length > 0 };
  }

  if (kind === "dock") {
    if (!Number.isFinite(vision.count)) return fallbackFields;
    return { ...fallbackFields, dockCount: vision.count };
  }

  return fallbackFields;
}
