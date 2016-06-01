var path = require('path');
var url = require('url');
var fs = require('fs');
var cluster = require('cluster');
var exec = require('child_process').exec;
var util = require('util');
var shellescape = require('shell-escape');

var mkdirp = require('mkdirp');
var debug = require('debug')('clb-project');

function isValidBranchName(branchName) {
	// .. is forbidden
	return branchName && !branchName.match(/\.\./);
}

function Branch(config) {
	this.repository = config.repository;
	this.destination = config.destination;
	this.name = config.name;
	if(!isValidBranchName(this.name)) {
		throw new Error('Invalid branch name');
	}
}

Branch.prototype.getDirectory = function() {
	return path.join(this.destination, this.name);
};

Branch.prototype.checkout = function(callback) {
	var branch = this;
	var branchName = this.name;
	var destinationDir = this.getDirectory();
	var repo = this.repository;
	this.exists(function(err, branchExist) {
		if(err || !branchExist) {
			return callback(err || new Error('Branch not found '+branchName));
		}
		// check if branch exists remotely
		fs.stat(destinationDir, function(err) {
			if(!err) return branch.update(callback);
			// ensure `git clone` won't fail if branch contains slashes '/'
			mkdirp(destinationDir, function(err) {
				if(err) return callback(err, destinationDir);
				exec('git clone '+repo.getDirectory()+' '+destinationDir, function(err) {
					if(err) return callback(err, destinationDir);
					exec('git checkout '+shellescape([branch.name]), {
						cwd: destinationDir
					}, function(err) {
						callback(err, destinationDir);
					});
				});
			});
		});
	});
};

Branch.prototype.update = function(callback) {
	var branch = this;
	exec('git fetch origin; git reset --hard @{u}', {
		cwd: branch.getDirectory()
	}, function(err) {
		callback(err, branch.getDirectory());
	});
};

Branch.prototype.isUpToDate = function(callback) {
	var branch = this;
	exec('git fetch origin; git log HEAD..@{u} --oneline', {
		cwd: branch.getDirectory()
	}, function(err, stdout) {
		callback(err, stdout.toString().length === 0);
	});
};

Branch.prototype.getLastCommit = function(callback) {
	exec('git rev-parse HEAD', {
		cwd: this.getDirectory()
	}, function(err, stdout) {
		callback(err, stdout.toString().replace(/\s/gm, ''));
	});
};

Branch.prototype.hasChanged = function(sinceCommit, inDirs, callback) {
	if(!inDirs || inDirs.length === 0) {
		inDirs = [ '.' ];
	}
	exec('git diff --name-only '+shellescape([sinceCommit+'..HEAD'].concat(inDirs)), {
		cwd: this.getDirectory()
	}, function(err, stdout) {
		callback(err, stdout.toString().length > 0);
	});
};

Branch.prototype.exists = function(callback) {
	var branchName = this.name;
	var repo = this.repository;
	// check if ref exists in the mirror repository
	// Do not use `origin` as we might want to know without being in a git repository

	exec('git ls-remote '+shellescape([repo.getDirectory(), branchName]), function(err, stdout) {
		var branchExist = stdout.toString().replace(/\s/gm, '').length > 0;
		callback(err, branchExist);
	});
};

module.exports = Branch;
