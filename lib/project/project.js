var path = require('path');
var fs = require('fs');
var cluster = require('cluster');
var util = require("util");
var execSync = require('child_process').execSync;
var exec = require('child_process').exec;
var shellescape = require('shell-escape');

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
	this.config = config;
	this.name = config.name;
	this.destination = path.resolve(config.destination, this.name);
	this.graveyard = path.join( process.env.TMP_DIR || '/tmp', 'clb-to-remove', this.name );
	this.repository = createRepository(config.repository, this.destination);
	this.branches = {};
	this.startJanitor();
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

Project.prototype.getLogPath = function(branchName) {
	return path.join(this.destination, 'logs', branchName+'.log');
};

Project.prototype.cleanupBranch = function(branchName) {
	var branch = this.branches[ branchName ];
	if ( ! branch ) {
		return new Error( 'Branch already cleaned up' );
	}
	var graveDestination = path.join( this.graveyard, branch.name );
	try {
		// need to be sync so we don't recreate this branch in the meantime
		execSync( shellescape( [ 'mkdir', '-p', path.dirname( graveDestination ) ] ) );
		execSync( shellescape( [ 'mv', branch.getDirectory(), graveDestination ] ) );
	} catch( err ) {
		return err;
	}
	delete this.branches[ branchName ];
	return true;
};

Project.prototype.startJanitor = function() {
	var self = this;
	var emptyDir = path.join( process.env.TMP_DIR || '/tmp', 'empty-dir' );
	exec( 'mkdir -p ' + shellescape( [ emptyDir ] ), function() {
		debug( 'Starting janitor on ' + self.graveyard );
		exec( 'rsync -aqr --delete --ignore-errors ' +
				shellescape( [ emptyDir+'/' ] ) + ' ' +
				shellescape( [ self.graveyard+'/' ] ),
			function(error, stdout, stderr) {
				if ( error || stderr ) {
					debug( error || stderr );
				}
				debug( 'Janitor stopped.' );
				setTimeout( function () {
					self.startJanitor();
				}, 60 * 1000 );
			}
		);
	} );
};

module.exports = Project;
