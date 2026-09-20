// Wine rig — the libuv CLIENT, run as `wine node.exe client.js <pipe> <httpPipe>`.
//
// This is Electron main's exact code path (`net.connect(pipe)` and
// `http.request({ socketPath })` are what electron-uds.ts calls), so a pass
// here is "Electron would reach the app", minus the window. Prints one line
// `RESULT {"tests":[{name, ok, ms, error?}]}`; never throws past a test.
"use strict";
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");

// Under Wine a PIPED stdout cannot be wrapped by libuv (`open EBADF` from
// `process.stdout`), so the result goes to RESULT_FILE (a Windows path) and
// console is never touched. The runner reads the file.
const emit = (obj) => {
  const line = `RESULT ${JSON.stringify(obj)}`;
  if (process.env.RESULT_FILE) {
    fs.writeFileSync(process.env.RESULT_FILE, line + "\n");
  } else fs.writeSync(1, line + "\n");
};

const [pipe, httpPipe, cpus] = process.argv.slice(2);
// Deno's blocking pool on Windows is 4 × cores. The pool-exhaustion cases
// need MORE pending operations than that, so they size themselves from the
// host's own core count (the READY line carries it) — a fixed 40 passes
// happily on a 32-core machine and proves nothing.
const POOL = 4 * (Number(cpus) || 8);
const OVER = POOL + 16;
const tests = [];
const winErr = (e) =>
  e &&
  `${e.code ?? ""}${e.errno != null ? ` errno=${e.errno}` : ""} ${
    e.message ?? e
  }`.trim();

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    tests.push({ name, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    tests.push({ name, ok: false, ms: Date.now() - t0, error: winErr(e) });
  }
}

const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`timeout ${ms}ms: ${what}`)), ms)
    ),
  ]);

/** Send `lines` NDJSON over one pipe connection, resolve with the echoed lines. */
function ndjsonRoundTrip(path, lines) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path);
    const got = [];
    let buf = "";
    sock.on("error", reject);
    sock.on("connect", () => {
      for (const l of lines) sock.write(l + "\n");
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        got.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (got.length === lines.length) {
          sock.end();
          resolve(got);
        }
      }
    });
    sock.on("close", () => {
      if (got.length < lines.length) {
        reject(
          new Error(`pipe closed after ${got.length}/${lines.length} echoes`),
        );
      }
    });
  });
}

function makeLines(n, tag) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(
      JSON.stringify({
        i,
        tag,
        pad: i === n >> 1 ? "x".repeat(1024 * 1024) : "",
      }),
    );
  }
  return lines;
}

