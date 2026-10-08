export function getProviderEndpoint() {
  return document.querySelector('meta[name="aeon-api-endpoint"]')?.content.trim() ?? '';
}

export async function requestGroundedExplanation(payload, { endpoint = getProviderEndpoint(), fetchImpl = fetch, signal } = {}) {
  if (!endpoint) throw new Error('AI endpoint is not configured.');
  const response = await fetchImpl(new URL('/v1/explain', endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
    cache: 'no-store',
    credentials: 'omit',
  });
  if (!response.ok) throw new Error('AI explanation is unavailable.');
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('AI explanation response is invalid.');
  }
  if (result?.apiVersion !== '1' || !result.answer) throw new Error('AI explanation response is invalid.');
  return result;
}
