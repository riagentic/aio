// gtk-splash-worker.ts — the Linux splash, drawn by aio itself with GTK 3
// over FFI (gtk-splash.ts starts it). Its own thread: GTK is pumped here
// (`gtk_main_iteration_do`, never a blocking `gtk_main`) so the app's event
// loop never waits on a redraw, and a terminate always lands — the thread is
// in JS between pumps. GTK is touched from this thread only.
//
// Everything it needs arrives in the "open" message, computed by the pure
// helpers in gtk-splash.ts; it imports only splash-place.ts (pure, itself
// importing nothing) — the placement rule every OS's splash follows.
//
// The same thread draws the download window ("progress") and the Retry /
// Quit question ("ask") — one kind of window per worker — placed by the same
// rule, centred where the app's window opens.
import {
  type Bounds,
  centredOn,
  fitRect,
  type Rect,
  roundedRows,
  splashFrame,
  splashOrigin,
  windowRect,
} from "./splash-place.ts";

/** The look as the worker reads it (`helperLook` for Linux) and the bar's
 *  height in logical px. */
export type GtkLook = {
  sized: boolean;
  w: number;
  h: number;
  iw: number;
  ih: number;
  fit: "cover" | "contain";
  mode: "window" | "primary" | "pointer";
  target: (number | null)[] | null;
  below: boolean;
  align: "left" | "center" | "right";
  side: number;
  bottom: number;
  barHeight: number | null;
  barEdge: boolean;
  barRadius: number | null;
  radius: number;
  border: string | null;
  shadow: boolean;
  windowShadow: boolean;
  fadeMs: number;
  cancel: boolean;
  bp: number;
};

/** What the main thread sends. */
export type GtkSplashIn =
  | { type: "init" }
  | {
    type: "open";
    title: string;
    text: string;
    hasText: boolean;
    png: Uint8Array;
    scale: 1 | 2;
    look: GtkLook;
    css: { light: string; dark: string };
    colors: { light: string; dark: string };
  }
  /** The download window: a titled window with the heading, the detail and
   *  a bar (pulsing while `update`'s pct is -1). Its close is the cancel. */
  | {
    type: "progress";
    title: string;
    heading: string;
    target: Bounds | null;
    /** The app's look (`gtkDialogCss`), light and dark; null: the theme's. */
    css: { light: string; dark: string } | null;
    /** Its Cancel button (the close cancels either way). */
    cancel: boolean;
  }
  /** The question: the message and its buttons, left to right; the answer is
   *  the button's index (-1: the window was closed). */
  | {
    type: "ask";
    title: string;
    message: string;
    buttons: string[];
    target: Bounds | null;
    css: { light: string; dark: string } | null;
  }
  | { type: "update"; pct: number; text: string }
  /** Clicks the ✕ (the splash), or the question's button `index`, through
   *  GTK's own "clicked" signal (tests: no pointer device to click with). */
  | { type: "click"; index?: number }
  /** The splash re-centres on the app's window, where it really is. */
  | { type: "move"; target: [number, number, number, number] }
  | { type: "close" };

/** What it answers. */
export type GtkSplashOut =
  | { type: "init"; ok: true }
  | { type: "init"; ok: false; why: string }
  | { type: "shown"; what: string }
  | { type: "cancel" }
  | { type: "answer"; index: number }
  | { type: "lost"; why: string }
  | { type: "closed" };

