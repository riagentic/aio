// deno-lint-ignore-file
/**
 * @module
 * AIR entry point — `aio/air`.
 *
 * Single import for all AIR component needs: signals, hooks, routing,
 * forms, animation, virtual scrolling, devtools, and server framework symbols.
 *
 * @example
 * ```ts
 * import { useFeature, signal, effect, onMount, h } from "aio/air";
 * ```
 */

// ── Full AIR runtime (hooks, routing, signals, rendering, protocol) ──
export * from "./browser-air.ts";

// ── VDOM extras not in browser-air ───────────────────────────────────
export {
  ErrorBoundary,
  Fragment,
  lazy,
  Portal,
  renderToString,
  Suspense,
} from "./vdom.ts";
export type { Ref } from "./vdom.ts";

// ── AIR component utilities ──────────────────────────────────────────
export { useFieldArray, useForm } from "./form.ts";
export type {
  FieldArrayState,
  FieldState,
  FormState,
  ValidationRule,
} from "./form.ts";
export { useSpring, useTransition } from "./animation.ts";
export type {
  SpringConfig,
  SpringValue,
  TransitionConfig,
  TransitionState,
} from "./animation.ts";
export { useVirtualList } from "./virtual-list.ts";
export type { VirtualListConfig, VirtualListState } from "./virtual-list.ts";
export { connectAioDevTools } from "./devtools.ts";
export type {
  ComponentTreeNode,
  DevToolsHandle,
  RenderEvent,
} from "./devtools.ts";

// ── React migration compat hooks ─────────────────────────────────────
export { useCallback, useEffect, useMemo, useState } from "./compat.ts";

// ── Server/framework symbols NOT already in browser-air.ts ───────────
export {
  bindFeature,
  call,
  composeFeatures,
  composeMiddleware,
  connectCli,
  connectCliUDS,
  createDB,
  createSelector,
  createSliceSelector,
  deepFreeze,
  DEFAULT_PRAGMAS,
  draft,
  instances,
  integer,
  lint,
  markAsync,
  matchEffect,
  parseCli,
  pk,
  real,
  ref,
  resolveAppId,
  table,
  testFeature,
  text,
  VERSION,
} from "../mod.ts";

// ── Server/framework types (none conflict with browser-air) ──────────
export type {
  ActionsFeatureConfig,
  ActionSource,
  ActionUnion,
  AioApp,
  AioConfig,
  AioError,
  AioErrorCode,
  AioErrorContext,
  AioErrorSource,
  AioMeta,
  AioUser,
  AsyncMethod,
  CallOptions,
  Catalog,
  CheckpointData,
  CircuitBreakerConfig,
  CliApp,
  CliFlags,
  ColumnDef,
  ColumnOpts,
  ComposedFeatures,
  Creators,
  DB,
  DBOpts,
  DiagEvent,
  DiagEventDetail,
  DiagnosticsConfig,
  DiagnosticsOptions,
  DirectCalling,
  ExecuteHandlers,
  ExtractState,
  FactoryCreators,
  FactoryResult,
  FeatureAio,
  FeatureDef,
  FeatureEntry,
  FeatureExecuteFn,
  FeatureMethods,
  FeatureReduceFn,
  FeaturesConfig,
  FeatureStateSize,
  FeatureStatus,
  FlatActions,
  FlowDef,
  FlowStep,
  FlowStepRecord,
  Gen,
  GenCtx,
  InstanceInfo,
  LayerThreshold,
  Lint,
  LockData,
  Log,
  LogConfig,
  LogLevel,
  LowerFirst,
  MachineConfig,
  MemoryConfig,
  MemoryReport,
  Method,
  MethodsFeatureConfig,
  MiddlewareFn,
  Msg,
  PerfBudget,
  PerfCheck,
  Prefixed,
  QueryOpts,
  QueryResult,
  ReduceBreakdown,
  ReduceHandlers,
  RenderBudget,
  ScheduleDef,
  ScheduleEffect,
  ScopedApp,
  Selector,
  SendOf,
  SingletonMode,
  SyncMethod,
  TableDef,
  TestContext,
  Tx,
  TypedCreator,
  UiConfig,
  VitalAlert,
  VitalHint,
  VitalLayer,
  VitalsConfig,
  VitalStatus,
  VitalThresholds,
  WhereClause,
  WhereOp,
} from "../mod.ts";
