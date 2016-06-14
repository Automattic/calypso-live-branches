var fs = require('fs');
var debug = require('debug')('clb-server');

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
	return normalizeBranchName(branchName);
}

function normalizeBranchName(branchName) {
	return branchName.toLowerCase();
}

function serveBootPage(req, res, message) {
	if(res.headersSent) return;
    res.status(202);
    if(isHTML(req)) {
		res.render('boot', { logUrl: req.path + '?branch=' + getBranchName(req) + '&log=1', message: message } );
	} else {
		res.send(message);
	}
}

function serveLogFile(req, res, logPath) {
	var readStream = fs.createReadStream(logPath);
	readStream.on('error', function(err) {
		res.status(500).end(err.toString());
	});
	readStream.pipe(res);
}

function isHTML(req) {
	var acceptedContentTypes = (req.header('accept') || '').split(";")[0];
	if(acceptedContentTypes) {
		acceptedContentTypes = acceptedContentTypes.split(',');
		if(acceptedContentTypes.indexOf('text/html') >= 0) return true;
	}
	return false;
}

module.exports = function(proxyManager) {

	function proxyHTTP(req, res, next) {
		var branchName = getBranchName(req);
		if (req.query.log) {
			var branchOutput = proxyManager.project.getLogPath(branchName);
			return serveLogFile(req, res, branchOutput);
		}
		if (req.query.reboot) {
			proxyManager.stopServingBranch(branchName);
			return res.redirect(req.path + '?branch=' + branchName);
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
					serveBootPage(req, res, err.message);
				}
			});
			// wait 5 seconds before serving the booting page so `proxyManager.bootBranch` may print
			// an error if it fails quickly.
			setTimeout(function() {
				serveBootPage(req, res, 'Booting branch...');
			}, 5 * 1000);
			return;
		}
		if (proxyManager.isBooting(branchName)) {
			serveBootPage(req, res, 'Booting branch...');
		} else {
			proxyManager.checkUpdated(branchName, function(err) {
				if(err) return next(err);
				proxyManager.proxyRequest(branchName, req, res);
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
