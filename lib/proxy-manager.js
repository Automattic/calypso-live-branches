var fs = require('fs');
var path = require('path');
var net = require('net');
var http = require('http');
var cluster = require('cluster');
var child_process = require('child_process');
var os = require('os');
var async = require('async');
var mkdirp = require('mkdirp');
var httpProxy = require('http-proxy');
var debug = require('debug')('clb-server');
var Hub  = require('cluster-hub');

function noop() {}

function deserializeError(err) {
	if( ! err || typeof err !== 'object' ) return;
	err.constructor = Error;
	err.__proto__ = Error.prototype;
	Object.defineProperties( err, Object.keys( err ).reduce( function( acc, errProperty ) {
		acc[ errProperty ] = {
			value: err[ errProperty ],
			enumerable: false
		};
		return acc;
	}, {} ) );
}

function ProxyManager(project, calypsoLiveConfig) {
	if (!(this instanceof ProxyManager)) {
		return new ProxyManager(project, calypsoLiveConfig);
	}
	this.project = project;
	this.hub = new Hub();
	this.workers = {};
	this.proxies = {};
	this.bootStatuses = {};
	this.calypsoLiveConfig = calypsoLiveConfig;

	// start refreshing the mirror repository periodically
	this.project.repository.keepSynced({
		maxBranches: calypsoLiveConfig.maxBranches
	});
	this.project.repository.on('update', this.serveActiveBranches.bind(this));
}

ProxyManager.prototype.serveActiveBranches = function(activeBranches) {
	var self = this;
	// always serve master
	if ( activeBranches.indexOf( 'master' ) !== -1 ) {
		activeBranches.push( 'master' );
	}
	// kill off dead branches first
	for ( var branch in self.workers ) {
		var proxy = self.proxies[ branch ];
		// a branch should be killed if it's not active (deleted or old) and if it is booted but not accessed in the last 24h
		if ( activeBranches.indexOf( branch ) === -1 && proxy && proxy.lastAccess < Date.now() - 24 * 3600 * 1000 ) {
			debug( 'Stopping inactive branch ' + branch );
			this.stopServingBranch( branch );
		}
	}
	if ( this.calypsoLiveConfig.autoBoot ) {
		async.eachLimit( activeBranches, os.cpus().length - 1 || 1,  function iterator( branch, callback ) {
			if ( ! self.workers[ branch ] ) {
				self.serveBranch( branch, callback );
			}
		});
	}
	var branchInfo = this.listBranches();
	debug( 'Active branches updated, now serving ' + branchInfo.active.length + ' branches (' + branchInfo.ready.length + ' ready).' );
};

ProxyManager.prototype.serveBranch = function(branchName, callback) {
	var worker = cluster.fork();
	var self = this;
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
			worker.lastUpdated = Date.now();
			callback && callback(err);
		});
	});
};

ProxyManager.prototype.stopServingBranch = function( branchName, cleanup, callback ) {
	var self = this;
	callback = callback || noop;
	if ( typeof cleanup === 'function' ) {
		callback = cleanup;
		cleanup = false;
	}
	var proxy = this.proxies[ branchName ];
	if ( proxy ) {
		proxy.close();
		delete this.proxies[ branchName ];
	}
	this.killWorker( branchName, function() {
		debug( 'Worker for ' + branchName + ' is dead.' );
		if ( cleanup ) {
			debug( 'Cleaning up ' + branchName );
			self.project.cleanupBranch( branchName );
		}
		// Don't reset the error status immediately
		setTimeout( function() {
			delete self.bootStatuses[ branchName ];
			callback();
		}, 20 * 1000 );
	} );
};

ProxyManager.prototype.killWorker = function( branchName, callback ) {
	var self = this;
	var worker = this.workers[branchName];
	if ( worker && ! worker.isDead() ) {
		worker.kill( 'SIGTERM' );
		// Give it 2s to shutdown cleanly
		setTimeout( function() {
			if ( ! worker.isDead() || ! worker.killed ) {
				worker.kill( 'SIGKILL' );
				setTimeout( function() {
					delete self.workers[ branchName ];
					callback();
				}, 100 );
			} else {
				delete self.workers[ branchName ];
				callback();
			}
		}, 2000 );
	} else {
		delete self.workers[ branchName ];
		callback();
	}
};

