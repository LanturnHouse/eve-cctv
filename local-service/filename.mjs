const CCTV_NAME = /^CCTV(\d{14})(\d*)_(.+)\.png$/i;

export function parseCctvFilename(filename) {
  const match = filename.match(CCTV_NAME);
  if (!match) return null;

  const [, base, fraction = "", character] = match;
  const year = base.slice(0, 4);
  const month = base.slice(4, 6);
  const day = base.slice(6, 8);
  const hour = base.slice(8, 10);
  const minute = base.slice(10, 12);
  const second = base.slice(12, 14);
  const milliseconds = `${fraction}000`.slice(0, 3);

  return {
    character,
    captureKey: `${base}${fraction}`,
    capturedAt: `${year}-${month}-${day}T${hour}:${minute}:${second}.${milliseconds}`,
  };
}
