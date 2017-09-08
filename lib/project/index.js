var path = require('path');
var debug = require('debug')('clb-project');

var Project = require('./project');

var projects = {};

module.exports = function(config) {
	if ( ! projects[ config.name ] ) {
		debug( 'Creating project ' + config.name );
		projects[ config.name ] = new Project({
			name: config.name,
			repository: config.repository,
			destination: path.resolve(process.env.TMP_DIR || '/tmp')
		});
	}
	return projects[ config.name ];
};

module.exports.Project = Project;
module.exports.MirrorRepository = require('./mirror-repository');
module.exports.Branch = require('./branch');
