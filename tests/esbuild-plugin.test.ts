import { assertEquals, assertStringIncludes } from "@std/assert";
import { aioBrowserPlugin } from "../src/build/esbuild-plugin.ts";

type ResolveArgs = { path: string; kind?: string };
type ResolveResult =
  | { path: string; namespace?: string; external?: boolean }
  | undefined;
type ResolveCallback = (args: ResolveArgs) => ResolveResult;
type LoadCallback = (
  args: { path: string; namespace: string },
) => { contents: string; loader: string } | undefined;

function collectPluginCallbacks(
  plugin: { name: string; setup: (build: unknown) => void },
) {
  const resolvers: { filter: RegExp; cb: ResolveCallback }[] = [];
  const loaders: { filter: RegExp; namespace: string; cb: LoadCallback }[] = [];
  const build = {
    onResolve(opts: { filter: RegExp }, cb: ResolveCallback) {
      resolvers.push({ filter: opts.filter, cb });
    },
    onLoad(opts: { filter: RegExp; namespace: string }, cb: LoadCallback) {
      loaders.push({ filter: opts.filter, namespace: opts.namespace, cb });
    },
  };
  plugin.setup(build);
  return { resolvers, loaders };
}

Deno.test("plugin: intercepts @std/* imports", () => {
  const plugin = aioBrowserPlugin();
  const { resolvers } = collectPluginCallbacks(plugin);
  const stdResolver = resolvers.find((r) => r.filter.test("@std/fs"));
  assertEquals(stdResolver !== undefined, true);
  const result = stdResolver!.cb({ path: "@std/fs" });
  assertEquals(result?.namespace, "aio-server-only");
});

Deno.test("plugin: intercepts node:* imports", () => {
  const plugin = aioBrowserPlugin();
  const { resolvers } = collectPluginCallbacks(plugin);
  const nodeResolver = resolvers.find((r) => r.filter.test("node:fs"));
  assertEquals(nodeResolver !== undefined, true);
  const result = nodeResolver!.cb({ path: "node:fs" });
  assertEquals(result?.namespace, "aio-server-only");
});

Deno.test("plugin: does NOT intercept regular imports", () => {
  const plugin = aioBrowserPlugin();
  const { resolvers } = collectPluginCallbacks(plugin);
  for (const r of resolvers) {
    if (r.filter.test("react")) {
      const result = r.cb({ path: "react" });
      assertEquals(result, undefined);
    }
  }
});

Deno.test("plugin: server-only load returns CJS throwing proxy", () => {
  const plugin = aioBrowserPlugin();
  const { loaders } = collectPluginCallbacks(plugin);
  const loader = loaders.find((l) => l.namespace === "aio-server-only");
  assertEquals(loader !== undefined, true);
  const result = loader!.cb({ path: "@std/fs", namespace: "aio-server-only" });
  assertEquals(result?.loader, "js");
  assertStringIncludes(result!.contents, "Proxy");
  assertStringIncludes(result!.contents, "server-only");
  assertStringIncludes(result!.contents, "@std/fs");
  // AIO-55: Must use CJS (module.exports) so esbuild resolves named imports at runtime
  assertStringIncludes(result!.contents, "module.exports");
});

Deno.test("plugin: proxy module includes package name in error", () => {
  const plugin = aioBrowserPlugin();
  const { loaders } = collectPluginCallbacks(plugin);
  const loader = loaders.find((l) => l.namespace === "aio-server-only")!;
  const result = loader.cb({
    path: "@std/path",
    namespace: "aio-server-only",
  })!;
  assertStringIncludes(result.contents, "@std/path");
});

// AIO-55: *.server.ts dynamic imports are marked external
Deno.test("plugin: marks *.server.ts dynamic imports as external", () => {
  const plugin = aioBrowserPlugin();
  const { resolvers } = collectPluginCallbacks(plugin);
  const serverResolver = resolvers.find((r) =>
    r.filter.test("./helpers.server.ts")
  );
  assertEquals(serverResolver !== undefined, true);
  const result = serverResolver!.cb({
    path: "./helpers.server.ts",
    kind: "dynamic-import",
  });
  assertEquals(result?.external, true);
});

Deno.test("plugin: does NOT externalize *.server.ts static imports", () => {
  const plugin = aioBrowserPlugin();
  const { resolvers } = collectPluginCallbacks(plugin);
  const serverResolver = resolvers.find((r) =>
    r.filter.test("./helpers.server.ts")
  );
  assertEquals(serverResolver !== undefined, true);
  const result = serverResolver!.cb({
    path: "./helpers.server.ts",
    kind: "import-statement",
  });
  assertEquals(result, undefined); // falls through to default resolution
});
