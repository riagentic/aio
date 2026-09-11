# Desktop notifications (`notify`)

A method that finishes something can tell the desktop about it:

```ts
import { cell, notify } from "aio";

type S = { done: number };

export const exporter = cell("exporter", {
  state: { done: 0 } as S,
  methods: {
    run(s) {
      s.done++;
      s.$do(
        notify({
          title: "Export finished",
          body: "3 files",
          route: "/exports",
        }),
      );
    },
  },
});
```

It is an **effect**, like `schedule` and `own`: the server hands it to every
connected UI client, and each client shows it through the one Notification API
every renderer has — a browser tab, the Electron window (granted without a
prompt), a PWA. Clicking it brings the app to the front and, with `route`,
navigates there. The icon is the app's own monogram, so a notification looks
like the app that sent it.

| option   |                                                                 |
| -------- | --------------------------------------------------------------- |
| `title`  | required, non-empty — refused where it is written otherwise     |
| `body`   |                                                                 |
| `tag`    | same tag replaces the previous card — a progress counter is one |
| `silent` | no sound                                                        |
| `route`  | where the router goes when the card is clicked                  |

## Permission, in a browser

A browser grants notifications only from a user gesture. The first `notify`
asks; when the ask was refused for lack of a gesture, aio warns once and names
the fix — `requestNotificationPermission()` from `aio/air`, called in a click
handler. The answer sticks. Electron needs none of this.

```tsx
import { requestNotificationPermission } from "aio/air";

<button onClick={() => requestNotificationPermission()}>Enable alerts</button>;
```

## Where it cannot show — and says so

- **No UI client connected** (a server-only or CLI-only run): the server logs
  `notify: no UI client is connected — "…" was not shown`. Never silent.
- **An Android WebView** or a test window has no Notification API: logged once.
- A **`connectCli`** client cannot show a card; it prints the line.
- **`testCell`** records it: `t.expect.effects(["__notify"])`. It arms nothing,
  so an unread one owes the test nothing.

## See also

- [Scheduling](../state/scheduling.md) — the other effects a method emits
- [Electron](electron.md) — the desktop shell, and `ui.tray`
