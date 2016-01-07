var fs = require('fs');
var path = require('path');
var net = require('net');
var http = require('http');
var cluster = require('cluster');
var child_process = require('child_process');
var mkdirp = require('mkdirp');
var express = require('express');
var cookieSession = require('cookie-session');
var httpProxy = require('http-proxy');
var debug = require('debug')('server');
var Hub  = require('cluster-hub');

module.exports = function(config) {
	var hub = new Hub();
	var branchManager = require('./branch-manager')(config);
	var workers = {};
	var proxies = {};

	var sessionMiddleware = cookieSession({
		name: 'livebranches',
		keys: ['key1', 'key2']
	});

	// start refreshing the mirror repository periodically
	branchManager.repository.keepSynced();

	var app = express();
	app.enable('trust proxy');
	app.use(sessionMiddleware);

	function deserializeError(err) {
		if(!err || typeof err !== 'object') return;
		err.__proto__ = Error.prototype;
	}

	function serveBranch(branchName, callback) {
		var worker = cluster.fork();
		workers[branchName] = worker;
		worker.on('exit', function() {
			stopServingBranch(branchName);
		});
		branchManager.repository.waitAvailable(function() {
			hub.requestWorker(worker, 'init', {
				branch: branchName
			}, function(err) {
				deserializeError(err);
				callback(err);
			});
		});
	}

	function stopServingBranch(branchName) {
		var proxy = proxies[branchName];
		var worker = workers[branchName];
		if(proxy) {
			proxy.close();
			proxies[branchName] = null;
		}
		if(worker) {
			if (!worker.isDead()) {
				worker.kill();
			}
			workers[branchName] = null;
		}
	}

	function checkUpdated(branchName, callback) {
		var worker = workers[branchName];
		if(worker.updating) {
			return worker.once('branch updated', callback);
		}
		worker.setMaxListeners(1000);
		worker.updating = true;
		branchManager.repository.waitAvailable(function() {
			hub.requestWorker(worker, 'update', null, function (err, mustRestart) {
				deserializeError(err);
				if (err) debug(err);
				if (!mustRestart) {
					worker.updating = false;
					worker.emit('branch updated');
					return callback();
				}
				stopServingBranch(branchName);
				serveBranch(branchName, function (err) {
					worker.updating = false;
					worker.emit('branch updated');
					callback(err);
				});
			});
		});
	}

	function proxy(branchName, req, res) {
		var proxy = proxies[branchName];
		if(!proxy) return res.send('proxy stopped');
		proxy.web(req, res, function(err) {
			debug(err);
		});
	}

	function serveBootPage(req, res, message) {
		res.send('<head><meta http-equiv="refresh" content="5"></head><body><p>' + message + '</p></body>');
	}

	function isHTML(req) {
		var acceptedContentTypes = (req.header('accept') || '').split(";")[0];
		if(acceptedContentTypes) {
			acceptedContentTypes = acceptedContentTypes.split(',');
			if(acceptedContentTypes.indexOf('text/html') >= 0) return true;
		}
		return false;
	}

	app.use(function(req, res, next) {
		var branchName = req.query.branch || req.session.branch || 'master';
		if(branchName !== req.session.branch) {
			debug('Using branch', branchName);
			req.session.branch = branchName;
		}
		if(!workers[branchName] && !proxies[branchName]) {
			serveBranch(branchName, function(err) {
				if(err) {
					stopServingBranch(branchName);
					debug(err);
					return next(err);
				}
				var socketPath = branchManager.getSocketPath(branchName);
				debug('creating proxy to', socketPath);
				proxies[branchName] = httpProxy.createProxyServer({
					target: {
						socketPath: socketPath
					}
				});
				// try to serve the booting page if the proxied request times out
				proxies[branchName].on('proxyReq', function (proxyReq, req, res) {
					proxyReq.setTimeout(50*1000, function onTimeout() {
						if(isHTML(req) && !res.headersSent) {
							proxyReq.abort();
							serveBootPage(req, res, 'Compiling assets...');
						}
					});
				});
			});
		}
		if(!proxies[branchName]) {
			return serveBootPage(req, res, 'Booting branch...');
		}
		checkUpdated(branchName, function(err) {
			if(err) return next(err);
			if(!res.headersSent) {
				proxy(branchName, req, res);
			}
		});
	});

	var server = http.createServer(app);
	// Proxy WebSockets as well proxy.ws.bind( proxy )
	server.on('upgrade', function(req, socket, head) {
		sessionMiddleware(req, { headers: {} } , function(err) {
			if(err) {
				socket.end('Error opening session: '+(err.message || err.toString()));
				return;
			}
			var branchName = req.session.branch || 'master';
			var proxy = proxies[branchName];
			if(!branchName || !proxies[branchName]) {
				socket.end('Session not found');
				return;
			}
			if(!proxy) {
				socket.end('Proxy not found');
				return;
			}
			proxy.ws(req, socket, head);
		});
	});
	server.listen(3000);
	server.on('listening', function() {
		console.log('Server running on port '+3000);
	});
};
