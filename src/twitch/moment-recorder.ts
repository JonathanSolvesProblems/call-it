import type { MomentRecord, MomentRecorder } from "../bets/moment-recorder.js";
import { HelixClient } from "./helix.js";
import { twitchFailureStatus } from "../bets/moment-recorder.js";

export class TwitchMomentRecorder implements MomentRecorder {
  constructor(
    private readonly helix: HelixClient,
    private readonly broadcasterId: string,
    private readonly sendClipMessage: (message: string) => Promise<void>,
    private readonly isLive: () => boolean,
    private readonly log: (message: string) => void = console.log,
  ) {}

  async record(question: string, result: string): Promise<MomentRecord> {
    if (!this.isLive()) return {};
    const description = `Call It: ${question} -> ${result}`.slice(0, 140);
    const record: MomentRecord = {};
    const [marker, clip] = await Promise.allSettled([
      this.helix.createStreamMarker(this.broadcasterId, description),
      this.helix.createClip(this.broadcasterId),
    ]);
    if (marker.status === "fulfilled" && marker.value) record.markerPositionSeconds = marker.value.position_seconds;
    else if (marker.status === "rejected") this.log(`Call It stream marker failed (${twitchFailureStatus(marker.reason)}).`);
    else this.log("Call It stream marker failed (empty response).");
    if (clip.status === "fulfilled" && clip.value) {
      record.clipId = clip.value.id;
      record.clipUrl = `https://clips.twitch.tv/${clip.value.id}`;
      try { await this.sendClipMessage(`Clip: ${record.clipUrl}`); }
      catch (error) { this.log(`Call It clip chat message failed (${twitchFailureStatus(error)}).`); }
    } else if (clip.status === "rejected") this.log(`Call It clip creation failed (${twitchFailureStatus(clip.reason)}).`);
    else this.log("Call It clip creation failed (empty response).");
    return record;
  }
}
