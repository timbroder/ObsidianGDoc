import { sha256, sha256Buffer } from "@/utils/hash";

describe("sha256", () => {
  it("hashes empty string to known SHA-256 value", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("hashes a simple string correctly", () => {
    // SHA-256 of "hello" is well-known
    expect(sha256("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  it("hashes unicode content correctly", () => {
    const hash = sha256("\u{1F600} emoji and \u00FC\u00F1\u00EE\u00E7\u00F6de");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // Must be deterministic
    expect(sha256("\u{1F600} emoji and \u00FC\u00F1\u00EE\u00E7\u00F6de")).toBe(hash);
  });

  it("is deterministic - same content produces same hash", () => {
    const content = "deterministic test content";
    expect(sha256(content)).toBe(sha256(content));
  });

  it("produces different hashes for different content", () => {
    expect(sha256("content A")).not.toBe(sha256("content B"));
  });
});

describe("sha256Buffer", () => {
  it("hashes empty buffer to known SHA-256 value", () => {
    expect(sha256Buffer(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("produces the same hash as sha256 for equivalent string content", () => {
    const content = "hello world";
    expect(sha256Buffer(Buffer.from(content, "utf-8"))).toBe(sha256(content));
  });
});