const SYMBOLS = {
  gtk_disable_setlocale: { parameters: [], result: "void" },
  gtk_init_check: { parameters: ["pointer", "pointer"], result: "i32" },
  gtk_events_pending: { parameters: [], result: "i32" },
  gtk_main_iteration_do: { parameters: ["i32"], result: "i32" },
  gtk_window_new: { parameters: ["i32"], result: "pointer" },
  gtk_window_set_title: { parameters: ["pointer", "buffer"], result: "void" },
  gtk_window_set_decorated: { parameters: ["pointer", "i32"], result: "void" },
  gtk_window_set_skip_taskbar_hint: {
    parameters: ["pointer", "i32"],
    result: "void",
  },
  gtk_window_set_skip_pager_hint: {
    parameters: ["pointer", "i32"],
    result: "void",
  },
  gtk_window_set_keep_above: { parameters: ["pointer", "i32"], result: "void" },
  gtk_window_set_type_hint: { parameters: ["pointer", "i32"], result: "void" },
  gtk_window_move: { parameters: ["pointer", "i32", "i32"], result: "void" },
  gtk_widget_shape_combine_region: {
    parameters: ["pointer", "pointer"],
    result: "void",
  },
  cairo_region_create: { parameters: [], result: "pointer" },
  cairo_region_union_rectangle: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
  cairo_region_destroy: { parameters: ["pointer"], result: "void" },
  gdk_pixbuf_scale_simple: {
    parameters: ["pointer", "i32", "i32", "i32"],
    result: "pointer",
  },
  gdk_pixbuf_new_subpixbuf: {
    parameters: ["pointer", "i32", "i32", "i32", "i32"],
    result: "pointer",
  },
  gdk_display_get_n_monitors: { parameters: ["pointer"], result: "i32" },
  gdk_display_get_monitor: {
    parameters: ["pointer", "i32"],
    result: "pointer",
  },
  gdk_display_get_primary_monitor: {
    parameters: ["pointer"],
    result: "pointer",
  },
  gdk_monitor_get_workarea: {
    parameters: ["pointer", "buffer"],
    result: "void",
  },
  gdk_display_get_default_seat: { parameters: ["pointer"], result: "pointer" },
  gdk_seat_get_pointer: { parameters: ["pointer"], result: "pointer" },
  gdk_device_get_position: {
    parameters: ["pointer", "pointer", "buffer", "buffer"],
    result: "void",
  },
  gtk_window_set_resizable: { parameters: ["pointer", "i32"], result: "void" },
  gtk_window_set_accept_focus: {
    parameters: ["pointer", "i32"],
    result: "void",
  },
  gtk_window_set_focus_on_map: {
    parameters: ["pointer", "i32"],
    result: "void",
  },
  gtk_window_set_default_size: {
    parameters: ["pointer", "i32", "i32"],
    result: "void",
  },
  gtk_container_add: { parameters: ["pointer", "pointer"], result: "void" },
  gtk_fixed_new: { parameters: [], result: "pointer" },
  gtk_fixed_put: {
    parameters: ["pointer", "pointer", "i32", "i32"],
    result: "void",
  },
  gtk_fixed_move: {
    parameters: ["pointer", "pointer", "i32", "i32"],
    result: "void",
  },
  gtk_image_new_from_surface: { parameters: ["pointer"], result: "pointer" },
  gtk_label_new: { parameters: ["buffer"], result: "pointer" },
  gtk_label_set_text: { parameters: ["pointer", "buffer"], result: "void" },
  gtk_label_set_xalign: { parameters: ["pointer", "f32"], result: "void" },
  gtk_label_set_ellipsize: { parameters: ["pointer", "i32"], result: "void" },
  gtk_box_new: { parameters: ["i32", "i32"], result: "pointer" },
  gtk_button_new_with_label: { parameters: ["buffer"], result: "pointer" },
  gtk_button_set_relief: { parameters: ["pointer", "i32"], result: "void" },
  gtk_widget_set_name: { parameters: ["pointer", "buffer"], result: "void" },
  gtk_widget_set_size_request: {
    parameters: ["pointer", "i32", "i32"],
    result: "void",
  },
  gtk_widget_get_preferred_height: {
    parameters: ["pointer", "buffer", "buffer"],
    result: "void",
  },
  gtk_widget_show_all: { parameters: ["pointer"], result: "void" },
  gtk_widget_show: { parameters: ["pointer"], result: "void" },
  gtk_widget_hide: { parameters: ["pointer"], result: "void" },
  gtk_widget_set_no_show_all: {
    parameters: ["pointer", "i32"],
    result: "void",
  },
  gtk_widget_get_mapped: { parameters: ["pointer"], result: "i32" },
  gtk_widget_get_scale_factor: { parameters: ["pointer"], result: "i32" },
  gtk_widget_set_opacity: { parameters: ["pointer", "f64"], result: "void" },
  gtk_widget_destroy: { parameters: ["pointer"], result: "void" },
  gtk_progress_bar_new: { parameters: [], result: "pointer" },
  gtk_progress_bar_set_fraction: {
    parameters: ["pointer", "f64"],
    result: "void",
  },
  gtk_progress_bar_pulse: { parameters: ["pointer"], result: "void" },
  gtk_label_set_markup: { parameters: ["pointer", "buffer"], result: "void" },
  gtk_label_set_line_wrap: { parameters: ["pointer", "i32"], result: "void" },
  gtk_label_set_max_width_chars: {
    parameters: ["pointer", "i32"],
    result: "void",
  },
  gtk_box_pack_start: {
    parameters: ["pointer", "pointer", "i32", "i32", "u32"],
    result: "void",
  },
  gtk_container_set_border_width: {
    parameters: ["pointer", "u32"],
    result: "void",
  },
  gtk_widget_set_halign: { parameters: ["pointer", "i32"], result: "void" },
  gtk_widget_grab_focus: { parameters: ["pointer"], result: "void" },
  gtk_widget_get_preferred_size: {
    parameters: ["pointer", "buffer", "buffer"],
    result: "void",
  },
  gtk_css_provider_new: { parameters: [], result: "pointer" },
  gtk_css_provider_load_from_data: {
    parameters: ["pointer", "buffer", "i64", "pointer"],
    result: "i32",
  },
  gtk_style_context_add_provider_for_screen: {
    parameters: ["pointer", "pointer", "u32"],
    result: "void",
  },
  gtk_settings_get_default: { parameters: [], result: "pointer" },
  gdk_screen_get_default: { parameters: [], result: "pointer" },
  gtk_widget_get_window: { parameters: ["pointer"], result: "pointer" },
  gdk_window_raise: { parameters: ["pointer"], result: "void" },
  gdk_window_get_origin: {
    parameters: ["pointer", "buffer", "buffer"],
    result: "i32",
  },
  gdk_x11_display_get_type: { parameters: [], result: "usize" },
  gdk_x11_window_get_xid: { parameters: ["pointer"], result: "u64" },
  g_type_check_instance_is_a: {
    parameters: ["pointer", "usize"],
    result: "i32",
  },
  gtk_button_clicked: { parameters: ["pointer"], result: "void" },
  gdk_display_get_default: { parameters: [], result: "pointer" },
  gdk_display_open: { parameters: ["pointer"], result: "pointer" },
  gdk_display_manager_get: { parameters: [], result: "pointer" },
  gdk_display_manager_set_default_display: {
    parameters: ["pointer", "pointer"],
    result: "void",
  },
  gdk_cairo_surface_create_from_pixbuf: {
    parameters: ["pointer", "i32", "pointer"],
    result: "pointer",
  },
  gdk_pixbuf_loader_new: { parameters: [], result: "pointer" },
  gdk_pixbuf_loader_write: {
    parameters: ["pointer", "buffer", "usize", "pointer"],
    result: "i32",
  },
  gdk_pixbuf_loader_close: {
    parameters: ["pointer", "pointer"],
    result: "i32",
  },
  gdk_pixbuf_loader_get_pixbuf: { parameters: ["pointer"], result: "pointer" },
  cairo_surface_destroy: { parameters: ["pointer"], result: "void" },
  g_object_unref: { parameters: ["pointer"], result: "void" },
  g_value_init: { parameters: ["buffer", "usize"], result: "pointer" },
  g_value_unset: { parameters: ["buffer"], result: "void" },
  g_value_get_string: { parameters: ["buffer"], result: "pointer" },
  g_value_get_boolean: { parameters: ["buffer"], result: "i32" },
  g_object_get_property: {
    parameters: ["pointer", "buffer", "buffer"],
    result: "void",
  },
  g_signal_connect_data: {
    parameters: ["pointer", "buffer", "function", "pointer", "pointer", "i32"],
    result: "u64",
  },
} as const;

