var exec = require('cordova/exec');

var JGit = {
    cloneRepo: function (repoUrl, directory, successCallback, errorCallback) {
        exec(successCallback, errorCallback, "JGit", "cloneRepo", [repoUrl, directory]);
    }
};

module.exports = JGit;
