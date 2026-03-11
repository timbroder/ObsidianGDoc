import { writeFile, rename, unlink } from "fs/promises";

/**
 * Atomically write data to a file by writing to a temp file first,
 * then renaming. This prevents partial writes from corrupting the target file.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
): Promise<void> {
  const tmpPath = filePath + ".tmp";
  try {
    await writeFile(tmpPath, data, "utf-8");
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // temp file may not exist if writeFile itself failed; ignore cleanup error
    }
    throw err;
  }
}

/**
 * Atomically write a JSON-serializable value to a file.
 */
export async function atomicWriteJson(
  filePath: string,
  data: any,
): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, json);
}
