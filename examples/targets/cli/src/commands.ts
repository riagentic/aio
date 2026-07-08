export function parseCommand(
  args: string[],
): { type: string; payload?: unknown } | null {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "inc":
      return {
        type: "counter:increment",
        payload: { args: [Number(rest[0]) || 1] },
      };
    case "dec":
      return {
        type: "counter:decrement",
        payload: { args: [Number(rest[0]) || 1] },
      };
    case "reset":
      return { type: "counter:reset", payload: { args: [] } };
    default:
      return null;
  }
}

export function printHelp(): void {
  console.log("Commands: inc [n], dec [n], reset");
}
