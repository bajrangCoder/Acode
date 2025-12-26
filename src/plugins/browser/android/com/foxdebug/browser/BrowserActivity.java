package com.foxdebug.browser;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.Manifest;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.foxdebug.system.Ui;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class BrowserActivity extends Activity {

  private Browser browser;
  private Ui.Theme theme;
  
  private static final int PERMISSION_REQUEST_CODE = 100;
  private PermissionRequest pendingPermissionRequest;
  private String[] pendingResources;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    Intent intent = getIntent();
    String url = intent.getStringExtra("url");
    String themeString = intent.getStringExtra("theme");
    boolean onlyConsole = intent.getBooleanExtra("onlyConsole", false);

    try {
      JSONObject obj = new JSONObject(themeString);
      theme = new Ui.Theme(obj);
    } catch (Exception e) {
      theme = new Ui.Theme(new JSONObject());
    }

    browser = new Browser(this, theme, onlyConsole);
    browser.setPermissionHandler(this);
    browser.setUrl(url);
    setContentView(browser);
    setSystemTheme(theme.get("primaryColor"));
  }

  @Override
  public void onBackPressed() {
    boolean didGoBack = browser.goBack();

    if (!didGoBack) {
      browser.exit();
    }
  }
  
  /**
   * Handle WebView permission request by checking/requesting Android runtime permissions
   */
  public void handlePermissionRequest(PermissionRequest request, String[] resources) {
    this.pendingPermissionRequest = request;
    this.pendingResources = resources;
    
    List<String> permissionsToRequest = new ArrayList<>();
    
    for (String resource : resources) {
      if (resource.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) 
            != PackageManager.PERMISSION_GRANTED) {
          permissionsToRequest.add(Manifest.permission.CAMERA);
        }
      } else if (resource.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) 
            != PackageManager.PERMISSION_GRANTED) {
          permissionsToRequest.add(Manifest.permission.RECORD_AUDIO);
        }
      }
    }
    
    if (permissionsToRequest.isEmpty()) {
      // All permissions already granted, grant to WebView
      request.grant(resources);
    } else {
      // Request the needed Android permissions
      ActivityCompat.requestPermissions(
        this, 
        permissionsToRequest.toArray(new String[0]), 
        PERMISSION_REQUEST_CODE
      );
    }
  }
  
  // Geolocation permission handling
  private static final int GEOLOCATION_PERMISSION_REQUEST_CODE = 101;
  private android.webkit.GeolocationPermissions.Callback pendingGeolocationCallback;
  private String pendingGeolocationOrigin;
  
  public void handleGeolocationPermission(String origin, android.webkit.GeolocationPermissions.Callback callback) {
    this.pendingGeolocationCallback = callback;
    this.pendingGeolocationOrigin = origin;
    
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) 
        != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(
        this,
        new String[] { Manifest.permission.ACCESS_FINE_LOCATION },
        GEOLOCATION_PERMISSION_REQUEST_CODE
      );
    } else {
      // Already granted
      callback.invoke(origin, true, false);
      pendingGeolocationCallback = null;
      pendingGeolocationOrigin = null;
    }
  }
  
  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    
    if (requestCode == PERMISSION_REQUEST_CODE && pendingPermissionRequest != null) {
      boolean allGranted = true;
      for (int result : grantResults) {
        if (result != PackageManager.PERMISSION_GRANTED) {
          allGranted = false;
          break;
        }
      }
      
      if (allGranted) {
        pendingPermissionRequest.grant(pendingResources);
      } else {
        pendingPermissionRequest.deny();
      }
      
      pendingPermissionRequest = null;
      pendingResources = null;
    } else if (requestCode == GEOLOCATION_PERMISSION_REQUEST_CODE && pendingGeolocationCallback != null) {
      boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
      pendingGeolocationCallback.invoke(pendingGeolocationOrigin, granted, false);
      pendingGeolocationCallback = null;
      pendingGeolocationOrigin = null;
    }
  }

  private void setSystemTheme(int systemBarColor) {
    try {
      Ui.Icons.setSize(Ui.dpToPixels(this, 18));
      final Window window = getWindow();
      // Method and constants not available on all SDKs but we want to be able to compile this code with any SDK
      window.clearFlags(0x04000000); // SDK 19: WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
      window.addFlags(0x80000000); // SDK 21: WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
      try {
        // Using reflection makes sure any 5.0+ device will work without having to compile with SDK level 21

        window
          .getClass()
          .getMethod("setNavigationBarColor", int.class)
          .invoke(window, systemBarColor);

        window
          .getClass()
          .getMethod("setStatusBarColor", int.class)
          .invoke(window, systemBarColor);

        if (Build.VERSION.SDK_INT < 30) {
          setStatusBarStyle(window);
          setNavigationBarStyle(window);
        } else {
          String themeType = theme.getType();
          WindowInsetsController controller = window.getInsetsController();
          int appearance =
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS |
            WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;

          if (themeType.equals("light")) {
            controller.setSystemBarsAppearance(appearance, appearance);
          } else {
            controller.setSystemBarsAppearance(0, appearance);
          }
        }
      } catch (IllegalArgumentException ignore) {} catch (Exception ignore) {}
    } catch (Exception e) {}
  }

  private void setStatusBarStyle(final Window window) {
    View decorView = window.getDecorView();
    int uiOptions = decorView.getSystemUiVisibility();
    String themeType = theme.getType();

    if (themeType.equals("light")) {
      decorView.setSystemUiVisibility(
        uiOptions | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
      );
      return;
    }
  }

  private void setNavigationBarStyle(final Window window) {
    View decorView = window.getDecorView();
    int uiOptions = decorView.getSystemUiVisibility();
    String themeType = theme.getType();

    if (themeType.equals("light")) {
      decorView.setSystemUiVisibility(uiOptions | 0x80000000 | 0x00000010);
      return;
    }
  }

  @Override
  protected void onActivityResult(
    int requestCode,
    int resultCode,
    Intent data
  ) {
    super.onActivityResult(requestCode, resultCode, data);

    if (requestCode == browser.FILE_SELECT_CODE) {
      if (browser.filePathCallback == null) {
        return;
      }

      browser.filePathCallback.onReceiveValue(
        WebChromeClient.FileChooserParams.parseResult(resultCode, data)
      );

      browser.filePathCallback = null;
    }
  }
}
