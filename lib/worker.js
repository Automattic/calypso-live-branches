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
var terminate = require('terminate');

var hub = new Hub();
var worker = cluster.worker;

// patch net.Server.listen to use the socket file instead of the port given by the program
function patchNetServerListen(socketPath, onConnected) {
	var originalNetServerListen = net.Server.prototype.listen;
	var serverStarted = false;
	var calledOnce = false;
	net.Server.prototype.listen = function() {
		var server = this;
		var args = Array.prototype.slice.call( arguments );
		var realCallback;

		debug('listen() called from worker %d', worker.id);
		// prevent binding on the same socket file multiple times
		if (calledOnce) {
			return originalNetServerListen.apply(this, arguments);
		}
		calledOnce = true;
		if(args.length > 0 && typeof args[args.length-1] === 'function') {
			realCallback = args[args.length-1];
		}
		worker.on('exit', function() {
			debug('worker %d exiting, closing server', worker.id);
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

function terminateSubprocess( subprocess, subprocessName, branchName ) {
	if ( subprocess ) {
		debug( 'Terminating ' + subprocessName + ' subprocess...' );
		terminate( subprocess.pid, function( err ) {
			if ( err ) {
				debug( 'Could not terminate ' + subprocessName + ' subprocess for ' + branchName );
			} else {
				debug( 'Successfully terminated ' + subprocessName + ' subprocess for ' + branchName );
			}
		} );
	}
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
		debug( 'Worker booting ' + branchName );
		debug( 'Clearing log ' + logPath );
		resetFile(logPath, function() {
			debug( 'Redirecting log calls to ' + logPath );
			var outputStream = fs.createWriteStream(logPath);
			worker.on('exit', function() {
				outputStream.end();
			});
			// patch console calls
			process.stdout.write = process.stderr.write = outputStream.write.bind( outputStream );

			if (socketPath.length >= 103) {
				console.warn('WARNING: Socket path is longer than UNIX_PATH_MAX on OS X (104), this might cause some problems');
			}

			debug( 'Checking out branch ' + branchName );
			var checkoutCurrentProcess = null;
			currentBranch.checkout(function(err, destination) {
				if(err) return callback(serializeError(err));

				branchDestination = destination;
				console.log('Switched to branch '+branchName+' at '+destination);

				debug( 'Patching package.json for branch ' + branchName );
				patchPackageJSON(destination, config, function(err) {
					if(err) return callback(serializeError(err));
					debug( 'Preparing branch (npm install) ' + branchName );
					console.log('Installing...');
					// run application in this context by
					// - overwriting the ENV
					// - using package.json + config to build the app
					// - calling the main script with require (warning: the test (require.main === module) won't pass)
					var installProcess = prepareApp(destination, config, function(err) {
						if(err) return callback(serializeError(err));
						installProcess = null;
						// ensure the socket file does not exist yet
						resetFile(socketPath, function() {
							debug( 'Patching net.Server.listen for branch ' + branchName );
							patchNetServerListen(socketPath, callback);
							console.log('net.Server.prototype.listen patched');
							require(path.join(destination, config.main || 'index'));
						});
					});
					installProcess.stdout.on('data', function(chunk) {
						outputStream.write(chunk);
					});
					installProcess.stderr.on('data', function(chunk) {
						outputStream.write(chunk);
					});
					worker.on('exit', function() {
						terminateSubprocess( installProcess, '`npm install`', branchName );
					});
				});
			}, function currentProcessUpdate( currentProcess ) {
				checkoutCurrentProcess = currentProcess;
			} );
			worker.on( 'exit', function() {
				terminateSubprocess( checkoutCurrentProcess, 'checkout', branchName );
			} );
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
