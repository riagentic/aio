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
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom

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
 *  string as NATIVE_STORE_GLOBAL (src/browser/native-fetch.ts, read by
 *  `_pickPersistStore`) — the only two places it appears. */
private const val STORE_GLOBAL = "AioNativeStore"
/** The global the store's per-launch key is handed to the app's own page
 *  under — by a document-start script restricted to the app's own origin, so
 *  a frame from any other origin never has it. The page names the same string
 *  as NATIVE_STORE_KEY_GLOBAL (src/browser/native-fetch.ts). */
private const val STORE_KEY_GLOBAL = "__aioNativeStoreKey"
/** The JS global the native fetch below is installed as. `nativeFetch()`
 *  names the same string in src/browser/native-fetch.ts — the only two places
 *  it appears. */
private const val FETCH_GLOBAL = "AioNativeFetch"
/** The native fetch's limits: the largest body carried either way, and the
 *  connect / between-bytes timeouts. */
private const val FETCH_MAX_BODY = 8 * 1024 * 1024
private const val FETCH_CONNECT_TIMEOUT_MS = 15_000
private const val FETCH_READ_TIMEOUT_MS = 30_000
/** When the WebView's renderer process was last lost (elapsedRealtime), and
 *  how soon after it a second loss is a loop — see `onRenderProcessGone`.
 *  Process-wide: it must outlive the activity `recreate()` replaces. */
private var lastRendererLoss = 0L
private const val RENDERER_LOSS_LOOP_MS = 10_000L

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
 *   3. `renameTo` puts them under the real name in one atomic step,
 *   4. the directory is fsync'd, so that rename survives a power cut too.
 * A reader therefore sees the whole previous value or the whole new one,
 * never half of either: a torn state file is worse than a lost change. `write`
 * returns only once step 3 is done, so the page's method has already survived
 * the kill by the time it returns.
 *
 * SECURITY — `addJavascriptInterface` hands these methods to EVERY page the
 * WebView loads, and to every FRAME of it — a third-party `<iframe>` the app
 * embeds included (`onPageStarted` sees the main frame only). So:
 *  - it is installed only when `TALKS_TO_SERVER` is false: a standalone APK,
 *    the one shape whose WebView can never show anything but its own bundled
 *    assets (`shouldOverrideUrlLoading` hands every other URL to an external
 *    Intent). A client or dev APK never gets the bridge at all, and
 *    `onPageStarted` removes it if a page from any other origin ever loads;
 *  - every method takes a KEY first: 32 random bytes made per launch, handed
 *    to the page by `addDocumentStartJavaScript` whose origin rule is the
 *    app's own asset origin — so a frame from any other origin sees an object
 *    whose every method throws. The key is compared in constant time.
 * The store reaches only this app's own `filesDir`, and its keys are
 * flattened to a leaf filename, so no key can walk out of that directory.
 * The file layout is the one 1.0.12 wrote: an upgrade reads its state as is.
 */
private class AioNativeStore(private val dir: File) {
    /** This launch's key — see SECURITY above. Hex, so it is a JS string
     *  literal as is. */
    val key: String = ByteArray(32).also { SecureRandom().nextBytes(it) }
        .joinToString("") { "%02x".format(it) }
    private val keyBytes = key.toByteArray(Charsets.US_ASCII)

    /** Throws for a caller without this launch's key: a foreign frame gets an
     *  exception from every method, never a value and never a write. */
    private fun admit(k: String) {
        if (!MessageDigest.isEqual(k.toByteArray(Charsets.US_ASCII), keyBytes)) {
            android.util.Log.e("aio", "native store call REFUSED: wrong key — " +
                "a frame that is not the app's own page tried to use it")
            throw SecurityException("AioNativeStore: wrong key")
        }
    }

    /** A key ("aio:myapp") → one leaf filename in `dir`. The readable part is
     *  sanitised so no separator survives, and the hash keeps two keys that
     *  sanitise alike from becoming one file. */
    private fun fileFor(key: String): File {
        val safe = key.replace(Regex("[^A-Za-z0-9._-]"), "_").take(64)
        return File(dir, safe + "." + Integer.toHexString(key.hashCode()) + ".json")
    }

