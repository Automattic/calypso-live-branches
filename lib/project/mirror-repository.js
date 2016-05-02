var url = require('url');
var fs = require('fs');
var cluster = require('cluster');
var exec = require('child_process').exec;
var util = require("util");
var EventEmitter = require("events");

var mkdirp = require('mkdirp');
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
	exec('git config --add remote.origin.fetch "+refs/pull/*/head:refs/heads/gh-pull/*"; git fetch origin', {
		cwd: this.getDirectory()
	}, callback);
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

MirrorRepository.prototype.keepSynced = function() {
	var repo = this;
	this.init(function(err) {
		if(err) console.error(err);
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
	});
};

MirrorRepository.prototype._sync = function(callback) {
	exec('git fetch -p origin', {
		cwd: this.getDirectory()
	}, function(err, stdout, stderr) {
		callback(err);
	});
};

module.exports = MirrorRepository;
