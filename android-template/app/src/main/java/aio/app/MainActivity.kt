package aio.app

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebResourceError
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/** Filled at build time: true for a client APK and a dev build, false for a
 *  standalone APK (packaged assets only). One decider with the manifest's
 *  cleartext attribute — see `talksToServer` in build-android.ts. */
private const val TALKS_TO_SERVER = {{TALKS_TO_SERVER}}
private const val ASSET_HOST = "appassets.androidplatform.net"
/** Filled at build time: true only for a client APK (its packaged page is the
 *  connect form). A dev build talks to a server but packages no form. */
private const val IS_CLIENT = {{IS_CLIENT}}
/** Filled at build time from deno.json `android.camera`. The manifest declares
 *  CAMERA only when this is true, so the two can never disagree — one decider,
 *  `_cameraPermission` in build-android.ts. It used to be declared for EVERY
 *  APK, so every aio app told its user it could watch them and Play flagged a
 *  permission almost none of them used. Opt-in now; and because a silently
 *  missing permission would fail `getUserMedia` with nothing said, the refusal
 *  below names the exact key to add. */
private const val CAMERA_DECLARED = {{CAMERA_DECLARED}}
/** The JS global the store below is injected as. The page names the same
 *  string in `_pickPersistStore` (src/standalone-air.ts) — the only two places
 *  it appears. */
private const val STORE_GLOBAL = "AioNativeStore"

/**
 * The store a standalone app's state actually lives in.
 *
 * A standalone APK used to persist through `localStorage`, and the WebView
 * commits that to disk on its own lazy schedule. Measured on an API 35
 * emulator with examples/counter: a SIGKILL 122 ms after a committed change
 * brought the app back WITHOUT it — the change was gone and nothing said so.
 * (At 933 ms it survived, which is what made it look fine in every earlier
 * test.) A swipe-away, an OOM kill or a crash is exactly that kill.
 *
 * So: a real file, written durably.
 *   1. the bytes go to `<name>.tmp`,
 *   2. `fd.sync()` — they are ON the disk, not in a page cache,
 *   3. `renameTo` puts them under the real name in one atomic step.
 * A reader therefore sees the whole previous value or the whole new one,
 * never half of either: a torn state file is worse than a lost change. `set`
 * returns only once step 3 is done, so the page's method has already survived
 * the kill by the time it returns.
 *
 * SECURITY — `addJavascriptInterface` hands these methods to EVERY page the
 * WebView loads, for the life of the WebView. It is therefore installed only
 * when `TALKS_TO_SERVER` is false: a standalone APK, the one shape whose
 * WebView can never show anything but its own bundled assets
 * (`shouldOverrideUrlLoading` hands every other URL to an external Intent).
 * A client or dev APK — the two that open a server's pages — never gets the
 * bridge at all. `onPageStarted` removes it again if a page from any other
 * origin ever does load, so that is an enforced invariant rather than a
 * comment. The store reaches only this app's own `filesDir`, and its keys are
 * flattened to a leaf filename, so no key can walk out of that directory.
 */
private class AioNativeStore(private val dir: File) {
    /** A key ("aio:myapp") → one leaf filename in `dir`. The readable part is
     *  sanitised so no separator survives, and the hash keeps two keys that
     *  sanitise alike from becoming one file. */
    private fun fileFor(key: String): File {
        val safe = key.replace(Regex("[^A-Za-z0-9._-]"), "_").take(64)
        return File(dir, safe + "." + Integer.toHexString(key.hashCode()) + ".json")
    }

    @JavascriptInterface
    fun get(key: String): String? = try {
        val f = fileFor(key)
        if (f.isFile) f.readText(Charsets.UTF_8) else null
    } catch (e: Exception) {
        // Loud: state that exists on disk and did not come back is the same
        // loss as state that was never written. The RETURN is still null, and
        // null also means "nothing written yet" — `has` below is what keeps
        // the page from reading one as the other.
        android.util.Log.e("aio", "native store READ failed for $key: $e")
        null
    }

