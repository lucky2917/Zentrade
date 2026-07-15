import { z } from "zod";
import { defineEvent } from "../envelope/envelope.js";

/**
 * mem.episode.formed v1 — an episodic memory was indexed over a labeled
 * outcome (M14). Memory is an index over experience: the payload carries
 * the stable memory key and journal references, never journal content.
 */
export const MemEpisodeFormedPayloadV1 = z.strictObject({
    memoryId: z.uuid(),
    memoryKey: z.string().regex(/^[0-9a-f]{64}$/),
    semantics: z.string().min(1).max(32),
    decisionId: z.uuid(),
    outcomeId: z.uuid(),
    horizon: z.string().min(1).max(16),
    regime: z.string().min(1).max(48),
    hit: z.enum(["target", "stop", "neither"]),
});
export type MemEpisodeFormedPayloadV1 = z.infer<typeof MemEpisodeFormedPayloadV1>;

export const MemEpisodeFormedV1 = defineEvent("mem.episode.formed", 1, MemEpisodeFormedPayloadV1);
export const MEM_EPISODE_FORMED = { type: "mem.episode.formed", v: 1 } as const;
