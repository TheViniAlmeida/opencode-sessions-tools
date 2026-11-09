import { DomainError } from "./index";

export function canonical(
  value: unknown,
  ancestors = new Set<object>(),
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value !== "object" || ancestors.has(value))
    throw new DomainError("invalid_input");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new DomainError("invalid_input");
  if (Object.getOwnPropertySymbols(value).length)
    throw new DomainError("invalid_input");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.keys(value).length !== value.length ||
        Object.keys(value).some((key, index) => key !== String(index)) ||
        Object.keys(value).some(
          (key) =>
            !Object.hasOwn(
              Object.getOwnPropertyDescriptor(value, key) ?? {},
              "value",
            ),
        )
      )
        throw new DomainError("invalid_input");
      return `[${value.map((item) => canonical(item, ancestors)).join(",")}]`;
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor))
          throw new DomainError("invalid_input");
        return `${JSON.stringify(key)}:${canonical(descriptor.value, ancestors)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
