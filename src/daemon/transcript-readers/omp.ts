/**
 * oh-my-pi (omp) transcript reader
 * (`~/.omp/agent/sessions/<enc-cwd>/<ts>_<uuidv7>.jsonl` — NOT `~/.oh-my-pi/`).
 * Schema shared with pi — see `pi-family.ts` for the classifier and its
 * research notes.
 */

import type { TranscriptReader } from "../transcript-read";
import { foldJsonlTurns } from "../transcript-read";
import { classifyPiFamilyLine } from "./pi-family";

export const ompTranscriptReader: TranscriptReader = {
  agentType: "omp",
  async read(session, turns) {
    if (!session.logPath) return null;
    return foldJsonlTurns(session.logPath, turns, classifyPiFamilyLine);
  },
};
