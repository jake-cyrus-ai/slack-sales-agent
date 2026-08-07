export function configurationRedirectPath(
  query: Record<string, unknown>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") params.append(key, value);
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") params.append(key, item);
    }
  }
  const encoded = params.toString();
  return encoded ? `/?${encoded}` : "/";
}
