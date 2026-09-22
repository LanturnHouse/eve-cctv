// EVE's overview uses commas for digit grouping and dots for decimals. OCR can
// mistake a grouping comma for a dot, so a three-digit final group is treated
// as grouping (except 0.xxx). Genuine short decimal speeds remain fractional.
export function parseOverviewSpeed(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.abs(value) : null;
  const text = String(value ?? "").replace(/(\d)\s*([,.])\s*(?=\d)/g, "$1$2");
  const token = text.match(/-?\d+(?:[,.]\d+)*/)?.[0]?.replace(/^-/, "");
  if (!token) return null;

  const groups = token.split(/[,.]/);
  const separators = token.match(/[,.]/g) || [];
  const finalGroup = groups.at(-1);
  const integerPart = groups.slice(0, -1).join("");
  const decimal = separators.at(-1) === "."
    && (finalGroup.length <= 2 || (integerPart === "0" && finalGroup.length === 3));
  const normalized = decimal ? `${integerPart}.${finalGroup}` : groups.join("");
  const speed = Number(normalized);
  return Number.isFinite(speed) ? speed : null;
}
