// am-cmd-report.ts — the maintainer's side of problem reports.
//
// The app writes reports into its own data directory; this reads them. Kept
// deliberately thin: a report is plain JSON, so `cat` works too, and this
// exists to save someone from having to know the path.
import { appDirs } from "../server/app-dirs.ts";
import { listReports, type Report, summarize } from "../server/report.ts";
import { detectMode, out, outError } from "./am-output.ts";
import type { GlobalFlags } from "./am-types.ts";
import { resolveAmAppId } from "./am-utils.ts";
import { count } from "../diagnostics/fmt.ts";

/** `am report [list|show <id>|path] [--app=id] [--json]` */
export async function cmdReport(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const dirs = appDirs(appId);
  const positional = args.filter((a) => !a.startsWith("--"));
  const sub = positional[0] ?? "list";

  if (sub === "path") {
    out(`${dirs.data}/reports`, mode);
    return;
  }

  const reports = await listReports(dirs.data);

  if (sub === "show") {
    const id = positional[1];
    if (!id) {
      outError("am report show needs a report id (see `am report list`)", mode);
      Deno.exit(1);
    }
    // Prefix match: report ids are long and timestamped, and nobody should
    // have to paste one in full to read it.
    const found = reports.filter((r) => r.id.startsWith(id));
    if (found.length === 0) {
      outError(
        `no report starting with "${id}" for ${appId} — ` +
          `\`am report list\` shows what is there`,
        mode,
      );
      Deno.exit(1);
    }
    if (found.length > 1) {
      outError(
        `"${id}" matches ${found.length} reports — use more of the id`,
        mode,
      );
      Deno.exit(1);
    }
    // Always the whole document: this is what gets attached to an issue, and a
    // summarized bug report is a bug report that has to be re-collected.
    out(found[0] as unknown as Record<string, unknown>, mode);
    return;
  }

  if (sub !== "list") {
    outError(
      `unknown: am report ${sub} (expected list, show <id>, or path)`,
      mode,
    );
    Deno.exit(1);
  }

  if (mode === "json") {
    out(
      {
        appId,
        dir: `${dirs.data}/reports`,
        count: reports.length,
        reports: reports.map((r: Report) => ({
          id: r.id,
          kind: r.kind,
          title: r.title,
          createdAt: r.createdAt,
          version: r.app.version,
        })),
      },
      mode,
    );
    return;
  }

  if (reports.length === 0) {
    out(
      `no reports for ${appId}.\n` +
        `  Reports land in ${dirs.data}/reports when the app runs with ` +
        `feedback: true — user-filed, and automatic when it breaks.`,
      mode,
    );
    return;
  }
  out(
    [
      `${count(reports.length, "report")} for ${appId} — ${dirs.data}/reports`,
      "",
      ...reports.map((r) => `  ${r.id.slice(0, 24)}  ${summarize(r)}`),
      "",
      `  am report show <id>   the full bundle (attach this to an issue)`,
    ].join("\n"),
    mode,
  );
}
