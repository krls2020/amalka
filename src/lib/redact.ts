const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_\-]{20,}\b/g,
  /\bek_[A-Za-z0-9_\-]{20,}\b/g,
  /\brk_[A-Za-z0-9_\-]{20,}\b/g,
];

export function redact(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  for (const pat of SECRET_PATTERNS) {
    text = text.replace(pat, (m) => m.slice(0, 6) + "***");
  }
  return text;
}

function fmt(meta?: unknown): string {
  if (meta === undefined) return "";
  return " " + redact(meta);
}

export const log = {
  info: (msg: string, meta?: unknown) =>
    console.log(`[INFO] ${redact(msg)}${fmt(meta)}`),
  warn: (msg: string, meta?: unknown) =>
    console.warn(`[WARN] ${redact(msg)}${fmt(meta)}`),
  error: (msg: string, meta?: unknown) =>
    console.error(`[ERROR] ${redact(msg)}${fmt(meta)}`),
};
