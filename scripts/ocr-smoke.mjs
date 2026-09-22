import { resolve } from "node:path";
import { recognizeRegion, stopOcr } from "../local-service/ocr.mjs";

const filePath = process.argv[2];
const requestedKind = process.argv[3] || "overview";
if (!filePath) {
  console.error("Usage: node scripts/ocr-smoke.mjs <image-path>");
  process.exit(1);
}

try {
  const isCuda = /CUDA_Toolkit/i.test(filePath);
  const region = requestedKind === "probe"
    ? { watcherId: "smoke", kind: "probe", x: 0.5, y: 10.5, w: 41.5, h: 27 }
    : requestedKind === "dock"
      ? { watcherId: "smoke", kind: "dock", x: 0, y: 8.6, w: 15, h: 4 }
      : isCuda
        ? { watcherId: "smoke", kind: "overview", x: 1, y: 1, w: 98, h: 15 }
        : { watcherId: "smoke", kind: "overview", x: 42.5, y: 9.2, w: 55.5, h: 24 };
  const result = await recognizeRegion({
    image: { filePath: resolve(filePath), filename: filePath.split(/[\\/]/).pop() },
    region,
    imageId: "smoke",
    regionIndex: 0,
    dataRoot: resolve(".local-data"),
  });
  console.log(JSON.stringify({ confidence: result.confidence, rawText: result.payload.rawText, ...result.payload.fields }, null, 2));
} finally {
  await stopOcr();
}
