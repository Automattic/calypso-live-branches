
var path = require('path');
var url = require('url');
var fs = require('fs');
var cluster = require('cluster');
var exec = require('child_process').exec;
var util = require("util");
var EventEmitter = require("events");

var mkdirp = require('mkdirp');
var debug = require('debug')('branch-manager');


function uniqueNameProject(projectPath) {
	var parsedUrl = url.parse(projectPath);
	if(parsedUrl.host === 'github.com') {
		return 'gh-'+path.basename(parsedUrl.pathname, '.git')
	}
	return path.dirname(projectPath);
}

function createRepository(config, destination) {
	if(config.type === 'git') {
		return new MirrorRepository(config.url, path.join(destination, 'repo'));
	}
}

function MirrorRepository(url, destination) {
	EventEmitter.call(this);
	this.remoteUrl = url.replace('git+https', 'https');
	this.destination = destination;
	this.ready = false;
	this.initializing = false;
	this.syncing = false;
}

util.inherits(MirrorRepository, EventEmitter);

MirrorRepository.prototype.getDirectory = function() {
	return this.destination;
};

MirrorRepository.prototype.init = function(callback) {
	var repo = this;
	var repoDir = this.getDirectory();
	repo.ready = false;
	repo.initializing = true;
	// check if repo exists
	fs.stat(repoDir, function(err) {
		if(!err) {
			repo.ready = true;
			repo.initializing = false;
			return callback();
		}
		mkdirp(repoDir, function() {
			exec('git clone --mirror '+repo.remoteUrl+' '+repoDir, function(err) {
				repo.ready = true;
				repo.initializing = false;
				repo.emit('ready');
				callback(err);
			});
		});
	});
};

/*
 * To ensure that a git command is only executed once at a time on the mirror repository,
 * any commands on a MirrorRepository instance must be called from the master process
 */
MirrorRepository.prototype.waitAvailable = function(callback) {
	var repo = this;
	repo._checkReady(function() {
		repo._checkNotSyncing(callback);
	});
};

MirrorRepository.prototype._checkReady = function(callback) {
	if(!this.ready && !this.initializing) {
		return this.init(callback);
	}
	if(!this.ready && this.initializing) {
		return this.once('ready', callback);
	}
	callback();
};

MirrorRepository.prototype._checkNotSyncing = function(callback) {
	if(this.syncing) {
		return this.once('synced', callback);
	}
	callback();
};

MirrorRepository.prototype.keepSynced = function() {
	var repo = this;
	(function sync() {
		repo.syncing = true;
		repo.emit('syncing');
		repo._sync(function(err) {
			if(err) console.error(err);
			repo.syncing = false;
			repo.emit('synced');
			setTimeout(sync, 60*1000);
		});
	})();
};

MirrorRepository.prototype._sync = function(callback) {
	exec('git fetch -p origin', {
		cwd: this.getDirectory()
	}, function(err, stdout, stderr) {
		callback(err);
	});
};


function Project(config) {
	this.name = config.name || uniqueNameProject(config.repository.url);
	this.destination = path.resolve(config.destination, this.name);
	this.repository = createRepository(config.repository, this.destination);
	this.branches = {};
}

Project.prototype.getDirectory = function() {
	return this.destination;
};

Project.prototype.getBranch = function(branchName) {
	if(!this.branches[branchName]) {
		this.branches[branchName] = new Branch({
			repository: this.repository,
			destination: path.join(this.destination, 'branches'),
			name: branchName
		});
	}
	return this.branches[branchName];
};

Project.prototype.getSocketPath = function(branchName) {
	return path.join(this.destination, 'sockets', branchName+'.socket');
};

function Branch(config) {
	this.repository = config.repository;
	this.destination = config.destination;
	this.name = config.name;
}

Branch.prototype.getDirectory = function() {
	return path.join(this.destination, this.name);
};

Branch.prototype.checkout = function(callback) {
	var branch = this;
	var branchName = this.name;
	var destinationDir = this.getDirectory();
	var repo = this.repository;
	// check if branch exists in the mirror repository
	exec('git ls-remote --heads '+repo.getDirectory()+' '+branchName, function(err, stdout) {
		var branchExist = stdout.toString().replace(/\s/gm, '').length > 0;
		if(err || !branchExist) {
			return callback(err || new Error('Branch not found'));
		}
		// check if branch exists locally
		fs.stat(destinationDir, function(err) {
			if(!err) return branch.update(callback);
			// ensure `git clone` won't fail if branch contains slashes '/'
			mkdirp(destinationDir, function(err) {
				if(err) return callback(err, destinationDir);
				exec('git clone -b '+branchName+' '+repo.getDirectory()+' '+destinationDir, function(err) {
					callback(err, destinationDir);
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
	exec('git diff --name-only '+sinceCommit+'..HEAD '+inDirs.join(' '), {
		cwd: this.getDirectory()
	}, function(err, stdout) {
		callback(err, stdout.toString().length > 0);
	});
};


module.exports = function(config) {
	return new Project({
		repository: config.repository,
		destination: path.resolve(process.env.TMP_DIR || '/tmp')
	});
};

module.exports.Project = Project;
module.exports.MirrorRepository = MirrorRepository;
module.exports.Branch = Branch;
