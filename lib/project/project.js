var path = require('path');
var fs = require('fs');
var cluster = require('cluster');
var util = require("util");

var mkdirp = require('mkdirp');
var debug = require('debug')('clb-project');

var Branch = require('./branch');
var MirrorRepository = require('./mirror-repository');

function createRepository(config, destination) {
	if(config.type === 'git') {
		return new MirrorRepository(config.url, path.join(destination, 'repo'));
	}
}

function Project(config) {
	this.name = config.name;
	this.destination = path.resolve(config.destination, this.name);
	this.repository = createRepository(config.repository, this.destination);
	this.branches = {};
}

Project.prototype.getDirectory = function() {
	return this.destination;
};

Project.prototype.getBranch = function(branchName) {
	if(!this.branches[branchName]) {
		this.branches[branchName] = new Branch({
			repository: this.repository,
			destination: path.join(this.destination, 'branches'),
			name: branchName
		});
	}
	return this.branches[branchName];
};

Project.prototype.getSocketPath = function(branchName) {
	return path.join(this.destination, 'sockets', branchName+'.socket');
};

module.exports = Project;
