var fs = require('fs');
var path = require('path');
var net = require('net');
var cluster = require('cluster');
var _ = require('lodash');
var exec = require('child_process').exec;
var mkdirp = require('mkdirp');
var Hub  = require('cluster-hub');
var debug = require('debug')('clb-worker');
var async = require('async');

var hub = new Hub();
var worker = cluster.worker;

function patchNetServerListen(socketPath, onConnected) {
	var originalNetServerListen = net.Server.prototype.listen;
	var serverStarted = false;
	var calledOnce = false;
	net.Server.prototype.listen = function() {
		debug('listen() called from worker %d', worker.id);
		// prevent binding on the same socket file multiple times
		if (calledOnce) {
			return originalNetServerListen.apply(this, arguments);
		}
		calledOnce = true;
		var args = Array.prototype.slice.call( arguments );
		var realCallback;
		if(args.length > 0 && typeof args[args.length-1] === 'function') {
			realCallback = args[args.length-1];
		}
		var server = this;
		worker.on('exit', function() {
			server.close();
			server.unref();
		});
		originalNetServerListen.call(this, socketPath, function connectListener() {
			if(realCallback) {
				realCallback.apply(this, arguments);
			}
			if(!serverStarted) {
				serverStarted = true;
				onConnected && onConnected();
			}
		});
	};
}

function patchPackageJSON(destination, config, callback) {
	var packageJSONPath = path.join(destination, 'package.json');
	fs.readFile(packageJSONPath, function(err, buffer) {
		if(err) return callback(); // file does not exist (probably)
		var packageJSON = JSON.parse(buffer.toString());
		// local config must overwrite packageJSON config
		_.merge(config, _.merge({ scripts: {} }, packageJSON, config));
		fs.writeFile(packageJSONPath, JSON.stringify(config, null, 2), callback);
	});
}

function runAppInContext(destination, config, callback) {
	_.merge(process.env, config.env || {});
	var installProcess = exec('npm install', { cwd: destination }, function(err, stdout, stderr) {
		if(err) return callback(err);
		// reinit paths for require
		process.chdir(destination);
		require('module').Module._initPaths();
		require(path.join(destination, config.main || 'index'));
		callback();
	});
	return installProcess;
}

function serializeError(err) {
	if(!err || typeof err === 'string') return err;
	return {
		name: err.name || 'Error',
		message: err.message,
		stack: err.stack
	};
}

function checkBranchStillExists( branch ) {
	branch.exists(function(err, branchExists) {
		if(!branchExists) {
			process.exit(0);
		}
		setTimeout(function() {
			checkBranchStillExists( branch );
		}, 60 * 60 * 1000 ); // 1h
	})
}

module.exports = function(config) {
	var project = require('./project')(config);
	var currentBranch;

	hub.on('init', function(data, sender, callback) {
		if(currentBranch) return callback('Branch already booted');
		var branchName = data.branch;
		try {
			currentBranch = project.getBranch(branchName);
		} catch(err) {
			return callback(serializeError(err));
		}

		var socketPath = project.getSocketPath(branchName);
		var logPath = project.getLogPath(branchName);
		debug('socket path', socketPath);

		currentBranch.checkout(function(err, destination) {
			if(err) return callback(serializeError(err));
			debug('branch '+branchName+' checkouted in '+destination);

			patchPackageJSON(destination, config, function(err) {
				if(err) return callback(serializeError(err));

				// create dirs for socket and log files
				var socketDir = path.dirname(socketPath);
				var logDir = path.dirname(logPath);
				async.each([ socketDir, logDir ], mkdirp, function(err) {
					// ensure the socket and the log files does not exist yet
					async.each([ socketPath, logPath ], fs.unlink, function(err) {
						// patch net.Server.listen to use the socket file instead of the port given by the program
						patchNetServerListen(socketPath, callback);

						// run application in this context by
						// - overwriting the ENV
						// - using package.json + config to build the app
						// - calling the main script with require (warning: the test (require.main === module) won't pass)
						var appProcess = runAppInContext(destination, config, function(err) {
							if(err) return callback(serializeError(err));
						});
						var outputStream = fs.createWriteStream(logPath);
						appProcess.stdout.pipe(outputStream);
						appProcess.stderr.pipe(outputStream);
					});
				});
			});
		});
    });

	hub.on('update', function(data, sender, callback) {
		currentBranch.isUpToDate(function(err, upToDate) {
			if(err) return callback(serializeError(err));
			if(upToDate) return callback(null, false);
			currentBranch.getLastCommit(function(err, lastCommit) {
				if(err) return callback(serializeError(err));
				currentBranch.update(function(err) {
					if(err) return callback(serializeError(err));
					currentBranch.hasChanged(lastCommit, config.watchDirs, function(err, changed) {
						callback(serializeError(err), changed);
					});
				});
			});
		});
	});
};
