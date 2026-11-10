package com.tmuxlab.app;

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
