
var path = require('path');
var url = require('url');
var fs = require('fs');
var cluster = require('cluster');
var child_process = require('child_process');
var mkdirp = require('mkdirp');

function uniqueNameProject(projectPath) {
	var parsedUrl = url.parse(projectPath);
	if(parsedUrl.host === 'github.com') {
		return 'gh-'+path.basename(parsedUrl.pathname, '.git')
	}
	return path.dirname(projectPath);
}

module.exports = function(config) {
	var repositoryUrl = config.repository.url.replace('git+https', 'https');
	var projectName = uniqueNameProject(repositoryUrl);
	var tmpDir = path.resolve(config.tmpDir || '/tmp');
	var sourceDir = path.join(tmpDir, 'projects', projectName);

	function refreshProject(callback) {
		if(!fs.existsSync(sourceDir)) {
			child_process.exec('git clone --mirror '+repositoryUrl+' '+sourceDir, callback);
		}
		child_process.exec('git fetch -p origin', {
			cwd: sourceDir
		}, callback);
	}

	function checkout(branchName, callback) {
		refreshProject(function() {
			// check if branch exists
			child_process.exec('git ls-remote --heads '+sourceDir+' '+branchName, function(err, stdout) {
				var branchExist = stdout.toString().length > 0;
				if(err || !branchExist) {
					return callback(err || new Error('Branch not found'));
				}
				var destinationDir = path.join(tmpDir, 'branches', branchName);
				if(!fs.existsSync(destinationDir)) {
					mkdirp(destinationDir);
					child_process.exec('git clone -b '+branchName+' '+sourceDir+' '+destinationDir, function(err) {
						callback(err, destinationDir);
					});
				} else {
					child_process.exec('git reset --hard HEAD && git pull', {
						cwd: destinationDir
					}, function(err) {
						callback(err, destinationDir);
					});
				}
			});
		});
	}

	function isUpToDate(branchName, callback) {
		refreshProject(function() {
			var destinationDir = path.join(tmpDir, 'branches', branchName);
			child_process.exec('git log HEAD..@{u} --oneline', {
				cwd: destinationDir
			}, function(err, stdout) {
				callback(err, stdout.toString().length === 0);
			});
		});
	}

	return {
		checkout: checkout,
		isUpToDate: isUpToDate
	};
};



