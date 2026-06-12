import { requestUrl } from "obsidian";
import { GoogleDoc, BatchUpdateRequest } from "@/types";
import { DOCS_API_BASE } from "@/constants";
import { RateLimiter, RateLimitError } from "./rate-limiter";

export class DocsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DocsApiError";
  }
}

function checkDocsResponse(
  response: { status: number; headers?: Record<string, string>; json: unknown },
  context: string,
): void {
  const { status } = response;
  if (status < 400) {
    return;
  }
  if (status === 429) {
    const retryAfter = response.headers?.["retry-after"] ?? response.headers?.["Retry-After"];
    const seconds = retryAfter ? parseInt(retryAfter, 10) : NaN;
    throw new RateLimitError(isNaN(seconds) ? undefined : seconds);
  }
  const json = response.json;
  const detail =
    json && typeof json === "object" && "error" in json
      ? JSON.stringify((json as { error: unknown }).error)
      : `HTTP ${status}`;
  throw new DocsApiError(`Docs API error for ${context} (${status}): ${detail}`, status);
}

export class DocsAPI {
  private getAccessToken: () => Promise<string>;
  private rateLimiter: RateLimiter;

  constructor(
    getAccessToken: () => Promise<string>,
    rateLimiter: RateLimiter
  ) {
    this.getAccessToken = getAccessToken;
    this.rateLimiter = rateLimiter;
  }

  async getDocument(documentId: string): Promise<GoogleDoc> {
    return this.rateLimiter.execute(async () => {
      const token = await this.getAccessToken();
      const response = await requestUrl({
        url: `${DOCS_API_BASE}/documents/${documentId}`,
        method: "GET",
        throw: false,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      checkDocsResponse(response, documentId);
      return response.json as GoogleDoc;
    });
  }

  async batchUpdate(
    documentId: string,
    request: BatchUpdateRequest
  ): Promise<void> {
    return this.rateLimiter.execute(async () => {
      const token = await this.getAccessToken();
      const response = await requestUrl({
        url: `${DOCS_API_BASE}/documents/${documentId}:batchUpdate`,
        method: "POST",
        throw: false,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });

      checkDocsResponse(response, documentId);
    });
  }

  async clearAndUpdate(
    documentId: string,
    newContent: BatchUpdateRequest
  ): Promise<void> {
    // Atomic: delete all content (except trailing newline) then insert new content
    // in a single batchUpdate call
    const doc = await this.getDocument(documentId);

    const bodyContent = doc.body?.content;
    if (!bodyContent || bodyContent.length === 0) {
      // Empty doc, just insert
      if (newContent.requests.length > 0) {
        await this.batchUpdate(documentId, newContent);
      }
      return;
    }

    const lastElement = bodyContent[bodyContent.length - 1];
    const endIndex = lastElement.endIndex;

    const requests = [];

    // Delete existing content (preserve the required trailing newline at index endIndex-1)
    if (endIndex > 2) {
      requests.push({
        deleteContentRange: {
          range: {
            startIndex: 1,
            endIndex: endIndex - 1,
          },
        },
      });
    }

    // Add new content requests (they all start at index 1 since we cleared)
    requests.push(...newContent.requests);

    if (requests.length > 0) {
      await this.batchUpdate(documentId, { requests });
    }
  }
}
