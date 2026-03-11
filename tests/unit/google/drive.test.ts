import { requestUrl } from "obsidian";
import {
  DriveAPI,
  DriveFileNotFoundError,
  DrivePermissionError,
} from "@/google/drive";
import { RateLimiter } from "@/google/rate-limiter";
import { DRIVE_API_BASE, GOOGLE_DOC_MIME_TYPE, GOOGLE_FOLDER_MIME_TYPE } from "@/constants";

// ============================================================
// Mocks
// ============================================================

jest.mock("obsidian");

const mockRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

// Create a pass-through rate limiter that executes immediately
function createMockRateLimiter(): RateLimiter {
  const limiter = new RateLimiter(12000, 60000);
  // Override execute to just call the function directly
  limiter.execute = jest.fn(<T>(fn: () => Promise<T>) => fn());
  return limiter;
}

const mockGetAccessToken = jest.fn().mockResolvedValue("test-access-token");

function createDriveAPI(): DriveAPI {
  return new DriveAPI(mockGetAccessToken, createMockRateLimiter());
}

function mockResponse(status: number, json: unknown, text?: string) {
  return {
    status,
    headers: {},
    json,
    text: text || JSON.stringify(json),
    arrayBuffer: new ArrayBuffer(0),
  };
}

// ============================================================
// Tests
// ============================================================

