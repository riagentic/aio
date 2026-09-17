// Start (and hold) this user's nested X display — the one aio's GUI tests and
// a non-interactive `am start` put their windows on. `scripts/xephyr.sh` is
// the door; this is the mechanism, shared with the framework so a display a
// person starts by hand is the same kind of display aio starts for itself:
// access-controlled, with a cookie in the user's private runtime directory,
// never `-ac`.
//
//   deno run -A scripts/xephyr.ts [:N] [WxH]
import {
  _spawnXephyr,
  AIO_NESTED_SCREEN,
  displayOwner,
  nestedDisplayCookieFile,
  pickNestedDisplay,
  xauthorityEntry,
} from "../src/server/nested-display.ts";

const wanted = Deno.args.find((a) => /^:\d+$/.test(a));
const screen = Deno.args.find((a) => /^\d+x\d+$/.test(a)) ?? AIO_NESTED_SCREEN;
const display = wanted ?? pickNestedDisplay()?.display;
if (!display) {
  console.error("every nested display number belongs to another user");
  Deno.exit(1);
}
const owner = displayOwner(display);
if (owner === "mine") {
  console.log(`${display} is already up — nothing to do.`);
  Deno.exit(0);
}
if (owner === "other") {
  console.error(`${display} belongs to another user — pick another number.`);
  Deno.exit(1);
}
const file = nestedDisplayCookieFile(display);
if (!file) {
  console.error(
    "no private runtime directory for the display cookie — set " +
      "$XDG_RUNTIME_DIR to a directory you own",
  );
  Deno.exit(1);
}
const cookie = new Uint8Array(16);
crypto.getRandomValues(cookie);
Deno.writeFileSync(file, xauthorityEntry(display, cookie), { mode: 0o600 });
Deno.chmodSync(file, 0o600);
const child = _spawnXephyr(display, screen, file);
if (!child) {
  console.error("Xephyr not installed.");
  console.error("  Debian/Ubuntu: sudo apt install xserver-xephyr");
  console.error("  Fedora:        sudo dnf install xorg-x11-server-Xephyr");
  console.error("  Arch:          sudo pacman -S xorg-server-xephyr");
  Deno.exit(1);
}
console.log(
  `Xephyr on ${display} (${screen}), access-controlled. Test windows open in ` +
    `here, not on your desktop. Leave it running; Ctrl-C or closing the ` +
    `window stops it.\n  cookie: ${file}\n  to look in from a shell: ` +
    `DISPLAY=${display} XAUTHORITY=${file} <x client>`,
);
const status = await child.status;
Deno.exit(status.code);
