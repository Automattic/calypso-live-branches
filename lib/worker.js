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

var log = debug;

function patchNetServerListen(socketPath, onConnected) {
	var originalNetServerListen = net.Server.prototype.listen;
	var serverStarted = false;
	var calledOnce = false;
	net.Server.prototype.listen = function() {
		var server = this;
		var args = Array.prototype.slice.call( arguments );
		var realCallback;

		log('listen() called from worker %d', worker.id);
		// prevent binding on the same socket file multiple times
		if (calledOnce) {
			return originalNetServerListen.apply(this, arguments);
		}
		calledOnce = true;
		if(args.length > 0 && typeof args[args.length-1] === 'function') {
			realCallback = args[args.length-1];
		}
		worker.on('exit', function() {
			log('worker %d exiting, closing server', worker.id);
			server.close();
			server.unref();
			setImmediate(function() {
				server.emit('close');
			});
		});
		originalNetServerListen.call(server, socketPath, function connectListener() {
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

function prepareApp(destination, config, callback) {
	_.merge(process.env, config.env || {});
	var installProcess = exec('npm install', { cwd: destination, maxBuffer: 1024 * 1024 * 5 /* 5MB */ }, function(err, stdout, stderr) {
		if(err) return callback(err);
		// reinit paths for require
		process.chdir(destination);
		require('module').Module._initPaths();
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

function resetFile(filePath, callback) {
	// create dir for the file
	mkdirp(path.dirname(filePath), function() {
		// ensure the file does not exist yet
		fs.unlink(filePath, callback)
	});
}

module.exports = function(config) {
	var project = require('./project')(config);
	var currentBranch, branchDestination;

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

		// clear the log file if it exists
		resetFile(logPath, function() {
			// redirect log calls to the log file
			var outputStream = fs.createWriteStream(logPath);
			worker.on('exit', function() {
				outputStream.end();
			});
			// patch console calls
			console.log = console.warn = console.error = function() {
				var args = Array.prototype.slice.call(arguments);
				var out = args.map(function(arg) { return arg && arg.toString() || arg; }).join(' ');
				outputStream.write(out+'\n');
			};

			if (socketPath.length >= 103) {
				console.warn('WARNING: Socket path is longer than UNIX_PATH_MAX on OS X (104), this might cause some problems');
			}

			currentBranch.checkout(function(err, destination) {
				if(err) return callback(serializeError(err));

				branchDestination = destination;
				console.log('branch '+branchName+' checkouted in '+destination);
				
				exec('npm run clean', { cwd: branchDestination }, function (err) {
					// ignore error here

					patchPackageJSON(destination, config, function(err) {
						if(err) return callback(serializeError(err));

						console.log('package.json patched');
						// ensure the socket file does not exist yet
						resetFile(socketPath, function() {
							// patch net.Server.listen to use the socket file instead of the port given by the program


							console.log('net.Server.prototype.listen patched');
							// run application in this context by
							// - overwriting the ENV
							// - using package.json + config to build the app
							// - calling the main script with require (warning: the test (require.main === module) won't pass)
							var installProcess = prepareApp(destination, config, function(err) {
								if(err) return callback(serializeError(err));

								patchNetServerListen(socketPath, callback);
								require(path.join(destination, config.main || 'index'));
							});
							installProcess.stdout.on('data', function(chunk) {
								outputStream.write(chunk);
							});
							installProcess.stderr.on('data', function(chunk) {
								outputStream.write(chunk);
							});
						});
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
					currentBranch.hasChanged(lastCommit, config.watchPaths, function(err, changed) {
						callback(serializeError(err), changed);
					});
				});
			});
		});
	});
};
