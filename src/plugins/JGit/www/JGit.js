var exec = require("cordova/exec");

var JGit = {
  /**
   * Clone a git repository to a directory
   * @param {string} repoUrl - The URL of the repository to clone
   * @param {string} directory - The directory to clone the repository to
   * @param {string} [username] - The username to use for authentication (only needed for private repositories)
   * @param {string} [password] - The password to use for authentication (only needed for private repositories)
   * @param {function} successCallback - The callback to call on success
   * @param {function} errorCallback - The callback to call on error
   */
  cloneRepo: function (
    repoUrl,
    directory,
    username,
    password,
    successCallback,
    errorCallback,
  ) {
    exec(successCallback, errorCallback, "JGit", "cloneRepo", [
      repoUrl,
      directory,
      username,
      password,
    ]);
  },
};

module.exports = JGit;