describe("DriveAPI", () => {
  let drive: DriveAPI;

  beforeEach(() => {
    jest.clearAllMocks();
    drive = createDriveAPI();
  });

  // ----------------------------------------------------------
  // createFile
  // ----------------------------------------------------------

  describe("createFile", () => {
    it("should create a file and return the file metadata", async () => {
      const createdFile = {
        id: "file-123",
        name: "Test Doc",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        parents: ["parent-folder"],
        modifiedTime: "2026-01-01T00:00:00Z",
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, createdFile));

      const result = await drive.createFile(
        "Test Doc",
        GOOGLE_DOC_MIME_TYPE,
        "parent-folder",
      );

      expect(result.id).toBe("file-123");
      expect(result.name).toBe("Test Doc");

      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.method).toBe("POST");
      expect(call.url).toContain(`${DRIVE_API_BASE}/files`);
      expect(call.headers?.Authorization).toBe("Bearer test-access-token");

      const body = JSON.parse(call.body!);
      expect(body.name).toBe("Test Doc");
      expect(body.mimeType).toBe(GOOGLE_DOC_MIME_TYPE);
      expect(body.parents).toEqual(["parent-folder"]);
    });

    it("should create a file with content using multipart upload", async () => {
      const createdFile = {
        id: "file-456",
        name: "plain.txt",
        mimeType: "text/plain",
        parents: ["parent-folder"],
        modifiedTime: "2026-01-01T00:00:00Z",
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, createdFile));

      const result = await drive.createFile(
        "plain.txt",
        "text/plain",
        "parent-folder",
        "Hello world",
      );

      expect(result.id).toBe("file-456");

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toContain("uploadType=multipart");
      expect(call.headers?.["Content-Type"]).toContain("multipart/related");
      expect(call.body).toContain("Hello world");
    });
  });

  // ----------------------------------------------------------
  // createFolder
  // ----------------------------------------------------------

  describe("createFolder", () => {
    it("should create a folder with the correct MIME type", async () => {
      const createdFolder = {
        id: "folder-789",
        name: "My Folder",
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        parents: ["root-folder"],
        modifiedTime: "2026-01-01T00:00:00Z",
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, createdFolder));

      const result = await drive.createFolder("My Folder", "root-folder");

      expect(result.id).toBe("folder-789");
      expect(result.mimeType).toBe(GOOGLE_FOLDER_MIME_TYPE);

      const call = mockRequestUrl.mock.calls[0][0];
      const body = JSON.parse(call.body!);
      expect(body.mimeType).toBe(GOOGLE_FOLDER_MIME_TYPE);
      expect(body.parents).toEqual(["root-folder"]);
    });
  });

  // ----------------------------------------------------------
  // listFiles
  // ----------------------------------------------------------

  describe("listFiles", () => {
    it("should list files in a folder", async () => {
      const listResponse = {
        files: [
          { id: "f1", name: "Doc1", mimeType: GOOGLE_DOC_MIME_TYPE, modifiedTime: "2026-01-01T00:00:00Z" },
          { id: "f2", name: "Doc2", mimeType: GOOGLE_DOC_MIME_TYPE, modifiedTime: "2026-01-02T00:00:00Z" },
        ],
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, listResponse));

      const result = await drive.listFiles("parent-id");

      expect(result.files).toHaveLength(2);
      expect(result.files[0].id).toBe("f1");
      expect(result.nextPageToken).toBeUndefined();

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.method).toBe("GET");
      expect(call.url).toContain(`${DRIVE_API_BASE}/files`);
      // Verify query contains the folder ID and trashed filter (URL-encoded)
      const url = new URL(call.url);
      const query = url.searchParams.get("q") || "";
      expect(query).toContain("parent-id");
      expect(query).toContain("in parents");
      expect(query).toContain("trashed = false");
    });

    it("should handle paginated responses", async () => {
      const page1Response = {
        files: [
          { id: "f1", name: "Doc1", mimeType: GOOGLE_DOC_MIME_TYPE, modifiedTime: "2026-01-01T00:00:00Z" },
        ],
        nextPageToken: "page-2-token",
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, page1Response));

      const result = await drive.listFiles("parent-id");

      expect(result.files).toHaveLength(1);
      expect(result.nextPageToken).toBe("page-2-token");

      // Now request page 2
      const page2Response = {
        files: [
          { id: "f2", name: "Doc2", mimeType: GOOGLE_DOC_MIME_TYPE, modifiedTime: "2026-01-02T00:00:00Z" },
        ],
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, page2Response));

      const result2 = await drive.listFiles("parent-id", "page-2-token");

      expect(result2.files).toHaveLength(1);
      expect(result2.files[0].id).toBe("f2");
      expect(result2.nextPageToken).toBeUndefined();

      const secondCall = mockRequestUrl.mock.calls[1][0];
      expect(secondCall.url).toContain("pageToken=page-2-token");
    });

    it("should auto-paginate with listAllFiles", async () => {
      const page1 = {
        files: [
          { id: "f1", name: "Doc1", mimeType: GOOGLE_DOC_MIME_TYPE, modifiedTime: "2026-01-01T00:00:00Z" },
        ],
        nextPageToken: "token-2",
      };
      const page2 = {
        files: [
          { id: "f2", name: "Doc2", mimeType: GOOGLE_DOC_MIME_TYPE, modifiedTime: "2026-01-02T00:00:00Z" },
        ],
        nextPageToken: "token-3",
      };
      const page3 = {
        files: [
          { id: "f3", name: "Doc3", mimeType: GOOGLE_DOC_MIME_TYPE, modifiedTime: "2026-01-03T00:00:00Z" },
        ],
      };

      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(200, page1))
        .mockResolvedValueOnce(mockResponse(200, page2))
        .mockResolvedValueOnce(mockResponse(200, page3));

      const allFiles = await drive.listAllFiles("parent-id");

      expect(allFiles).toHaveLength(3);
      expect(allFiles.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
      expect(mockRequestUrl).toHaveBeenCalledTimes(3);
    });
  });

  // ----------------------------------------------------------
  // getFile
  // ----------------------------------------------------------

  describe("getFile", () => {
    it("should get file metadata with default fields", async () => {
      const file = {
        id: "file-abc",
        name: "My Document",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        parents: ["folder-1"],
        modifiedTime: "2026-03-01T12:00:00Z",
        properties: { obsidian_sync_id: "sync-123" },
        size: "1024",
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, file));

      const result = await drive.getFile("file-abc");

      expect(result.id).toBe("file-abc");
      expect(result.name).toBe("My Document");

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toContain("/files/file-abc");
      expect(call.url).toContain("fields=");
      expect(call.url).toContain("id");
      expect(call.url).toContain("name");
      expect(call.url).toContain("mimeType");
    });

    it("should get file metadata with custom fields", async () => {
      const file = {
        id: "file-abc",
        name: "My Document",
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, file));

      await drive.getFile("file-abc", "id,name");

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toContain("fields=id,name");
    });
  });

  // ----------------------------------------------------------
  // updateFileMetadata
  // ----------------------------------------------------------

  describe("updateFileMetadata", () => {
    it("should rename a file", async () => {
      const updatedFile = {
        id: "file-abc",
        name: "Renamed Document",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        parents: ["folder-1"],
        modifiedTime: "2026-03-02T12:00:00Z",
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, updatedFile));

      const result = await drive.updateFileMetadata("file-abc", {
        name: "Renamed Document",
      });

      expect(result.name).toBe("Renamed Document");

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.method).toBe("PATCH");
      expect(call.url).toContain("/files/file-abc");

      const body = JSON.parse(call.body!);
      expect(body.name).toBe("Renamed Document");
    });

    it("should update properties", async () => {
      const updatedFile = {
        id: "file-abc",
        name: "Doc",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        modifiedTime: "2026-03-02T12:00:00Z",
        properties: { obsidian_sync_id: "new-id" },
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, updatedFile));

      const result = await drive.updateFileMetadata("file-abc", {
        properties: { obsidian_sync_id: "new-id" },
      });

      expect(result.properties?.obsidian_sync_id).toBe("new-id");

      const call = mockRequestUrl.mock.calls[0][0];
      const body = JSON.parse(call.body!);
      expect(body.properties).toEqual({ obsidian_sync_id: "new-id" });
    });
  });

  // ----------------------------------------------------------
  // moveFile
  // ----------------------------------------------------------

  describe("moveFile", () => {
    it("should move a file to a different folder", async () => {
      const movedFile = {
        id: "file-abc",
        name: "Doc",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        parents: ["new-folder"],
        modifiedTime: "2026-03-02T12:00:00Z",
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, movedFile));

      const result = await drive.moveFile("file-abc", "new-folder", "old-folder");

      expect(result.parents).toEqual(["new-folder"]);

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.method).toBe("PATCH");
      expect(call.url).toContain("/files/file-abc");
      expect(call.url).toContain("addParents=new-folder");
      expect(call.url).toContain("removeParents=old-folder");
    });
  });

  // ----------------------------------------------------------
  // deleteFile
  // ----------------------------------------------------------

  describe("deleteFile", () => {
    it("should trash a file", async () => {
      const trashedFile = {
        id: "file-abc",
        name: "Doc",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        modifiedTime: "2026-03-02T12:00:00Z",
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, trashedFile));

      await drive.deleteFile("file-abc");

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.method).toBe("PATCH");
      expect(call.url).toContain("/files/file-abc");

      const body = JSON.parse(call.body!);
      expect(body.trashed).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // getChanges
  // ----------------------------------------------------------

  describe("getChanges", () => {
    it("should get changes since a token", async () => {
      const changesResponse = {
        changes: [
          {
            fileId: "f1",
            removed: false,
            file: {
              id: "f1",
              name: "Changed Doc",
              mimeType: GOOGLE_DOC_MIME_TYPE,
              modifiedTime: "2026-03-02T12:00:00Z",
            },
            time: "2026-03-02T12:00:00Z",
          },
        ],
        newStartPageToken: "new-token-456",
      };

      mockRequestUrl.mockResolvedValueOnce(mockResponse(200, changesResponse));

      const result = await drive.getChanges("start-token-123");

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].fileId).toBe("f1");
      expect(result.changes[0].removed).toBe(false);
      expect(result.newStartPageToken).toBe("new-token-456");

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toContain("pageToken=start-token-123");
      expect(call.url).toContain("includeRemoved=true");
    });

    it("should handle paginated changes", async () => {
      const page1 = {
        changes: [
          {
            fileId: "f1",
            removed: false,
            file: { id: "f1", name: "Doc1", mimeType: GOOGLE_DOC_MIME_TYPE, modifiedTime: "2026-03-01T00:00:00Z" },
            time: "2026-03-01T00:00:00Z",
          },
        ],
        nextPageToken: "changes-page-2",
      };

      const page2 = {
        changes: [
          {
            fileId: "f2",
            removed: true,
            time: "2026-03-02T00:00:00Z",
          },
        ],
        newStartPageToken: "final-token",
      };

      mockRequestUrl
        .mockResolvedValueOnce(mockResponse(200, page1))
        .mockResolvedValueOnce(mockResponse(200, page2));

      // First page
      const result1 = await drive.getChanges("initial-token");
      expect(result1.changes).toHaveLength(1);
      expect(result1.nextPageToken).toBe("changes-page-2");
      expect(result1.newStartPageToken).toBe("");

      // Second page
      const result2 = await drive.getChanges("changes-page-2");
      expect(result2.changes).toHaveLength(1);
      expect(result2.changes[0].removed).toBe(true);
      expect(result2.newStartPageToken).toBe("final-token");
      expect(result2.nextPageToken).toBeUndefined();
    });
  });

  // ----------------------------------------------------------
  // getStartPageToken
  // ----------------------------------------------------------

  describe("getStartPageToken", () => {
    it("should return the start page token", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(200, { startPageToken: "initial-page-token" }),
      );

      const token = await drive.getStartPageToken();

      expect(token).toBe("initial-page-token");

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toContain("/changes/startPageToken");
      expect(call.method).toBe("GET");
    });
  });

  // ----------------------------------------------------------
  // Error handling
  // ----------------------------------------------------------

  describe("error handling", () => {
    it("should throw DriveFileNotFoundError on 404", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(404, { error: { message: "File not found", code: 404 } }),
      );

      const promise = drive.getFile("nonexistent-id");
      await expect(promise).rejects.toThrow(DriveFileNotFoundError);
    });

    it("should throw DriveFileNotFoundError with descriptive message", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(404, { error: { message: "File not found", code: 404 } }),
      );

      await expect(drive.getFile("nonexistent-id")).rejects.toThrow(
        /File not found/,
      );
    });

    it("should throw DrivePermissionError on 403", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(403, { error: { message: "Forbidden", code: 403 } }),
      );

      const promise = drive.getFile("forbidden-id");
      await expect(promise).rejects.toThrow(DrivePermissionError);
    });

    it("should throw DrivePermissionError with descriptive message", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(403, { error: { message: "Forbidden", code: 403 } }),
      );

      await expect(drive.getFile("forbidden-id")).rejects.toThrow(
        /Permission denied/,
      );
    });

    it("should throw DriveFileNotFoundError on 404 for createFile", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(404, { error: { message: "Parent not found", code: 404 } }),
      );

      await expect(
        drive.createFile("test", GOOGLE_DOC_MIME_TYPE, "bad-parent"),
      ).rejects.toThrow(DriveFileNotFoundError);
    });

    it("should throw DrivePermissionError on 403 for deleteFile", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(403, { error: { message: "Forbidden", code: 403 } }),
      );

      await expect(drive.deleteFile("protected-id")).rejects.toThrow(
        DrivePermissionError,
      );
    });

    it("should throw a generic error for other 4xx/5xx status codes", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(500, { error: { message: "Internal Server Error" } }),
      );

      await expect(drive.getFile("some-id")).rejects.toThrow(
        /Drive API error \(500\)/,
      );
    });
  });

  // ----------------------------------------------------------
  // batchRequest
  // ----------------------------------------------------------

  describe("batchRequest", () => {
    it("should return empty array for empty requests", async () => {
      const result = await drive.batchRequest([]);
      expect(result).toEqual([]);
      expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it("should throw when exceeding max batch size", async () => {
      const requests = Array.from({ length: 101 }, (_, i) => ({
        method: "GET",
        path: `/drive/v3/files/file-${i}`,
      }));

      await expect(drive.batchRequest(requests)).rejects.toThrow(
        /exceeds maximum size/,
      );
    });

    it("should send a multipart batch request", async () => {
      const batchResponseText = [
        "--batch_response",
        "Content-Type: application/http",
        "",
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "",
        '{"id":"f1","name":"Doc1"}',
        "--batch_response",
        "Content-Type: application/http",
        "",
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "",
        '{"id":"f2","name":"Doc2"}',
        "--batch_response--",
      ].join("\r\n");

      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(200, {}, batchResponseText),
      );

      const result = await drive.batchRequest([
        { method: "GET", path: "/drive/v3/files/f1" },
        { method: "GET", path: "/drive/v3/files/f2" },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].status).toBe(200);
      expect((result[0].body as { id: string }).id).toBe("f1");
      expect(result[1].status).toBe(200);
      expect((result[1].body as { id: string }).id).toBe("f2");

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toContain("batch/drive/v3");
      expect(call.headers?.["Content-Type"]).toContain("multipart/mixed");
    });
  });

  // ----------------------------------------------------------
  // Access token usage
  // ----------------------------------------------------------

  describe("access token", () => {
    it("should call getAccessToken for each request", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockResponse(200, { id: "f1", name: "Doc", mimeType: GOOGLE_DOC_MIME_TYPE, modifiedTime: "2026-01-01T00:00:00Z" }),
      );

      await drive.getFile("f1");

      expect(mockGetAccessToken).toHaveBeenCalledTimes(1);

      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.headers?.Authorization).toBe("Bearer test-access-token");
    });
  });
});
