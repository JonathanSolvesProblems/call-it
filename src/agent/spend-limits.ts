export function positiveLimit(value: string | undefined, fallback: number | undefined, name: string, integer = true): number | undefined {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}.`);
  }
  return parsed;
}

export function scheduleForceLiveLimit(forceLive: boolean, maxMinutes: number, onLimit: () => void): () => void {
  if (!forceLive) return () => {};
  const timer = setTimeout(onLimit, maxMinutes * 60_000);
  return () => clearTimeout(timer);
}

export class ModelCallReporter {
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  private lastReportedCall = 0;

  constructor(private readonly log: (message: string) => void, private readonly reportEvery = 50) {}

  callStarted(): void { this.calls += 1; }

  recordUsage(usage: { inputTokens: number; outputTokens: number }): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    if (this.calls > 0 && this.calls % this.reportEvery === 0 && this.lastReportedCall !== this.calls) {
      this.lastReportedCall = this.calls;
      this.log(`Model usage: ${this.calls} calls, ${this.inputTokens} input tokens, ${this.outputTokens} output tokens.`);
    }
  }
}
