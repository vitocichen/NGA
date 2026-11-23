package com.vitocichen.ngalive;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * 和 iPhone 上的 Scriptable 脚本同一个做法：从 GitHub Pages 取实时版页面，以 https://bbs.nga.cn/ 为来源加载，
 * 页面里请求 NGA 就是同源的。页面内容都在线上，App 本身基本不用更新。
 */
public class MainActivity extends Activity {
    private static final String LIVE_URL = "https://vitocichen.github.io/NGA/live.html";
    private static final String BASE_URL = "https://bbs.nga.cn/nga_live";
    private static final String CACHE_FILE = "live.html";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(0x59, 0x18, 0x04));

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        // 登录页里的验证码来自第三方域名
        cookies.setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 实时版页面本身不会整页跳走；整页跳转的都是外部链接，交给系统浏览器
                if (!request.isForMainFrame()) return false;
                openExternal(request.getUrl());
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // target="_blank" 的链接（原帖、图片等）用系统浏览器打开
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView probe = new WebView(MainActivity.this);
                probe.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                        openExternal(r.getUrl());
                        v.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(probe);
                resultMsg.sendToTarget();
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "NgaApp");

        load();
    }

    private void load() {
        new Thread(() -> {
            String html = download();
            if (html != null) saveCache(html);
            else html = readCache();
            final String page = html != null ? html : errorPage();
            runOnUiThread(() -> web.loadDataWithBaseURL(BASE_URL, page, "text/html", "utf-8", null));
        }).start();
    }

    private String download() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(LIVE_URL + "?t=" + System.currentTimeMillis()).openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);
            conn.setUseCaches(false);
            if (conn.getResponseCode() != 200) return null;
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                String html = out.toString("UTF-8");
                return html.contains("NGA_LIVE") ? html : null;
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void saveCache(String html) {
        try (FileOutputStream out = new FileOutputStream(new File(getFilesDir(), CACHE_FILE))) {
            out.write(html.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
        }
    }

    private String readCache() {
        try {
            File f = new File(getFilesDir(), CACHE_FILE);
            return f.exists() ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8) : null;
        } catch (Exception e) {
            return null;
        }
    }

    private String errorPage() {
        return "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
                + "<body style='font:16px sans-serif;padding:40px 24px;color:#333;background:#fbf1d6'>"
                + "<p>页面加载失败，请检查网络。</p>"
                + "<button style='font-size:16px;padding:8px 24px' onclick='NgaApp.retry()'>重试</button></body></html>";
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
        }
    }

    private class Bridge {
        @JavascriptInterface
        public void retry() {
            runOnUiThread(MainActivity.this::load);
        }
    }

    // 返回键先交给页面：关面板、从帖子回到列表；页面不处理时才退出
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.__androidBack ? String(window.__androidBack()) : 'false'", v -> {
            if (!"\"true\"".equals(v)) finish();
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
        // 登录状态写到磁盘，下次打开不用重新登录
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
