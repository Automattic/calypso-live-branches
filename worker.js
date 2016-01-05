var fs = require('fs');
var path = require('path');
var net = require('net');
var cluster = require('cluster');
var _ = require('lodash');
var exec = require('child_process').exec;
var mkdirp = require('mkdirp');
var Hub  = require('cluster-hub');
var debug = require('debug')('worker');

var hub = new Hub();
var worker = cluster.worker;

function patchNetServerListen(socketPath, onConnected) {
	var originalNetServerListen = net.Server.prototype.listen;
	var serverStarted = false;
	net.Server.prototype.listen = function() {
		debug('listen() called from worker %d', worker.id);
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
	exec(config.scripts.build || 'npm install', { cwd: destination }, function(err, stdout, stderr) {
		if(err) return callback(err);
		debug(stderr || stdout);

		// reinit paths for require
		process.chdir(destination);
		require('module').Module._initPaths();
		require(path.join(destination, config.main || 'index'));
		callback();
	});
}

function serializeError(err) {
	if(!err || typeof err === 'string') return err;
	return {
		name: err.name || 'Error',
		message: err.message,
		stack: err.stack
	};
}

module.exports = function(config) {
	var branchManager = require('./branch-manager')(config);
	var currentBranch;

	hub.on('init', function(data, sender, callback) {
		if(currentBranch) return callback('Branch already booted');
		var branchName = data.branch;
		currentBranch = branchManager.getBranch(branchName);

		var socketPath = branchManager.getSocketPath(branchName);
		debug('socket path', socketPath);

		currentBranch.checkout(function(err, destination) {
			if(err) return callback(serializeError(err));
			debug('branch '+branchName+' checkouted in '+destination);

			patchPackageJSON(destination, config, function(err) {
				if(err) return callback(serializeError(err));

				// create dir for socket in case branch contains '/'
				mkdirp(path.dirname(socketPath), function() {
					// ensure the socket file does not exist yet
					fs.unlink(socketPath, function(err) {
						// patch net.Server.listen to use the socket file instead of the port given by the program
						patchNetServerListen(socketPath, callback);

						// run application in this context by
						// - overwriting the ENV
						// - using package.json + config to build the app
						// - calling the main script with require (warning: the test (require.main === module) won't pass)
						runAppInContext(destination, config, function(err) {
							if(err) return callback(serializeError(err));
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
					currentBranch.hasChanged(lastCommit, config.watchDirs, function(err, changed) {
						callback(serializeError(err), changed);
					});
				});
			});
		});
	});
};
