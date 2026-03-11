import { requestUrl } from "obsidian";

const CONNECTIVITY_URL = "https://www.googleapis.com/generate_204";
const TIMEOUT_MS = 5000;

/**
 * Check whether the device currently has network connectivity by
 * hitting a lightweight Google endpoint.
 *
 * Returns true if the endpoint responds with 200 or 204, false on any error.
 */
export async function isOnline(): Promise<boolean> {
  try {
    const response = await requestUrl({
      url: CONNECTIVITY_URL,
      method: "GET",
      headers: {
        "Cache-Control": "no-cache",
      },
      // requestUrl from Obsidian uses the `contentType` field but does not
      // expose an explicit timeout option in its public type. We pass the
      // request as-is and rely on the platform default / short response.
    });

    return response.status === 200 || response.status === 204;
  } catch {
    return false;
  }
}
