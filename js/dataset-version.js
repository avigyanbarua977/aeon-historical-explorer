function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function getDatasetVersion({ events, eras, relationships } = {}) {
  if (![events, eras, relationships].every(Array.isArray)) {
    throw new TypeError('Dataset versioning requires events, eras, and canonical relationships.');
  }
  const byId = (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  const canonicalPayload = JSON.stringify({
    events: [...events].sort(byId),
    eras: [...eras].sort(byId),
    relationships: [...relationships].sort(byId),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPayload));
  return `sha256-${toHex(digest)}`;
}
