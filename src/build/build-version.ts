/**
 * build-version.ts — the build's view of THE app version.
 *
 * The implementation lives in `src/server/app-version.ts` because the RUNTIME
 * reads the same rule (a compiled binary reports the version the build
 * stamped; a source run derives it the same way), and `server` may not import
 * `build`. This module is the build-side name for that one decider — nothing
 * here decides anything twice.
 */
export {
  artifactBaseName,
  artifactVersion,
  BUILD_STAMP_FILE,
  BUILD_VERSION_ENV,
  type BuildStamp,
  type BuildVersion,
  buildVersionFor,
  buildVersionNotes,
  contentHash8,
  type DeclaredVersion,
  DEFAULT_BASE,
  installArtifactName,
  outDirExclude,
  parseDeclaredVersion,
  readBuildStamp,
  readTreeFacts,
  resolveBuildVersion,
  resolveRuntimeVersion,
  stripVersionToken,
  type TreeFacts,
  unpublishableReason,
  VERSION_TOKEN_RE,
  versionedArtifactName,
  type VersionSource,
  writeBuildStamp,
} from "../server/app-version.ts";
