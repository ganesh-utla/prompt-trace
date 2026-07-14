import * as vscode from "vscode";

export { isExcluded, matchGlob } from "./util/glob";

export interface TraceSettings {
  excludePatterns: string[];
  storageLocation: "workspace" | "global";
  retentionEnabled: boolean;
  retentionKeepLastPrompts: number;
  retentionKeepLastDays: number;
  maxFileSizeKB: number;
  autoInstallHooks: boolean;
}

/** Read settings from the VS Code workspace configuration (extension host only). */
export function readSettings(): TraceSettings {
  const c = vscode.workspace.getConfiguration("prompttrace");
  return {
    excludePatterns: c.get<string[]>("excludePatterns", []),
    storageLocation: c.get<string>("storageLocation", "global") === "workspace"
      ? "workspace"
      : "global",
    retentionEnabled: c.get<boolean>("retention.enabled", false),
    retentionKeepLastPrompts: c.get<number>("retention.keepLastPrompts", 1000),
    retentionKeepLastDays: c.get<number>("retention.keepLastDays", 90),
    maxFileSizeKB: c.get<number>("maxFileSizeKB", 1024),
    autoInstallHooks: c.get<boolean>("autoInstallHooks", true),
  };
}
