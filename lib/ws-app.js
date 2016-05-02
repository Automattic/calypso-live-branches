var express = require('express');
var async = require('async');

function WsApp() {
	if (!(this instanceof WsApp)) {
		return new WsApp();
	}
	this.connectMiddlewares = [];
	this.socketMiddlewares = [];
}

WsApp.prototype.useExpressMiddleware = function(middleware) {
	if (!this.expressApp) {
		this.expressApp = express();
	}
	if (middleware === 'init') {
		middleware = require('express/lib/middleware/init').init(this.expressApp);
	} else if (middleware === 'query') {
		middleware = require('express/lib/middleware/query')(this.expressApp.get('query parser fn'));
	}
	this.useConnectMiddleware( middleware );
};

WsApp.prototype.useConnectMiddleware = function(middleware) {
	this.connectMiddlewares.push(middleware);
};

WsApp.prototype.use = function(middleware) {
	this.socketMiddlewares.push(middleware);
};

WsApp.prototype.chainMiddlewares = function(next, onError) {
	var connectMiddlewares = this.connectMiddlewares;
	return function(req, socket, head) {
		var resMock = {
			headers: {},
			setHeader: function (key, value) {
				this.headers[key] = value;
			}
		};
		async.series(
			connectMiddlewares.map(function(middleware) {
				return middleware.bind(null, req, resMock);
			}),
			function(err) {
				if (err) {
					return onError && onError(err, req, socket, head);
				}
				next(req, socket, head);
			}
		);
	};
};

module.exports = WsApp;
