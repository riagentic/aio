// The REAL module cache, for a child spawned with a throwaway HOME.
//
// Without DENO_DIR a child resolves its cache under $HOME, so every run
// re-downloaded each jsr/npm module into an empty temp dir: seconds per spawn,
// network-dependent, and under the mutation gate's load a red test that
// proved nothing ("ALREADY RED unmutated").
export const DENO_DIR: string = Deno.env.get("DENO_DIR") ??
  JSON.parse(
    new TextDecoder().decode(
      (await new Deno.Command(Deno.execPath(), {
        args: ["info", "--json"],
        stdout: "piped",
      }).output()).stdout,
    ),
  ).denoDir;
