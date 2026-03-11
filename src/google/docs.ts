import { requestUrl } from "obsidian";
import { GoogleDoc, BatchUpdateRequest } from "@/types";
import { DOCS_API_BASE } from "@/constants";
import { RateLimiter } from "./rate-limiter";

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
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.status !== 200) {
        throw new Error(`Failed to get document: ${response.status}`);
      }

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
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });

      if (response.status !== 200) {
        throw new Error(`batchUpdate failed: ${response.status}`);
      }
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
