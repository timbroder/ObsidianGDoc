/**
 * Loopback redirect listener for the OAuth 2.0 installed-app flow.
 *
 * Google's desktop flow redirects to http://127.0.0.1:{port}/ after the user
 * grants consent. This starts a throwaway HTTP server on an ephemeral port,
 * waits for that single redirect, extracts the authorization code, and shuts
 * down.
 */

import * as http from "http";
import { AddressInfo } from "net";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const SUCCESS_PAGE = `<!DOCTYPE html>
<html><body style="font-family: sans-serif; text-align: center; padding-top: 4em;">
<h2>Signed in to Google Docs Sync</h2>
<p>You can close this window and return to Obsidian.</p>
</body></html>`;

const ERROR_PAGE = (message: string) => `<!DOCTYPE html>
<html><body style="font-family: sans-serif; text-align: center; padding-top: 4em;">
<h2>Sign-in failed</h2>
<p>${message}</p>
<p>Return to Obsidian and try again.</p>
</body></html>`;

export class OAuthTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for the OAuth redirect.");
    this.name = "OAuthTimeoutError";
  }
}

export class OAuthDeniedError extends Error {
  constructor(public readonly code: string) {
    super(`Authorization was denied: ${code}`);
    this.name = "OAuthDeniedError";
  }
}

export class OAuthLoopbackServer {
  private server: http.Server | null = null;

  /**
   * Start listening on an ephemeral 127.0.0.1 port.
   * Returns the redirect URI to use in the authorization request.
   */
  async start(): Promise<string> {
    if (this.server) {
      throw new Error("OAuth server is already running");
    }

    this.server = http.createServer();

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });

    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/`;
  }

  /**
   * Wait for the OAuth redirect and return the authorization code.
   * Rejects on user denial, state mismatch, or timeout. Always stops the
   * server before settling.
   */
  waitForCode(expectedState: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
    const server = this.server;
    if (!server) {
      return Promise.reject(new Error("OAuth server is not running"));
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        finish(() => reject(new OAuthTimeoutError()));
      }, timeoutMs);

      const finish = (settle: () => void) => {
        clearTimeout(timeout);
        this.stop();
        settle();
      };

      server.on("request", (req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");

        // Ignore favicon and other stray requests.
        if (url.pathname !== "/") {
          res.writeHead(404).end();
          return;
        }

        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" }).end(ERROR_PAGE(error));
          finish(() => reject(new OAuthDeniedError(error)));
          return;
        }

        if (!code || state !== expectedState) {
          res
            .writeHead(400, { "Content-Type": "text/html" })
            .end(ERROR_PAGE("Invalid response from Google (missing code or state mismatch)."));
          finish(() => reject(new Error("OAuth redirect missing code or state mismatch")));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" }).end(SUCCESS_PAGE);
        finish(() => resolve(code));
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