    @JavascriptInterface
    fun read(k: String, key: String): String? {
        admit(k)
        return try {
            val f = fileFor(key)
            if (f.isFile) f.readText(Charsets.UTF_8) else null
        } catch (e: Exception) {
            // Loud: state that exists on disk and did not come back is the same
            // loss as state that was never written. The RETURN is still null, and
            // null also means "nothing written yet" — `exists` below is what keeps
            // the page from reading one as the other.
            android.util.Log.e("aio", "native store READ failed for $key: $e")
            null
        }
    }

    /** Is a value for this key ON DISK? — regardless of whether it could be
     *  read back.
     *
     *  `read` answers null for BOTH "never written" and "written, and this read
     *  threw" (an IO error, an OOM on a large state). The page's upgrade path
     *  adopts the previous build's `localStorage` copy on a null, and writes
     *  it in: on the second meaning that silently replaces the app's real
     *  state with a snapshot from before the upgrade, and reports it as a
     *  successful adoption. One nullable return cannot separate the two, so
     *  this does — a stat, it does not read the bytes.
     *
     *  Answering TRUE is the safe side (the page then refuses to overwrite),
     *  so only ENOENT answers "no". `File.isFile` is not enough: it answers
     *  false for a stat that FAILED (EACCES, EIO) as well — the same
     *  ambiguity one level down, and the first write then replaced the file
     *  it could not see. */
    @JavascriptInterface
    fun exists(k: String, key: String): Boolean {
        admit(k)
        return try {
            android.system.Os.stat(fileFor(key).absolutePath)
            true
        } catch (e: android.system.ErrnoException) {
            if (e.errno == android.system.OsConstants.ENOENT) return false
            android.util.Log.e("aio", "native store HAS failed for $key: $e")
            true
        } catch (e: Exception) {
            android.util.Log.e("aio", "native store HAS failed for $key: $e")
            true
        }
    }

    /** True when the value is on disk. False is a REAL failure — the page
     *  turns it into a thrown error rather than a silent no-op. */
    @JavascriptInterface
    fun write(k: String, key: String, value: String): Boolean {
        admit(k)
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
            syncDir()
            true
        } catch (e: Exception) {
            tmp.delete()
            android.util.Log.e("aio", "native store WRITE failed for $key: $e " +
                "— THIS CHANGE IS NOT SAVED")
            false
        }
    }

    /** Step 4: fsync the DIRECTORY, so the rename itself is on disk.
     *
     *  `fd.sync()` made the new bytes durable, but the name pointing at them
     *  is a directory entry, and a power cut before the directory is flushed
     *  can bring back the OLD name (the previous value, or no file at all on
     *  a first write). `android.system.Os` is the platform's own fsync on a
     *  directory fd (minSdk is 29); `FileInputStream` refuses a directory.
     *
     *  A filesystem that refuses fsync on a directory (EINVAL on some FUSE /
     *  sdcardfs mounts) does not undo anything: the rename happened and the
     *  contents are durable, only the power-cut window stays open. So `write`
     *  still answers true — but not in silence: one logcat warning per
     *  process, naming what is lost, rather than one per keystroke. */
    private var dirSyncRefusedSaid = false
    private fun syncDir() {
        var fd: java.io.FileDescriptor? = null
        try {
            fd = android.system.Os.open(dir.absolutePath, android.system.OsConstants.O_RDONLY, 0)
            android.system.Os.fsync(fd)
        } catch (e: Exception) {
            if (!dirSyncRefusedSaid) {
                dirSyncRefusedSaid = true
                android.util.Log.w("aio", "native store: this filesystem refused fsync on " +
                    "$dir ($e) — every change is still written and fsync'd, but a power " +
                    "cut right after one can bring back the previous value")
            }
        } finally {
            if (fd != null) try { android.system.Os.close(fd) } catch (ignored: Exception) {}
        }
    }

    /** For the page's boot line, so a developer can see where the state went. */
    @JavascriptInterface
    fun where(k: String): String {
        admit(k)
        return dir.absolutePath
    }
}