type Gtk = Deno.DynamicLibrary<typeof SYMBOLS>["symbols"];

const post = (m: GtkSplashOut) =>
  (self as unknown as { postMessage(m: GtkSplashOut): void }).postMessage(m);
const enc = new TextEncoder();
const z = (s: string) => enc.encode(s + "\0");

let g: Gtk | null = null;
let win: Deno.PointerValue = null;
let fixed: Deno.PointerValue = null;
let label: Deno.PointerValue = null;
let track: Deno.PointerValue = null;
let fill: Deno.PointerValue = null;
let closeBtn: Deno.PointerValue = null;
let look: GtkLook | null = null;
let frame: ReturnType<typeof splashFrame> | null = null;
let pumpId: ReturnType<typeof setInterval> | undefined;
let labelH = 0;
let bar: Deno.PointerValue = null; // the download window's
let pulsing = false;
let buttons: Deno.PointerValue[] = []; // the question's
let placed: { w: number; h: number } | null = null; // the splash's size
// Held for the window's life: a collected callback is a crash in GTK.
const callbacks: { close(): void }[] = [];

/** Every pending GTK event, handled now — never waits. */
function pump(): void {
  if (!g) return;
  for (let n = 0; n < 500 && g.gtk_events_pending(); n++) {
    g.gtk_main_iteration_do(0);
  }
}

