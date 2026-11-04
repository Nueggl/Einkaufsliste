package com.nikni.einkaufsliste;

import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

/**
 * MainActivity lädt die Web-Anwendung aus dem "www"-Ordner über eine sichere
 * https://appassets.androidplatform.net/ Domain (via AndroidX WebViewAssetLoader).
 * Dadurch funktionieren ES6-Module (<script type="module">), Firebase Auth,
 * Firestore IndexedDB Offline-Persistenz und die Smartphone-Tastatur-Steuerung
 * nativ auf Android.
 */
public class MainActivity extends AppCompatActivity {

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Statusbar-Farbe passend zur App-Bar
        getWindow().setStatusBarColor(Color.parseColor("#1e293b"));

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Bereitstellung der lokalen Web-Dateien (aus ../www) unter https://appassets.androidplatform.net/assets/
        // Dies ist zwingend nötig, damit ES6-Module (import/export) und IndexedDB ohne CORS-Fehler laufen.
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                // Lokale Assets über den AssetLoader bedienen, externe Requests (z.B. Firebase gstatic CDN) normal durchlassen
                if ("appassets.androidplatform.net".equals(url.getHost())) {
                    return assetLoader.shouldInterceptRequest(url);
                }
                return super.shouldInterceptRequest(view, request);
            }
        });

        webView.setWebChromeClient(new WebChromeClient());

        // Starte die Einkaufslisten-App
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html");

        // Zurück-Taste des Smartphones: Schließt offene Overlays/Menüs oder geht im Verlauf zurück
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });
    }
}
