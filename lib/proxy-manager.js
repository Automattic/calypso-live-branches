var fs = require('fs');
var path = require('path');
var net = require('net');
var http = require('http');
var cluster = require('cluster');
var child_process = require('child_process');
var mkdirp = require('mkdirp');
var httpProxy = require('http-proxy');
var debug = require('debug')('clb-server');
var Hub  = require('cluster-hub');

function noop() {}

function deserializeError(err) {
	if(!err || typeof err !== 'object') return;
	err.constructor = Error;
	err.__proto__ = Error.prototype;
}

function ProxyManager(project) {
	if (!(this instanceof ProxyManager)) {
		return new ProxyManager(project);
	}
	this.project = project;
	this.hub = new Hub();
	this.workers = {};
	this.proxies = {};
	this.bootStatuses = {};

	// start refreshing the mirror repository periodically
	this.project.repository.keepSynced();
	this.project.repository.on('update', this.serveActiveBranches.bind(this));
}

ProxyManager.prototype.serveActiveBranches = function(activeBranches) {
	var self = this;
	// kill off dead branches first
	for (var branch in self.workers) {
		if(activeBranches.indexOf(branch) === -1) {
			this.stopServingBranch(branch);
		}
	}
	if(process.env.AUTOBOOT_BRANCHES) {
		// boot new branches
		activeBranches.forEach(function(branch) {
			if(!self.workers[branch]) {
				self.serveBranch(branch);
			}
		});
	}
};

ProxyManager.prototype.serveBranch = function(branchName, callback) {
	var worker = cluster.fork();
	var self = this;
	console.log('serving branch '+branchName);
	this.workers[branchName] = worker;
	worker.on('exit', function() {
		self.stopServingBranch(branchName);
	});
	worker.on('message', function(msg) {
		if (msg && msg.boot && self.isUp(branchName)) {
			debug('Branch '+branchName+' is ' + msg.boot);
			self.bootStatuses[branchName] = msg.boot;
		}
	});
	this.project.repository.waitAvailable(function() {
		self.hub.requestWorker(worker, 'init', {
			branch: branchName
		}, function(err) {
			deserializeError(err);
			callback && callback(err);
		});
	});
};

ProxyManager.prototype.stopServingBranch = function(branchName) {
	var proxy = this.proxies[branchName];
	var worker = this.workers[branchName];
	if(proxy) {
		proxy.close();
		delete this.proxies[branchName];
	}
	if(worker) {
		if (!worker.isDead()) {
			worker.kill();
		}
		delete this.workers[branchName];
	}
	delete this.bootStatuses[branchName];
};

ProxyManager.prototype.checkUpdated = function(branchName, callback) {
	var self = this;
	callback = callback || noop;
	if (!this.isUp(branchName) || this.isBooting(branchName)) {
		return callback(new Error('branch not ready'));
	}
	var worker = this.workers[branchName];
	if(worker.updating) {
		return worker.once('branch updated', callback);
	}
	worker.setMaxListeners(1000);
	worker.updating = true;
	this.project.repository.waitAvailable(function() {
		self.hub.requestWorker(worker, 'update', null, function (err, mustRestart) {
			deserializeError(err);
			if (err) debug(err);
			if (mustRestart) {
				self.stopServingBranch(branchName);
			}
			worker.updating = false;
			worker.emit('branch updated');
			callback(err, mustRestart);
		});
	});
};

ProxyManager.prototype.proxyRequest = function(branchName, req, res, next) {
	if(res.headersSent) return;
	var proxy = this.proxies[branchName];
	if(!proxy) return res.send('proxy stopped');
	proxy.web(req, res, function(err) {
		debug(err);
		// retry once
		proxy.web(req, res, next);
	});
};

ProxyManager.prototype.isUp = function(branchName) {
	return !!this.workers[branchName];
};

ProxyManager.prototype.isBooting = function(branchName) {
	return this.workers[branchName] && !this.proxies[branchName];
};

ProxyManager.prototype.getStatus = function(branchName) {
	if (this.bootStatuses[branchName]) {
		return this.bootStatuses[branchName];
	} else if (this.workers[branchName] && this.proxies[branchName]) {
		return 'UP';
	} else if (this.workers[branchName]) {
		return 'BOOTING';
	} else {
		return 'DOWN';
	}
};

ProxyManager.prototype.getCommitId = function(branchName, callback) {
	var currentBranch;
	if (!this.isUp(branchName)) {
		return callback();
	}
	try {
		currentBranch = this.project.getBranch(branchName);
	} catch(err) {
		return callback(err);
	}
	currentBranch.getLastCommit(callback);
};

ProxyManager.prototype.bootBranch = function(branchName, callback) {
	var self = this;
	this.serveBranch(branchName, function (err) {
		if (err) {
			self.stopServingBranch(branchName);
			callback(err);
			return;
		}
		var socketPath = self.project.getSocketPath(branchName);
		debug('creating proxy to', socketPath);
		self.proxies[branchName] = httpProxy.createProxyServer({
			target: {
				socketPath: socketPath
			}
		});
		self.proxies[branchName].on('error', function(err) {
			debug(err);
		});
	});
};

module.exports = ProxyManager;