function init(): GtkSplashOut {
  try {
    const lib = Deno.dlopen("libgtk-3.so.0", SYMBOLS);
    g = lib.symbols;
  } catch (e) {
    return {
      type: "init",
      ok: false,
      why: `libgtk-3.so.0 could not be opened (${
        e instanceof Error ? e.message : e
      })`,
    };
  }
  // The app's process keeps its C locale: GTK's own setlocale would change
  // it for every thread.
  g.gtk_disable_setlocale();
  // GTK initialises once per PROCESS: after a failed start a second
  // gtk_init_check says yes with no display behind it — so the display is
  // what is checked, and opened when an earlier try could not.
  let display = g.gtk_init_check(null, null)
    ? g.gdk_display_get_default()
    : null;
  if (!display && g.gtk_init_check(null, null)) {
    display = g.gdk_display_open(null);
    if (display) {
      g.gdk_display_manager_set_default_display(
        g.gdk_display_manager_get(),
        display,
      );
    }
  }
  if (!display) {
    return {
      type: "init",
      ok: false,
      why: `GTK could not open the display ${
        Deno.env.get("WAYLAND_DISPLAY") || Deno.env.get("DISPLAY") || ""
      }`.trim(),
    };
  }
  return { type: "init", ok: true };
}

/** The GTK theme is dark: the app asks for it, or its name says so. */
function themeIsDark(gt: Gtk): boolean {
  const settings = gt.gtk_settings_get_default();
  if (!settings) return false;
  const prop = (
    name: string,
    type: number,
    read: (v: Uint8Array) => unknown,
  ) => {
    const v = new Uint8Array(24); // a GValue, zeroed
    gt.g_value_init(v, BigInt(type));
    gt.g_object_get_property(settings, z(name), v);
    const r = read(v);
    gt.g_value_unset(v);
    return r;
  };
  const G_TYPE_BOOLEAN = 5 << 2, G_TYPE_STRING = 16 << 2;
  const prefer = prop(
    "gtk-application-prefer-dark-theme",
    G_TYPE_BOOLEAN,
    (v) => gt.g_value_get_boolean(v) !== 0,
  );
  const theme = prop("gtk-theme-name", G_TYPE_STRING, (v) => {
    const p = gt.g_value_get_string(v);
    return p ? Deno.UnsafePointerView.getCString(p) : "";
  }) as string;
  return prefer === true || /dark/i.test(theme) ||
    /:dark$/i.test(Deno.env.get("GTK_THEME") ?? "");
}

