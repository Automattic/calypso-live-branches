
var path = require('path');
var url = require('url');
var fs = require('fs');
var cluster = require('cluster');
var child_process = require('child_process');

function uniqueNameProject(projectPath) {
	var parsedUrl = url.parse(projectPath);
	if(parsedUrl.host === 'github.com') {
		return 'gh-'+path.basename(parsedUrl.pathname, '.git')
	}
	return path.dirname(projectPath);
}

module.exports = function(config) {

	var bareRepository;
	var projectName = uniqueNameProject(config.project);
	var sourceDir = path.join( config.dir, 'projects', projectName );

	function refreshProject(callback) {
		if(!fs.existsSync(sourceDir)) {
			child_process.exec('git clone --mirror '+config.project+' '+sourceDir, callback);
		}
		child_process.exec('git fetch -p origin', {
			cwd: sourceDir
		}, callback);
	}

	function checkout(branchName, callback) {
		refreshProject(function() {
			var destinationDir = path.join(config.dir, 'branches', branchName);
			if(!fs.existsSync(destinationDir)) {
				child_process.exec('git clone -b '+branchName+' '+sourceDir+' '+destinationDir, function(err) {
					callback(err, destinationDir);
				});
			} else {
				child_process.exec('git pull', {
					cwd: destinationDir
				}, function(err) {
					callback(err, destinationDir);
				});
			}
		});
	}

	function isUpToDate(branchName, callback) {
		refreshProject(function() {
			var destinationDir = path.join(config.dir, 'branches', branchName);
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



