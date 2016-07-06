var http = require('http');
var path = require('path');
var express = require('express');
var cookieSession = require('cookie-session');
var WsApp = require('./ws-app');
var debug = require('debug')('clb-server');

module.exports = function(config) {
	var project = require('./project')(config);
	var proxyManager = require('./proxy-manager')(project);
	var appDefaultConfig = config.env.CALYPSO_LIVE_DEFAULT_CONFIG && JSON.parse(config.env.CALYPSO_LIVE_DEFAULT_CONFIG) || {};
	var proxyMiddlewares = require('./proxy-middlewares')(proxyManager, appDefaultConfig);
	var PORT = config.port || process.env.PORT || 3000;

	var sessionMiddleware = cookieSession({
		name: 'livebranches',
		keys: ['key1', 'key2']
	});

	var app = express();
	app.set('view engine', 'pug');
	app.set('views', path.join(__dirname, 'views'));
	app.enable('trust proxy');
	app.use(sessionMiddleware);
	app.use(proxyMiddlewares.http);

	var server = http.createServer(app);

	// Proxy WebSockets as well
	if (!process.env.DISABLE_WS_PROXY) {
		var wsApp = new WsApp();
		wsApp.useExpressMiddleware('init');
		wsApp.useExpressMiddleware('query');
		wsApp.useConnectMiddleware(sessionMiddleware);
		server.on('upgrade',
			wsApp.chainMiddlewares(
				proxyMiddlewares.websocket,
				function handleWsError(err, req, socket, head) {
					debug('Error opening session', err);
					socket.end('Error opening session: ' + (err.message || err.toString()));
				}
			)
		);
	}

	server.listen(PORT);
	server.on('listening', function() {
		console.log('Server running on port '+PORT);
	});
};
