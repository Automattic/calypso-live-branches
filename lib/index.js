
var path = require('path');
var fs = require('fs');
var cluster = require('cluster');
var mkdirp = require('mkdirp');
var argument = process.argv.slice(2)[0];
var config;

if(!argument) {
	console.error('Enter url of repository or path to config file');
	return;
}

try {
	fs.accessSync(argument);
	config = JSON.parse(fs.readFileSync(argument));
} catch (e) {
	config = {
		repository: {
			type: 'git',
			url: argument
		}
	};
}

if(cluster.isMaster) {
	require('./server')(config);
} else {
	require('./worker')(config);
}
