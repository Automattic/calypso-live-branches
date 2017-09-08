
var express = require( 'express' );
var bodyParser = require( 'body-parser' );

module.exports = function( config ) {
	var app = express();

	app.use( bodyParser.json() );
	app.use( bodyParser.urlencoded( { extended: true } ) );

	app.post( '/push', function( req, res ) {
		var payload = req.body;
		if ( payload && payload.repository && payload.repository.name === '' ) {

		}
	} );

	app.listen( 3001, function() {
		console.log( 'Github webhooks set up on port 3001' );
	} );

	return app;
};
