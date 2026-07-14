import * as path from "path";

/** Directory name for the trace store (under the workspace in `workspace` mode). */
export const STORE_DIR_NAME = ".prompt-trace";
export const DB_FILE_NAME = "db.sqlite";
export const BLOBS_DIR_NAME = "blobs";

export function storeDirName(): string {
  return STORE_DIR_NAME;
}

export function dbFilePath(storeRoot: string): string {
  return path.join(storeRoot, DB_FILE_NAME);
}

export function blobsDirPath(storeRoot: string): string {
  return path.join(storeRoot, BLOBS_DIR_NAME);
}
