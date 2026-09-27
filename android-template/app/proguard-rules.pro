# R8 rules for the release build (isMinifyEnabled = true).
#
# The page calls the native store (AioNativeStore in MainActivity.kt) through
# addJavascriptInterface — by NAME, from JavaScript, where R8 cannot see the
# call. Without a keep rule R8 may remove or rename read/write/exists/where and
# a release APK loses its saved state in silence. AGP's default file carries
# this rule today; it is stated here so it never depends on that default.
# The annotation itself is what the WebView looks for, so it is kept too.
-keepattributes RuntimeVisibleAnnotations
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
