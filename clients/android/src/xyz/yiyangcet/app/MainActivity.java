package xyz.yiyangcet.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.*;
import android.view.View;
import android.view.WindowInsets;
import android.widget.*;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Small HTTPS-only online client. Authentication stays in this app's WebView profile. */
public final class MainActivity extends Activity {
    private static final String HOME = "https://yiyangcet.xyz/";
    private static final int PICK_FILE = 31;
    private WebView web;
    private ProgressBar progress;
    private LinearLayout error;
    private ValueCallback<Uri[]> fileResult;
    private boolean mainFrameFailed;
    private final Handler updateHandler=new Handler(Looper.getMainLooper());
    private final ExecutorService updateExecutor=Executors.newSingleThreadExecutor();
    private boolean resumed,checkingUpdate;
    private long lastUpdateCheck;
    private long lastPromptedAt;
    private String availableVersion,availableFile,lastPromptedVersion;
    private final Runnable updateTick=new Runnable(){public void run(){checkForUpdates();if(resumed)updateHandler.postDelayed(this,300000);}};

    private boolean internal(Uri uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
            && "yiyangcet.xyz".equalsIgnoreCase(uri.getHost()) && (uri.getPort() == -1 || uri.getPort() == 443);
    }
    private void external(Uri uri) {
        if (uri == null || !("https".equalsIgnoreCase(uri.getScheme()) || "mailto".equalsIgnoreCase(uri.getScheme()))) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
        catch (ActivityNotFoundException e) { Toast.makeText(this, "请先安装浏览器后再打开此链接", Toast.LENGTH_LONG).show(); }
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(245,247,250));
        getWindow().setNavigationBarColor(Color.rgb(245,247,250));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(245,247,250));
        // Android 15+ enforces edge-to-edge; keep text above keyboard and system bars.
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v,insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left,bars.top,bars.right,Math.max(bars.bottom,ime.bottom));
                return WindowInsets.CONSUMED;
            });
        }
        progress = new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal); progress.setMax(100);
        root.addView(progress,new LinearLayout.LayoutParams(-1,6));
        FrameLayout body = new FrameLayout(this); root.addView(body,new LinearLayout.LayoutParams(-1,0,1));
        web = new WebView(this); web.setBackgroundColor(Color.rgb(245,247,250)); body.addView(web,new FrameLayout.LayoutParams(-1,-1));
        error = new LinearLayout(this); error.setOrientation(LinearLayout.VERTICAL); error.setGravity(android.view.Gravity.CENTER); error.setPadding(40,40,40,40); error.setBackgroundColor(Color.rgb(245,247,250));
        TextView title = new TextView(this); title.setText("暂时无法连接译洋"); title.setTextSize(22); title.setTextColor(Color.rgb(23,43,77)); error.addView(title);
        TextView hint = new TextView(this); hint.setText("请检查网络连接后重试"); hint.setPadding(0,20,0,20); error.addView(hint);
        Button retry = new Button(this); retry.setText("重新连接"); retry.setOnClickListener(v -> web.loadUrl(HOME)); error.addView(retry);
        error.setVisibility(View.GONE); body.addView(error,new FrameLayout.LayoutParams(-1,-1)); setContentView(root);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController controller = getWindow().getInsetsController();
            int lightBars = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (controller != null) controller.setSystemBarsAppearance(lightBars, lightBars);
        }
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true); settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(true); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUserAgentString(settings.getUserAgentString()+" YiyangAndroid/"+BuildInfo.VERSION);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request) {
                if (internal(request.getUrl())) return false;
                if (request.isForMainFrame()) external(request.getUrl());
                return true;
            }
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon) {
                mainFrameFailed=false; progress.setVisibility(View.VISIBLE); error.setVisibility(View.GONE);
            }
            @Override public void onPageFinished(WebView view,String url) {
                progress.setVisibility(View.GONE); CookieManager.getInstance().flush();
            }
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError reason) {
                if(request.isForMainFrame()){ mainFrameFailed=true; error.setVisibility(View.VISIBLE); progress.setVisibility(View.GONE); }
            }
            @Override public void onReceivedHttpError(WebView view,WebResourceRequest request,WebResourceResponse response) {
                if(request.isForMainFrame() && response.getStatusCode()>=400){ mainFrameFailed=true; error.setVisibility(View.VISIBLE); progress.setVisibility(View.GONE); }
            }
            // Keep the platform's default SSL-error cancellation. Never bypass certificate validation.
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view,int value) { progress.setProgress(value); }
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params) {
                if(!internal(Uri.parse(view.getUrl()==null?"":view.getUrl()))) return false;
                if(fileResult!=null) fileResult.onReceiveValue(null);
                fileResult=callback;
                Intent picker=new Intent(Intent.ACTION_GET_CONTENT); picker.addCategory(Intent.CATEGORY_OPENABLE); picker.setType("*/*");
                String[] types=params.getAcceptTypes(); if(types!=null && types.length>0 && !types[0].isEmpty())picker.putExtra(Intent.EXTRA_MIME_TYPES,types);
                picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
                try{startActivityForResult(Intent.createChooser(picker,"选择要上传的文件"),PICK_FILE);}
                catch(ActivityNotFoundException e){fileResult.onReceiveValue(null);fileResult=null;}
                return true;
            }
            @Override public boolean onCreateWindow(WebView view,boolean dialog,boolean gesture,android.os.Message message) {
                if(!gesture) return false;
                final WebView popup=new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient(){
                    @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest request){
                        Uri uri=request.getUrl(); if(internal(uri))web.loadUrl(uri.toString());else external(uri);popup.destroy();return true;
                    }
                });
                ((WebView.WebViewTransport)message.obj).setWebView(popup);message.sendToTarget();return true;
            }
        });
        // User-triggered HTTPS downloads use the browser's normal file saving UI.
        web.setDownloadListener((url,agent,disposition,mime,length) -> {
            Uri uri=Uri.parse(url);
            if("https".equalsIgnoreCase(uri.getScheme()))external(uri);
            else Toast.makeText(this,"请在浏览器打开译洋后导出此文件",Toast.LENGTH_LONG).show();
        });
        boolean restored=false;
        if(state!=null)restored=web.restoreState(state)!=null;
        if(!restored || !internal(Uri.parse(web.getUrl()==null?"":web.getUrl())))web.loadUrl(HOME);
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request==PICK_FILE && fileResult!=null){
            Uri[] values=WebChromeClient.FileChooserParams.parseResult(result,data);
            if(values!=null)for(Uri value:values)if(value==null || !("content".equals(value.getScheme()))){values=null;break;}
            fileResult.onReceiveValue(values);fileResult=null;
        }
    }
    @Override protected void onSaveInstanceState(Bundle state){web.saveState(state);super.onSaveInstanceState(state);}
    @Override public void onWindowFocusChanged(boolean focused){
        super.onWindowFocusChanged(focused);
        if(focused && android.os.Build.VERSION.SDK_INT>=30){
            android.view.WindowInsetsController controller=getWindow().getInsetsController();
            int lightBars=android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if(controller!=null)controller.setSystemBarsAppearance(lightBars,lightBars);
        }
    }
    private void checkForUpdates(){
        long now=SystemClock.elapsedRealtime();
        if(checkingUpdate || isFinishing() || (lastUpdateCheck!=0 && now-lastUpdateCheck<300000))return;
        checkingUpdate=true;lastUpdateCheck=now;
        updateExecutor.execute(() -> {
            HttpURLConnection connection=null;
            try{
                connection=(HttpURLConnection)new URL(HOME+"downloads/manifest.json").openConnection();
                connection.setConnectTimeout(8000);connection.setReadTimeout(10000);connection.setUseCaches(false);connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("Cache-Control","no-cache");connection.setRequestProperty("User-Agent","YiyangAndroid/"+BuildInfo.VERSION);
                if(connection.getResponseCode()!=200 || connection.getContentLengthLong()>65536)return;
                ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                try(InputStream stream=connection.getInputStream()){
                    byte[] buffer=new byte[4096];int count;
                    while((count=stream.read(buffer))!=-1){if(bytes.size()+count>65536)return;bytes.write(buffer,0,count);}
                }
                JSONObject item=new JSONObject(bytes.toString("UTF-8")).getJSONObject("android");
                String version=item.optString("version"),file=item.optString("file");
                if(!UpdatePolicy.valid(version,BuildInfo.VERSION,file,item.optLong("bytes"),item.optString("sha256")))return;
                runOnUiThread(() -> {if(!isFinishing()&&!isDestroyed()){availableVersion=version;availableFile=file;showUpdate();}});
            }catch(Exception ignored){ /* A failed update check must not interrupt practice. */ }
            finally{if(connection!=null)connection.disconnect();runOnUiThread(() -> checkingUpdate=false);}
        });
    }
    private void showUpdate(){
        if(!resumed || availableVersion==null || (availableVersion.equals(lastPromptedVersion) && System.currentTimeMillis()-lastPromptedAt<86400000) || isFinishing())return;
        android.content.SharedPreferences preferences=getSharedPreferences("client-updates",MODE_PRIVATE);
        long deferredAt=preferences.getLong("deferred-at",0),now=System.currentTimeMillis();
        if(availableVersion.equals(preferences.getString("deferred-version","")) && now>=deferredAt && now-deferredAt<86400000)return;
        final String version=availableVersion,file=availableFile;lastPromptedVersion=version;lastPromptedAt=now;
        new AlertDialog.Builder(this).setTitle("译洋有新版本")
            .setMessage("新版本 v"+version+"，当前 v"+BuildInfo.VERSION+"。\n下载后按手机提示更新，账号和练习记录会保留。")
            .setPositiveButton("下载更新",(d,w)->external(Uri.parse(HOME+"downloads/"+file)))
            .setNegativeButton("稍后提醒",(d,w)->preferences.edit().putString("deferred-version",version).putLong("deferred-at",System.currentTimeMillis()).apply())
            .setOnCancelListener(d->preferences.edit().putString("deferred-version",version).putLong("deferred-at",System.currentTimeMillis()).apply()).show();
    }
    @Override protected void onPause(){resumed=false;updateHandler.removeCallbacks(updateTick);CookieManager.getInstance().flush();web.onPause();super.onPause();}
    @Override protected void onResume(){super.onResume();resumed=true;if(web!=null)web.onResume();showUpdate();updateHandler.post(updateTick);}
    @Override public void onBackPressed(){
        if(web.canGoBack() && !mainFrameFailed)web.goBack();
        else new AlertDialog.Builder(this).setTitle("退出译洋？").setNegativeButton("继续练习",null).setPositiveButton("退出",(d,w)->finish()).show();
    }
    @Override protected void onDestroy(){updateHandler.removeCallbacksAndMessages(null);updateExecutor.shutdownNow();if(fileResult!=null)fileResult.onReceiveValue(null);web.destroy();super.onDestroy();}
}