function open(m: Extract<GtkSplashIn, { type: "open" }>): void {
  const gt = g!;
  const L = look = m.look;
  const { w: W, h: H, bp } = L;
  const dark = themeIsDark(gt);

  const css = gt.gtk_css_provider_new();
  const src = enc.encode(dark ? m.css.dark : m.css.light);
  gt.gtk_css_provider_load_from_data(css, src, BigInt(src.length), null);
  // GTK_STYLE_PROVIDER_PRIORITY_APPLICATION + 1: over any theme.
  gt.gtk_style_context_add_provider_for_screen(
    gt.gdk_screen_get_default(),
    css,
    601,
  );

  const loader = gt.gdk_pixbuf_loader_new();
  const okW = gt.gdk_pixbuf_loader_write(
    loader,
    m.png,
    BigInt(m.png.length),
    null,
  );
  const okC = gt.gdk_pixbuf_loader_close(loader, null);
  const pixbuf = gt.gdk_pixbuf_loader_get_pixbuf(loader);
  if (!okW || !okC || !pixbuf) {
    gt.g_object_unref(loader);
    post({ type: "lost", why: "GdkPixbuf could not read the image" });
    return;
  }

  win = gt.gtk_window_new(0); // GTK_WINDOW_TOPLEVEL
  gt.gtk_widget_set_name(win, z("aio-splash"));
  gt.gtk_window_set_title(win, z(m.title));
  gt.gtk_window_set_decorated(win, 0);
  gt.gtk_window_set_skip_taskbar_hint(win, 1);
  gt.gtk_window_set_skip_pager_hint(win, 1);
  gt.gtk_window_set_keep_above(win, 1);
  gt.gtk_window_set_type_hint(win, 4); // GDK_WINDOW_TYPE_HINT_SPLASHSCREEN
  gt.gtk_window_set_resizable(win, 0);
  gt.gtk_window_set_accept_focus(win, 0); // focus stays where it is
  gt.gtk_window_set_focus_on_map(win, 0);
  // A window manager's close (no frame, but Alt+F4 reaches it): the user
  // closed it — the start's cancel, as the other OSes'. Kept, never
  // destroyed under us.
  const onDelete = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "i32" },
    () => {
      post({ type: "cancel" });
      return 1;
    },
  );
  callbacks.push(onDelete);
  gt.g_signal_connect_data(
    win,
    z("delete-event"),
    onDelete.pointer,
    null,
    null,
    0,
  );

  fixed = gt.gtk_fixed_new();
  gt.gtk_container_add(win, fixed);
  // The image at its point size: an @2x image is a scale-2 surface, drawn at
  // half its pixels (crisp on a 2× screen). With `size` (or a strip below),
  // it is first scaled to the box it fills (`fit`), cropped for `cover`.
  let pb: Deno.PointerValue = pixbuf, at = { x: 0, y: 0 };
  const owned: Deno.PointerValue[] = [];
  if (L.sized) {
    const r = fitRect(L.iw, L.ih, W, H, L.fit);
    const k = m.scale;
    const scaled = gt.gdk_pixbuf_scale_simple(
      pixbuf,
      r.width * k,
      r.height * k,
      2,
    );
    owned.push(scaled);
    pb = scaled;
    at = { x: Math.max(0, r.x), y: Math.max(0, r.y) };
    if (r.x < 0 || r.y < 0) {
      const sub = gt.gdk_pixbuf_new_subpixbuf(
        scaled,
        Math.max(0, -r.x) * k,
        Math.max(0, -r.y) * k,
        Math.min(r.width, W) * k,
        Math.min(r.height, H) * k,
      );
      owned.push(sub);
      pb = sub;
    }
  }
  const surface = gt.gdk_cairo_surface_create_from_pixbuf(pb, m.scale, null);
  const image = gt.gtk_image_new_from_surface(surface);
  gt.cairo_surface_destroy(surface);
  for (const o of owned) gt.g_object_unref(o);
  gt.g_object_unref(loader); // owns the pixbuf
  if (!L.sized) gt.gtk_widget_set_size_request(image, W, H);
  gt.gtk_fixed_put(fixed, image, at.x, at.y);

  if (m.hasText) {
    label = gt.gtk_label_new(z(m.text));
    gt.gtk_widget_set_name(label, z("aio-splash-text"));
    gt.gtk_label_set_xalign(
      label,
      L.align === "center" ? 0.5 : L.align === "right" ? 1 : 0,
    );
    gt.gtk_label_set_ellipsize(label, 3); // PANGO_ELLIPSIZE_END
    gt.gtk_widget_set_size_request(label, W - 2 * L.side, -1);
    // Measured in place (its style is the window's), then moved up by it.
    gt.gtk_fixed_put(fixed, label, L.side, 0);
    gt.gtk_widget_show(label); // a hidden widget measures 0
    const min = new Int32Array(1), nat = new Int32Array(1);
    gt.gtk_widget_get_preferred_height(
      label,
      new Uint8Array(min.buffer),
      new Uint8Array(nat.buffer),
    );
    labelH = nat[0]!;
  }
  frame = splashFrame(L, labelH);
  const { TH, yb, bx, bw, labelBottom } = frame;
  if (label) gt.gtk_fixed_move(fixed, label, L.side, labelBottom - labelH);
  gt.gtk_window_set_default_size(win, W, TH);
  gt.gtk_widget_set_size_request(win, W, TH);
  if (bp > 0) {
    const box = (name: string, w: number) => {
      const b = gt.gtk_box_new(0, 0);
      gt.gtk_widget_set_name(b, z(name));
      gt.gtk_widget_set_size_request(b, w, bp);
      gt.gtk_widget_set_no_show_all(b, 1); // hidden until a download runs
      gt.gtk_fixed_put(fixed, b, bx, yb);
      return b;
    };
    track = box("aio-splash-track", bw);
    fill = box("aio-splash-fill", 0);
    if (L.cancel) {
      // During a download, this cancels it (as a dialog's close button does).
      closeBtn = gt.gtk_button_new_with_label(z("✕"));
      gt.gtk_widget_set_name(closeBtn, z("aio-splash-close"));
      gt.gtk_button_set_relief(closeBtn, 2); // GTK_RELIEF_NONE
      gt.gtk_widget_set_no_show_all(closeBtn, 1);
      const onClick = new Deno.UnsafeCallback(
        { parameters: ["pointer", "pointer"], result: "void" },
        () => post({ type: "cancel" }),
      );
      callbacks.push(onClick);
      gt.g_signal_connect_data(
        closeBtn,
        z("clicked"),
        onClick.pointer,
        null,
        null,
        0,
      );
      gt.gtk_fixed_put(fixed, closeBtn, W - 30, 4);
    }
  }
  if (L.border) {
    // On top of everything: the 1 px border (and its rounded corners).
    const b = gt.gtk_box_new(0, 0);
    gt.gtk_widget_set_name(b, z("aio-splash-border"));
    gt.gtk_widget_set_size_request(b, W, TH);
    gt.gtk_fixed_put(fixed, b, 0, 0);
  }
  if (L.radius > 0) {
    // The window's shape: rounded corners without a compositor (X11 SHAPE).
    const region = gt.cairo_region_create();
    const rect = new Int32Array(4);
    for (const r of roundedRows(W, TH, L.radius)) {
      rect.set([r.x, r.y, r.width, r.height]);
      gt.cairo_region_union_rectangle(region, new Uint8Array(rect.buffer));
    }
    gt.gtk_widget_shape_combine_region(win, region);
    gt.cairo_region_destroy(region);
  }
  placed = { w: W, h: TH };
  const o = placeOn(gt, W, TH);
  gt.gtk_window_move(win, o.x, o.y);
  gt.gtk_widget_show_all(win);

  const t0 = performance.now();
  let shown = false;
  let ticks = 0;
  pumpId = setInterval(() => {
    pump();
    if (!win) return;
    // Back on top of the app's window, which shows under it the moment it is
    // ready: keep-above is a request a window manager may ignore (and with no
    // window manager nothing keeps it), so it is re-raised — a restack only,
    // never a focus change.
    if (shown && ++ticks % 6 === 0) {
      gt.gdk_window_raise(gt.gtk_widget_get_window(win));
    }
    if (shown) return;
    if (gt.gtk_widget_get_mapped(win)) {
      shown = true;
      post({
        type: "shown",
        what: `shown splash size=${W}x${TH} scale=${m.scale} dark=${
          dark ? 1 : 0
        } text=${m.hasText ? 1 : 0} barpx=${bp} colors=${
          (dark ? m.colors.dark : m.colors.light).split(" ").join(",")
        } label-h=${labelH} device-scale=${
          gt.gtk_widget_get_scale_factor(win)
        } ${where(gt)}`,
      });
    } else if (performance.now() - t0 > 5_000) {
      // A window that never maps (a Wayland compositor refusing it, a broken
      // display): said, never waited on.
      post({ type: "lost", why: "the GTK window never appeared within 5 s" });
      destroy();
    }
  }, 16);
}

