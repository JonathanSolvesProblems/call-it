import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface DecisionEntry {
  timestamp: string;
  frameHashes: string[];
  frameFiles?: string[];
  model: string;
  tool: string;
  arguments: unknown;
  guardResult: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export class DecisionLog {
  private readonly recent: DecisionEntry[] = [];

  constructor(readonly filePath = join(process.cwd(), "data", "decisions.jsonl")) {}

  async loadRecent(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf8");
      for (const line of content.split(/\r?\n/).filter(Boolean).slice(-10)) {
        try { this.recent.push(JSON.parse(line) as DecisionEntry); } catch { /* Ignore a partial final line. */ }
      }
      this.recent.splice(0, Math.max(0, this.recent.length - 10));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async append(entry: DecisionEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    this.recent.push(entry);
    this.recent.splice(0, Math.max(0, this.recent.length - 10));
  }

  latest(): DecisionEntry[] {
    return this.recent.map((entry) => structuredClone(entry));
  }
}
