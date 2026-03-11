import { requestUrl } from "obsidian";
import {
  GoogleAuth,
  GoogleAuthError,
  encryptTokens,
  decryptTokens,
} from "@/google/auth";
import { OAuthTokens } from "@/types";
import {
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_REVOKE_URL,
  OAUTH_SCOPES,
} from "@/constants";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

jest.mock("obsidian");

const mockRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT_URI = "http://localhost:49152/callback";

function createAuth(): GoogleAuth {
  return new GoogleAuth(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function mockTokenResponse(overrides: Record<string, any> = {}) {
  return {
    status: 200,
    headers: {},
    json: {
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
      ...overrides,
    },
    text: "",
    arrayBuffer: new ArrayBuffer(0),
  };
}

function mockRefreshResponse(overrides: Record<string, any> = {}) {
  return {
    status: 200,
    headers: {},
    json: {
      access_token: "refreshed-access-token",
      expires_in: 3600,
      token_type: "Bearer",
      ...overrides,
    },
    text: "",
    arrayBuffer: new ArrayBuffer(0),
  };
}

function mockErrorResponse(status: number, error: string, description?: string) {
  return {
    status,
    headers: {},
    json: {
      error,
      error_description: description,
    },
    text: "",
    arrayBuffer: new ArrayBuffer(0),
  };
}

describe("GoogleAuth", () => {
  let auth: GoogleAuth;

  beforeEach(() => {
    auth = createAuth();
    jest.clearAllMocks();
  });

  // ============================================================
  // getAuthUrl
  // ============================================================

  describe("getAuthUrl", () => {
    it("should generate auth URL with correct scopes and redirect", () => {
      const url = auth.getAuthUrl();
      const parsed = new URL(url);

      expect(parsed.origin + parsed.pathname).toBe(GOOGLE_AUTH_URL);
      expect(parsed.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(parsed.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("scope")).toBe(OAUTH_SCOPES.join(" "));
      expect(parsed.searchParams.get("access_type")).toBe("offline");
      expect(parsed.searchParams.get("prompt")).toBe("consent");
    });

    it("should include state parameter when provided", () => {
      const url = auth.getAuthUrl("my-state-value");
      const parsed = new URL(url);

      expect(parsed.searchParams.get("state")).toBe("my-state-value");
    });

    it("should not include state parameter when not provided", () => {
      const url = auth.getAuthUrl();
      const parsed = new URL(url);

      expect(parsed.searchParams.has("state")).toBe(false);
    });
  });

  // ============================================================
  // exchangeCode
  // ============================================================

  describe("exchangeCode", () => {
    it("should exchange auth code for tokens", async () => {
      mockRequestUrl.mockResolvedValueOnce(mockTokenResponse());

      const tokens = await auth.exchangeCode("test-auth-code");

      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toBe(GOOGLE_TOKEN_URL);
      expect(call.method).toBe("POST");
      expect(call.headers?.["Content-Type"]).toBe(
        "application/x-www-form-urlencoded",
      );

      const body = new URLSearchParams(call.body as string);
      expect(body.get("code")).toBe("test-auth-code");
      expect(body.get("client_id")).toBe(CLIENT_ID);
      expect(body.get("client_secret")).toBe(CLIENT_SECRET);
      expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(body.get("grant_type")).toBe("authorization_code");

      expect(tokens.accessToken).toBe("mock-access-token");
      expect(tokens.refreshToken).toBe("mock-refresh-token");
      expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    });

    it("should throw on token exchange failure", async () => {
      mockRequestUrl.mockResolvedValueOnce(
        mockErrorResponse(400, "invalid_grant", "Bad Request"),
      );

      await expect(auth.exchangeCode("bad-code")).rejects.toThrow(
        /Token exchange failed/,
      );
    });
  });

  // ============================================================
  // getAccessToken (auto-refresh)
  // ============================================================

  describe("getAccessToken", () => {
    it("should return current access token when not expired", async () => {
      mockRequestUrl.mockResolvedValueOnce(mockTokenResponse());
      await auth.exchangeCode("test-code");

      const token = await auth.getAccessToken();
      expect(token).toBe("mock-access-token");
      // Should not have made another request (only the initial exchange)
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });

    it("should refresh expired access token", async () => {
      // Set tokens with an already-expired expiresAt
      auth.setTokens({
        accessToken: "expired-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() - 1000, // expired
      });

      mockRequestUrl.mockResolvedValueOnce(mockRefreshResponse());

      const token = await auth.getAccessToken();
      expect(token).toBe("refreshed-access-token");
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);

      const call = mockRequestUrl.mock.calls[0][0];
      const body = new URLSearchParams(call.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("mock-refresh-token");
    });

    it("should refresh token that expires within 60 seconds", async () => {
      auth.setTokens({
        accessToken: "soon-to-expire-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 30_000, // 30s from now, within the 60s buffer
      });

      mockRequestUrl.mockResolvedValueOnce(mockRefreshResponse());

      const token = await auth.getAccessToken();
      expect(token).toBe("refreshed-access-token");
    });

    it("should throw when no tokens are available", async () => {
      await expect(auth.getAccessToken()).rejects.toThrow(GoogleAuthError);
      await expect(auth.getAccessToken()).rejects.toThrow(
        /No tokens available/,
      );
    });

    it("should handle refresh token revocation with specific error", async () => {
      auth.setTokens({
        accessToken: "expired-token",
        refreshToken: "revoked-refresh-token",
        expiresAt: Date.now() - 1000,
      });

      mockRequestUrl.mockResolvedValueOnce(
        mockErrorResponse(400, "invalid_grant", "Token has been revoked"),
      );

      try {
        await auth.getAccessToken();
        fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GoogleAuthError);
        expect((err as GoogleAuthError).code).toBe("token_revoked");
        expect((err as GoogleAuthError).message).toContain("revoked");
      }

      // Tokens should be cleared after revocation
      expect(auth.getTokens()).toBeNull();
    });
  });

  // ============================================================
  // revokeTokens
  // ============================================================

  describe("revokeTokens", () => {
    it("should revoke tokens successfully", async () => {
      auth.setTokens({
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3600_000,
      });

      mockRequestUrl.mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {},
        text: "",
        arrayBuffer: new ArrayBuffer(0),
      });

      await auth.revokeTokens();

      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.url).toContain(GOOGLE_REVOKE_URL);
      expect(call.url).toContain("test-refresh");
      expect(call.method).toBe("POST");

      // Tokens should be cleared
      expect(auth.getTokens()).toBeNull();
    });

    it("should throw when no tokens to revoke", async () => {
      await expect(auth.revokeTokens()).rejects.toThrow(GoogleAuthError);
      await expect(auth.revokeTokens()).rejects.toThrow(
        /No tokens available to revoke/,
      );
    });

    it("should throw on revocation failure", async () => {
      auth.setTokens({
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3600_000,
      });

      mockRequestUrl.mockResolvedValueOnce(
        mockErrorResponse(400, "invalid_token"),
      );

      await expect(auth.revokeTokens()).rejects.toThrow(
        /Failed to revoke tokens/,
      );
    });
  });

  // ============================================================
  // Encryption / Decryption
  // ============================================================

  describe("encrypt and decrypt tokens", () => {
    const sampleTokens: OAuthTokens = {
      accessToken: "sample-access-token",
      refreshToken: "sample-refresh-token",
      expiresAt: Date.now() + 3600_000,
    };

    it("should encrypt tokens at rest and decrypt correctly", () => {
      const passphrase = "my-secure-passphrase";
      const encrypted = encryptTokens(sampleTokens, passphrase);

      // Encrypted data should have all required fields
      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.salt).toBeDefined();
      expect(encrypted.authTag).toBeDefined();

      // Ciphertext should not contain the plaintext
      expect(encrypted.ciphertext).not.toContain("sample-access-token");

      const decrypted = decryptTokens(encrypted, passphrase);
      expect(decrypted).toEqual(sampleTokens);
    });

    it("should produce different ciphertext for the same input (random salt/iv)", () => {
      const passphrase = "test-passphrase";
      const encrypted1 = encryptTokens(sampleTokens, passphrase);
      const encrypted2 = encryptTokens(sampleTokens, passphrase);

      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
      expect(encrypted1.salt).not.toBe(encrypted2.salt);
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
    });

    it("should fail to decrypt with invalid passphrase", () => {
      const encrypted = encryptTokens(sampleTokens, "correct-passphrase");

      expect(() => decryptTokens(encrypted, "wrong-passphrase")).toThrow(
        GoogleAuthError,
      );
      expect(() => decryptTokens(encrypted, "wrong-passphrase")).toThrow(
        /Failed to decrypt tokens/,
      );
    });
  });

  // ============================================================
  // saveTokens / loadTokens (file I/O)
  // ============================================================

  describe("saveTokens and loadTokens", () => {
    let tmpDir: string;
    let tokenFilePath: string;
    const passphrase = "test-passphrase-for-file-io";

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-auth-test-"));
      tokenFilePath = path.join(tmpDir, "auth.json");
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("should save and load tokens from file", async () => {
      auth.setTokens({
        accessToken: "file-access-token",
        refreshToken: "file-refresh-token",
        expiresAt: 1700000000000,
      });

      await auth.saveTokens(tokenFilePath, passphrase);

      // Verify file exists and is not plaintext
      const raw = await fs.readFile(tokenFilePath, "utf-8");
      expect(raw).not.toContain("file-access-token");
      const parsed = JSON.parse(raw);
      expect(parsed.ciphertext).toBeDefined();
      expect(parsed.iv).toBeDefined();
      expect(parsed.salt).toBeDefined();
      expect(parsed.authTag).toBeDefined();

      // Load into a new auth instance
      const auth2 = createAuth();
      const loaded = await auth2.loadTokens(tokenFilePath, passphrase);

      expect(loaded.accessToken).toBe("file-access-token");
      expect(loaded.refreshToken).toBe("file-refresh-token");
      expect(loaded.expiresAt).toBe(1700000000000);
    });

    it("should throw specific error when token file is missing", async () => {
      const missingPath = path.join(tmpDir, "nonexistent.json");

      try {
        await auth.loadTokens(missingPath, passphrase);
        fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GoogleAuthError);
        expect((err as GoogleAuthError).code).toBe("token_file_not_found");
        expect((err as GoogleAuthError).message).toContain("not found");
      }
    });

    it("should throw when loading with wrong passphrase", async () => {
      auth.setTokens({
        accessToken: "secure-access",
        refreshToken: "secure-refresh",
        expiresAt: 1700000000000,
      });

      await auth.saveTokens(tokenFilePath, "correct-passphrase");

      const auth2 = createAuth();
      await expect(
        auth2.loadTokens(tokenFilePath, "wrong-passphrase"),
      ).rejects.toThrow(GoogleAuthError);
      await expect(
        auth2.loadTokens(tokenFilePath, "wrong-passphrase"),
      ).rejects.toThrow(/Failed to decrypt tokens/);
    });

    it("should throw when saving with no tokens", async () => {
      await expect(
        auth.saveTokens(tokenFilePath, passphrase),
      ).rejects.toThrow(GoogleAuthError);
      await expect(
        auth.saveTokens(tokenFilePath, passphrase),
      ).rejects.toThrow(/No tokens available to save/);
    });
  });
});
