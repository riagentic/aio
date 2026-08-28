import UIKit
import WebKit

/// The aio iOS client: a WKWebView that opens the packaged connect page
/// (`www/index.html`) and then navigates to the aio server the user (or the
/// build's `build.server`) named. There is no Deno runtime on iOS, so this
/// shell never runs the app — the server does, elsewhere; this is the same
/// shape as `android-client`.
class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // localStorage keeps the last server address across launches.
        config.websiteDataStore = WKWebsiteDataStore.default()
        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        if #available(iOS 16.4, *) {
            #if DEBUG
            webView.isInspectable = true
            #endif
        }
        view.addSubview(webView)

        guard let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "www") else {
            fatalError("aio: www/index.html is missing from the bundle — rebuild with `deno task build --targets=ios-client`")
        }
        webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
    }

    // Camera / microphone for pages that ask (QR scanning) — grant once the
    // OS permission is in hand; iOS prompts the user itself.
    @available(iOS 15.0, *)
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.prompt)
    }

    // A navigation the server page opens in a new window stays in this view.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil {
            webView.load(navigationAction.request)
        }
        return nil
    }
}
