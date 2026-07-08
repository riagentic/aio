// Boot step: single-instance AppLock acquisition
import { AppLock, lockDir } from "../server/single-instance-lock.ts";

export interface BootLock {
  appLock: AppLock | null;
  appId: string;
}

export interface LockOptions {
  appId: string;
  singletonMode: boolean | string;
  killExisting: boolean;
  port: number;
  log: {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
}

export async function bootLock(
  { appId, singletonMode, killExisting, port, log }: LockOptions,
): Promise<BootLock> {
  let appLock: AppLock | null = null;
  if (singletonMode !== false) {
    appLock = new AppLock(appId);
    const result = await appLock.acquire(port, killExisting);
    if (!result.ok) {
      const ex = result.existing;
      const exUrl = `http://localhost:${ex.port}`;
      console.error(
        `[AIO] ${
          killExisting ? "Failed to take over" : "Already running"
        }: ${ex.appId} at ${exUrl} (pid ${ex.pid})`,
      );
      Deno.exit(1);
    }
    log.debug(`lock: acquired ${lockDir()}/${appId}.lock (PID ${Deno.pid})`);
  }
  return { appLock, appId };
}
