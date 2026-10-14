// The module form of the blocking pool (tests/blocking.test.ts): everything an
// inline function cannot have — an import, a module constant, a helper.
// `posix`: the same answer on every OS — the test compares it.
import { join } from "@std/path/posix";

const PREFIX = "job";
const tag = (s: string) => `${PREFIX}:${s}`;

export default (arg: { a: string; b: string }) => tag(join(arg.a, arg.b));
