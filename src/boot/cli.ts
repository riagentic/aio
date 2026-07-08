// Boot step: CLI parsing, --help, --version
import { VERSION } from "../server/aio-cli.ts";

export interface BootCli {
  help: boolean;
  version: boolean;
  port?: number;
  verbose?: boolean;
  prod?: boolean;
  killExisting?: boolean;
  client?: string;
  serverUrl?: string;
  title?: string;
  expose?: boolean;
  persist?: boolean;
}

export interface ParsedCli {
  _: string[];
  help?: boolean;
  version?: boolean;
  port?: number;
  verbose?: boolean;
  prod?: boolean;
  killExisting?: boolean;
  client?: string;
  serverUrl?: string;
  title?: string;
  expose?: boolean;
  persist?: boolean;
}

function parseArgs(args: string[]): ParsedCli {
  const result: ParsedCli = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--version" || arg === "-v") {
      result.version = true;
    } else if (arg === "--verbose" || arg === "-V") {
      result.verbose = true;
    } else if (arg === "--prod") {
      result.prod = true;
    } else if (arg === "--kill-existing" || arg === "-k") {
      result.killExisting = true;
    } else if (arg === "--persist" || arg === "--no-persist") {
      result.persist = arg === "--persist";
    } else if (arg.startsWith("--port=")) {
      result.port = parseInt(arg.slice(7), 10);
    } else if (arg === "--port" && i + 1 < args.length) {
      result.port = parseInt(args[++i]!, 10);
    } else if (arg.startsWith("--client=")) {
      result.client = arg.slice(9);
    } else if (arg === "--client" && i + 1 < args.length) {
      result.client = args[++i];
    } else if (arg.startsWith("--server-url=")) {
      result.serverUrl = arg.slice(13);
    } else if (arg === "--server-url" && i + 1 < args.length) {
      result.serverUrl = args[++i];
    } else if (arg.startsWith("--title=")) {
      result.title = arg.slice(8);
    } else if (arg === "--title" && i + 1 < args.length) {
      result.title = args[++i];
    } else if (arg === "--expose") {
      result.expose = true;
    } else if (arg.startsWith("-")) {
      result._.push(arg);
    } else {
      result._.push(arg);
    }
  }
  return result;
}

export function parseCli(args: string[] = Deno.args): ParsedCli {
  return parseArgs(args);
}

export function printHelp() {
  console.log(`aio ${VERSION}
Run an aio app.

Usage: deno run -A src/app.ts [options]

Options:
  --help, -h          Show this help
  --version, -v       Show version
  --port=<n>          Set port (default: auto)
  --client=<target>   electron|browser|cli|server-only (default: electron)
  --server-url=<url>  Connect to remote server (thin client mode)
  --title=<name>      Window title
  --expose            Expose on LAN (enables auth)
  --prod              Force prod mode
  --verbose, -V       Verbose output
  --kill-existing, -k  Kill existing instance
  --persist           Enable persistence (default)
  --no-persist        Disable persistence
`);
}

export function handleCliExit(cli: ParsedCli): void {
  if (cli.help) {
    printHelp();
    Deno.exit(0);
  }
  if (cli.version) {
    console.log(`aio ${VERSION}`);
    Deno.exit(0);
  }
}
