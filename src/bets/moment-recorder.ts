export interface MomentRecord {
  clipId?: string;
  clipUrl?: string;
  markerPositionSeconds?: number;
}

export interface MomentRecorder {
  record(question: string, result: string): Promise<MomentRecord>;
}

export class FakeMomentRecorder implements MomentRecorder {
  constructor(private readonly log: (message: string) => void = console.log) {}

  async record(question: string, result: string): Promise<MomentRecord> {
    this.log(`[fake moment recorder] marker and clip: ${question} -> ${result}`);
    return {};
  }
}

export function twitchFailureStatus(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /\((\d{3})\)/.exec(message)?.[1] ?? message;
}