/** Pango markup's text: `&`, `<`, `>` are text. Pure. */
const markup = (t: string) =>
  t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The display's monitors' work areas and its primary (the first when none
 *  is marked) — what splash-place.ts places by. */
function screensOf(gt: Gtk): { screens: Rect[]; primary: Rect | null } {
  const d = gt.gdk_display_get_default();
  const rect = new Int32Array(4);
  const area = (mon: Deno.PointerValue): Rect => {
    gt.gdk_monitor_get_workarea(mon, new Uint8Array(rect.buffer));
    return { x: rect[0]!, y: rect[1]!, width: rect[2]!, height: rect[3]! };
  };
  const screens: Rect[] = [];
  for (let i = 0; i < gt.gdk_display_get_n_monitors(d); i++) {
    screens.push(area(gt.gdk_display_get_monitor(d, i)));
  }
  const pm = gt.gdk_display_get_primary_monitor(d);
  return { screens, primary: pm ? area(pm) : screens[0] ?? null };
}

/** A titled window holding `box`, centred where the app's window opens
 *  (`windowRect` of `target`; none: the primary's centre), shown; says
 *  "shown" once it is on screen. `onClose`: the window manager's close. */
function dialogWindow(
  gt: Gtk,
  title: string,
  box: Deno.PointerValue,
  target: Bounds | null,
  css: { light: string; dark: string } | null,
  onClose: () => void,
): void {
  win = gt.gtk_window_new(0);
  gt.gtk_widget_set_name(win, z("aio-dialog"));
  if (css) {
    // The app's colours, light or dark as the desktop is (`themeIsDark`).
    const p = gt.gtk_css_provider_new();
    const src = enc.encode(themeIsDark(gt) ? css.dark : css.light);
    gt.gtk_css_provider_load_from_data(p, src, BigInt(src.length), null);
    gt.gtk_style_context_add_provider_for_screen(
      gt.gdk_screen_get_default(),
      p,
      601,
    );
  }
  gt.gtk_window_set_title(win, z(title));
  gt.gtk_window_set_resizable(win, 0);
  gt.gtk_container_set_border_width(win, 18);
  gt.gtk_container_add(win, box);
  const onDelete = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "i32" },
    () => {
      onClose();
      return 1; // kept: the main thread closes it
    },
  );
  callbacks.push(onDelete);
  gt.g_signal_connect_data(
    win,
    z("delete-event"),
    onDelete.pointer,
    null,
    null,
    0,
  );
  // Its size before it maps, so it opens where it belongs (no jump).
  gt.gtk_widget_show_all(box);
  const min = new Int32Array(2), nat = new Int32Array(2);
  gt.gtk_widget_get_preferred_size(
    win,
    new Uint8Array(min.buffer),
    new Uint8Array(nat.buffer),
  );
  const { screens, primary } = screensOf(gt);
  const w = nat[0]!, h = nat[1]!;
  const p = primary ?? { x: 0, y: 0, width: w, height: h };
  const o = target
    ? centredOn(windowRect(target, screens, p), w, h)
    : centredOn({ ...p, screen: p }, w, h);
  gt.gtk_window_move(win, o.x, o.y);
  gt.gtk_widget_show_all(win);
  let shown = false, ticks = 0;
  const t0 = performance.now();
  pumpId = setInterval(() => {
    pump();
    if (!win) return;
    if (bar && pulsing && ++ticks % 6 === 0) gt.gtk_progress_bar_pulse(bar);
    if (shown) return;
    if (gt.gtk_widget_get_mapped(win)) {
      shown = true;
      post({
        type: "shown",
        what: `shown dialog size=${w}x${h} screens=${screens.length} ${
          where(gt)
        }`,
      });
    } else if (performance.now() - t0 > 5_000) {
      post({ type: "lost", why: "the GTK window never appeared within 5 s" });
      destroy();
    }
  }, 16);
}

