var path = require('path');
var net = require('net');
var http = require('http');
var cluster = require('cluster');
var child_process = require('child_process');
var mkdirp = require('mkdirp');
var express = require('express');
var cookieSession = require('cookie-session');
var httpProxy = require('http-proxy');
var Hub  = require('cluster-hub');
var hub = new Hub();

module.exports = function( config ) {
	var socketsDir = path.resolve(config.dir, 'sockets');
	var pm = require('./process-manager')(config);
	var workers = {};
	var proxies = {};

	var app = express();
	app.enable('trust proxy');
	app.use(cookieSession({
		name: 'session',
		keys: ['key1', 'key2']
	}));

	function serveBranch(branchName, callback) {
		var worker = cluster.fork('./worker');
		workers[branchName] = worker;
		worker.on('online', function(address) {
			hub.requestWorker(worker, 'init', {
				branch: branchName
			}, callback);
		});
	}

	function checkUpdated(branchName, callback) {
		pm.isUpToDate(branchName, function(err, noChange) {
			if(err || noChange) return callback(err);
			worker.kill();
			workers[branchName] = null;
			serveBranch(branchName, callback);
		});
	}

	function proxy(branchName, req, res) {
		proxies[branchName].web(req, res, function(err) {
			console.error(err);
		});
	}

	app.use(function(req, res) {
		var branchName = req.query.branch || req.session.branch || 'master';
		if(branchName !== req.session.branch) {
			console.log('Using branch', branchName);
			req.session.branch = branchName;
		}
		if(!workers[branchName] && !proxies[branchName]) {
			serveBranch(branchName, function() {
				var socketPath = path.join(socketsDir, branchName+'.socket');
				console.log('creating proxy to', socketPath);
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
	// Proxy WebSockets as well
	//server.on( 'upgrade', proxy.ws.bind( proxy ) );
	server.listen(3000);
};


