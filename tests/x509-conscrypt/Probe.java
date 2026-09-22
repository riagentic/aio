// Conscrypt TrustManager probe — the path Android's HttpsURLConnection uses.
//
// Built by tests/x509-conscrypt.test.ts. Speak one line to stdout:
//   <case> ACCEPT
//   <case> REFUSE:<root-cause>
// stderr carries provider/version for the ledger.
//
// Do NOT read a REFUSE on checkServerTrusted(emailProtection leaf) as an
// anchor-EKU measurement: Conscrypt's ExtendedKeyUsagePKIXCertPathChecker
// refuses the LEAF for lacking serverAuth. Anchor EKU is measured with
// checkClientTrusted on a clientAuth leaf instead.
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.KeyStore;
import java.security.Security;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import org.conscrypt.Conscrypt;

public final class Probe {
  private Probe() {}

  static X509Certificate load(String path) throws Exception {
    try (InputStream in = new FileInputStream(path)) {
      return (X509Certificate) CertificateFactory.getInstance("X.509")
        .generateCertificate(in);
    }
  }

  public static void main(String[] args) throws Exception {
    if (args.length < 4) {
      System.err.println(
        "usage: Probe <case> <server|client> <trust.pem> <leaf.pem> [extras...]"
      );
      System.exit(2);
    }
    String name = args[0];
    String mode = args[1];
    Security.insertProviderAt(Conscrypt.newProvider(), 1);
    System.err.println(
      "provider=Conscrypt version=" +
      Conscrypt.version().major() + "." +
      Conscrypt.version().minor() + "." +
      Conscrypt.version().patch()
    );

    X509Certificate trust = load(args[2]);
    List<X509Certificate> chain = new ArrayList<>();
    for (int i = 3; i < args.length; i++) chain.add(load(args[i]));

    // Seed the trust store with the anchor. Putting the root only in the
    // peer chain (the Windows ExtraStore mistake) makes name-constraint
    // checks look like they pass when the instrument is simply blind.
    KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
    ks.load(null);
    ks.setCertificateEntry("aio-root", trust);
    TrustManagerFactory tmf = TrustManagerFactory.getInstance(
      TrustManagerFactory.getDefaultAlgorithm(),
      Conscrypt.newProvider()
    );
    tmf.init(ks);
    X509TrustManager tm = null;
    for (TrustManager t : tmf.getTrustManagers()) {
      if (t instanceof X509TrustManager) {
        tm = (X509TrustManager) t;
        break;
      }
    }
    if (tm == null) throw new IllegalStateException("no X509TrustManager");

    X509Certificate[] arr = chain.toArray(new X509Certificate[0]);
    try {
      if ("client".equals(mode)) tm.checkClientTrusted(arr, "RSA");
      else if ("server".equals(mode)) tm.checkServerTrusted(arr, "RSA");
      else throw new IllegalArgumentException("mode must be server|client");
      System.out.println(name + " ACCEPT");
    } catch (CertificateException e) {
      Throwable c = e;
      while (c.getCause() != null) c = c.getCause();
      String msg = c.getMessage() == null
        ? c.getClass().getSimpleName()
        : c.getMessage();
      msg = msg.replace('\n', ' ').replace('\r', ' ');
      System.out.println(name + " REFUSE:" + msg);
    }
  }
}
