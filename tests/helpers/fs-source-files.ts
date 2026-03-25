import { promises as fs } from "node:fs";
import path from "node:path";

import type { SourceFile } from "../../lib/types";

type WalkEntry = {
  absolutePath: string;
  relativePath: string;
  size: number;
};

async function walkDirectory(rootPath: string, currentPath: string, out: WalkEntry[]): Promise<void> {
  const dirEntries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of dirEntries) {
    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      await walkDirectory(rootPath, absolutePath, out);
      continue;
    }

    if (!entry.isFile()) continue;

    const stats = await fs.stat(absolutePath);
    out.push({
      absolutePath,
      relativePath,
      size: stats.size
    });
  }
}

export async function createSourceFilesFromDirectory(rootPath: string): Promise<SourceFile[]> {
  const absoluteRoot = path.resolve(rootPath);
  const stats = await fs.stat(absoluteRoot);
  if (!stats.isDirectory()) {
    throw new Error(`Fixture path is not a directory: ${absoluteRoot}`);
  }

  const entries: WalkEntry[] = [];
  await walkDirectory(absoluteRoot, absoluteRoot, entries);

  return entries.map((entry) => {
    let bytesPromise: Promise<Uint8Array> | null = null;
    let textPromise: Promise<string> | null = null;

    const loadBytes = async () => {
      if (!bytesPromise) {
        bytesPromise = fs.readFile(entry.absolutePath).then((buffer) => new Uint8Array(buffer));
      }
      return await bytesPromise;
    };

    return {
      name: path.basename(entry.absolutePath),
      path: entry.relativePath,
      size: entry.size,
      readBytes: loadBytes,
      readText: async () => {
        if (!textPromise) {
          textPromise = loadBytes().then((bytes) => new TextDecoder("utf-8", { fatal: false }).decode(bytes));
        }
        return await textPromise;
      }
    } satisfies SourceFile;
  });
}
