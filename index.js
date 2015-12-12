
var cluster = require('cluster');

if (!process.env.PROJECT) {
	return console.error('Enter PROJECT path');
}

if (!process.env.DIR) {
	return console.error('Enter DIR path');
}

var config = {
	dir: process.env.DIR,
	project: process.env.PROJECT
};

if(cluster.isMaster) {
	require('./server')(config);
} else {
	require('./worker')(config);
}
