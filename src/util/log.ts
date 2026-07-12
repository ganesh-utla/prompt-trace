/**
 * Host-agnostic logger. Writes to stderr by default (works in the capture CLI).
 * The extension can attach an output channel via `setOutputChannel` so logs
 * also surface in the "PromptTrace" output panel.
 */

type Sink = (line: string) => void;

let sink: Sink | null = null;

/** Called once by the extension host to route logs to an output channel. */
export function setOutputChannel(write: Sink): void {
  sink = write;
}

function ts(): string {
  return new Date().toISOString();
}

function write(level: string, msg: string): void {
  const line = `[${ts()}] [${level}] ${msg}`;
  if (sink) {
    sink(line);
  }
  // Always also go to stderr so CLI logs are visible and never pollute stdout.
  process.stderr.write(line + "\n");
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};