ProxyManager.prototype.checkUpdated = function( branchName, callback ) {
	var self = this;
	callback = callback || noop;
	if ( ! this.isUp( branchName ) || this.isBooting( branchName ) ) {
		return callback( new Error('branch not ready' ) );
	}
	var worker = this.workers[ branchName ];
	// Don't check if recent update (30s)
	if ( worker.lastUpdated > Date.now() - 30 * 1000 ) {
		return callback( null, false );
	}
	if( worker.updating ) {
		return worker.once( 'branch updated', callback );
	}
	worker.setMaxListeners( 1000 );
	worker.updating = true;
	this.project.repository.waitAvailable( function() {
		self.hub.requestWorker( worker, 'update', null, function( err, mustRestart ) {
			deserializeError( err );
			if ( err ) {
				self.markErrored( branchName );
				return;
			}
			worker.lastUpdated = Date.now();
			if ( mustRestart ) {
				self.stopServingBranch( branchName, function() {
					callback( null, mustRestart );
				} );
			} else {
				worker.updating = false;
				worker.emit( 'branch updated' );
				callback( null, false );
			}
		} );
	} );
};

ProxyManager.prototype.proxyRequest = function(branchName, req, res, next) {
	if(res.headersSent) return;
	var proxy = this.proxies[branchName];
	if(!proxy) return next(new Error('proxy stopped'));
	proxy.lastAccess = Date.now();
	proxy.web(req, res, next);
};

ProxyManager.prototype.isUp = function( branchName ) {
	return ( branchName in this.workers ) && this.bootStatuses[ branchName ] !== 'ERROR';
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

ProxyManager.prototype.bootBranch = function( branchName, callback ) {
	var self = this;
	if ( this.hasErrored( branchName ) ) {
		return callback( new Error( branchName + ' has errored. Please wait while this branch is being cleaned up.' ) );
	}
	this.serveBranch( branchName, function ( err ) {
		if ( err ) {
			self.markErrored( branchName );
			debug( 'Branch '+branchName+' has errored. Cause: ', err );
			callback( err );
			return;
		}
		var socketPath = self.project.getSocketPath(branchName);
		debug('creating proxy to', socketPath);
		self.proxies[branchName] = httpProxy.createProxyServer({
			target: {
				socketPath: socketPath
			}
		});
		self.proxies[branchName].lastAccess = Date.now();
		self.proxies[branchName].on('error', function(err) {
			debug(err);
		});
	});
};

ProxyManager.prototype.listBranches = function() {
	var self = this;
	var activeBranches = Object.keys( this.workers );
	var upBranches = Object.keys( this.proxies );
	var readyBranches;
	if ( this.calypsoLiveConfig.readyEvent ) {
		readyBranches = upBranches.filter( function( branchName ) { return self.bootStatuses[branchName] === self.calypsoLiveConfig.readyEvent; } );
	} else {
		readyBranches = upBranches;
	}
	var erroredBranches = activeBranches.filter( function( branchName ) { return self.bootStatuses[branchName] === "ERROR"; } );
	return {
		active: activeBranches,
		up: upBranches,
		ready: readyBranches,
		errored: erroredBranches,
	}
};

ProxyManager.prototype.markErrored = function( branchName ) {
	var self = this;
	if ( this.hasErrored( branchName ) ) {
		return;
	}
	debug( 'Branch ' + branchName + ' has errored. It will be cleaned up and ready to boot again in 20s.' );
	this.bootStatuses[ branchName ] = 'ERROR';
	self.stopServingBranch( branchName, true );
};

ProxyManager.prototype.hasErrored = function( branchName ) {
	return this.bootStatuses[ branchName ] === 'ERROR';
};

module.exports = ProxyManager;
