// Boot step: app identity — appId, port, title resolution
import { resolveAppId } from "../server/single-instance-lock.ts";
import { join } from "@std/path";

export interface BootIdentity {
  appId: string;
  port: number;
  title: string;
  baseDir: string;
}

export interface IdentityOptions {
  appId: string;
  configPort?: number;
  cliPort?: number;
  cliTitle?: string;
  uiTitle?: string;
  baseDir?: string;
  log: {
    debug: (msg: string) => void;
  };
}

async function findFreePort(): Promise<number> {
  const listener = await Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

export async function bootIdentity(
  {
    appId,
    configPort,
    cliPort,
    cliTitle,
    uiTitle,
    baseDir,
    log,
  }: IdentityOptions,
): Promise<BootIdentity> {
  const resolvedAppId = resolveAppId(appId);
  log.debug(`app-id: ${resolvedAppId}`);

  const port = cliPort ?? configPort ?? await findFreePort();

  let denoJsonTitle: string | undefined;
  try {
    denoJsonTitle = JSON.parse(
      await Deno.readTextFile(join(Deno.cwd(), "deno.json")),
    ).title;
  } catch { /* no deno.json or no title field */ }

  const title = cliTitle ?? uiTitle ?? denoJsonTitle ?? "AIO App";
  const resolvedBaseDir = baseDir
    ? join(Deno.cwd(), baseDir)
    : join(Deno.cwd(), "src");

  return {
    appId: resolvedAppId,
    port,
    title,
    baseDir: resolvedBaseDir,
  };
}