/**
 * `nativeFetch()` for a standalone APK: an HTTP request made by the app, not
 * by the WebView — so it carries no `Origin`, no `Referer`, no WebView cookie,
 * and no CORS check applies to its answer. Some public APIs refuse every
 * request that carries an Origin (a JSON-RPC answering 403), and a page in a
 * WebView can never send one without it.
 *
 * SECURITY — it is a network client with none of the browser's rules, so:
 *  - installed only when TALKS_TO_SERVER is false (a standalone APK), like the
 *    store, and removed again by `onPageStarted` on a foreign page;
 *  - through `addWebMessageListener` with the app's own asset origin as its
 *    only allowed origin. Unlike `addJavascriptInterface`, a frame from any
 *    other origin (an embedded third-party iframe) never sees the object;
 *  - http and https only: `URL.openConnection` would read a `file:` URL,
 *    this app's own files included;
 *  - no cookie jar: HttpURLConnection shares nothing with the WebView's
 *    CookieManager, and this app installs no CookieHandler; `Set-Cookie` is
 *    not handed back (a page's `fetch` never sees it either);
 *  - bounded: FETCH_CONNECT_TIMEOUT_MS to connect, FETCH_READ_TIMEOUT_MS
 *    between bytes, FETCH_MAX_BODY per body each way;
 *  - cleartext stays under the manifest's rule, which for a standalone APK is
 *    none: an `http://` URL fails exactly as it does in the WebView.
 * The work runs on a small pool, never on the UI thread; the answer goes back
 * on the UI thread, as JSON the page matches to its request by `id`.
 */
private val fetchPool by lazy { java.util.concurrent.Executors.newFixedThreadPool(4) }

private object AioNativeFetch : WebViewCompat.WebMessageListener {
    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        // The origin rule already guarantees this; a second check costs nothing.
        if (sourceOrigin.host != ASSET_HOST) return
        val raw = message.data ?: return
        fetchPool.execute {
            val reply = org.json.JSONObject()
            try {
                val req = org.json.JSONObject(raw)
                reply.put("id", req.getInt("id"))
                perform(req, reply)
            } catch (e: Exception) {
                reply.put("error", e.toString())
            }
            view.post { replyProxy.postMessage(reply.toString()) }
        }
    }

    private fun perform(req: org.json.JSONObject, reply: org.json.JSONObject) {
        val url = java.net.URL(req.getString("url"))
        if (url.protocol != "https" && url.protocol != "http") {
            throw IOException("only http and https URLs, not " + url.protocol + ":")
        }
        val conn = url.openConnection() as java.net.HttpURLConnection
        try {
            conn.connectTimeout = FETCH_CONNECT_TIMEOUT_MS
            conn.readTimeout = FETCH_READ_TIMEOUT_MS
            conn.useCaches = false
            conn.requestMethod = req.getString("method")
            val headers = req.getJSONArray("headers")
            for (i in 0 until headers.length()) {
                val h = headers.getJSONArray(i)
                conn.addRequestProperty(h.getString(0), h.getString(1))
            }
            if (!req.isNull("body")) {
                val body = android.util.Base64.decode(req.getString("body"), android.util.Base64.NO_WRAP)
                if (body.size > FETCH_MAX_BODY) throw IOException("request body over $FETCH_MAX_BODY bytes")
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            }
            val status = conn.responseCode
            val out = java.io.ByteArrayOutputStream()
            (if (status >= 400) conn.errorStream else conn.inputStream)?.use { s ->
                val buf = ByteArray(16384)
                while (true) {
                    val n = s.read(buf)
                    if (n < 0) break
                    if (out.size() + n > FETCH_MAX_BODY) throw IOException("response body over $FETCH_MAX_BODY bytes")
                    out.write(buf, 0, n)
                }
            }
            val hs = org.json.JSONArray()
            for ((k, vs) in conn.headerFields) {
                if (k == null || k.equals("set-cookie", ignoreCase = true)) continue
                hs.put(org.json.JSONArray().put(k).put(vs.joinToString(", ")))
            }
            reply.put("status", status)
                .put("statusText", conn.responseMessage ?: "")
                .put("headers", hs)
                .put("body", android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP))
        } finally {
            conn.disconnect()
        }
    }
}

/** The JS global the pairing bridge below is installed as — on the connect
 *  page of a client APK only (`_writeConnectPage` in build-android.ts). */
private const val CONNECT_GLOBAL = "AioConnect"

/** Is `der` (the certificate a server presented) covered by `pin`?
 *  A pin is the certificate file an aio server serves — its leaf, then the
 *  app's own root — as a pairing reply carries it. It is met by the exact
 *  certificate, or by one SIGNED by a certificate in the pin (the root: the
 *  leaf is re-issued whenever the machine's addresses change). The signature
 *  is verified. The same rule the desktop client applies (`pinMatches`). */
