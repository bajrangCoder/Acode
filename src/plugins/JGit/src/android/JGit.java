package com.foxdebug.jgit;

import android.net.Uri;
import java.io.File;
import java.io.IOException;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.eclipse.jgit.api.CloneCommand;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.api.errors.GitAPIException;
import org.eclipse.jgit.lib.ProgressMonitor;
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider;
import org.json.JSONArray;
import org.json.JSONException;

public class JGit extends CordovaPlugin {

  @Override
  public boolean execute(
    String action,
    JSONArray args,
    final CallbackContext callbackContext
  ) throws JSONException {
    if (action.equals("cloneRepo")) {
      final String repoUrl = args.getString(0);
      final String directoryUri = args.getString(1);
      final String username = args.optString(2, null); // Username is optional
      final String password = args.optString(3, null); // Password is optional

      cordova
        .getThreadPool()
        .execute(
          new Runnable() {
            public void run() {
              cloneRepo(
                repoUrl,
                directoryUri,
                username,
                password,
                callbackContext
              );
            }
          }
        );
      return true;
    }
    return false;
  }

  private void cloneRepo(
    String repoUrl,
    String directoryUri,
    String username,
    String password,
    CallbackContext callbackContext
  ) {
    try {
      Uri uri = Uri.parse(directoryUri);
      if (uri.getScheme().equals("file")) {
        cloneToFileUri(repoUrl, uri, username, password, callbackContext);
      } else {
        callbackContext.error("Unsupported URI scheme: " + uri.getScheme());
      }
    } catch (Exception e) {
      callbackContext.error("Failed to clone: " + e.getMessage());
    }
  }

  private void cloneToFileUri(
    String repoUrl,
    Uri uri,
    String username,
    String password,
    CallbackContext callbackContext
  ) throws GitAPIException, IOException {
    File localPath = new File(uri.getPath());
    if (!localPath.exists()) {
      localPath.mkdirs();
    }

    // Initialize the clone command
    CloneCommand cloneCommand = Git.cloneRepository()
      .setURI(repoUrl)
      .setDirectory(localPath)
      .setProgressMonitor(new SimpleProgressMonitor(callbackContext));

    // If username and password are provided, add credentials
    if (username != null && password != null) {
      cloneCommand.setCredentialsProvider(
        new UsernamePasswordCredentialsProvider(username, password)
      );
    }

    try {
      cloneCommand.call();
      callbackContext.success("Cloned to: " + localPath.getAbsolutePath());
    } catch (GitAPIException e) {
      if (e.getMessage().contains("not authorized")) {
        callbackContext.error(
          "Authentication failed: Invalid username or password."
        );
      } else {
        callbackContext.error("Failed to clone: " + e.getMessage());
      }
    }
  }

  public static class SimpleProgressMonitor implements ProgressMonitor {

    private CallbackContext callbackContext;
    private int totalWork;
    private int completedWork;
    private int lastPercentage;

    public SimpleProgressMonitor(CallbackContext callbackContext) {
      this.callbackContext = callbackContext;
      this.lastPercentage = 0;
    }

    @Override
    public void start(int totalTasks) {
      sendProgressUpdate("Starting " + totalTasks + " tasks...");
    }

    @Override
    public void beginTask(String title, int totalWork) {
      this.totalWork = totalWork;
      this.completedWork = 0;
      this.lastPercentage = 0;
      sendProgressUpdate("Cloning: " + title);

      // Check if totalWork is reasonable, otherwise log without percentage
      if (totalWork <= 0 || totalWork == Integer.MAX_VALUE) {
        sendProgressUpdate("Cloning: " + title + " (unknown work units)");
      }
    }

    @Override
    public void update(int completed) {
      // Only update progress if totalWork is realistic
      if (totalWork > 0 && totalWork != Integer.MAX_VALUE) {
        completedWork += completed;
        int percentage = (int) ((completedWork / (float) totalWork) * 100);

        // Only report if progress has moved by 10% or more
        if (percentage >= lastPercentage + 10) {
          lastPercentage = percentage;
          sendProgressUpdate("Progress: " + percentage + "% completed");
        }
      } else {
        // For unknown work units, log the number of updates
        completedWork += completed;
        sendProgressUpdate(
          "Progress: " + completedWork + " work units completed"
        );
      }
    }

    @Override
    public void endTask() {
      sendProgressUpdate("Task completed.");
    }

    @Override
    public boolean isCancelled() {
      return false;
    }

    @Override
    public void showDuration(boolean enabled) {
      // Not used in this case
    }

    private void sendProgressUpdate(String message) {
      org.apache.cordova.PluginResult pluginResult =
        new org.apache.cordova.PluginResult(
          org.apache.cordova.PluginResult.Status.OK,
          message
        );
      pluginResult.setKeepCallback(true);
      callbackContext.sendPluginResult(pluginResult);
    }
  }
}
