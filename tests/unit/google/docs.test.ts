import { requestUrl } from "obsidian";
import { DocsAPI, DocsApiError } from "@/google/docs";
import { RateLimiter, RateLimitError } from "@/google/rate-limiter";
import { DOCS_API_BASE } from "@/constants";

jest.mock("obsidian");

const mockRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

function createMockRateLimiter(): RateLimiter {
  const limiter = new RateLimiter(300, 60000);
  limiter.execute = jest.fn(<T,>(fn: () => Promise<T>) => fn());
  return limiter;
}

const mockGetAccessToken = jest.fn().mockResolvedValue("test-access-token");

function createDocsAPI(): DocsAPI {
  return new DocsAPI(mockGetAccessToken, createMockRateLimiter());
}

function mockResponse(status: number, json: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    headers,
    json,
    text: JSON.stringify(json),
    arrayBuffer: new ArrayBuffer(0),
  };
}

describe("DocsAPI", () => {
  let docs: DocsAPI;

  beforeEach(() => {
    jest.clearAllMocks();
    docs = createDocsAPI();
  });

  describe("getDocument", () => {
    it("fetches and returns the document", async () => {
      const doc = { documentId: "doc-1", title: "T", body: { content: [] } };
      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, doc));

      const result = await docs.getDocument("doc-1");

      expect(result).toEqual(doc);
      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toBe(`${DOCS_API_BASE}/documents/doc-1`);
      // Must opt out of Obsidian's throw-on-400 behavior so error handling
      // (and 429 retry) can see the status code.
      expect((call as { throw?: boolean }).throw).toBe(false);
    });

    it("throws DocsApiError with status on failure", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(404, { error: { message: "not found" } })
      );

      await expect(docs.getDocument("missing")).rejects.toThrow(DocsApiError);
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(404, { error: { message: "not found" } })
      );
      await expect(docs.getDocument("missing")).rejects.toMatchObject({ status: 404 });
    });

    it("throws RateLimitError with Retry-After on 429", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(429, { error: { message: "rate" } }, { "retry-after": "7" })
      );

      await expect(docs.getDocument("doc-1")).rejects.toMatchObject({
        status: 429,
        retryAfter: 7,
      });
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(429, { error: { message: "rate" } })
      );
      await expect(docs.getDocument("doc-1")).rejects.toThrow(RateLimitError);
    });
  });

  describe("batchUpdate", () => {
    it("POSTs the request body", async () => {
      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, {}));

      const request = {
        requests: [{ insertText: { text: "hi", location: { index: 1 } } }],
      };
      await docs.batchUpdate("doc-1", request);

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toBe(`${DOCS_API_BASE}/documents/doc-1:batchUpdate`);
      expect(call.method).toBe("POST");
      expect(JSON.parse(call.body as string)).toEqual(request);
    });

    it("throws on a 400 response", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(400, { error: { message: "bad request" } })
      );

      await expect(
        docs.batchUpdate("doc-1", { requests: [] })
      ).rejects.toThrow(DocsApiError);
    });
  });

  describe("clearAndUpdate", () => {
    it("deletes existing content and inserts new content in one batch", async () => {
      const doc = {
        documentId: "doc-1",
        title: "T",
        body: { content: [{ startIndex: 0, endIndex: 25 }] },
      };
      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, doc)); // getDocument
      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, {})); // batchUpdate

      const insert = { insertText: { text: "new", location: { index: 1 } } };
      await docs.clearAndUpdate("doc-1", { requests: [insert] });

      expect(mockRequestUrl).toHaveBeenCalledTimes(2);
      const body = JSON.parse(mockRequestUrl.mock.calls[1][0].body as string);
      expect(body.requests[0]).toEqual({
        deleteContentRange: { range: { startIndex: 1, endIndex: 24 } },
      });
      expect(body.requests[1]).toEqual(insert);
    });

    it("skips the delete for an effectively empty document", async () => {
      const doc = {
        documentId: "doc-1",
        title: "T",
        body: { content: [{ startIndex: 0, endIndex: 2 }] },
      };
      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, doc));
      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, {}));

      const insert = { insertText: { text: "new", location: { index: 1 } } };
      await docs.clearAndUpdate("doc-1", { requests: [insert] });

      const body = JSON.parse(mockRequestUrl.mock.calls[1][0].body as string);
      expect(body.requests).toEqual([insert]);
    });
  });
});
