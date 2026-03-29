// feature.ts — barrel re-export for the feature system
//
// Split into:
//   feature-types.ts    — shared types, tagSource, RESERVED_KEYS
//   feature-machine.ts  — machine validation
//   feature-catalog.ts  — catalog building, flattenOnto, bindFeature
//   feature-create.ts   — feature() + createFeatureFromMethods/Actions
//   feature-compose.ts  — composeFeatures, resolveFeatures, registry
//   feature-test.ts     — testFeature, TestContext
//
// Only re-exports symbols that were public in the original feature.ts.
// Internal helpers (buildCatalog, flattenOnto, validateMachine, RESERVED_KEYS)
// are imported directly by sibling files and NOT exposed here.

export {
  type ActionSource,
  type ActionUnion,
  type Catalog,
  type Creators,
  type DirectCalling,
  type ExtractState,
  type FeatureAio,
  type FeatureDef,
  type FeatureEntry,
  type FeatureExecuteFn,
  type FeatureReduceFn,
  type FlatActions,
  type MachineConfig,
  type Msg,
  type ScopedApp,
  type SendOf,
  tagSource,
} from "./feature-types.ts";

export { bindFeature } from "./feature-catalog.ts";

export {
  type ActionsFeatureConfig,
  type ExecuteHandlers,
  feature,
  type MethodsFeatureConfig,
  type ReduceHandlers,
} from "./feature-create.ts";

export {
  type CircuitBreakerConfig,
  type ComposedFeatures,
  composeFeatures,
  type FeatureStatus,
} from "./feature-compose.ts";

export { testBridge, type TestContext, testFeature } from "./feature-test.ts";
