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
  tagSource,
  type ActionUnion,
  type MachineConfig,
  type ActionSource,
  type ScopedApp,
  type FeatureDef,
  type DirectCalling,
  type FeatureEntry,
  type Creators,
  type Catalog,
  type Msg,
  type FeatureAio,
  type FeatureExecuteFn,
  type FlatActions,
  type FeatureReduceFn,
} from './feature-types.ts'

export { bindFeature } from './feature-catalog.ts'

export { feature, type MethodsFeatureConfig, type ActionsFeatureConfig, type ReduceHandlers, type ExecuteHandlers } from './feature-create.ts'

export {
  composeFeatures,
  type ComposedFeatures,
  type FeatureStatus,
} from './feature-compose.ts'

export {
  testFeature,
  testBridge,
  type TestContext,
} from './feature-test.ts'