    /** Is a value for this key ON DISK? — regardless of whether it could be
     *  read back.
     *
     *  `get` answers null for BOTH "never written" and "written, and this read
     *  threw" (an IO error, an OOM on a large state). The page's upgrade path
     *  adopts the previous build's `localStorage` copy on a null, and writes
     *  it in: on the second meaning that silently replaces the app's real
     *  state with a snapshot from before the upgrade, and reports it as a
     *  successful adoption. One nullable return cannot separate the two, so
     *  this does — `isFile` is a stat, it does not read the bytes, and it
     *  cannot fail the way the read did.
     *
     *  Answering TRUE is the safe side (the page then refuses to overwrite),
     *  so a throw here answers true rather than "no". */
    @JavascriptInterface
    fun has(key: String): Boolean = try {
        fileFor(key).isFile
    } catch (e: Exception) {
        android.util.Log.e("aio", "native store HAS failed for $key: $e")
        true
    }

    /** True when the value is on disk. False is a REAL failure — the page
     *  turns it into a thrown error rather than a silent no-op. */
    @JavascriptInterface
    fun set(key: String, value: String): Boolean {
        val target = fileFor(key)
        val tmp = File(dir, target.name + ".tmp")
        return try {
            if (!dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create $dir")
            FileOutputStream(tmp).use { out ->
                out.write(value.toByteArray(Charsets.UTF_8))
                out.flush()
                out.fd.sync()
            }
            if (!tmp.renameTo(target)) throw IOException("rename " + tmp.name + " -> " + target.name + " failed")
            true
        } catch (e: Exception) {
            tmp.delete()
            android.util.Log.e("aio", "native store WRITE failed for $key: $e " +
                "— THIS CHANGE IS NOT SAVED")
            false
        }
    }

    /** For the page's boot line, so a developer can see where the state went. */
    @JavascriptInterface
    fun describe(): String = dir.absolutePath
}

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private var pendingCameraRequest: PermissionRequest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        // Packaged assets are served from an https origin via WebViewAssetLoader:
        // file:// is not a secure context, so navigator.mediaDevices (camera /
        // QR scanning) would never exist there.
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            // NOTE: the page above is an https origin, so it may not open a
            // plaintext ws:// or http:// connection. An app talking to a LAN
            // server over plain http renders perfectly and connects to nothing.
            // Serve that server over TLS (wss://), or add
            // `settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW`
            // here via an <app>/android/ overlay — it is a whole-app setting.
            settings.domStorageEnabled = true
            // The durable store, for a standalone APK only — see AioNativeStore
            // for why that condition is the security boundary. A client or dev
            // APK keeps the WebView's own localStorage: it holds a server
            // address, not the app's state, and the state lives on the server.
            if (!TALKS_TO_SERVER) {
                addJavascriptInterface(AioNativeStore(File(filesDir, "aio-store")), STORE_GLOBAL)
            }
            webViewClient = object : WebViewClient() {
                // The bridge belongs to the app's own bundle and to nothing
                // else. A standalone APK cannot navigate away from it, so this
                // should never fire — which is the point: an invariant that is
                // checked cannot quietly stop being true.
                override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    if (!TALKS_TO_SERVER && Uri.parse(url ?: "").host != ASSET_HOST) {
                        view?.removeJavascriptInterface(STORE_GLOBAL)
                        android.util.Log.e("aio", "$STORE_GLOBAL removed: this WebView loaded " +
                            "$url, which is not the app's own bundle. The native store is " +
                            "never handed to foreign content.")
                    }
                }
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                    val url = request?.url ?: return null
                    return assetLoader.shouldInterceptRequest(url)
                }
                // A client whose server cannot be reached: the connect form,
                // saying so — not Chromium's "Webpage not available".
                override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                    if (IS_CLIENT && request?.isForMainFrame == true && request.url.host != ASSET_HOST) {
                        view?.loadUrl("https://$ASSET_HOST/assets/index.html#unreachable")
                    }
                }
                override fun shouldOverrideUrlLoading(view: WebView?, request: android.webkit.WebResourceRequest?): Boolean {
                    val uri = request?.url ?: return false
                    if (uri.host == ASSET_HOST) return false
                    // An APK that talks to a server (a client, or a dev build):
                    // the connect page opening that server, and the server's own
                    // pages, ARE the app — they stay in this WebView. This used
                    // to return true for every non-asset URL, so a client APK
                    // could never leave its connect page.
                    if (TALKS_TO_SERVER && (uri.scheme == "http" || uri.scheme == "https")) {
                        val here = view?.url?.let { Uri.parse(it) }
                        if (here == null || here.host == ASSET_HOST || here.host == uri.host) return false
                    }
                    // Anything else (another site, mailto:, tel:) opens outside
                    // the app — it used to be swallowed without a sound.
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                    } catch (e: ActivityNotFoundException) {
                        android.util.Log.w("aio", "no app on this device opens $uri")
                    }
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                // getUserMedia inside the WebView: grant the page camera access
                // once the OS-level CAMERA permission is in hand (asking for it
                // on demand when missing).
                override fun onPermissionRequest(request: PermissionRequest) {
                    if (!request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                        // Denied, but never in silence: the page asked for
                        // something this shell does not hand out, and a dead
                        // microphone with no line in logcat is an evening lost.
                        android.util.Log.w("aio", "WebView permission request DENIED: " +
                            request.resources.joinToString(", ") +
                            " \u2014 this APK grants camera (video capture) only. Anything " +
                            "else needs native code: add it under <app>/android/ " +
                            "(docs/build/targets.md).")
                        request.deny()
                        return
                    }
                    if (!CAMERA_DECLARED) {
                        // The page called getUserMedia and this APK never
                        // declared CAMERA, so Android would refuse the runtime
                        // permission and the page would see a bare
                        // NotAllowedError. Say which key turns it on.
                        android.util.Log.e("aio", "camera DENIED: this page asked for the camera, " +
                            "but the APK does not declare android.permission.CAMERA. " +
                            "It is opt-in: add \"android\": { \"camera\": true } to your " +
                            "deno.json and rebuild (docs/build/targets.md#the-camera-is-opt-in).")
                        request.deny()
                        return
                    }
                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA)
                        == PackageManager.PERMISSION_GRANTED
                    ) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                        pendingCameraRequest = request
                        ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.CAMERA), 1)
                    }
                }
            }
            loadUrl("https://appassets.androidplatform.net/assets/index.html")
        }
        // targetSdk 35 puts every activity edge-to-edge by DEFAULT on Android
        // 15+. Measured on API 35 without this: the page drew UNDER the status
        // bar — "AIO Counter" and the clock on the same pixels. So the WebView
        // sits in a frame that carries the bars as padding, and the page keeps
        // the area it had before the bump on every API level. (The frame, not
        // the WebView itself: a WebView consumes insets for its own IME
        // handling, and a listener on it never ran.) This is the
        // forward-compatible fix — the opt-out flag is gone in Android 16.
        val root = FrameLayout(this)
        root.addView(webView)
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(root)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val request = pendingCameraRequest ?: return
        pendingCameraRequest = null
        if (requestCode == 1 && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            request.deny()
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack()
        // A client APK: the connect page sends every launch straight to the
        // server, and that redirect REPLACES it in history — so Back from the
        // server's first page is the one way back to the form (a server that
        // moved, or an error page when it is gone). `#change` = stay on it.
        else if (IS_CLIENT && Uri.parse(webView.url ?: "").host != ASSET_HOST) {
            webView.loadUrl("https://$ASSET_HOST/assets/index.html#change")
        } else super.onBackPressed()
    }
}
