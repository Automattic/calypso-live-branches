var fs = require('fs');
var debug = require('debug')('clb-server');
var merge = require('lodash').merge;
var AnsiToHTML = require('ansi-to-html');
var ansiToHTMLConverter = new AnsiToHTML();

function escapeRegExp(text) {
	return text.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
}

var subdomainRegexp = null;
if(process.env.HOST) {
	subdomainRegexp = new RegExp("(.+?)" + escapeRegExp('.'+process.env.HOST));
}

function getBranchName(req) {
	var branchName;
	if(subdomainRegexp) {
		var matches = req.hostname.match(subdomainRegexp);
		if(matches && matches[1]) {
			branchName = matches[1].replace('.', '/');
		}
	}
	if(!branchName) {
		branchName = req.query.branch || req.session.branch || 'master';
	}
	return branchName;
}

function serveBootPage(req, res, message, options) {
	if(res.headersSent) return;
	options = options || {};
    res.status(202);
    if(isHTML(req)) {
		res.render('boot', {
			message: message,
			config: {
				logUrl: req.path + '?branch=' + getBranchName(req) + '&log=1',
				statusUrl: req.path + '?branch=' + getBranchName(req) + '&status=1',
				readyEvent: options.readyEvent
			}
		} );
	} else {
		res.send(message);
	}
}

function serveLogFile(req, res, logPath, options) {
	options = options || {};
	var readStream = fs.createReadStream(logPath, { encoding: 'utf8' });
	readStream.on('error', function(err) {
		res.status(500).end(err.toString());
	});
	if(options.format === 'html') {
		readStream.on('data', function(chunk) {
			res.write(ansiToHTMLConverter.toHtml(chunk));
		});
		readStream.on('end', function() {
			res.end();
		});
	} else {
		readStream.pipe(res);
	}
}

function isHTML(req) {
	var acceptedContentTypes = (req.header('accept') || '').split(";")[0];
	if(acceptedContentTypes) {
		acceptedContentTypes = acceptedContentTypes.split(',');
		if(acceptedContentTypes.indexOf('text/html') >= 0) return true;
	}
	return false;
}

module.exports = function(proxyManager, appDefaultConfig) {

	function proxyHTTP(req, res, next) {
		var branchName = getBranchName(req);
		var options = merge({}, appDefaultConfig, req.query);
		if (options.log) {
			var branchOutput = proxyManager.project.getLogPath(branchName);
			return serveLogFile(req, res, branchOutput, options);
		}
		if (options.reboot) {
			proxyManager.stopServingBranch(branchName);
			return res.redirect(req.path + '?branch=' + branchName);
		}
		if (options.status) {
			return proxyManager.checkUpdated(branchName, function() { // ignore update errors
				proxyManager.getCommitId(branchName, function(err, commitId) {
					res.send({
						branch: branchName,
						status: proxyManager.getStatus(branchName),
						commit: !err && commitId
					});
				});
			});
		}
		// update branch in session
		if (branchName !== req.session.branch) {
			debug('Using branch', branchName);
			req.session.branch = branchName;
		}
		// boot if branch is not up
		if (!proxyManager.isUp(branchName)) {
			debug('Booting branch', branchName);
			proxyManager.bootBranch(branchName, function(err) {
				if(err) {
					debug(err);
					serveBootPage(req, res, err.message, options);
				}
			});
			// wait 5 seconds before serving the booting page so `proxyManager.bootBranch` may print
			// an error if it fails quickly.
			setTimeout(function() {
				serveBootPage(req, res, 'Booting branch...', options);
			}, 5 * 1000);
			return;
		}
		if (proxyManager.isBooting(branchName)) {
			serveBootPage(req, res, 'Booting branch...', options);
		} else {
			proxyManager.checkUpdated(branchName, function(err, mustRestart) {
				if (err) {
					return serveBootPage(req, res, err.message, options);
				}
				if (mustRestart) {
					return serveBootPage(req, res, 'Rebooting branch...', options);
				}
				proxyManager.proxyRequest(branchName, req, res, next);
			});
		}
	}

	// assumes the branch has booted
	function proxyWebsocket(req, socket, head) {
		var branchName = getBranchName(req);
		if (!branchName || !proxyManager.proxies[branchName]) {
			socket.end('Session not found');
			return;
		}
		var proxy = proxyManager.proxies[branchName];
		if (!proxy) {
			socket.end('Proxy not found');
			return;
		}
		proxy.ws(req, socket, head, function(err) {
			debug(err);
		});
	}

	return {
		http: proxyHTTP,
		websocket: proxyWebsocket
	};
};
