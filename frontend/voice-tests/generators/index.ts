import type { CommandLaneScenario } from "../schema";
import { generateSetupScenario } from "./setup-generator";
import { generateScoresScenario } from "./scores-generator";

export function generateScenario(seed: number, index: number): CommandLaneScenario {
  // Split space: even -> setup, odd -> scores (simple, deterministic)
  if (index % 2 === 0) return generateSetupScenario(seed, index);
  return generateScoresScenario(seed, index);
}
