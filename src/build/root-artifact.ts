// The one rule for a build artifact left in the project root.
import { isArtifactName } from "../build-all.ts";

/** A previous build's artifact left in the project ROOT (a single-target build
 *  writes there) is an OUTPUT, not a change, to the version's dirty test: the
 *  onboarding lab built one scaffold twice and got two dirty hashes for one
 *  codebase. THE rule the single-target build and `am publish`'s pre-check
 *  both hand `buildVersionFor` as `isOutput`. */
export function rootArtifactIsOutput(
  binaryName: string,
): (rel: string) => boolean {
  return (rel) => !rel.includes("/") && isArtifactName(rel, binaryName);
}
