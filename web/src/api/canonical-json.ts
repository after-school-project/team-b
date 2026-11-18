export type JsonValue = null | boolean | number | string | readonly JsonValue[] |
  { readonly [key: string]: JsonValue | undefined };

export function canonicalJson(value: JsonValue): string {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("Validated input must contain plain JSON values.");
    }
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : Number(left > right));
    const fields = entries.flatMap(([key, item]) =>
      item === undefined ? [] : [JSON.stringify(key) + ":" + canonicalJson(item)]);
    return "{" + fields.join(",") + "}";
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Validated input must contain finite numbers.");
  }
  return JSON.stringify(value);
}
