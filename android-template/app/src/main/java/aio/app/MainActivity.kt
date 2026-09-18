package aio.app

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebResourceError
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader

/** Filled at build time: true for a client APK and a dev build, false for a
 *  standalone APK (packaged assets only). One decider with the manifest's
 *  cleartext attribute — see `talksToServer` in build-android.ts. */
private const val TALKS_TO_SERVER = {{TALKS_TO_SERVER}}
private const val ASSET_HOST = "appassets.androidplatform.net"
/** Filled at build time: true only for a client APK (its packaged page is the
 *  connect form). A dev build talks to a server but packages no form. */
private const val IS_CLIENT = {{IS_CLIENT}}

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
            webViewClient = object : WebViewClient() {
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
        setContentView(webView)
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
