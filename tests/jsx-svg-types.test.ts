// JSX type coverage (external review): SVG elements beyond the core 13
// (linearGradient/radialGradient/stop/filter/feGaussianBlur/foreignObject/…)
// must be typed as SVG (accept SVG attrs), and referrerPolicy/fetchPriority +
// <iframe> must be accepted. Verified by running `deno check` on a fixture
// compiled with jsxImportSource=aio — a type error there fails the test.
import { assertEquals } from "@std/assert";

const FIXTURE = `
const gradient = (
  <svg viewBox="0 0 10 10">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(45)">
        <stop offset="0%" stopColor="red" />
        <stop offset="100%" stopColor="blue" />
      </linearGradient>
      <radialGradient id="r" cx="0.5"><stop offset="1" /></radialGradient>
      <filter id="f"><feGaussianBlur stdDeviation="2" /><feOffset dx="1" /></filter>
    </defs>
    <rect width="10" height="10" fill="url(#g)" />
    <foreignObject width="10" height="10"><div>x</div></foreignObject>
    <ellipse cx="5" cy="5" rx="4" ry="2" />
    <g transform="translate(1,2)" />
  </svg>
);
const link = <a href="/x" referrerPolicy="no-referrer">x</a>;
const image = <img src="/i.png" referrerPolicy="no-referrer" fetchPriority="high" />;
const frame = <iframe src="/x" sandbox="allow-scripts" referrerPolicy="no-referrer" />;
export const _ = [gradient, link, image, frame];
`;

Deno.test("jsx types: SVG elements + referrerPolicy/iframe type-check", async () => {
  const dir = await Deno.makeTempDir();
  const repo = new URL("..", import.meta.url).pathname;
  try {
    await Deno.writeTextFile(
      `${dir}/deno.jsonc`,
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "aio",
          lib: ["deno.ns", "dom"],
        },
        imports: {
          "aio/jsx-runtime": `${repo}src/jsx-runtime.ts`,
          "aio": `${repo}mod.ts`,
        },
      }),
    );
    await Deno.writeTextFile(`${dir}/fixture.tsx`, FIXTURE);
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["check", "-c", `${dir}/deno.jsonc`, `${dir}/fixture.tsx`],
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(
      code,
      0,
      `deno check failed:\n${new TextDecoder().decode(stderr)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
