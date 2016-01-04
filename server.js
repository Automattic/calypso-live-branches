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

	var app = express();
	app.enable('trust proxy');
	app.use(sessionMiddleware);

	function deserializeError(err) {
		if(!err || typeof err !== 'object') return;
		err.__proto__ = Error.prototype;
	}

	function serveBranch(branchName, callback) {
		var worker = cluster.fork('./worker');
		workers[branchName] = worker;
		hub.requestWorker(worker, 'init', {
			branch: branchName
		}, callback);
		worker.on('exit', function() {
			workers[branchName] = null;
			if(proxies[branchName]) {
				proxies[branchName].close();
				proxies[branchName] = null;
			}
			// ensure unix socket file is removed
			var socketPath = branchManager.getSocketPath(branchName);
			try {
				fs.unlinkSync(socketPath);
			} catch(e) {}
		});
	}

	function checkUpdated(branchName, callback) {
		hub.requestWorker(workers[branchName], 'update', {
			branch: branchName
		}, function(err, mustRestart) {
			deserializeError(err);
			if(err || !mustRestart) return callback(err);
			worker.kill();
			worker.once('exit', function() {
				serveBranch(branchName, callback);
			});
		});
	}

	function proxy(branchName, req, res) {
		proxies[branchName].web(req, res, function(err) {
			debug(err);
		});
	}

	app.use(function(req, res) {
		var branchName = req.query.branch || req.session.branch || 'master';
		if(branchName !== req.session.branch) {
			debug('Using branch', branchName);
			req.session.branch = branchName;
		}
		if(!workers[branchName] && !proxies[branchName]) {
			serveBranch(branchName, function(err) {
				deserializeError(err);
				if(err) {
					debug(err);
					res.send('Error while booting branch: '+err);
					return;
				}
				var socketPath = branchManager.getSocketPath(branchName)
				debug('creating proxy to', socketPath);
				proxies[branchName] = httpProxy.createProxyServer({
					target: {
						socketPath: socketPath
					}
				});
				proxy(branchName, req, res);
			});
			return;
		}
		if(!proxies[branchName]) {
			res.send('Booting branch '+branchName+'...');
			return;
		}
		checkUpdated(branchName, function() {
			proxy(branchName, req, res);
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
};
