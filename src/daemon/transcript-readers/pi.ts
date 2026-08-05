/**
 * pi transcript reader (`~/.pi/agent/sessions/--<enc-cwd>--/<ts>_<uuidv7>.jsonl`).
 * Schema shared with omp — see `pi-family.ts` for the classifier and its
 * research notes.
 */

import type { TranscriptReader } from "../transcript-read";
import { foldJsonlTurns } from "../transcript-read";
import { classifyPiFamilyLine } from "./pi-family";

export const piTranscriptReader: TranscriptReader = {
  agentType: "pi",
  async read(session, turns) {
    if (!session.logPath) return null;
    return foldJsonlTurns(session.logPath, turns, classifyPiFamilyLine);
  },
};
