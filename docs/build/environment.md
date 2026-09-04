# Environment variables

Every `AIO_*` variable the framework reads, in one table — because a variable
that works and is documented nowhere is a feature only its author can use. A
field report found `AIO_BUILD_VERSION` by reading aio's build source.

`deno task check:env` fails when `src/` reads a variable this page does not
name, so the table cannot fall behind the code.

## Running an app

| Variable             | Read by          | Effect                                                                                                                                                                           |
| -------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AIO_PORT`           | boot             | Port to serve on. `--port` wins over it; both win over `port:` in config                                                                                                         |
| `AIO_HOME`           | installers, `am` | Where aio itself lives (checkout or install root)                                                                                                                                |
| `AIO_APPS_DIR`       | app dirs         | Root for every app's data directory — the one switch that moves all of them (see [where files live](../persistence/where-files-live.md))                                         |
| `AIO_INSTALL_ROOT`   | installs         | Where an installed app lives (`am installed` lists them). Default `~/app/<name>/`                                                                                                |
| `AIO_TEST_ROOT`      | tests            | Root for every directory the test harnesses create. Default `~/tmp/aio/`, mode 0700 — user space, not `/tmp`: a test's scratch holds an `auth.db`, an `app.key` and TLS material |
| `AIO_VERSIONS_DIR`   | framework pin    | Where pinned aio versions are kept                                                                                                                                               |
| `AIO_UPDATE_CHANNEL` | update check     | Follow a different channel than the one stamped into the artifact                                                                                                                |
| `AIO_PARENT_PID`     | Electron child   | The pid the window must not outlive — set by the launcher, not by hand                                                                                                           |
| `AIO_NO_OPEN=1`      | `open-external`  | Never open a browser or a file manager. For any harness that must not spawn a UI                                                                                                 |
| `AIO_DISCOVERY_PORT` | discovery        | UDP port apps broadcast and answer discovery probes on — server and client must match. Default `8099` (see [the Electron client](../clients/electron.md))                        |
| `AIO_SUPERVISED=1`   | restart decision | "You are supervised: exit, do not spawn your own successor" — the generated systemd unit sets it (see [updates](../deploy/updates.md))                                           |

## Building

| Variable                  | Read by       | Effect                                                                                           |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `AIO_BUILD_VERSION`       | build         | **The supported way a parent build hands a version to a child.** See below                       |
| `AIO_BUILD_COMMIT`        | update check  | The commit a build came from, when git is not available where the binary runs                    |
| `AIO_ELECTRON_PROTOCOL=1` | dev           | Load the dev window over `aio://` — the packaged path — instead of `http://`. Test what you ship |
| `AIO_ELECTRON_SANDBOX=1`  | Electron      | Force the strict sandbox behaviour rather than the platform default                              |
| `ELECTRON_PATH`           | Electron      | Use this Electron runtime instead of the downloaded one                                          |
| `ELECTRON_MIRROR`         | Electron      | Mirror to download Electron from                                                                 |
| `AIO_AVD`                 | `dev-android` | Which Android emulator image to boot. Default: the first one                                     |

### `AIO_BUILD_VERSION` — one build, one version

aio derives a version rather than accepting one: `deno.json` `version` plus the
repository's commit count, with `-dirty.<hash>` when the tree is not clean. That
is right for a build that owns its repository and wrong for a build that is a
**child** of another one.

The case that matters: a build script that rewrites tracked files before
building (baking in a key or a CA, restoring the placeholder afterwards). aio's
builder, running inside that window, sees a dirty tree and stamps
`0.2.4-dirty.f0bfee54` into an artifact whose file name and signed manifest both
say `0.2.4` — three derivations of one number, disagreeing.

```sh
# The parent decides once; every child build carries that exact string.
AIO_BUILD_VERSION=0.2.4 deno task build
```

`buildVersionFor` returns it verbatim — no re-derivation, no dirty suffix. This
is how aio's own fleet hands one version to its per-target children, and it is
the supported hand-off for any parent build.

## Diagnostics and tests

| Variable               | Read by          | Effect                                                                            |
| ---------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `AIO_DEBUG=1`          | `deno task ship` | Keep the stack trace on a ship error that would otherwise print one line and exit |
| `AIO_DEV`              | `install.sh`     | Marks a development checkout so `am upgrade` leaves it alone                      |
| `AIO_AM_NO_DELEGATE=1` | `am`             | Do not delegate to the app's pinned aio — run this `am`                           |
| `AIO_CDP=1`            | app              | Open a CDP port so `am shot` can attach                                           |
| `AIO_TEST_NAMES=all`   | `testUI`         | Print every semantic name the harness resolved, not just the misses               |
| `AIO_TEST_DISPLAY`     | test helper      | Set by the test display helper; tells `open-external` it is inside a harness      |

## Not aio's

Read, never set: `HOME`, `USER`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`,
`TMPDIR`/`TEMP`/`TMP`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`,
`DISPLAY`, `WAYLAND_DISPLAY`, `CI`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`,
`JAVA_HOME`, `CHROME_BIN`, `CHROMIUM_BIN`, `APPIMAGE`, `APPDIR`, `ARGV0`.

`TMPDIR` deserves a note: it decides where an AppImage unpacks itself, and it is
read by the AppImage runtime **before** your app starts — see
[targets](targets.md#appimage-and-tmpdir).
