import type { Observation, RunState } from "../shared/types.js";

export function observationsForPublication(
  run: Pick<RunState, "observations" | "publicationExclusions">
): Observation[] {
  if (!run.publicationExclusions?.length) return run.observations;
  const excluded = new Set(run.publicationExclusions.map((item) =>
    `${item.domain}\u0000${item.brand}`
  ));
  return run.observations.filter((item) =>
    !excluded.has(`${item.domain}\u0000${item.brand}`)
  );
}
