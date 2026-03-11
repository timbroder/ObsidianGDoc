import { requestUrl } from "obsidian";
import { DriveFile, DriveChangeList, DriveChange } from "@/types";
import {
  DRIVE_API_BASE,
  GOOGLE_DOC_MIME_TYPE,
  GOOGLE_FOLDER_MIME_TYPE,
} from "@/constants";
import { RateLimiter } from "@/google/rate-limiter";

// ============================================================
// Error types
// ============================================================

export class DriveFileNotFoundError extends Error {
  status = 404;

  constructor(fileId: string) {
    super(`File not found: ${fileId}`);
    this.name = "DriveFileNotFoundError";
  }
}

export class DrivePermissionError extends Error {
  status = 403;

  constructor(fileId: string) {
    super(`Permission denied: ${fileId}`);
    this.name = "DrivePermissionError";
  }
}

// ============================================================
// Batch request types
// ============================================================

export interface BatchRequestEntry {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

export interface BatchResponseEntry {
  status: number;
  body: unknown;
}

// ============================================================
// Internal types
// ============================================================

interface DriveListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

// ============================================================
// DriveAPI
// ============================================================

const DEFAULT_FILE_FIELDS = "id,name,mimeType,parents,modifiedTime,properties,size";
const BATCH_BOUNDARY = "batch_boundary_obsidian_gdocs";
const MAX_BATCH_SIZE = 100;

export class DriveAPI {
  private getAccessToken: () => Promise<string>;
  private rateLimiter: RateLimiter;

  constructor(
    getAccessToken: () => Promise<string>,
    rateLimiter: RateLimiter,
  ) {
    this.getAccessToken = getAccessToken;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Create a file or folder in Google Drive.
   */
  async createFile(
    name: string,
    mimeType: string,
    parentId: string,
    content?: string,
  ): Promise<DriveFile> {
    const metadata: Record<string, unknown> = {
      name,
      mimeType,
      parents: [parentId],
    };

    // For Google Docs and folders, use the metadata-only endpoint.
    // For files with content, use the multipart upload endpoint.
    if (content !== undefined && mimeType !== GOOGLE_DOC_MIME_TYPE && mimeType !== GOOGLE_FOLDER_MIME_TYPE) {
      return this.createFileWithContent(metadata, content, mimeType);
    }

    const token = await this.getAccessToken();
    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url: `${DRIVE_API_BASE}/files?fields=${DEFAULT_FILE_FIELDS}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metadata),
      }),
    );

    this.checkResponseError(response.status, response.json, name);
    return response.json as DriveFile;
  }

  /**
   * Convenience method to create a folder.
   */
  async createFolder(name: string, parentId: string): Promise<DriveFile> {
    return this.createFile(name, GOOGLE_FOLDER_MIME_TYPE, parentId);
  }

  /**
   * Get file metadata by ID.
   */
  async getFile(fileId: string, fields?: string): Promise<DriveFile> {
    const token = await this.getAccessToken();
    const fileFields = fields || DEFAULT_FILE_FIELDS;

    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url: `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=${fileFields}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
    );

    this.checkResponseError(response.status, response.json, fileId);
    return response.json as DriveFile;
  }

