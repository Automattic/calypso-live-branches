
var path = require('path');
var url = require('url');
var fs = require('fs');
var cluster = require('cluster');
var exec = require('child_process').exec;
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
	this.remoteUrl = url.replace('git+https', 'https');
	this.destination = destination;
	this.ready = false;
	this.lastSync = 0;
}


MirrorRepository.prototype.getDirectory = function() {
	return this.destination;
};

MirrorRepository.prototype.init = function(callback) {
	var repo = this;
	var repoDir = this.getDirectory();
	// check if repo exists
	fs.stat(repoDir, function(err) {
		if(!err) return callback();
		exec('git clone --mirror '+repo.remoteUrl+' '+repoDir, function(err) {
			repo.ready = true;
			callback(err);
		});
	});
};

MirrorRepository.prototype.refresh = function(callback) {
	var repo = this;
	if(!this.ready) {
		this.init(function(err) {
			if(err) return callback(err);
			repo._sync(callback);
		});
		return;
	}
	this._sync(callback);
};

MirrorRepository.prototype._sync = function(callback) {
	// don't try to sync too often
	if(Date.now() - this.lastSync < 5*1000) {
		return callback();
	}
	var repo = this;
	exec('git fetch -p origin', {
		cwd: this.getDirectory()
	}, function(err) {
		if(err) return callback(err);
		repo.lastSync = Date.now();
		callback();
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

Project.prototype.init = function(callback) {
	var repo = this.repository;
	mkdirp(this.destination, function(err) {
		if(err) return callback(err);
		repo.init(callback);
	})
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
	repo.refresh(function(err) {
		if(err) return callback(err);
		// check if branch exists in the mirror repository
		exec('git ls-remote --heads '+repo.getDirectory()+' '+branchName, function(err, stdout) {
			var branchExist = stdout.toString().length > 0;
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
	});
};

Branch.prototype.update = function(callback) {
	var branch = this;
	this.repository.refresh(function(err) {
		if (err) return callback(err);
		exec('git reset --hard origin/'+branch.name, {
			cwd: branch.getDirectory()
		}, function(err) {
			callback(err, branch.getDirectory());
		});
	});
};

Branch.prototype.isUpToDate = function(callback) {
	var branch = this;
	this.repository.refresh(function(err) {
		if (err) return callback(err);
		exec('git log HEAD..@{u} --oneline', {
			cwd: branch.getDirectory()
		}, function(err, stdout) {
			callback(err, stdout.toString().length === 0);
		});
	});
};

Branch.prototype.getLastCommit = function(callback) {
	exec('git rev-parse HEAD', {
		cwd: this.getDirectory()
	}, function(err, stdout) {
		callback(err, stdout.toString());
	});
};


Branch.prototype.hasChanged = function(sinceCommit, inDirs, callback) {
	if(!inDirs || inDirs.length === 0) {
		inDirs = [ '.' ];
	}
	exec('git diff --name-only '+sinceCommit+'..HEAD '+inDirs.join(' '), {
		cwd: this.getDirectory()
	}, function(err, stdout) {
		callback(err, stdout.toString().length === 0);
	});
};


module.exports = function(config) {
	var project = new Project({
		repository: config.repository,
		destination: path.resolve(config.tmpDir || '/tmp')
	});
	return project;
};

module.exports.Project = Project;
module.exports.MirrorRepository = MirrorRepository;
module.exports.Branch = Branch;
