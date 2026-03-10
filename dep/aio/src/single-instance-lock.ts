// Single-instance lock for aio apps
// Cross-platform: works on Linux, macOS, Windows
// Prevents multiple instances from corrupting shared resources

export class AppLock {
  private readonly LOCK_FILE = ".aio.lock";

  async acquire(port: number): Promise<boolean> {
    const maxRetries = 30; // 3 seconds total with 100ms backoff

    for (let i = 0; i < maxRetries; i++) {
      // Check lock first (faster than port check)
      const lockStatus = await this.checkLockStatus(port);
      
      switch (lockStatus) {
        case 'free':
          // Lock is free, try to acquire
          const acquired = await this.tryAcquireLock(port);
          if (acquired) return true;
          break;
          
        case 'dead':
          // Dead process, remove lock and continue
          await Deno.remove(this.LOCK_FILE).catch(() => {});
          break;
          
        case 'alive':
          // Healthy running instance
          console.error(
            `[AIO-LOCK] Another instance is running (port ${port}) — exiting`,
          );
          return false;
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    console.error(
      `[AIO-LOCK] Failed to acquire lock after ${maxRetries * 100}ms — another instance may be running`,
    );
    return false;
  }

  private async checkLockStatus(port: number): Promise<'free' | 'dead' | 'alive'> {
    try {
      const content = await Deno.readTextFile(this.LOCK_FILE);
      const lock = JSON.parse(content) as { pid: number; port: number };

      // Check if lock port matches our port
      if (lock.port !== port) {
        // Different app, treat as free
        return 'free';
      }

      // Check if process is alive
      if (this.isProcessAlive(lock.pid)) {
        // Check if port is actually in use (defense against zombie)
        try {
          await this.checkPortInUse(port);
          return 'alive'; // Process alive + port in use = healthy
        } catch {
          // Process alive but port free = zombie, remove lock
          return 'dead';
        }
      }

      return 'dead';
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        return 'free';
      }
      return 'free'; // Can't read lock, assume free
    }
  }

  private async checkPortInUse(port: number): Promise<void> {
    try {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      conn.close();
      throw new Error("Port in use");
    } catch (e) {
      if (e instanceof Error && e.message === "Port in use") {
        throw e;
      }
    }
  }

  private async tryAcquireLock(port: number): Promise<boolean> {
    const lockData = JSON.stringify({ pid: Deno.pid, port, ts: Date.now() });
    const lockFile = new TextEncoder().encode(lockData);

    try {
      const fd = await Deno.open(this.LOCK_FILE, {
        createNew: true,
        write: true,
      });
      await fd.write(lockFile);
      fd.close();
      return true;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        return false;
      }

      try {
        const content = await Deno.readTextFile(this.LOCK_FILE);
        const lock = JSON.parse(content) as { pid: number; port: number };

        if (this.isProcessAlive(lock.pid)) {
          console.error(
            `[AIO-LOCK] Another instance is running (PID ${lock.pid}, port ${lock.port}) — exiting`,
          );
          return false;
        }

        await Deno.remove(this.LOCK_FILE);
      } catch {
        try {
          await Deno.remove(this.LOCK_FILE);
        } catch {}
      }

      return false;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      Deno.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if process is healthy (alive + port listening + responsive)
   * Returns 'healthy', 'zombie', or 'dead'
   */
  private async checkProcessHealth(pid: number, port: number): Promise<'healthy' | 'zombie' | 'dead'> {
    // First check if process exists
    if (!this.isProcessAlive(pid)) {
      return 'dead';
    }

    // Check if port is listening
    try {
      await this.checkPortInUse(port);
    } catch {
      return 'zombie'; // Process alive but not listening
    }

    // Try HTTP health check (if aio provides one)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__trojan/state`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return 'healthy';
      }
    } catch {
      // Health check failed, but port is open - might be zombie
      return 'zombie';
    }

    return 'healthy';
  }

  release(): void {
    try {
      Deno.removeSync(this.LOCK_FILE);
    } catch {}
  }
}
