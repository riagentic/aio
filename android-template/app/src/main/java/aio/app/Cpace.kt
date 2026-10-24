package aio.app

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * CPace (draft-irtf-cfrg-cpace-21, suite CPACE-X25519-SHA512) and aio's
 * pairing exchange on it — the Kotlin port of src/server/cpace.ts, held to
 * the same vectors (the draft's Appendix B.1, and aio's golden vector:
 * tests/cpace-vectors.ts, run on a JVM by tests/pairing-pake-kotlin.test.ts).
 *
 * X25519 is written out here (RFC 7748 §5, BigInteger) rather than taken
 * from the platform: Android's KeyAgreement "XDH"/"X25519" exists only from
 * API 33, and this client's floor is API 29. One code path on every API
 * level, and the JVM test runs exactly the code the phone runs. BigInteger
 * is not constant-time; the scalar is a fresh random one per exchange, used
 * once, on the client — a timing channel would have to be read from the
 * phone during that one exchange. SHA-512/256, HMAC, AES-GCM are the
 * platform's (javax.crypto — every API level).
 */
internal object Cpace {
    const val SUITE = "CPACE-X25519-SHA512"
    private val P: BigInteger = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19))
    private val A: BigInteger = BigInteger.valueOf(486662)
    private val A24: BigInteger = BigInteger.valueOf(121665)
    private val TWO: BigInteger = BigInteger.valueOf(2)
    private val rng = SecureRandom()

    fun cat(vararg parts: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        for (p in parts) out.write(p)
        return out.toByteArray()
    }

    /** LEB128 length, then the bytes (draft A.1.1). */
    fun prependLen(data: ByteArray): ByteArray {
        val len = java.io.ByteArrayOutputStream()
        var n = data.size
        do {
            len.write(if (n < 128) n else (n and 0x7f) + 0x80)
            n = n shr 7
        } while (n != 0)
        return cat(len.toByteArray(), data)
    }

    fun lvCat(vararg args: ByteArray): ByteArray = cat(*args.map { prependLen(it) }.toTypedArray())

    fun generatorString(dsi: ByteArray, prs: ByteArray, ci: ByteArray, sid: ByteArray, sInBytes: Int): ByteArray {
        val zpad = maxOf(0, sInBytes - 1 - prependLen(prs).size - prependLen(dsi).size)
        return lvCat(dsi, prs, ByteArray(zpad), ci, sid)
    }

    private fun leToN(b: ByteArray): BigInteger = BigInteger(1, b.reversedArray())

    private fun nToLe(n: BigInteger): ByteArray {
        val out = ByteArray(32)
        var v = n
        for (i in 0 until 32) {
            out[i] = v.toInt().toByte()
            v = v.shiftRight(8)
        }
        return out
    }

    fun sha512(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-512").digest(b)
    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    private fun inv(x: BigInteger): BigInteger = x.modPow(P.subtract(TWO), P)

    /** draft Appendix A.5 elligator2(r, q, A, 255), Z = 2. */
    private fun elligator2(r: BigInteger): BigInteger {
        val v = A.negate().multiply(inv(BigInteger.ONE.add(TWO.multiply(r).multiply(r)).mod(P))).mod(P)
        val eps = v.pow(3).add(A.multiply(v.pow(2))).add(v).mod(P).modPow(P.subtract(BigInteger.ONE).shiftRight(1), P)
        return eps.multiply(v).subtract(BigInteger.ONE.subtract(eps).multiply(A).multiply(inv(TWO))).mod(P)
    }

    fun calculateGenerator(prs: ByteArray, ci: ByteArray, sid: ByteArray): ByteArray {
        val h = sha512(generatorString("CPace255".toByteArray(Charsets.US_ASCII), prs, ci, sid, 128)).copyOf(32)
        h[31] = (h[31].toInt() and 0x7f).toByte() // decodeUCoordinate, 255 bits
        return nToLe(elligator2(leToN(h)))
    }

    /** RFC 7748 §5 X25519(k, u). */
    fun x25519(k: ByteArray, u: ByteArray): ByteArray {
        val kk = k.copyOf(32)
        kk[0] = (kk[0].toInt() and 248).toByte()
        kk[31] = ((kk[31].toInt() and 127) or 64).toByte()
        val uu = u.copyOf(32)
        uu[31] = (uu[31].toInt() and 127).toByte()
        val scalar = leToN(kk)
        val x1 = leToN(uu).mod(P)
        var x2 = BigInteger.ONE
        var z2 = BigInteger.ZERO
        var x3 = x1
        var z3 = BigInteger.ONE
        var swap = 0
        for (t in 254 downTo 0) {
            val kt = if (scalar.testBit(t)) 1 else 0
            swap = swap xor kt
            if (swap == 1) {
                x2 = x3.also { x3 = x2 }
                z2 = z3.also { z3 = z2 }
            }
            swap = kt
            val a = x2.add(z2).mod(P)
            val aa = a.multiply(a).mod(P)
            val b = x2.subtract(z2).mod(P)
            val bb = b.multiply(b).mod(P)
            val e = aa.subtract(bb).mod(P)
            val c = x3.add(z3).mod(P)
            val d = x3.subtract(z3).mod(P)
            val da = d.multiply(a).mod(P)
            val cb = c.multiply(b).mod(P)
            x3 = da.add(cb).pow(2).mod(P)
            z3 = x1.multiply(da.subtract(cb).pow(2)).mod(P)
            x2 = aa.multiply(bb).mod(P)
            z2 = e.multiply(aa.add(A24.multiply(e))).mod(P)
        }
        if (swap == 1) {
            x2 = x3.also { x3 = x2 }
            z2 = z3.also { z3 = z2 }
        }
        return nToLe(x2.multiply(inv(z2)).mod(P))
    }

    /** G_X25519.scalar_mult_vfy — G.I (32 zero bytes) is the abort case. */
    fun scalarMultVfy(y: ByteArray, u: ByteArray): ByteArray = x25519(y, u)

    fun isNeutral(k: ByteArray): Boolean = k.all { it.toInt() == 0 }

    fun isk(sid: ByteArray, k: ByteArray, ya: ByteArray, ada: ByteArray, yb: ByteArray, adb: ByteArray): ByteArray =
        sha512(cat(lvCat("CPace255_ISK".toByteArray(Charsets.US_ASCII), sid, k), lvCat(ya, ada), lvCat(yb, adb)))

    // ── aio's application layer (see src/server/cpace.ts) ──────────────────
    private fun hmac(alg: String, key: ByteArray, msg: ByteArray): ByteArray {
        val m = Mac.getInstance(alg)
        m.init(SecretKeySpec(key, alg))
        return m.doFinal(msg)
    }

    fun random(n: Int): ByteArray = ByteArray(n).also { rng.nextBytes(it) }

    fun channel(fp: ByteArray): ByteArray = lvCat("aio-pair-v1".toByteArray(Charsets.US_ASCII), fp)

    fun fingerprint(der: ByteArray?): ByteArray = if (der == null || der.isEmpty()) ByteArray(0) else sha256(der)

    /** RFC 5869 HKDF-SHA256, 32 bytes — WebCrypto's deriveKey on the TS side. */
    private fun boxKey(isk: ByteArray, sid: ByteArray): ByteArray {
        val prk = hmac("HmacSHA256", sid, isk)
        return hmac("HmacSHA256", prk, cat("aio-pair-v1 profile".toByteArray(Charsets.US_ASCII), byteArrayOf(1)))
    }

    class Start(val sid: ByteArray, val y: ByteArray, val ya: ByteArray)
    class Keys(val isk: ByteArray, val ta: ByteArray, val tb: ByteArray)

    private fun keys(sid: ByteArray, k: ByteArray, ya: ByteArray, ada: ByteArray, yb: ByteArray, adb: ByteArray): Keys {
        val i = isk(sid, k, ya, ada, yb, adb)
        val mac = sha512(cat("CPaceMac".toByteArray(Charsets.US_ASCII), sid, i))
        return Keys(i, hmac("HmacSHA512", mac, lvCat(ya, ada)), hmac("HmacSHA512", mac, lvCat(yb, adb)))
    }

    /** Initiator (this client), message 1. */
    fun start(pin: String, fp: ByteArray, y: ByteArray = random(32), sid: ByteArray = random(16)): Start {
        val g = calculateGenerator(pin.toByteArray(Charsets.UTF_8), channel(fp), sid)
        return Start(sid, y, scalarMultVfy(y, g))
    }

    /** Responder — the server's side, here for the vectors. null = abort. */
    fun respond(pin: String, fp: ByteArray, sid: ByteArray, ya: ByteArray, y: ByteArray): Pair<ByteArray, Keys>? {
        val g = calculateGenerator(pin.toByteArray(Charsets.UTF_8), channel(fp), sid)
        val yb = scalarMultVfy(y, g)
        val k = scalarMultVfy(y, ya)
        if (isNeutral(k)) return null
        return Pair(yb, keys(sid, k, ya, ByteArray(0), yb, fp))
    }

    /** Initiator, on the server's answer. null = abort. */
    fun finish(st: Start, yb: ByteArray, adb: ByteArray): Keys? {
        val k = scalarMultVfy(st.y, yb)
        if (isNeutral(k)) return null
        return keys(st.sid, k, st.ya, ByteArray(0), yb, adb)
    }

    fun seal(isk: ByteArray, sid: ByteArray, plain: String, iv: ByteArray = random(12)): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(boxKey(isk, sid), "AES"), GCMParameterSpec(128, iv))
        return cat(iv, c.doFinal(plain.toByteArray(Charsets.UTF_8)))
    }

    /** The profile text, or null when the box does not open under this key. */
    fun open(isk: ByteArray, sid: ByteArray, box: ByteArray): String? {
        if (box.size < 28) return null
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(boxKey(isk, sid), "AES"), GCMParameterSpec(128, box.copyOfRange(0, 12)))
            String(c.doFinal(box.copyOfRange(12, box.size)), Charsets.UTF_8)
        } catch (e: javax.crypto.AEADBadTagException) {
            null
        }
    }

    fun same(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

    fun b64(b: ByteArray): String = java.util.Base64.getEncoder().encodeToString(b)

    /** Base64 → bytes of `len` (any length when null); null otherwise. */
    fun unb64(s: String?, len: Int? = null): ByteArray? {
        if (s == null || s.length > 8192) return null
        val b = try { java.util.Base64.getDecoder().decode(s) } catch (e: IllegalArgumentException) { return null }
        return if (len == null || b.size == len) b else null
    }
}
