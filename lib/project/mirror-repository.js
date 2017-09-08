var url = require('url');
var fs = require('fs');
var cluster = require('cluster');
var exec = require('child_process').exec;
var util = require("util");
var EventEmitter = require("events");
var shellescape = require('shell-escape');

var mkdirp = require('mkdirp');
var isEqual = require('lodash').isEqual;
var debug = require('debug')('clb-project');

function MirrorRepository(url, destination) {
	EventEmitter.call(this);
	this.remoteUrl = url;
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
	if (repo.initializing) {
		return repo.once('ready', callback);
	}
	repo.initializing = true;
	// check if repo exists
	fs.stat(repoDir, function(err) {
		if(!err) {
			repo.ready = true;
			repo.initializing = false;
			repo.emit('ready');
			return callback();
		}
		mkdirp(repoDir, function() {
			debug('Cloning ' + repo.remoteUrl + ' to ' + repoDir);
			exec('git clone --mirror '+repo.remoteUrl+' '+repoDir, function(err) {
				if(err) return callback(err);
				debug('Updating mirror git repository configuration');
				repo.updateConfig(function(err) {
					if(err) return callback(err);
					debug('Mirror repository is ready');
					repo.ready = true;
					repo.initializing = false;
					repo.emit('ready');
					callback(err);
				});
			});
		});
	});
};

MirrorRepository.prototype.updateConfig = function(callback) {
	if(process.env.ENABLE_GH_PULL) {
		exec('git config --add remote.origin.fetch "+refs/pull/*/head:refs/heads/gh-pull/*"; git fetch origin', {
			cwd: this.getDirectory()
		}, callback);
	} else {
		callback();
	}
};

/*
 * To ensure that a git command is only executed once at a time on the mirror repository,
 * any commands on a MirrorRepository instance must be called from the master process
 */
MirrorRepository.prototype.waitAvailable = function(callback) {
	var repo = this;
	repo._checkReady(function(err) {
		if(err) debug(err);
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

MirrorRepository.prototype.keepSynced = function( options ) {
	var repo = this;
	this.init(function(err) {
		if(err) console.error(err);
		var currentBranches = [];
		(function sync() {
			repo.syncing = true;
			repo.emit('syncing');
			repo._sync(function(err) {
				if(err) console.error(err);
				repo.syncing = false;
				repo.emit('synced');
				repo.listBranches(options.maxBranches, function(err, branches) {
					if(err) console.error(err);
					branches = branches || [];
					branches.sort();
					if(!isEqual(currentBranches, branches)) {
						currentBranches = branches;
						repo.emit('update', branches);
					}
					setTimeout(sync, 60*1000);
				});
			});
		})();
	});
};

MirrorRepository.prototype.exec = function(command, callback) {
	debug('REPO > '+command);
	exec(command, {
		cwd: this.getDirectory()
	}, function(err, stdout, stderr) {
		debug('REPO > ' + (err || stderr.toString() || stdout.toString()));
		callback && callback(err, stdout.toString(), stderr.toString());
	});
};

MirrorRepository.prototype._sync = function(callback) {
	this.exec('git fetch -p origin', function(err, stdout) {
		callback(err);
	});
};

MirrorRepository.prototype.listBranches = function( maxBranches, callback ) {
	var cmd;
	if ( ! callback ) {
		callback = maxBranches;
		cmd = 'git branch --list --no-color';
	} else {
		cmd = 'git branch --list --no-color --sort=-committerdate | head -n ' + shellescape( [ maxBranches ] );
	}
	this.exec(cmd, function(err, stdout) {
		if(err) return callback(err);
		var branches = stdout.split('\n').map(function(line) {
			return line.replace(/\s|\*/g, '');
		}).filter(function(line) { // remove empty lines
			return !!line;
		});
		callback(null, branches);
	});
};

module.exports = MirrorRepository;
