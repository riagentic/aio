# amui
## am ui - The aio UI manager (amui)

## General

- amui is aio electron application for managing and monitoring aio applications
- app has modern layout, is aesthetically styled with good positioning
- app is reactive
- app is fully working, production state ready, tested with passing tests
- "production state ready" includes BUILDING: `deno run -A ../src/build.ts` and
  the `compile` task must both succeed. amui had not been buildable for some
  time while this line said otherwise — its `manager.ts` reached aio's server
  internals with a bare `await import("../../src/am/…")`, esbuild bundled that
  dynamic import of a local module, and every build ended
  `✗ discarded dist/app.js`. Every hop out of amui into server-only code goes
  through a `*.server.ts` file NAME (the only convention the bundler enforces —
  a `server/` folder is not one), and `amui/src/amui.test.ts` runs the real
  bundler so a regression is a red gate, not a discovery.

## Functionality

- it has button to discover all aio application on the computer
- it has vertical tabs so user can easily switch between details of each aio
  application
- it will have button to create new aio app
- only the currently selected aio app details are visible

## Aio app page = page for specific aio application

- shows status of the app (running|stopped)
- allows to run or stop the app
- shows how much CPU is the app utilizing
- shows how much memroy is the app utilizing
- shows all cells (just list of cells, not their content)
- provides all trojan api to diagnose and get details from the app (like buttons
  to run methods of each cells:, etc.)
- a control-plane read that FAILS is reported. amui degrades every panel to null
  on failure, so a wedged app once read as a healthy one — status ok, uptime and
  connection counts frozen at their last good value, a timestamp still advancing
  every second, and no banner. A panel is a claim about a live process; a claim
  that could not be re-checked says so, and the "as of" timestamp only advances
  on an answer.
- a MUTATION is confirmed. Dispatching a cell method into a live app is at least
  as consequential as stopping it, so it asks first and names the exact call —
  including "with NO arguments" when that is what is about to happen.
- amui never lists or reads `.ssh` / `.aws` / `.gnupg`, and never treats $HOME as
  the enclosing repository: the file viewer copies a file's text into cell state
  and from there into the DOM and every connected client.
