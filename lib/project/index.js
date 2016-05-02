var path = require('path');

var Project = require('./project');

module.exports = function(config) {
	return new Project({
		name: config.name,
		repository: config.repository,
		destination: path.resolve(process.env.TMP_DIR || '/tmp')
	});
};

module.exports.Project = Project;
module.exports.MirrorRepository = require('./mirror-repository');
module.exports.Branch = require('./branch');
