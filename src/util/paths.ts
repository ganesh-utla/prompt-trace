import * as path from "path";

/** Workspace-relative path of the trace store (phase 1: in-workspace). */
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
