// A second esbuild instance in the test's process: this worker's isolate loads
// its own copy of the package and starts its own service — a child of the same
// OS process that the main isolate's `stop()` never touches.
// tests/esbuild-stop-in-flight.test.ts
const esbuild = await import("npm:esbuild@0.25.12");
await esbuild.transform("let a = 1", {});
self.onmessage = async () => {
  await esbuild.stop();
  self.postMessage("stopped");
};
self.postMessage("up");