private fun pinMatches(pin: String, der: ByteArray): Boolean {
    val bodies = pin.replace(Regex("\\s+"), "").split(Regex("-----[A-Z0-9]+-----")).filter { it.isNotEmpty() }
    if (bodies.contains(android.util.Base64.encodeToString(der, android.util.Base64.NO_WRAP))) return true
    return try {
        val cf = java.security.cert.CertificateFactory.getInstance("X.509")
        val leaf = cf.generateCertificate(der.inputStream())
        bodies.any { b ->
            try {
                leaf.verify(cf.generateCertificate(android.util.Base64.decode(b, android.util.Base64.DEFAULT).inputStream()).publicKey)
                true
            } catch (e: Exception) {
                false
            }
        }
    } catch (e: Exception) {
        false
    }
}

/** `host:port` — what a pin is stored under. */
private fun authority(host: String?, port: Int): String = (host ?: "") + ":" + (if (port > 0) port else 443)

/**
 * A client APK and a server whose certificate Android does not trust — every
 * server run with `--expose` signs its own. The WebView alone can only refuse
 * it. The connect page asks this bridge one of two questions, and a server
 * that answers is PINNED: `onReceivedSslError` then lets exactly that
 * certificate (or one its root signed) through, for that host:port only.
 *
 *  - `{ base, pin }`: the pairing code the app shows (`am pair`). POST
 *    /__aio/pair → the app's key and its certificate file.
 *  - `{ base, key }`: a share link's key. POST /__aio/pin-proof — the server
 *    proves it holds the same key, ON the certificate it is presenting
 *    (src/server/pin-proof.ts), so something answering in its place cannot.
 *
 * Both requests are made without judging the certificate — they are the
 * question that decides whether to trust it — and what was presented is
 * captured and must be the one the answer names. This is what the desktop
 * client does (electron-client-script.ts: `pairWith`, `askProof`).
 *
 * It also REMEMBERS the address the form opened (`{ remember }`, answered at
 * the next launch by `{ recall }`). The form kept it in `localStorage` alone,
 * and the WebView commits that to disk on its own lazy schedule. Measured on
 * an API 35 emulator: a kill within a second of pairing brought the client
 * back to "needs its key" — the pairing was gone, and a pairing code works
 * once. `commit()` returns once the value is on disk, and the form opens the
 * server only after that.
 *
 * SECURITY — installed only when IS_CLIENT, through `addWebMessageListener`
 * with the app's own asset origin as its only allowed origin: the server's
 * pages never see it. It POSTs two fixed paths and nothing else. The
 * remembered address (a share link carries the server's key) stays in this
 * app's private preferences, beside the pins — where `localStorage` is too.
 */