function openProgress(m: Extract<GtkSplashIn, { type: "progress" }>): void {
  const gt = g!;
  const box = gt.gtk_box_new(1, 8); // GTK_ORIENTATION_VERTICAL
  const head = gt.gtk_label_new(z(""));
  gt.gtk_label_set_markup(head, z(`<b>${markup(m.heading)}</b>`));
  gt.gtk_label_set_xalign(head, 0);
  label = gt.gtk_label_new(z(""));
  gt.gtk_label_set_xalign(label, 0);
  gt.gtk_label_set_ellipsize(label, 3); // PANGO_ELLIPSIZE_END
  bar = gt.gtk_progress_bar_new();
  pulsing = true;
  gt.gtk_widget_set_size_request(bar, 424, -1);
  // Cancel — the one button: it ends the download (as the window's close).
  const row = gt.gtk_box_new(0, 8);
  gt.gtk_widget_set_halign(row, 2); // GTK_ALIGN_END
  const cancel = gt.gtk_button_new_with_label(z("Cancel"));
  const cb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer"], result: "void" },
    () => post({ type: "cancel" }),
  );
  callbacks.push(cb);
  gt.g_signal_connect_data(cancel, z("clicked"), cb.pointer, null, null, 0);
  gt.gtk_box_pack_start(row, cancel, 0, 0, 0);
  buttons = [cancel];
  for (const w of m.cancel ? [head, label, bar, row] : [head, label, bar]) {
    gt.gtk_box_pack_start(box, w, 0, 0, 0);
  }
  dialogWindow(
    gt,
    m.title,
    box,
    m.target,
    m.css,
    () => post({ type: "cancel" }),
  );
}

function openAsk(m: Extract<GtkSplashIn, { type: "ask" }>): void {
  const gt = g!;
  const box = gt.gtk_box_new(1, 16);
  const msg = gt.gtk_label_new(z(m.message));
  gt.gtk_label_set_xalign(msg, 0);
  gt.gtk_label_set_line_wrap(msg, 1);
  gt.gtk_label_set_max_width_chars(msg, 60);
  const row = gt.gtk_box_new(0, 8); // GTK_ORIENTATION_HORIZONTAL
  gt.gtk_widget_set_halign(row, 2); // GTK_ALIGN_END
  buttons = m.buttons.map((text, i) => {
    const b = gt.gtk_button_new_with_label(z(text));
    const cb = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "void" },
      () => post({ type: "answer", index: i }),
    );
    callbacks.push(cb);
    gt.g_signal_connect_data(b, z("clicked"), cb.pointer, null, null, 0);
    gt.gtk_box_pack_start(row, b, 0, 0, 0);
    return b;
  });
  gt.gtk_box_pack_start(box, msg, 1, 1, 0);
  gt.gtk_box_pack_start(box, row, 0, 0, 0);
  dialogWindow(
    gt,
    m.title,
    box,
    m.target,
    m.css,
    () => post({ type: "answer", index: -1 }),
  );
  const last = buttons.at(-1);
  if (last) gt.gtk_widget_grab_focus(last);
}