function assertEchoes(lines, got) {
  if (got.length !== lines.length) {
    throw new Error(`got ${got.length}/${lines.length}`);
  }
  for (let i = 0; i < lines.length; i++) {
    if (got[i] !== `{"echo":${lines[i]}}`) {
      throw new Error(
        `line ${i} out of order or corrupted (${got[i].slice(0, 60)}…)`,
      );
    }
  }
}

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: httpPipe, ...opts }, (res) => {
      const chunks = [];
      const h = crypto.createHash("sha256");
      let len = 0;
      res.on("data", (c) => {
        len += c.length;
        h.update(c);
        if (opts.keepBody) chunks.push(c);
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          length: len,
          sha256: h.digest("hex"),
          body: opts.keepBody ? Buffer.concat(chunks) : null,
        }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  await test("node ndjson 1000 lines incl. 1 MB (net.connect)", async () => {
    const lines = makeLines(1000, "node");
    assertEchoes(
      lines,
      await withTimeout(ndjsonRoundTrip(pipe, lines), 60_000, "echo"),
    );
  });

  await test("node http GET /big 20 MB streamed (http.request socketPath)", async () => {
    const meta = await withTimeout(
      request({ path: "/big.sha256", method: "GET", keepBody: true }),
      15_000,
      "/big.sha256",
    );
    if (meta.status !== 200) throw new Error(`/big.sha256 → ${meta.status}`);
    const { length, sha256 } = JSON.parse(meta.body.toString("utf8"));
    const r = await withTimeout(
      request({ path: "/big", method: "GET" }),
      120_000,
      "/big",
    );
    if (r.status !== 200) throw new Error(`/big → ${r.status}`);
    if (r.headers["x-content-type-options"] !== "nosniff") {
      throw new Error(`nosniff header missing: ${JSON.stringify(r.headers)}`);
    }
    if (r.headers["x-aio-rig"] !== "big") throw new Error("custom header lost");
    if (r.length !== length) throw new Error(`length ${r.length} != ${length}`);
    if (r.sha256 !== sha256) throw new Error(`sha256 mismatch`);
  });

  await test("node http POST 5 MB echo", async () => {
    const body = crypto.randomBytes(5 * 1024 * 1024);
    const want = crypto.createHash("sha256").update(body).digest("hex");
    const r = await withTimeout(
      request({
        path: "/echo",
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": body.length,
        },
      }, body),
      120_000,
      "/echo",
    );
    if (r.status !== 200) throw new Error(`/echo → ${r.status}`);
    if (r.length !== body.length) {
      throw new Error(`echoed ${r.length}/${body.length} bytes`);
    }
    if (r.sha256 !== want) throw new Error("echoed body differs");
  });

  await test("node 8 concurrent clients (no ERROR_PIPE_BUSY)", async () => {
    const all = Array.from({ length: 8 }, (_, k) => {
      const lines = makeLines(50, `c${k}`).map((l) =>
        l.replace(/"pad":"x+"/, '"pad":""')
      );
      return ndjsonRoundTrip(pipe, lines).then((got) =>
        assertEchoes(lines, got)
      );
    });
    await withTimeout(Promise.all(all), 60_000, "8 clients");
  });

  // ── The pool-exhaustion deadlock (field report §13) ────────────────────
  //
  // The host used to park ONE blocking-pool thread per pending pipe
  // operation (`WaitForSingleObject`, nonblocking FFI), and every open
  // connection always has a pending read. Deno's pool is capped (4×cores on
  // Windows), so past the cap every further FFI call AND every async fs op
  // queued behind threads that could only be freed by work that was itself
  // queued: a permanent freeze, not slowness. Measured on Windows 11: 40 idle
  // clients hung, server threads 11 → 39.
  await test(`node ${OVER} concurrent clients (more than the blocking pool has threads)`, async () => {
    const all = Array.from({ length: OVER }, (_, k) => {
      const lines = makeLines(20, `p${k}`).map((l) =>
        l.replace(/"pad":"x+"/, '"pad":""')
      );
      return ndjsonRoundTrip(pipe, lines).then((got) =>
        assertEchoes(lines, got)
      );
    });
    await withTimeout(Promise.all(all), 120_000, `${OVER} concurrent clients`);
  });

  // The report's own repro, verbatim: "8 idle clients then one ping → echo in
  // 3 ms; 40 idle clients → hangs forever (not even the 40 connects
  // complete)". An IDLE connection is the pure form of the defect — it does
  // nothing at all, and used to cost one blocking-pool thread for as long as
  // it stayed open, because a connection ALWAYS has a pending read.
  await test(`node ${OVER} IDLE clients do not cost the app its blocking pool`, async () => {
    const idle = [];
    await withTimeout(
      Promise.all(
        Array.from({ length: OVER }, () =>
          new Promise((resolve, reject) => {
            const s = net.connect(pipe);
            s.on("error", reject);
            s.on("connect", () => {
              idle.push(s);
              resolve(null);
            });
          })),
      ),
      60_000,
      `${OVER} idle connects`,
    );
    try {
      const lines = makeLines(5, "after-idle").map((l) =>
        l.replace(/"pad":"x+"/, '"pad":""')
      );
      assertEchoes(
        lines,
        await withTimeout(
          ndjsonRoundTrip(pipe, lines),
          30_000,
          `echo while ${OVER} clients sit idle`,
        ),
      );
      const r = await withTimeout(
        request({ path: "/big.sha256", method: "GET", keepBody: true }),
        30_000,
        `/big.sha256 while ${OVER} clients sit idle`,
      );
      if (r.status !== 200) throw new Error(`/big.sha256 → ${r.status}`);
    } finally {
      for (const s of idle) s.destroy();
    }
  });

  // The trigger in the real app was UNREAD BODIES, not only count: 58 `<img>`
  // tags got a 404 with a chunked body, Chromium fired `error` at the headers
  // and never read the rest, and the server's drain (`FlushFileBuffers`)
  // parked a pool thread for each one — for the life of the app. So: 40
  // responses nobody reads, and then the question that matters — does the app
  // still answer at all?
  await test(`node ${OVER} never-read response bodies leave the app answering`, async () => {
    const stalled = [];
    await withTimeout(
      Promise.all(
        Array.from({ length: OVER }, () =>
          new Promise((resolve, reject) => {
            // `/big` because the body must be bigger than what the client
            // buffers before it stops reading: a tiny body is already in the
            // peer's socket buffer by the time anyone "stops", and nothing
            // ever stalls. The report's matrix used 200 KB.
            const req = http.request(
              { socketPath: httpPipe, path: "/big", method: "GET" },
              (res) => {
                // Exactly what `<img>` does with a body it has no use for:
                // take the headers, read nothing, hold the socket open.
                res.pause();
                stalled.push(res);
                resolve(res.statusCode);
              },
            );
            req.on("error", reject);
            req.end();
          })),
      ),
      120_000,
      `${OVER} unread bodies`,
    );
    // …and the app is still there. This is the assertion the frozen Windows
    // app failed: a fresh connection was accepted by the kernel and never
    // answered again.
    const lines = makeLines(5, "after-unread").map((l) =>
      l.replace(/"pad":"x+"/, '"pad":""')
    );
    assertEchoes(
      lines,
      await withTimeout(
        ndjsonRoundTrip(pipe, lines),
        30_000,
        `echo after ${OVER} unread bodies`,
      ),
    );
    const r = await withTimeout(
      request({ path: "/big.sha256", method: "GET", keepBody: true }),
      30_000,
      `/big.sha256 after ${OVER} unread bodies`,
    );
    if (r.status !== 200) throw new Error(`/big.sha256 → ${r.status}`);
    for (const res of stalled) res.destroy();
  });

  await test("node negative control: unhosted pipe fails fast (ENOENT/EBADF)", async () => {
    const t0 = Date.now();
    const err = await withTimeout(
      new Promise((resolve) => {
        const s = net.connect(
          `\\\\.\\pipe\\aio-nobody-${crypto.randomBytes(4).toString("hex")}`,
        );
        s.on("error", resolve);
        s.on("connect", () => resolve(null));
      }),
      5_000,
      "connect to unhosted pipe",
    );
    if (!err) throw new Error("connected to a pipe nobody hosts");
    if (Date.now() - t0 > 3_000) {
      throw new Error(`took ${Date.now() - t0}ms (${winErr(err)})`);
    }
    // Windows maps ERROR_FILE_NOT_FOUND to ENOENT; Wine 11 surfaces EBADF for
    // the same unhosted name (measured). Both are "failed fast, never
    // connected", which is the claim — the code is recorded, not asserted.
    if (!["ENOENT", "EBADF"].includes(err.code)) {
      throw new Error(`expected ENOENT/EBADF, got ${winErr(err)}`);
    }
  });

  emit({ tests });
  process.exit(0);
})().catch((e) => {
  emit({ tests, fatal: winErr(e) + "\n" + (e && e.stack) });
  process.exit(0);
});
