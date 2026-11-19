package com.tmuxlab.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  // set by the page: true while a terminal is open and the "volume buttons scroll" setting is on
  private volatile boolean volumeScroll = false;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getBridge().getWebView().addJavascriptInterface(new Object() {
      @JavascriptInterface
      public void setVolumeScroll(boolean on) { volumeScroll = on; }

      // 1 = allowed, 0 = not asked yet / refused. Asking opens the system dialog (Android 13+).
      @JavascriptInterface
      public boolean canNotify() { return Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED; }

      @JavascriptInterface
      public void askNotify() { if (!canNotify()) runOnUiThread(() -> requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7)); }

      @JavascriptInterface
      public void notify(String title, String body, String tag) {
        if (!canNotify()) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel("agents", "Agents", NotificationManager.IMPORTANCE_HIGH));
        PendingIntent open = PendingIntent.getActivity(MainActivity.this, 0, new Intent(MainActivity.this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(MainActivity.this, "agents") : new Notification.Builder(MainActivity.this);
        nm.notify(tag, 1, b.setSmallIcon(getApplicationInfo().icon).setContentTitle(title).setContentText(body).setContentIntent(open).setAutoCancel(true).build());
      }
    }, "TmuxlabNative");
  }

  @Override
  public boolean dispatchKeyEvent(KeyEvent e) {
    int k = e.getKeyCode();
    if (volumeScroll && (k == KeyEvent.KEYCODE_VOLUME_UP || k == KeyEvent.KEYCODE_VOLUME_DOWN)) {
      if (e.getAction() == KeyEvent.ACTION_DOWN) { // holding the button repeats
        final String dir = k == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down";
        getBridge().getWebView().post(() -> getBridge().getWebView().evaluateJavascript("window.tlVolume&&window.tlVolume('" + dir + "')", null));
      }
      return true; // no volume change
    }
    return super.dispatchKeyEvent(e);
  }
}
