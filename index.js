
var path = require('path');
var fs = require('fs');
var cluster = require('cluster');
var mkdirp = require('mkdirp');
var rmrf = require('rimraf');
var argument = process.argv.slice(2)[0];
var config;

if(!argument) {
	console.error('Enter url of repository or path to config file');
	return;
}

if(fs.existsSync(argument)) {
	config = JSON.parse(fs.readFileSync(argument));
} else {
	config = {
		repository: {
			type: 'git',
			url: argument
		},
		tmpDir: './data'
	};
}

var socketsDir = path.join(config.tmpDir, 'sockets');
mkdirp(socketsDir);
rmrf.sync(socketsDir+'/*');

if(cluster.isMaster) {
	require('./server')(config);
} else {
	require('./worker')(config);
}
