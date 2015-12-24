var fs = require('fs');
var path = require('path');
var net = require('net');
var cluster = require('cluster');
var _ = require('lodash');
var child_process = require('child_process');
var mkdirp = require('mkdirp');
var Hub  = require('cluster-hub');
var hub = new Hub();

module.exports = function(config) {
	var socketsDir = path.resolve(config.tmpDir, 'sockets');
	var pm = require('./process-manager')(config);
	var worker = cluster.worker;
	var currentBranch;

	hub.on('init', function(data, sender, callback) {
		if(currentBranch) return callback(new Error('Branch already booted'));
		var branchName = data.branch;
		currentBranch = branchName;
		var socketPath = path.join(socketsDir, branchName+'.socket');
		console.log('socket path', socketPath);
		mkdirp.sync(path.dirname(socketPath));
		var originalNetServerListen = net.Server.prototype.listen;
		var serverStarted = false;
		net.Server.prototype.listen = function() {
			console.log('listen called from worker ', worker.id);
			var args = Array.prototype.slice.call( arguments );
			var newArgs = [ socketPath ];
			if(args.length > 0 && typeof args[args.length-1] === 'function') {
				newArgs.push(args[args.length-1]);
			}
			originalNetServerListen.apply(this, newArgs);
			if(!serverStarted) {
				callback();
				serverStarted = true;
			}
		};
		pm.checkout(branchName, function(err, destination) {
			if(err) {
				return callback(err.message);
			}
			console.log('branch '+branchName+' checkouted in '+destination);
			process.chdir(destination);
			process.env = _.merge(process.env, config.env || {});
			var packageJSONPath = path.join(destination, 'package.json');
			var packageJSON = JSON.parse(fs.readFileSync(packageJSONPath));
			packageJSON = _.merge(packageJSON, config, { scripts: {} });
			fs.writeFileSync(packageJSONPath, JSON.stringify(packageJSON, null, 2), 'utf8');
			child_process.exec(packageJSON.scripts.build || 'npm install', function(err, stdout, stderr) {
				console.log(stderr || stdout);
				var mainFile = path.join(destination, packageJSON.main || 'index');
				// reinit paths for require
				require('module').Module._initPaths();
				require(mainFile);
			});
		});
    });
};
