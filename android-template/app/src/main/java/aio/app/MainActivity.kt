package aio.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader

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
                override fun shouldOverrideUrlLoading(view: WebView?, request: android.webkit.WebResourceRequest?): Boolean {
                    val url = request?.url?.toString() ?: return false
                    return !url.startsWith("https://appassets.androidplatform.net/")
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
        else super.onBackPressed()
    }
}
