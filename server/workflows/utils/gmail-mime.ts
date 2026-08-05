/**
 * Recursively flattens Gmail MIME parts.
 * Gmail nests parts inside multipart/* containers — this walks the tree
 * and returns every leaf and branch in a flat array.
 */
export function flattenMimeParts(parts: any[]): any[] {
  return parts.reduce((acc: any[], p: any) => {
    acc.push(p);
    if (p.parts) acc.push(...flattenMimeParts(p.parts));
    return acc;
  }, []);
}
