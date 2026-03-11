import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { atomicWriteFile, atomicWriteJson } from "@/utils/atomic-write";

describe("atomicWriteFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-write-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes content to file and leaves no temp file", async () => {
    const filePath = path.join(tmpDir, "test.txt");

    await atomicWriteFile(filePath, "hello world");

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("hello world");

    // Temp file should not remain
    await expect(fs.access(filePath + ".tmp")).rejects.toThrow();
  });

  it("overwrites existing file atomically", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "original");

    await atomicWriteFile(filePath, "updated");

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("updated");
  });
});

describe("atomicWriteJson", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-write-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes valid JSON with 2-space indentation", async () => {
    const filePath = path.join(tmpDir, "data.json");
    const data = { name: "test", count: 42, nested: { flag: true } };

    await atomicWriteJson(filePath, data);

    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(data);
    expect(raw).toBe(JSON.stringify(data, null, 2));
  });

  it("handles arrays", async () => {
    const filePath = path.join(tmpDir, "arr.json");
    const data = [1, "two", { three: 3 }];

    await atomicWriteJson(filePath, data);

    const raw = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual(data);
  });
});
