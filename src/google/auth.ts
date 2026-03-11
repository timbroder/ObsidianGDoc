import { requestUrl } from "obsidian";
import * as crypto from "crypto";
import { OAuthTokens } from "@/types";
import {
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_REVOKE_URL,
  OAUTH_SCOPES,
} from "@/constants";

// Encryption constants
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_DIGEST = "sha256";
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export class GoogleAuth {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private tokens: OAuthTokens | null = null;

  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
  }

  /**
   * Generate the OAuth 2.0 authorization URL with correct scopes and redirect.
   */
  getAuthUrl(state?: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: OAUTH_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
    });

    if (state) {
      params.set("state", state);
    }

    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for access and refresh tokens.
   */
  async exchangeCode(code: string): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: "authorization_code",
    });

    const response = await requestUrl({
      url: GOOGLE_TOKEN_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (response.status !== 200) {
      const errorData = response.json;
      throw new GoogleAuthError(
        `Token exchange failed: ${errorData?.error_description || errorData?.error || "unknown error"}`,
        errorData?.error || "token_exchange_failed",
      );
    }

    const data = response.json;
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    return { ...this.tokens };
  }

  /**
   * Get a valid access token, auto-refreshing if expired.
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      throw new GoogleAuthError(
        "No tokens available. Please authenticate first.",
        "no_tokens",
      );
    }

    // Refresh if token expires within the next 60 seconds
    if (Date.now() >= this.tokens.expiresAt - 60_000) {
      await this.refreshAccessToken();
    }

    return this.tokens.accessToken;
  }

  /**
   * Refresh the access token using the refresh token.
   */
  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new GoogleAuthError(
        "No refresh token available. Please re-authenticate.",
        "no_refresh_token",
      );
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.tokens.refreshToken,
      grant_type: "refresh_token",
    });

    const response = await requestUrl({
      url: GOOGLE_TOKEN_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (response.status !== 200) {
      const errorData = response.json;

      // Handle revoked refresh token
      if (errorData?.error === "invalid_grant") {
        this.tokens = null;
        throw new GoogleAuthError(
          "Refresh token has been revoked. Please re-authenticate.",
          "token_revoked",
        );
      }

      throw new GoogleAuthError(
        `Token refresh failed: ${errorData?.error_description || errorData?.error || "unknown error"}`,
        errorData?.error || "token_refresh_failed",
      );
    }

    const data = response.json;
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: this.tokens.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  /**
   * Revoke the current tokens.
   */
  async revokeTokens(): Promise<void> {
    if (!this.tokens) {
      throw new GoogleAuthError(
        "No tokens available to revoke.",
        "no_tokens",
      );
    }

    const tokenToRevoke = this.tokens.refreshToken || this.tokens.accessToken;

    const response = await requestUrl({
      url: `${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(tokenToRevoke)}`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (response.status !== 200) {
      throw new GoogleAuthError(
        "Failed to revoke tokens.",
        "revoke_failed",
      );
    }

    this.tokens = null;
  }

  /**
   * Encrypt and save tokens to a file.
   * Uses AES-256-GCM with a key derived from the passphrase via PBKDF2.
   */
  async saveTokens(filePath: string, passphrase: string): Promise<void> {
    if (!this.tokens) {
      throw new GoogleAuthError(
        "No tokens available to save.",
        "no_tokens",
      );
    }

    const encrypted = encryptTokens(this.tokens, passphrase);
    const { writeFile } = await import("fs/promises");
    await writeFile(filePath, JSON.stringify(encrypted), "utf-8");
  }

  /**
   * Load and decrypt tokens from a file.
   */
  async loadTokens(filePath: string, passphrase: string): Promise<OAuthTokens> {
    const { readFile, access } = await import("fs/promises");

    try {
      await access(filePath);
    } catch {
      throw new GoogleAuthError(
        `Token file not found: ${filePath}`,
        "token_file_not_found",
      );
    }

    const raw = await readFile(filePath, "utf-8");
    const encryptedData: EncryptedData = JSON.parse(raw);

    this.tokens = decryptTokens(encryptedData, passphrase);
    return { ...this.tokens };
  }

  /**
   * Set tokens directly (useful for restoring from storage).
   */
  setTokens(tokens: OAuthTokens): void {
    this.tokens = { ...tokens };
  }

  /**
   * Get the current tokens (may be null).
   */
  getTokens(): OAuthTokens | null {
    return this.tokens ? { ...this.tokens } : null;
  }
}

// ============================================================
// Encryption helpers
// ============================================================

interface EncryptedData {
  ciphertext: string;
  iv: string;
  salt: string;
  authTag: string;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    passphrase,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    PBKDF2_DIGEST,
  );
}

export function encryptTokens(tokens: OAuthTokens, passphrase: string): EncryptedData {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(passphrase, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const plaintext = JSON.stringify(tokens);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptTokens(data: EncryptedData, passphrase: string): OAuthTokens {
  const salt = Buffer.from(data.salt, "base64");
  const iv = Buffer.from(data.iv, "base64");
  const authTag = Buffer.from(data.authTag, "base64");
  const ciphertext = Buffer.from(data.ciphertext, "base64");

  const key = deriveKey(passphrase, salt);

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString("utf-8"));
  } catch {
    throw new GoogleAuthError(
      "Failed to decrypt tokens. Invalid passphrase or corrupted data.",
      "decryption_failed",
    );
  }
}
