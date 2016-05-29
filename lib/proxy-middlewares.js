
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
		if(branchName !== req.session.branch) {
			debug('Using branch', branchName);
			req.session.branch = branchName;
		}
	}
	return normalizeBranchName(branchName);
}

function normalizeBranchName(branchName) {
	return branchName.toLowerCase();
}

function serveBootPage(req, res, message) {
    res.status(202);
    if(isHTML(req)) {
		res.send('<head><meta http-equiv="refresh" content="5"></head><body><p>' + message + '</p></body>');
	} else {
		res.send(message);
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

module.exports = function(proxyManager) {

	function proxyHTTP(req, res, next) {
		var branchName = getBranchName(req);
		if (!proxyManager.isUp(branchName)) {
			debug('Booting branch', branchName);
			proxyManager.bootBranch(branchName);
		}
		if (proxyManager.isBooting(branchName)) {
			// wait 10 seconds before serving the booting page so `serveBranch` may print
			// an error if it fails quickly.
			setTimeout(function() {
				if(res.headersSent) return;
				serveBootPage(req, res, 'Booting branch...');
			}, 10 * 1000);
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

