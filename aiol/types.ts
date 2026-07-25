// aiol — aio linter types

/** Issue severity level — `'error'` blocks release, `'warn'` is advisory, `'hint'` is informational. */
export type Severity = "error" | "warn" | "hint";

/** A fix function receives the project dir and returns true if it applied a change */
export type SafeFixFn = (projectDir: string) => Promise<boolean>;

/** A single lint finding — severity, area, message, optional file location, and optional auto-fix. */
export type Issue = {
  severity: Severity;
  area: string;
  message: string;
  file?: string;
  line?: number;
  fix?: string;
  /** If set, --safe-fix can auto-fix this issue */
  safeFix?: SafeFixFn;
};

/** Lint report — issues found, checks passed, and scan statistics. */
export type Report = {
  issues: Issue[];
  passed: string[];
  stats: {
    filesScanned: number;
    cellsFound: number;
    testsFound: number;
  };
};

export type DenoJsonConfig = {
  appId?: string;
  version?: string;
  title?: string;
  nodeModulesDir?: string;
  unstable?: string[];
  imports?: Record<string, string>;
  tasks?: Record<string, string>;
  compilerOptions?: Record<string, unknown>;
  publish?: { exclude?: string[] };
  lint?: { exclude?: string[] };
  [key: string]: unknown;
};

export type SourceFile = {
  path: string; // absolute path
  relative: string; // relative to project root
  name: string; // filename only
  ext: string; // .ts, .tsx, .json, .css
  content: string;
  lines: string[];
};

export type CellInfo = {
  name: string;
  file: SourceFile;
  line: number;
  hasState: boolean;
  hasMethods: boolean;
  hasActions: boolean;
  hasGenerators: boolean;
  hasMachine: boolean;
  hasSelectors: boolean;
  /** `worker: true` — this cell's methods run on their own thread. */
  isWorker: boolean;
  stateKeys: string[];
  methodNames: string[];
  actionNames: string[];
};

export type LintContext = {
  projectDir: string;
  denoJson: DenoJsonConfig | null;
  denoJsonPath: string | null;
  sourceFiles: SourceFile[];
  tsxFiles: SourceFile[];
  tsFiles: SourceFile[];
  testFiles: SourceFile[];
  cells: CellInfo[];
  appEntry: SourceFile | null;
  appTsx: SourceFile | null;
  styleCss: SourceFile | null;
  report: (
    severity: Severity,
    area: string,
    message: string,
    opts?: { file?: string; line?: number; fix?: string; safeFix?: SafeFixFn },
  ) => void;
  pass: (message: string) => void;
};

export type Checker = (ctx: LintContext) => Promise<void> | void;
