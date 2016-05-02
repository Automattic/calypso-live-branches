var fs = require('fs');
var url = require('url');
var sshUrl = require('ssh-url');
var path = require('path');
var cluster = require('cluster');
var mkdirp = require('mkdirp');

function uniqueProjectName(projectPath) {
	var parsedUrl = url.parse(projectPath);
	if(parsedUrl.host === 'github.com') {
		return 'gh-'+path.basename(parsedUrl.pathname, '.git');
	}
	return path.dirname(projectPath);
}

// transforms git@github.com:User/project.git into git+ssh://git@github.com/User/project.git
function fixUrl(repoUrl) {
	// try to use git+ssh whenever possible
	repoUrl = repoUrl.replace('git+https', 'git+ssh');
	// if no protocol is provided in the url, assume it's an ssh url
	if(!repoUrl.match(/^\w{3,4}(\+\w{3,4})?:\/\//)) {
		var sshParsed = sshUrl.parse(repoUrl);
		return url.format({
			protocol: 'git+ssh:',
			hostname: sshParsed.hostname,
			pathname: sshParsed.pathname,
			auth: sshParsed.user,
			slashes: true
		});
	}
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
		config = JSON.parse(fs.readFileSync(argument));
	} catch (e) {
		config = {
			repository: {
				type: 'git',
				url: argument
			}
		};
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