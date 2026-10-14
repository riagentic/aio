import UIKit
import WebKit

/// The aio iOS client: a WKWebView that opens the packaged connect page
/// (`www/index.html`) and then navigates to the aio server the user (or the
/// build's `build.server`) named. There is no Deno runtime on iOS, so this
/// shell never runs the app — the server does, elsewhere; this is the same
/// shape as `android-client`.
class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    private var index: URL!

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
        self.index = index
        webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
    }

    /// Back to the connect form, saying why by HASH — the page reads it on
    /// load and on every hash change (`why()` in the connect page).
    private func showForm(_ why: String) {
        guard let url = URL(string: "#" + why, relativeTo: index) else { return }
        webView.loadFileURL(url.absoluteURL, allowingReadAccessTo: index.deletingLastPathComponent())
    }

    // A server that cannot be reached: the form, saying so. Without this the
    // failed load left the form as it was — a tap on Connect doing nothing.
    // Only URL-loading failures of a server address: a load this shell
    // cancelled itself (below, or a newer navigation) is not one.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        guard e.domain == NSURLErrorDomain, e.code != NSURLErrorCancelled else { return }
        guard let failed = e.userInfo[NSURLErrorFailingURLErrorKey] as? URL, !failed.isFileURL else { return }
        showForm("unreachable")
    }

    // …and one that answers 401 at its root: a keyed server opened without
    // its key. The form, saying what it needs — not a bare "Unauthorized".
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if navigationResponse.isForMainFrame,
           let http = navigationResponse.response as? HTTPURLResponse,
           http.statusCode == 401,
           let url = http.url, !url.isFileURL, url.path.isEmpty || url.path == "/" {
            decisionHandler(.cancel)
            showForm("keyed")
            return
        }
        decisionHandler(.allow)
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
