var path = require('path');
var net = require('net');
var cluster = require('cluster');
var child_process = require('child_process');
var mkdirp = require('mkdirp');
var Hub  = require('cluster-hub');
var hub = new Hub();

module.exports = function(config) {
	var socketsDir = path.resolve(config.dir, 'sockets');
	var pm = require('./process-manager')(config);
	var worker = cluster.worker;
	var currentBranch;

	hub.on('init', function(data, sender, callback) {
		if(currentBranch) return;
		var branchName = data.branch;
		currentBranch = branchName;
		var socketPath = path.join(socketsDir, branchName+'.socket');
		console.log('socket path', socketPath);
		mkdirp.sync(path.dirname(socketPath));
		var originalNetServerListen = net.Server.prototype.listen;
		net.Server.prototype.listen = function() {
			console.log('listen called from worker ', worker.id);
			var args = Array.prototype.slice.call( arguments );
			var newArgs = [ socketPath ];
			if(args.length > 0 && typeof args[args.length-1] === 'function') {
				newArgs.push(args[args.length-1]);
			}
			originalNetServerListen.apply(this, newArgs);
		};
		pm.checkout(branchName, function(err, destination) {
			process.chdir(destination);
			console.log('branch '+branchName+' checkouted in '+destination);
			child_process.exec('make build', function() {
				require('build/bundle-development.js');
				callback();
			});
		});
    });
};
