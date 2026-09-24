export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET a JSON URL, retrying on rate limits (429) and transient server errors. */
export async function getJson<T>(
  url: string,
  headers: Record<string, string> = {},
  retries = 4,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", ...headers } });
    if (res.ok) return (await res.json()) as T;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`HTTP ${res.status} for ${url}: ${body}`);
    }
    const waitSec = Number(res.headers.get("retry-after")) || 15 * 2 ** attempt;
    console.warn(`  ${res.status} from ${new URL(url).host}, retrying in ${waitSec}s...`);
    await sleep(waitSec * 1000);
  }
}