private class AioConnect(private val pins: android.content.SharedPreferences) : WebViewCompat.WebMessageListener {
    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        if (sourceOrigin.host != ASSET_HOST || !isMainFrame) return
        val raw = message.data ?: return
        fetchPool.execute {
            val reply = org.json.JSONObject()
            try {
                val req = org.json.JSONObject(raw)
                reply.put("id", req.getInt("id"))
                if (req.has("remember")) {
                    // No colon: never the `host:port` a pin is stored under.
                    val kept = pins.edit().putString("server", req.getString("remember")).commit()
                    if (!kept) android.util.Log.e("aio", "the server address could NOT be saved — " +
                        "this client may ask for it (and its key) again at the next launch")
                    reply.put("remembered", kept)
                } else if (req.has("recall")) {
                    reply.put("server", pins.getString("server", "") ?: "")
                } else {
                    val base = java.net.URL(req.getString("base"))
                    if (base.protocol != "https" && base.protocol != "http") throw IOException("not an http(s) address")
                    if (req.has("pin")) pair(base, req.getString("pin"), reply)
                    else prove(base, req.getString("key"), reply)
                }
            } catch (e: Exception) {
                reply.put("error", e.toString())
            }
            view.post { replyProxy.postMessage(reply.toString()) }
        }
    }

    private class Answer(val status: Int, val json: org.json.JSONObject?, val der: ByteArray?)

    private fun post(base: java.net.URL, path: String, body: org.json.JSONObject): Answer {
        val conn = java.net.URL(base.protocol, base.host, base.port, path).openConnection() as java.net.HttpURLConnection
        var der: ByteArray? = null
        if (conn is javax.net.ssl.HttpsURLConnection) {
            val ctx = javax.net.ssl.SSLContext.getInstance("TLS")
            ctx.init(null, arrayOf<javax.net.ssl.TrustManager>(@android.annotation.SuppressLint("CustomX509TrustManager") object : javax.net.ssl.X509TrustManager {
                override fun checkClientTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) {}
                // Captured, not judged: the caller compares it with the answer.
                @android.annotation.SuppressLint("TrustAllX509TrustManager")
                override fun checkServerTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) {
                    der = chain[0].encoded
                }
                override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf()
            }), null)
            conn.sslSocketFactory = ctx.socketFactory
            conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        }
        try {
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            conn.useCaches = false
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            val bytes = body.toString().toByteArray(Charsets.UTF_8)
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.outputStream.use { it.write(bytes) }
            val status = conn.responseCode
            val text = (if (status >= 400) conn.errorStream else conn.inputStream)?.use { s ->
                val out = java.io.ByteArrayOutputStream()
                val buf = ByteArray(8192)
                while (out.size() < 65536) {
                    val n = s.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                }
                out.toString("UTF-8")
            } ?: ""
            val json = try { org.json.JSONObject(text) } catch (e: Exception) { null }
            return Answer(status, json, der)
        } finally {
            conn.disconnect()
        }
    }

    private fun pin(base: java.net.URL, cert: String) {
        // commit, not apply: on disk before the form is told it may go on.
        pins.edit().putString(authority(base.host, if (base.port > 0) base.port else base.defaultPort), cert).commit()
    }

    private fun pair(base: java.net.URL, code: String, reply: org.json.JSONObject) {
        val a = post(base, "/__aio/pair", org.json.JSONObject().put("pin", code))
        reply.put("status", a.status)
        val key = a.json?.optString("key", "") ?: ""
        if (a.status != 200 || key.isEmpty()) return
        if (base.protocol == "https") {
            val cert = a.json?.optString("cert", "") ?: ""
            val der = a.der
            if (cert.isEmpty() || der == null || !pinMatches(cert, der)) {
                throw IOException("the certificate this server presented is not the one the app says it serves")
            }
            pin(base, cert)
        }
        reply.put("key", key)
    }

    private fun hmacHex(key: String, msg: String): String {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(msg.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    private fun prove(base: java.net.URL, key: String, reply: org.json.JSONObject) {
        val nonce = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val a = post(base, "/__aio/pin-proof", org.json.JSONObject()
            .put("nonce", nonce).put("tag", hmacHex(key, "aio-pin-proof-v1:c:$nonce")))
        val proof = a.json?.optString("proof", "") ?: ""
        val cert = a.json?.optString("cert", "") ?: ""
        val der = a.der
        val want = hmacHex(key, "aio-pin-proof-v1:s:$nonce:" + cert.replace(Regex("\\s+"), ""))
        val proved = a.status == 200 && cert.isNotEmpty() && der != null &&
            MessageDigest.isEqual(proof.toByteArray(Charsets.US_ASCII), want.toByteArray(Charsets.US_ASCII)) &&
            pinMatches(cert, der)
        if (proved) pin(base, cert)
        reply.put("status", a.status).put("proved", proved)
    }
}

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private var pendingCameraRequest: PermissionRequest? = null
    /** `<input type="file">`: the page's callback, held while the system's
     *  picker is open. It MUST be answered exactly once — null included (the
     *  user backed out) — or the WebView never opens a picker again. */
    private var pendingFiles: android.webkit.ValueCallback<Array<Uri>>? = null
    private val filePicker = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        val picked: Array<Uri>? = if (result.resultCode != RESULT_OK || data == null) null
            else data.clipData?.let { c -> Array(c.itemCount) { c.getItemAt(it).uri } }
                ?: data.data?.let { arrayOf(it) }
        pendingFiles?.onReceiveValue(picked)
        pendingFiles = null
    }

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
                val store = AioNativeStore(File(filesDir, "aio-store"))
                addJavascriptInterface(store, STORE_GLOBAL)
                // The key reaches the app's own origin only (its main frame
                // and same-origin frames), before any of the page's scripts.
                // A WebView without the feature gets the bridge but no key:
                // the page then refuses to use the store, saying why, rather
                // than fall back to one that loses changes or leaks them.
                if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    WebViewCompat.addDocumentStartJavaScript(this,
                        "Object.defineProperty(window, \"" + STORE_KEY_GLOBAL + "\", { value: \"" +
                            store.key + "\" });",
                        setOf("https://" + ASSET_HOST))
                } else {
                    android.util.Log.e("aio", STORE_GLOBAL + " key not handed out: this WebView " +
                        "has no DOCUMENT_START_SCRIPT, so the app can neither read nor save its " +
                        "state. Update Android System WebView.")
                }
                // `nativeFetch()` — see AioNativeFetch. A WebView too old for
                // the listener gets none, and the page's nativeFetch() then
                // fails saying so rather than sending an Origin after all.
                if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                    WebViewCompat.addWebMessageListener(this, FETCH_GLOBAL, setOf("https://$ASSET_HOST"), AioNativeFetch)
                } else {
                    android.util.Log.e("aio", "$FETCH_GLOBAL not installed: this WebView has no " +
                        "WEB_MESSAGE_LISTENER — nativeFetch() will fail. Update Android System WebView.")
                }
            }
            // The connect page's pairing bridge — see AioConnect. Its pins
            // are this app's private preferences.
            val pins = getSharedPreferences("aio-pins", MODE_PRIVATE)
            if (IS_CLIENT && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.addWebMessageListener(this, CONNECT_GLOBAL, setOf("https://$ASSET_HOST"), AioConnect(pins))
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
                        if (view != null && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                            WebViewCompat.removeWebMessageListener(view, FETCH_GLOBAL)
                        }
                        android.util.Log.e("aio", "$STORE_GLOBAL removed: this WebView loaded " +
                            "$url, which is not the app's own bundle. The native store is " +
                            "never handed to foreign content.")
                    }
                }
                // The page runs in the WebView's own renderer PROCESS, and
                // Android takes that process back on its own when memory is
                // short. Unanswered, the WebView then aborts the whole app.
                // Measured (chrome://crash and chrome://kill) on a phone
                // (Android 14, WebView 141): "Render process's crash wasn't
                // handled by all associated webviews, triggering application
                // crash" — the app gone from the screen, the launcher in its
                // place. So: the dead WebView is dropped and the activity
                // built again — the page reloads, and what a method committed
                // comes back from the store (a client: from its server). A
                // second loss within RENDERER_LOSS_LOOP_MS is a page that
                // kills its renderer on load: no loop, the app stops as it
                // did before.
                override fun onRenderProcessGone(view: WebView?, detail: android.webkit.RenderProcessGoneDetail?): Boolean {
                    val now = android.os.SystemClock.elapsedRealtime()
                    val loop = lastRendererLoss != 0L && now - lastRendererLoss < RENDERER_LOSS_LOOP_MS
                    lastRendererLoss = now
                    android.util.Log.e("aio", "the WebView's renderer process " +
                        (if (detail?.didCrash() == true) "CRASHED" else "was KILLED by the system (memory)") +
                        (if (loop) " again within " + RENDERER_LOSS_LOOP_MS / 1000 + " s — not reloading in a loop; the app stops"
                        else " — the page is reloaded; anything typed and not yet sent to a method is lost"))
                    if (loop) return false
                    (view?.parent as? android.view.ViewGroup)?.removeView(view)
                    view?.destroy()
                    recreate()
                    return true
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
                // …and one that answers 401 at its root: a keyed server reached
                // without its key. The form, saying what it needs — not the
                // server's bare "Unauthorized".
                override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) {
                    if (IS_CLIENT && request?.isForMainFrame == true && errorResponse?.statusCode == 401 &&
                        request.url.host != ASSET_HOST && (request.url.path ?: "/") == "/"
                    ) {
                        view?.loadUrl("https://$ASSET_HOST/assets/index.html#keyed")
                    }
                }
                // …and one whose certificate Android does not trust (a server
                // run with `--expose` signs its own unless told otherwise).
                // A certificate this client PINNED for that host:port — by a
                // pairing code or a share link's key, see AioConnect — is let
                // through; any other is refused, and the form says which case
                // it is. (The default only cancels the load: the form stayed
                // as it was, a tap on Connect doing nothing at all.)
                override fun onReceivedSslError(view: WebView?, handler: android.webkit.SslErrorHandler?, error: android.net.http.SslError?) {
                    val to = Uri.parse(error?.url ?: "")
                    val pin = if (IS_CLIENT) pins.getString(authority(to.host, to.port), null) else null
                    val der = error?.certificate?.let {
                        android.net.http.SslCertificate.saveState(it)?.getByteArray("x509-certificate")
                    }
                    if (pin != null && der != null && pinMatches(pin, der)) {
                        handler?.proceed()
                        return
                    }
                    handler?.cancel()
                    val from = view?.url?.let { Uri.parse(it).host }
                    if (IS_CLIENT && from == ASSET_HOST && to.host != ASSET_HOST) {
                        android.util.Log.e("aio", "certificate not trusted: " + error?.url + " ($error)" +
                            (if (pin != null) " — not the one pinned for this server" else ""))
                        view?.loadUrl("https://$ASSET_HOST/assets/index.html" + (if (pin != null) "#changed" else "#untrusted"))
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
            // A download — `<a download>`, a `blob:` or `data:` link, a
            // response the WebView cannot show. A WebView saves nothing by
            // itself, and with no listener the tap did NOTHING and said
            // nothing (measured on a phone, Android 14). A link on the network
            // goes to Android's DownloadManager — into Downloads, with the
            // system's own notification, carrying this page's cookies (a
            // signed-in server). A `blob:` or `data:` URL lives in this page
            // only, so nothing outside it can fetch it — refused, saying so.
            setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
                val uri = Uri.parse(url ?: "")
                if (uri.scheme == "http" || uri.scheme == "https") {
                    try {
                        val name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType)
                        val req = android.app.DownloadManager.Request(uri)
                            .setMimeType(mimeType)
                            .addRequestHeader("User-Agent", userAgent)
                            .setTitle(name)
                            .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                            .setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name)
                        android.webkit.CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
                        (getSystemService(DOWNLOAD_SERVICE) as android.app.DownloadManager).enqueue(req)
                        android.util.Log.i("aio", "download started: $name (Downloads)")
                    } catch (e: Exception) {
                        android.util.Log.e("aio", "download NOT started: $uri ($e)")
                    }
                } else {
                    android.util.Log.e("aio", "download NOT saved: a " + (uri.scheme ?: "?") + ": link (" + mimeType +
                        ") — this APK's WebView cannot write a file the page made. " +
                        "Saving one needs native code: add it under <app>/android/ " +
                        "(docs/build/targets.md).")
                }
            }
            webChromeClient = object : WebChromeClient() {
                // `<input type="file">`: the system's own picker (no permission
                // — the user hands over exactly the files they pick). Without
                // this a tap on the input did nothing at all, in every APK.
                override fun onShowFileChooser(
                    view: WebView?,
                    callback: android.webkit.ValueCallback<Array<Uri>>?,
                    params: FileChooserParams?,
                ): Boolean {
                    pendingFiles?.onReceiveValue(null)
                    pendingFiles = callback
                    try {
                        val intent = params?.createIntent()
                            ?: Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE)
                        // A type that is no MIME type (an `accept` of file
                        // extensions) would match nothing: any file then.
                        if (intent.type?.contains('/') != true) intent.type = "*/*"
                        if (params?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                        }
                        filePicker.launch(intent)
                    } catch (e: ActivityNotFoundException) {
                        android.util.Log.e("aio", "<input type=file>: no app on this device picks a file ($e)")
                        pendingFiles = null
                        callback?.onReceiveValue(null)
                    }
                    return true
                }
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

    /** Back asks the PAGE first: `window.__aioBack()` is aio/air's
     *  `onBackButton` (src/air/back-button.ts), true when a handler took it.
     *  `evaluateJavascript` needs no user gesture, so the first Back after a
     *  cold start reaches the app too — `history.pushState` cannot promise
     *  that. No handler, a page without aio, or one still loading → default. */
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        webView.evaluateJavascript(
            "typeof __aioBack == 'function' && __aioBack() === true"
        ) { handled -> if (handled != "true") defaultBack() }
    }

    @Suppress("DEPRECATION")
    private fun defaultBack() {
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
