var fs = require('fs');
var url = require('url');
var path = require('path');
var cluster = require('cluster');
var mkdirp = require('mkdirp');

var PROTOCOL_DEFAULT = process.env.PROTOCOL_DEFAULT || 'https';

function uniqueProjectName(projectPath) {
	var parsedUrl = url.parse(projectPath);
	if(parsedUrl.host === 'github.com') {
		return 'gh-'+path.basename(parsedUrl.pathname, '.git');
	}
	return path.dirname(projectPath);
}

// transforms git@github.com:User/project.git into git+ssh://git@github.com/User/project.git
function fixUrl(repoUrl) {
	// if no protocol is provided in the url, assume it's an ssh url and we have the key in our ssh config
	if(!repoUrl.match(/^\w{3,5}(\+\w{3,5})?:\/\//)) {
		return repoUrl;
	}
	// replace git+https? protocols by https
	repoUrl = repoUrl.replace(/git\+https?:\/\//, PROTOCOL_DEFAULT + '://');
	return repoUrl;
}

(function boot() {
	var argument = process.argv.slice(2)[0];
	var config;

	if (!argument) {
		console.error('Enter url of repository or path to config file');
		return;
	}

	try {
		fs.accessSync(argument);
	} catch (e) {
		config = {
			repository: {
				type: 'git',
				url: argument
			}
		};
	}

	if (!config) {
		config = JSON.parse(fs.readFileSync(argument));
	}

	config.repository.url = fixUrl(config.repository.url);

	if (!config.name) {
		config.name = uniqueProjectName(config.repository.url);
	}

	if(cluster.isMaster) {
		require('./server')(config);
	} else {
		require('./worker')(config);
	}

})();