/** Where the app's window will open (splash-place.ts): the display's
 *  monitors' work areas, its primary (the first when none is marked), the
 *  pointer. On Wayland the compositor places the window itself. */
function placeOn(gt: Gtk, w: number, h: number): { x: number; y: number } {
  const d = gt.gdk_display_get_default();
  const found = screensOf(gt);
  const screens = found.screens;
  const primary = found.primary ?? { x: 0, y: 0, width: w, height: h };
  let pointer: { x: number; y: number } | null = null;
  if (look!.mode === "pointer") {
    const dev = gt.gdk_seat_get_pointer(gt.gdk_display_get_default_seat(d));
    const px = new Int32Array(1), py = new Int32Array(1);
    if (dev) {
      gt.gdk_device_get_position(
        dev,
        null,
        new Uint8Array(px.buffer),
        new Uint8Array(py.buffer),
      );
      pointer = { x: px[0]!, y: py[0]! };
    }
  }
  const t = look!.target;
  return splashOrigin({
    mode: look!.mode,
    target: t && {
      width: t[2]!,
      height: t[3]!,
      ...(t[0] === null ? {} : { x: t[0]!, y: t[1]! }),
    },
    screens,
    primary,
    pointer,
    w,
    h,
  });
}

/** Where the window is: its screen origin, and its X11 id on X11. */
function where(gt: Gtk): string {
  const gw = gt.gtk_widget_get_window(win);
  const x = new Int32Array(1), y = new Int32Array(1);
  gt.gdk_window_get_origin(
    gw,
    new Uint8Array(x.buffer),
    new Uint8Array(y.buffer),
  );
  const x11 = gt.g_type_check_instance_is_a(
    gt.gdk_display_get_default(),
    gt.gdk_x11_display_get_type(),
  ) !== 0;
  return `at=${x[0]},${y[0]} ` +
    (x11
      ? `xid=0x${gt.gdk_x11_window_get_xid(gw).toString(16)}`
      : "backend=wayland");
}

function update(pct: number, text: string): void {
  const gt = g;
  if (!gt || !win) return;
  if (label) gt.gtk_label_set_text(label, z(text));
  if (bar) {
    pulsing = pct < 0;
    if (!pulsing) {
      gt.gtk_progress_bar_set_fraction(bar, Math.min(100, pct) / 100);
    }
  }
  if (track && fill && frame && look) {
    const on = pct >= 0;
    for (const w of [track, fill, closeBtn]) {
      if (w) on ? gt.gtk_widget_show(w) : gt.gtk_widget_hide(w);
    }
    if (on) {
      const fw = Math.round(frame.bw * Math.min(100, pct) / 100);
      gt.gtk_widget_set_size_request(fill, fw, look.bp);
      fw > 0 ? gt.gtk_widget_show(fill) : gt.gtk_widget_hide(fill);
    }
  }
  pump();
}

function destroy(): void {
  clearInterval(pumpId);
  if (g && win) {
    g.gtk_widget_destroy(win);
    pump();
  }
  win =
    label =
    track =
    fill =
    closeBtn =
    fixed =
    bar =
      null;
  buttons = [];
}

async function close(): Promise<void> {
  if (g && win) {
    clearInterval(pumpId);
    const n = Math.round((look?.fadeMs ?? 0) / 16); // dialogs: no fade
    for (let j = 0; j < n; j++) {
      g.gtk_widget_set_opacity(win, 0.85 * (n - j) / n);
      pump();
      await new Promise((r) => setTimeout(r, 16));
    }
  }
  destroy();
  post({ type: "closed" });
}

self.onmessage = (e: MessageEvent<GtkSplashIn>) => {
  const m = e.data;
  try {
    if (m.type === "init") post(init());
    else if (m.type === "open") open(m);
    else if (m.type === "progress") openProgress(m);
    else if (m.type === "ask") openAsk(m);
    else if (m.type === "update") update(m.pct, m.text);
    else if (m.type === "move") {
      if (win && look && placed) {
        look = { ...look, mode: "window", target: m.target };
        const o = placeOn(g!, placed.w, placed.h);
        g!.gtk_window_move(win, o.x, o.y);
      }
    } else if (m.type === "click") {
      const b = m.index === undefined ? closeBtn : buttons[m.index];
      if (b) g?.gtk_button_clicked(b);
    } else void close();
  } catch (err) {
    post({
      type: "lost",
      why: `GTK: ${err instanceof Error ? err.message : err}`,
    });
  }
};