  /**
   * List files in a folder with optional pagination.
   */
  async listFiles(
    folderId: string,
    pageToken?: string,
  ): Promise<DriveListResponse> {
    const token = await this.getAccessToken();
    const query = `'${folderId}' in parents and trashed = false`;
    const params = new URLSearchParams({
      q: query,
      fields: `nextPageToken,files(${DEFAULT_FILE_FIELDS})`,
      pageSize: "100",
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url: `${DRIVE_API_BASE}/files?${params.toString()}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
    );

    this.checkResponseError(response.status, response.json, folderId);

    return {
      files: response.json.files || [],
      nextPageToken: response.json.nextPageToken,
    };
  }

  /**
   * List ALL files in a folder, auto-paginating through all results.
   */
  async listAllFiles(folderId: string): Promise<DriveFile[]> {
    const allFiles: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const result = await this.listFiles(folderId, pageToken);
      allFiles.push(...result.files);
      pageToken = result.nextPageToken;
    } while (pageToken);

    return allFiles;
  }

  /**
   * Update file metadata (name, parents, properties, etc.).
   */
  async updateFileMetadata(
    fileId: string,
    metadata: Partial<Pick<DriveFile, "name" | "properties">>,
  ): Promise<DriveFile> {
    const token = await this.getAccessToken();

    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url: `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=${DEFAULT_FILE_FIELDS}`,
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metadata),
      }),
    );

    this.checkResponseError(response.status, response.json, fileId);
    return response.json as DriveFile;
  }

  /**
   * Move a file to a different parent folder.
   */
  async moveFile(
    fileId: string,
    newParentId: string,
    oldParentId: string,
  ): Promise<DriveFile> {
    const token = await this.getAccessToken();

    const params = new URLSearchParams({
      addParents: newParentId,
      removeParents: oldParentId,
      fields: DEFAULT_FILE_FIELDS,
    });

    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url: `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );

    this.checkResponseError(response.status, response.json, fileId);
    return response.json as DriveFile;
  }

  /**
   * Move a file to trash (soft delete).
   */
  async deleteFile(fileId: string): Promise<void> {
    const token = await this.getAccessToken();

    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url: `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=${DEFAULT_FILE_FIELDS}`,
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ trashed: true }),
      }),
    );

    this.checkResponseError(response.status, response.json, fileId);
  }

  /**
   * Get changes since a given page token.
   */
  async getChanges(startPageToken: string): Promise<DriveChangeList> {
    const token = await this.getAccessToken();
    const params = new URLSearchParams({
      pageToken: startPageToken,
      fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,modifiedTime,properties,size),time)",
      spaces: "drive",
      includeRemoved: "true",
      pageSize: "100",
    });

    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url: `${DRIVE_API_BASE}/changes?${params.toString()}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
    );

    this.checkResponseError(response.status, response.json, "changes");

    const data = response.json;
    const result: DriveChangeList = {
      changes: (data.changes || []) as DriveChange[],
      newStartPageToken: data.newStartPageToken || "",
      nextPageToken: data.nextPageToken,
    };

    return result;
  }

  /**
   * Get the starting page token for the changes API.
   */
  async getStartPageToken(): Promise<string> {
    const token = await this.getAccessToken();

    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url: `${DRIVE_API_BASE}/changes/startPageToken`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
    );

    this.checkResponseError(response.status, response.json, "startPageToken");
    return response.json.startPageToken;
  }

  /**
   * Execute multiple API calls in a single batch request (up to 100).
   */
  async batchRequest(requests: BatchRequestEntry[]): Promise<BatchResponseEntry[]> {
    if (requests.length === 0) {
      return [];
    }
    if (requests.length > MAX_BATCH_SIZE) {
      throw new Error(`Batch request exceeds maximum size of ${MAX_BATCH_SIZE}`);
    }

    const token = await this.getAccessToken();

    // Build multipart/mixed body
    const parts = requests.map((req, index) => {
      let part = `--${BATCH_BOUNDARY}\r\n`;
      part += `Content-Type: application/http\r\n`;
      part += `Content-ID: <item-${index}>\r\n\r\n`;
      part += `${req.method} ${req.path} HTTP/1.1\r\n`;

      if (req.body) {
        const bodyStr = JSON.stringify(req.body);
        part += `Content-Type: application/json\r\n`;
        part += `Content-Length: ${bodyStr.length}\r\n\r\n`;
        part += bodyStr;
      } else {
        part += `\r\n`;
      }

      return part;
    });

    const body = parts.join("\r\n") + `\r\n--${BATCH_BOUNDARY}--`;

    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url: "https://www.googleapis.com/batch/drive/v3",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/mixed; boundary=${BATCH_BOUNDARY}`,
        },
        body,
      }),
    );

    return this.parseBatchResponse(response.text);
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private async createFileWithContent(
    metadata: Record<string, unknown>,
    content: string,
    _mimeType: string,
  ): Promise<DriveFile> {
    const token = await this.getAccessToken();
    const boundary = "file_upload_boundary";

    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
      `${content}\r\n` +
      `--${boundary}--`;

    const response = await this.rateLimiter.execute(() =>
      requestUrl({
        url: `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${DEFAULT_FILE_FIELDS}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      }),
    );

    this.checkResponseError(response.status, response.json, metadata.name as string);
    return response.json as DriveFile;
  }

  private checkResponseError(
    status: number,
    json: unknown,
    context: string,
  ): void {
    if (status === 404) {
      throw new DriveFileNotFoundError(context);
    }
    if (status === 403) {
      throw new DrivePermissionError(context);
    }
    if (status >= 400) {
      const message = json && typeof json === "object" && "error" in json
        ? JSON.stringify((json as { error: unknown }).error)
        : `HTTP ${status}`;
      throw new Error(`Drive API error (${status}): ${message}`);
    }
  }

  private parseBatchResponse(responseText: string): BatchResponseEntry[] {
    const results: BatchResponseEntry[] = [];

    // Split by boundary - the boundary is in the Content-Type header of the response
    // but we need to find it in the response body
    const lines = responseText.split("\r\n");
    if (lines.length === 0) {
      return results;
    }

    // The first line is typically the boundary
    const responseBoundary = lines[0].trim();
    if (!responseBoundary.startsWith("--")) {
      return results;
    }

    const parts = responseText.split(responseBoundary).filter(
      (part) => part.trim() !== "" && part.trim() !== "--",
    );

    for (const part of parts) {
      // Each part contains HTTP headers and an HTTP response
      // Find the HTTP status line (e.g., "HTTP/1.1 200 OK")
      const httpStatusMatch = part.match(/HTTP\/1\.1\s+(\d+)/);
      if (!httpStatusMatch) {
        continue;
      }

      const status = parseInt(httpStatusMatch[1], 10);

      // Find the JSON body (after the blank line following HTTP headers)
      const jsonMatch = part.match(/\{[\s\S]*\}/);
      let body: unknown = null;
      if (jsonMatch) {
        try {
          body = JSON.parse(jsonMatch[0]);
        } catch {
          body = null;
        }
      }

      results.push({ status, body });
    }

    return results;
  }
}
