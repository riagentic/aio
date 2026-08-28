// todo — one binary, two roles. `todo serve` runs the aio server that OWNS the
// list (persisted, no UI: client "server-only"). Every other command connects
// to it over WS, dispatches a cell method, and prints — with `aio/cli` doing
// the flags, the table, the live view, and the exit codes.
//
//   todo serve [--port=8000]         # the server
//   todo add buy milk                # a command
//   todo list --watch                # a live view: redraws on every change
//   todo list --json | jq            # a script
//
// Dev: deno task dev (= serve)   Build: deno task compile (a `cli` binary)
import { aio } from "aio";
import { connectCli } from "aio/server";
import { args, EXIT, fail, style, table, watch } from "aio/cli";
import { todos } from "./cell/todos.ts";

if (Deno.args[0] === "serve") {
  // aio parses its own flags (--port, --expose, …) from Deno.args; the bare
  // `serve` word is not a flag, so it passes through.
  await aio.run({ client: "server-only" });
} else {
  const a = args({
    name: "todo",
    help: "A todo list you can script: a server owns it, commands talk to it.",
    version: "0.1.0",
    commands: {
      serve: "run the server (takes aio's flags: --port, --expose, …)",
      list: "show the list",
      add: "add a todo: todo add <text...>",
      done: "mark one done: todo done <id>",
      clear: "drop every done todo",
    },
    rest: "arg",
    flags: {
      url: {
        type: "string",
        default: "ws://localhost:8000/ws",
        help: "the server to talk to",
      },
      watch: { type: "boolean", short: "w", help: "list: redraw on change" },
      json: { type: "boolean", help: "machine-readable output" },
    },
  });

  const app = connectCli(a.flags.url, { readyTimeoutMs: 3000 });
  app.bind(todos);
  await app.ready.catch(() =>
    fail(`no server at ${a.flags.url} — start one: todo serve`, {
      json: a.json,
    })
  );

  const render = () =>
    a.json
      ? JSON.stringify(todos.items)
      : todos.items.length === 0
      ? style.dim("(nothing to do)")
      : table(
        todos.items.map((t) => ({
          id: t.id,
          done: t.done ? style.green("x") : " ",
          text: t.done ? style.dim(t.text) : t.text,
        })),
        { columns: [{ key: "id", align: "right" }, "done", "text"] },
      );

  try {
    switch (a.command) {
      case "add":
        if (!a.rest.length) fail("todo add <text...>", { code: EXIT.usage });
        await todos.add(a.rest.join(" "));
        break;
      case "done": {
        const id = Number(a.rest[0]);
        if (!Number.isInteger(id)) fail("todo done <id>", { code: EXIT.usage });
        await todos.done(id);
        break;
      }
      case "clear":
        await todos.clear();
        break;
      case "list":
        if (a.flags.watch) {
          const w = watch(app, render);
          Deno.addSignalListener("SIGINT", () => {
            w.stop();
            app.close();
            Deno.exit(EXIT.ok);
          });
          await new Promise(() => {}); // until ^C
        }
        break;
    }
    console.log(render());
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), { json: a.json });
  }
  app.close();
}
